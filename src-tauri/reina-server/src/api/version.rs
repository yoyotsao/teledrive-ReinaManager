//! `GET /game/api/version`：跨设备同步用的全局数据版本。

use axum::Json;
use axum::http::header::CACHE_CONTROL;
use axum::response::IntoResponse;
use reina_core::database::repository::version_repository::VersionRepository;
use serde_json::json;

use crate::api::auth::AuthUser;
use crate::error::ApiError;

pub async fn get_version(user: AuthUser) -> Result<impl IntoResponse, ApiError> {
    let data_version = VersionRepository::get(user.store.db()).await?;
    Ok((
        [(CACHE_CONTROL, "no-store")],
        Json(json!({ "data_version": data_version })),
    ))
}
