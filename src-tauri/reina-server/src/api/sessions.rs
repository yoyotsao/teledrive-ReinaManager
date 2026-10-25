//! 接受 bridge 的持久化游玩记录，并与统计投影和全局版本一起提交。

use axum::Json;
use axum::extract::{State, rejection::JsonRejection};
use reina_core::database::dto::BridgeSessionInput;
use reina_core::database::repository::game_stats_repository::{
    BridgeSessionError, insert_bridge_session_in_connection,
};
use serde::Serialize;

use crate::api::auth::AuthUser;
use crate::app::AppState;
use crate::error::ApiError;
use crate::tx;

#[derive(Serialize)]
pub struct SessionResponse {
    accepted: bool,
}

pub async fn create_session(
    user: AuthUser,
    State(state): State<AppState>,
    payload: Result<Json<BridgeSessionInput>, JsonRejection>,
) -> Result<Json<SessionResponse>, ApiError> {
    let Json(input) = payload.map_err(|rejection| ApiError::bad_request(rejection.body_text()))?;
    let transaction = tx::begin(user.store.db()).await?;
    let result = insert_bridge_session_in_connection(&transaction, input)
        .await
        .map_err(|error| match error {
            BridgeSessionError::InvalidInput(message) => ApiError::bad_request(message),
            BridgeSessionError::GameNotFound => ApiError::not_found("游戏不存在"),
            BridgeSessionError::Database(error) => ApiError::from(error),
        });
    let accepted = tx::finish(&state, transaction, result, |accepted| *accepted).await?;
    Ok(Json(SessionResponse { accepted }))
}
