use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};

use crate::api::auth::AuthUser;
use crate::api::covers::sniff::sniff;
use crate::app::AppState;
use crate::error::ApiError;
use crate::upstream::fetch::{UpstreamRequest, UpstreamResponse, fetch_bytes};
use crate::upstream::limiter::Limiters;
use crate::upstream::target::{HostRule, UpstreamError, resolve_target};

const MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/metadata/request", post(proxy_request))
        .route("/metadata/image", get(proxy_image))
        .layer(Extension(Arc::new(Limiters::from_policies())))
}

#[derive(Deserialize)]
pub struct ProxyRequest {
    source: Option<String>,
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Serialize)]
pub struct ProxyResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn upstream_error(error: UpstreamError) -> ApiError {
    match error {
        UpstreamError::Forbidden(reason) => {
            ApiError::new(StatusCode::FORBIDDEN, "upstream_forbidden", reason)
        }
        UpstreamError::Unreachable(reason) => {
            ApiError::new(StatusCode::BAD_GATEWAY, "upstream_unreachable", reason)
        }
        UpstreamError::TooLarge => ApiError::new(
            StatusCode::BAD_GATEWAY,
            "upstream_too_large",
            "upstream response too large",
        ),
    }
}

fn parse_retry_after(response: &UpstreamResponse) -> Option<Duration> {
    let raw = response
        .headers
        .iter()
        .find(|(name, _)| name == "retry-after")
        .map(|(_, value)| value.as_str())?;
    raw.trim()
        .parse::<u64>()
        .ok()
        .map(Duration::from_secs)
        .or_else(|| {
            httpdate::parse_http_date(raw)
                .ok()
                .and_then(|at| at.duration_since(std::time::SystemTime::now()).ok())
        })
}

async fn proxy_request(
    _user: AuthUser,
    State(state): State<AppState>,
    Extension(limiters): Extension<Arc<Limiters>>,
    Json(request): Json<ProxyRequest>,
) -> Result<Json<ProxyResponse>, ApiError> {
    let method = match request.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "PUT" => reqwest::Method::PUT,
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "method_not_allowed",
                "unsupported method",
            ));
        }
    };

    let target = resolve_target(&request.url, &state.config, HostRule::MetadataApi)
        .await
        .map_err(upstream_error)?;
    let policy = target
        .policy
        .expect("MetadataApi targets always have a policy");
    if let Some(source) = &request.source
        && source != policy.source
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "upstream_forbidden",
            "source does not match host",
        ));
    }

    let upstream_request = UpstreamRequest {
        method,
        headers: request.headers.into_iter().collect(),
        body: request.body,
    };
    let limiter = limiters.for_source(policy.source);
    let mut attempt = 0;

    loop {
        limiter.acquire().await;
        let response = fetch_bytes(
            &target,
            &state.config,
            upstream_request.clone(),
            MAX_METADATA_BYTES,
        )
        .await
        .map_err(upstream_error)?;

        if response.status == 429 && policy.default_backoff_ms > 0 {
            limiter.record_429(
                parse_retry_after(&response),
                Duration::from_millis(policy.default_backoff_ms),
                Duration::from_millis(policy.max_backoff_ms),
            );
            if attempt < policy.max_429_retries {
                attempt += 1;
                continue;
            }
        } else if (200..300).contains(&response.status) {
            limiter.record_success();
        }

        return Ok(Json(ProxyResponse {
            status: response.status,
            headers: response.headers,
            body: String::from_utf8_lossy(&response.body).into_owned(),
        }));
    }
}

#[derive(Deserialize)]
pub struct ImageQuery {
    url: String,
}

async fn proxy_image(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ImageQuery>,
) -> Result<Response, ApiError> {
    let target = resolve_target(&query.url, &state.config, HostRule::Image)
        .await
        .map_err(upstream_error)?;
    let response = fetch_bytes(
        &target,
        &state.config,
        UpstreamRequest::get(),
        MAX_IMAGE_BYTES,
    )
    .await
    .map_err(upstream_error)?;

    if !(200..300).contains(&response.status) {
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "upstream_status",
            format!("HTTP {}", response.status),
        ));
    }

    let kind = sniff(&response.body).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "not_image",
            "upstream did not return an image",
        )
    })?;
    let mut http_response = response.body.into_response();
    let headers = http_response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind.mime()));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=86400"),
    );
    Ok(http_response)
}
