//! 对单一 Target 发出请求。转址最多 3 次，而且只允许同一个 host；
//! 超过大小上限就中止；请求头只会带调用端明确交进来的内容。

use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Method, redirect};

use crate::config::Config;
pub use crate::upstream::target::{HostRule, UpstreamError};
use crate::upstream::target::{Target, resolve_target};

/// 允许转送给上游的请求头（小写）。其他一律丢弃，
/// 尤其是浏览器送给我们的 TeleDrive Authorization——它从来不会进到这里。
const FORWARDED_HEADERS: &[&str] = &[
    "accept",
    "accept-language",
    "authorization",
    "content-type",
    "cookie",
    "user-agent",
    "version",
    "referer",
    "x-requested-with",
];
const MAX_REDIRECTS: usize = 3;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct UpstreamRequest {
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl UpstreamRequest {
    pub fn get() -> Self {
        Self {
            method: Method::GET,
            headers: Vec::new(),
            body: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct UpstreamResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn client_for(target: &Target) -> Result<reqwest::Client, UpstreamError> {
    let mut builder = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(UPSTREAM_TIMEOUT)
        .user_agent(concat!("ReinaManager-Server/", env!("CARGO_PKG_VERSION")));
    if let Some(addrs) = &target.pinned {
        builder = builder.resolve_to_addrs(&target.host, addrs);
    }
    builder
        .build()
        .map_err(|error| UpstreamError::Unreachable(error.to_string()))
}

pub async fn fetch_bytes(
    target: &Target,
    config: &Config,
    request: UpstreamRequest,
    max_bytes: usize,
) -> Result<UpstreamResponse, UpstreamError> {
    let mut current = target.clone();
    for _ in 0..=MAX_REDIRECTS {
        let client = client_for(&current)?;
        let mut builder = client.request(request.method.clone(), current.request_url.clone());
        for (name, value) in &request.headers {
            let name = name.to_ascii_lowercase();
            if FORWARDED_HEADERS.contains(&name.as_str()) {
                builder = builder.header(name, value);
            }
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder
            .send()
            .await
            .map_err(|error| UpstreamError::Unreachable(error.to_string()))?;
        let status = response.status();
        if status.is_redirection()
            && let Some(location) = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
        {
            // 以原始（未覆写）的网址为基准解析相对转址，再重新验证
            let original = original_url(&current);
            let next = original
                .join(location)
                .map_err(|_| UpstreamError::Forbidden("bad redirect".into()))?;
            if next.host_str().map(|h| h.to_ascii_lowercase()) != Some(current.host.clone()) {
                return Err(UpstreamError::Forbidden("cross-host redirect".into()));
            }
            let rule = if current.policy.is_some() {
                HostRule::MetadataApi
            } else {
                HostRule::Image
            };
            current = resolve_target(next.as_str(), config, rule).await?;
            continue;
        }
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| *name != reqwest::header::SET_COOKIE)
            .filter_map(|(name, value)| {
                value
                    .to_str()
                    .ok()
                    .map(|v| (name.as_str().to_string(), v.to_string()))
            })
            .collect();
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| UpstreamError::Unreachable(error.to_string()))?;
            if body.len() + chunk.len() > max_bytes {
                return Err(UpstreamError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(UpstreamResponse {
            status: status.as_u16(),
            headers,
            body,
        });
    }
    Err(UpstreamError::Forbidden("too many redirects".into()))
}

fn original_url(target: &Target) -> url::Url {
    let mut url = target.request_url.clone();
    if target.pinned.is_none() {
        // 测试覆写：把 host 换回原本的名称，让相对转址的 host 比对有意义
        let _ = url.set_host(Some(&target.host));
        let _ = url.set_scheme("https");
        let _ = url.set_port(None);
    }
    url
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Router, http::HeaderMap, routing::get};
    use std::sync::{Arc, Mutex};

    async fn spawn(router: Router) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        addr
    }

    fn config_with(host: &str, addr: std::net::SocketAddr) -> crate::config::Config {
        let mut config = crate::config::Config::for_tests();
        config.upstream_overrides.insert(host.into(), addr);
        config
    }

    #[tokio::test]
    async fn 只转送指定标头() {
        let seen: Arc<Mutex<Option<HeaderMap>>> = Arc::default();
        let seen2 = seen.clone();
        let addr = spawn(Router::new().route(
            "/kana/vn",
            get(move |headers: HeaderMap| {
                *seen2.lock().unwrap() = Some(headers);
                async { "ok" }
            }),
        ))
        .await;
        let config = config_with("api.vndb.org", addr);
        let target = crate::upstream::target::resolve_target(
            "https://api.vndb.org/kana/vn",
            &config,
            HostRule::MetadataApi,
        )
        .await
        .unwrap();
        let request = UpstreamRequest {
            method: reqwest::Method::GET,
            headers: vec![
                ("accept".into(), "application/json".into()),
                ("x-forwarded-for".into(), "1.2.3.4".into()),
            ],
            body: None,
        };
        let response = fetch_bytes(&target, &config, request, 1024).await.unwrap();
        assert_eq!(response.status, 200);
        let headers = seen.lock().unwrap().clone().unwrap();
        assert_eq!(headers.get("accept").unwrap(), "application/json");
        assert!(headers.get("x-forwarded-for").is_none());
        assert!(headers.get("authorization").is_none());
    }

    #[tokio::test]
    async fn 超过上限返回_too_large() {
        let addr = spawn(Router::new().route("/big", get(|| async { vec![b'x'; 2048] }))).await;
        let config = config_with("t.vndb.org", addr);
        let target = crate::upstream::target::resolve_target(
            "https://t.vndb.org/big",
            &config,
            HostRule::Image,
        )
        .await
        .unwrap();
        let result = fetch_bytes(&target, &config, UpstreamRequest::get(), 1024).await;
        assert!(matches!(result, Err(UpstreamError::TooLarge)));
    }

    #[tokio::test]
    async fn 拒绝跨_host_转址_允许同_host_转址() {
        let addr = spawn(
            Router::new()
                .route(
                    "/same",
                    get(|| async { axum::response::Redirect::temporary("/final") }),
                )
                .route("/final", get(|| async { "final" }))
                .route(
                    "/cross",
                    get(|| async {
                        axum::response::Redirect::temporary("https://evil.example.com/x")
                    }),
                ),
        )
        .await;
        let config = config_with("t.vndb.org", addr);
        let same = crate::upstream::target::resolve_target(
            "https://t.vndb.org/same",
            &config,
            HostRule::Image,
        )
        .await
        .unwrap();
        assert_eq!(
            fetch_bytes(&same, &config, UpstreamRequest::get(), 1024)
                .await
                .unwrap()
                .body,
            b"final"
        );
        let cross = crate::upstream::target::resolve_target(
            "https://t.vndb.org/cross",
            &config,
            HostRule::Image,
        )
        .await
        .unwrap();
        assert!(matches!(
            fetch_bytes(&cross, &config, UpstreamRequest::get(), 1024).await,
            Err(UpstreamError::Forbidden(_))
        ));
    }
}
