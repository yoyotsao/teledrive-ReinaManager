use std::collections::BTreeMap;

use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use sea_orm::{DatabaseTransaction, SqlErr, TransactionTrait};
use serde::{Deserialize, Serialize};

use reina_core::database::dto::InsertGameData;
use reina_core::database::repository::games_repository::{GamesRepository, ScanPendingRow};

use crate::api::auth::AuthUser;
use crate::api::scan::naming::{ListingRow, derive_game_names, derive_game_sizes, rows_for_game};
use crate::api::scan::teledrive::{TeleDriveClient, TeleDriveError};
use crate::app::AppState;
use crate::error::ApiError;
use crate::tx;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/scan", post(scan))
        .route("/scan/pending", get(pending))
        .route("/scan/sizes", get(sizes))
        .route("/scan/cloud-trash", post(cloud_trash))
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

/// 用使用者自己的 token 讀 TeleDrive 遊戲資料夾的完整列表。
async fn list_game_rows(state: &AppState, user: &AuthUser) -> Result<Vec<ListingRow>, ApiError> {
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
    client
        .list_children(&game_folder)
        .await
        .map_err(teledrive_error)
}

async fn scan(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<ScanResponse>, ApiError> {
    // TeleDrive 列表要在寫入 transaction 之外讀完，避免網路等待期間占住 SQLite 寫鎖。
    let rows = list_game_rows(&state, &user).await?;
    let names = derive_game_names(&rows);
    let paths: Vec<String> = names
        .iter()
        .map(|name| format!("{}/{name}", state.config.game_folder))
        .collect();

    let txn = tx::begin(user.store.db()).await?;
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

async fn pending(user: AuthUser) -> Result<Json<Vec<ScanPendingRow>>, ApiError> {
    Ok(Json(
        GamesRepository::find_scan_pending(user.store.db()).await?,
    ))
}

/// 各遊戲 zip 的大小，鍵為 `teledrive_path`。資料夾型遊戲沒有單一大小，不回傳。
async fn sizes(
    user: AuthUser,
    State(state): State<AppState>,
) -> Result<Json<BTreeMap<String, u64>>, ApiError> {
    let rows = list_game_rows(&state, &user).await?;
    Ok(Json(
        derive_game_sizes(&rows)
            .into_iter()
            .map(|(name, size)| (format!("{}/{name}", state.config.game_folder), size))
            .collect(),
    ))
}

#[derive(Deserialize)]
struct CloudTrashRequest {
    game_ids: Vec<i32>,
}

#[derive(Serialize)]
struct CloudTrashResponse {
    /// 實際移到垃圾桶的項目數（沒有雲端來源的遊戲不計）。
    trashed: usize,
}

/// 把遊戲對應的 TeleDrive 檔案移到垃圾桶。要在刪除遊戲之前呼叫：
/// 先移走雲端檔案、再刪資料庫紀錄，中途失敗時使用者還能重試。
async fn cloud_trash(
    user: AuthUser,
    State(state): State<AppState>,
    Json(request): Json<CloudTrashRequest>,
) -> Result<Json<CloudTrashResponse>, ApiError> {
    let prefix = format!("{}/", state.config.game_folder);
    let mut names = Vec::new();
    for id in request.game_ids {
        let game = GamesRepository::find_by_id(user.store.db(), id).await?;
        // 只處理掃描建立、位於 game 資料夾底下的路徑，避免任意路徑被帶入
        if let Some(name) = game
            .and_then(|game| game.teledrive_path)
            .and_then(|path| path.strip_prefix(&prefix).map(str::to_string))
            .filter(|name| !name.is_empty() && !name.contains('/'))
        {
            names.push(name);
        }
    }
    if names.is_empty() {
        return Ok(Json(CloudTrashResponse { trashed: 0 }));
    }

    let rows = list_game_rows(&state, &user).await?;
    let base = url::Url::parse(&state.config.teledrive_api)
        .map_err(|error| ApiError::internal(format!("TELEDRIVE_API 不是合法網址: {error}")))?;
    let client = TeleDriveClient::new(state.http.clone(), base, user.token.clone());
    let mut trashed = 0;
    for name in &names {
        for row in rows_for_game(&rows, name) {
            client.trash(&row.file_id).await.map_err(teledrive_error)?;
            trashed += 1;
        }
    }
    Ok(Json(CloudTrashResponse { trashed }))
}
