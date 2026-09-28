//! `GET/PUT/DELETE /game/api/covers/{game_id}`、`POST /game/api/covers/{game_id}/source`。

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use reina_core::database::repository::games_repository::GamesRepository;

use crate::api::auth::AuthUser;
use crate::api::covers::sniff::{ImageKind, sniff};
use crate::api::covers::store::{CoverStore, StagedCover};
use crate::app::AppState;
use crate::error::ApiError;
use crate::tx;
use crate::upstream::fetch::{UpstreamRequest, fetch_bytes};
use crate::upstream::policy::{BANGUMI_IMAGE_PROXY_PREFIX, VNDB_IMAGE_PROXY_PREFIX};
use crate::upstream::target::{HostRule, resolve_target};

pub const MAX_COVER_BYTES: usize = 10 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/covers/{game_id}",
            get(get_cover)
                .put(put_custom_cover)
                .delete(delete_custom_cover),
        )
        .route("/covers/{game_id}/source", post(set_source_cover))
        // 多留一点给 HTTP 框架本身，实际上限在 handler 内精确判断
        .layer(DefaultBodyLimit::max(MAX_COVER_BYTES + 1))
}

pub fn cover_store(state: &AppState) -> CoverStore {
    CoverStore::new(state.config.data_dir.join("covers"))
}

#[derive(Deserialize)]
pub struct VersionQuery {
    v: Option<String>,
}

#[derive(Serialize)]
pub struct CoverVersionResponse {
    cover_version: Option<String>,
    has_custom_cover: bool,
}

async fn get_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
    Query(query): Query<VersionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let cover = GamesRepository::find_cover_state(&state.db, game_id)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "game_not_found", "game not found"))?;
    let Some(current) = cover.current() else {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "cover_not_found",
            "game has no cover",
        ));
    };
    if query.v.as_deref() != Some(current) {
        let location = format!("/game/api/covers/{game_id}?v={current}");
        return Ok((
            StatusCode::FOUND,
            [
                (header::LOCATION, location),
                (header::CACHE_CONTROL, "no-store".to_string()),
            ],
        )
            .into_response());
    }
    let etag = format!("\"{current}\"");
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|v| v.to_str().ok())
        == Some(etag.as_str())
    {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    let (bytes, kind) = cover_store(&state)
        .open(game_id, current)
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cover_read_failed",
                error.to_string(),
            )
        })?
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::NOT_FOUND,
                "cover_file_missing",
                "cover file missing",
            )
        })?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind.mime()));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, max-age=31536000, immutable"),
    );
    headers.insert(
        header::ETAG,
        HeaderValue::from_str(&etag).expect("hex etag"),
    );
    Ok(response)
}

/// 把已写好的文件切换成游戏的封面：数据库更新与版本递增在同一个 transaction。
/// commit 失败就删掉本次新建的文件；commit 成功才清理已不被引用的旧文件。
async fn commit_cover_change(
    state: &AppState,
    game_id: i32,
    staged: Option<StagedCover>,
    source: Option<Option<String>>,
    custom: Option<Option<String>>,
) -> Result<CoverVersionResponse, ApiError> {
    let store = cover_store(state);
    let result = async {
        let txn = tx::begin(&state.db).await?;
        let changed =
            GamesRepository::set_cover_hashes_in_connection(&txn, game_id, source, custom)
                .await
                .map_err(|error| match error {
                    sea_orm::DbErr::RecordNotFound(_) => {
                        ApiError::new(StatusCode::NOT_FOUND, "game_not_found", "game not found")
                    }
                    other => ApiError::from(other),
                });
        // 封面有变更就递增 data_version，让其他设备换成新的封面网址
        tx::finish(state, txn, changed, |_| true).await
    }
    .await;
    match result {
        Ok(cover_version) => {
            let state_after = GamesRepository::find_cover_state(&state.db, game_id)
                .await?
                .ok_or_else(|| {
                    ApiError::new(StatusCode::NOT_FOUND, "game_not_found", "game not found")
                })?;
            let keep: Vec<&str> = [
                state_after.source_hash.as_deref(),
                state_after.custom_hash.as_deref(),
            ]
            .into_iter()
            .flatten()
            .collect();
            let has_custom_cover = state_after.custom_hash.is_some();
            store.retain_only(game_id, &keep).await;
            Ok(CoverVersionResponse {
                cover_version,
                has_custom_cover,
            })
        }
        Err(error) => {
            if let Some(staged) = staged {
                store.discard(game_id, &staged).await;
            }
            Err(error)
        }
    }
}

