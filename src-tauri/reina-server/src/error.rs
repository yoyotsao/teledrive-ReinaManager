//! 统一的 API 错误格式：`{ "code": string, "message": string }`。

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

use crate::stores::StoreError;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "登入已失效，请重新登入 TeleDrive",
        )
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_arguments", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "command_failed", message)
    }
}

impl From<sea_orm::DbErr> for ApiError {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::internal(format!("数据库错误: {error}"))
    }
}

impl From<StoreError> for ApiError {
    fn from(error: StoreError) -> Self {
        match error {
            StoreError::InvalidUser => Self::unauthorized(),
            StoreError::LimitReached => Self::new(
                StatusCode::FORBIDDEN,
                "user_limit_reached",
                "ReinaManager 已达使用者人数上限，请联系管理员",
            ),
            StoreError::Open(detail) => {
                // 细节可能含本机路径，只写日志
                log::error!("开启使用者数据失败: {detail}");
                Self::internal("无法开启使用者数据")
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({ "code": self.code, "message": self.message })),
        )
            .into_response();
        // 错误响应不能被浏览器或代理缓存，否则登入恢复后仍会看到旧的 401
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}
