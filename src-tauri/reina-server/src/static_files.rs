//! `/game/` 前端静态文件与 SPA 深层路由回退。

use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::app::AppState;
use crate::error::ApiError;

const ASSET_CACHE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

pub async fn serve_index(State(state): State<AppState>, request: Request) -> Response {
    serve_relative(&state, "", request).await
}

pub async fn serve_path(
    State(state): State<AppState>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    serve_relative(&state, &path, request).await
}

async fn serve_relative(state: &AppState, relative: &str, request: Request) -> Response {
    // 防呆：API 路径一律不回前端页面（正常情况由 /game/api 的 fallback 处理）
    if relative == "api" || relative.starts_with("api/") {
        return ApiError::not_found("找不到这个 API").into_response();
    }
    let Some(safe) = sanitize(relative) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let root = &state.config.static_dir;
    if !safe.as_os_str().is_empty() {
        let candidate = root.join(&safe);
        let is_file = tokio::fs::metadata(&candidate)
            .await
            .map(|meta| meta.is_file())
            .unwrap_or(false);
        if is_file {
            let cache = if safe.starts_with("assets") {
                ASSET_CACHE
            } else {
                NO_CACHE
            };
            return serve_file(candidate, request, cache).await;
        }
        // 看起来像文件（最后一段有扩展名）却不存在：回 404，避免把 index.html 当成 JS 加载
        if has_extension(&safe) {
            return StatusCode::NOT_FOUND.into_response();
        }
    }

    // 其余都是前端路由，交给 React Router
    serve_file(root.join("index.html"), request, NO_CACHE).await
}

/// 只接受一般路径段；`..`、反斜线、磁盘代号一律拒绝。
/// axum 的 Path 已经做过 percent-decoding，所以 `%2e%2e` 也会在这里被挡下。
fn sanitize(relative: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for segment in relative.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            s if s.contains('\\') || s.contains(':') || s.contains('\0') => return None,
            s => out.push(s),
        }
    }
    Some(out)
}

fn has_extension(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains('.'))
}

async fn serve_file(path: PathBuf, request: Request, cache: &'static str) -> Response {
    let response = match ServeFile::new(path).oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    let mut response = response.map(Body::new);
    if response.status().is_success() {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    }
    response
}