async fn stage_image(
    state: &AppState,
    game_id: i32,
    bytes: &[u8],
) -> Result<StagedCover, ApiError> {
    if bytes.len() > MAX_COVER_BYTES {
        return Err(ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "cover_too_large",
            "cover exceeds 10 MiB",
        ));
    }
    let kind: ImageKind = sniff(bytes).ok_or_else(|| {
        ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "cover_not_image",
            "unsupported image",
        )
    })?;
    if GamesRepository::find_cover_state(&state.db, game_id)
        .await?
        .is_none()
    {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "game_not_found",
            "game not found",
        ));
    }
    cover_store(state)
        .put(game_id, bytes, kind)
        .await
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "cover_write_failed",
                error.to_string(),
            )
        })
}

async fn put_custom_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
    body: Bytes,
) -> Result<Json<CoverVersionResponse>, ApiError> {
    // 写档到清理整段持锁，见 CoverStore::lock_game
    let _guard = cover_store(&state).lock_game(game_id).await;
    let staged = stage_image(&state, game_id, &body).await?;
    let hash = staged.hash.clone();
    Ok(Json(
        commit_cover_change(&state, game_id, Some(staged), None, Some(Some(hash))).await?,
    ))
}

async fn delete_custom_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
) -> Result<Json<CoverVersionResponse>, ApiError> {
    let _guard = cover_store(&state).lock_game(game_id).await;
    Ok(Json(
        commit_cover_change(&state, game_id, None, None, Some(None)).await?,
    ))
}

#[derive(Deserialize)]
pub struct SourceCoverBody {
    url: Option<String>,
}

/// 依桌面版 `build_cover_download_candidates` 的顺序：Bangumi 先走代理、VNDB 先走原址。
fn download_candidates(url: &str) -> Vec<String> {
    let host = url::Url::parse(url)
        .ok()
        .and_then(|u| u.host_str().map(str::to_string));
    match host.as_deref() {
        Some("lain.bgm.tv") => vec![
            format!("{BANGUMI_IMAGE_PROXY_PREFIX}{url}"),
            url.to_string(),
        ],
        Some("t.vndb.org") => vec![url.to_string(), format!("{VNDB_IMAGE_PROXY_PREFIX}{url}")],
        _ => vec![url.to_string()],
    }
}

async fn set_source_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
    Json(body): Json<SourceCoverBody>,
) -> Result<Json<CoverVersionResponse>, ApiError> {
    let Some(url) = body.url.filter(|u| !u.trim().is_empty()) else {
        let _guard = cover_store(&state).lock_game(game_id).await;
        return Ok(Json(
            commit_cover_change(&state, game_id, None, Some(None), None).await?,
        ));
    };
    // 网络下载在写入 transaction 之外完成，不占用 SQLite 的写锁
    let mut last_error = None;
    for candidate in download_candidates(&url) {
        let target = match resolve_target(&candidate, &state.config, HostRule::Image).await {
            Ok(target) => target,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        match fetch_bytes(
            &target,
            &state.config,
            UpstreamRequest::get(),
            MAX_COVER_BYTES,
        )
        .await
        {
            Ok(response) if (200..300).contains(&response.status) => {
                // 下载在锁外完成（可能很慢），只有写档到清理这一段持锁
                let _guard = cover_store(&state).lock_game(game_id).await;
                let staged = stage_image(&state, game_id, &response.body).await?;
                let hash = staged.hash.clone();
                return Ok(Json(
                    commit_cover_change(&state, game_id, Some(staged), Some(Some(hash)), None)
                        .await?,
                ));
            }
            Ok(response) => last_error = Some(format!("HTTP {}", response.status)),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(ApiError::new(
        StatusCode::BAD_GATEWAY,
        "cover_download_failed",
        last_error.unwrap_or_else(|| "no candidate".into()),
    ))
}
