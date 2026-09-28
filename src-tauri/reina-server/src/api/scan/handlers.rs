use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use sea_orm::{DatabaseTransaction, SqlErr, TransactionTrait};
use serde::Serialize;

use reina_core::database::dto::InsertGameData;
use reina_core::database::repository::games_repository::{GamesRepository, ScanPendingRow};

use crate::api::auth::AuthUser;
use crate::api::scan::naming::derive_game_names;
use crate::api::scan::teledrive::{TeleDriveClient, TeleDriveError};
use crate::app::AppState;
use crate::error::ApiError;
use crate::tx;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/scan", post(scan))
        .route("/scan/pending", get(pending))
}

#[derive(Serialize)]
pub struct ScanResponse {
    added_ids: Vec<i32>,
    pending_ids: Vec<i32>,
}

fn teledrive_error(error: TeleDriveError) -> ApiError {
    match error {
        TeleDriveError::Unauthorized => ApiError::new(
            StatusCode::UNAUTHORIZED,
            "teledrive_unauthorized",
            "TeleDrive rejected the token",
        ),
        TeleDriveError::Unavailable(reason) => {
            ApiError::new(StatusCode::BAD_GATEWAY, "teledrive_unavailable", reason)
        }
    }
}

async fn scan(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<ScanResponse>, ApiError> {
    // TeleDrive 列表要在寫入 transaction 之外讀完，避免網路等待期間占住 SQLite 寫鎖。
    let base = url::Url::parse(&state.config.teledrive_api)
        .map_err(|error| ApiError::internal(format!("TELEDRIVE_API 不是合法網址: {error}")))?;
    let client = TeleDriveClient::new(state.http.clone(), base, user.token.clone());
    let game_folder = client
        .find_game_folder(&state.config.game_folder)
        .await
        .map_err(teledrive_error)?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "game_folder_missing",
                "TeleDrive has no game folder",
            )
        })?;
    let rows = client
        .list_children(&game_folder)
        .await
        .map_err(teledrive_error)?;
    let names = derive_game_names(&rows);
    let paths: Vec<String> = names
        .iter()
        .map(|name| format!("{}/{name}", state.config.game_folder))
        .collect();

    let txn = tx::begin(&state.db).await?;
    let result = insert_missing(&txn, &names, &paths).await;
    let response = tx::finish(&state, txn, result, |response: &ScanResponse| {
        !response.added_ids.is_empty()
    })
    .await?;
    Ok(Json(response))
}

async fn insert_missing(
    txn: &DatabaseTransaction,
    names: &[String],
    paths: &[String],
) -> Result<ScanResponse, ApiError> {
    let existing = GamesRepository::find_ids_by_teledrive_paths(txn, paths).await?;
    let mut added_ids = Vec::new();

    for (name, path) in names.iter().zip(paths.iter()) {
        if existing.contains_key(path) {
            continue;
        }

        // 每筆一個 savepoint。若未來改為多 SQLite 連線，並行掃描撞唯一索引時也只略過該筆。
        let savepoint = txn.begin().await?;
        match GamesRepository::insert_in_connection(
            &savepoint,
            InsertGameData::cloud_placeholder(name, Some(path.clone())),
        )
        .await
        {
            Ok(game) => {
                savepoint.commit().await?;
                added_ids.push(game.id);
            }
            Err(error) if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) => {
                savepoint.rollback().await?;
            }
            Err(error) => return Err(ApiError::from(error)),
        }
    }

    let pending_ids = GamesRepository::find_scan_pending(txn)
        .await?
        .into_iter()
        .map(|row| row.id)
        .collect();

    Ok(ScanResponse {
        added_ids,
        pending_ids,
    })
}

async fn pending(
    _user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<Vec<ScanPendingRow>>, ApiError> {
    Ok(Json(GamesRepository::find_scan_pending(&state.db).await?))
}
