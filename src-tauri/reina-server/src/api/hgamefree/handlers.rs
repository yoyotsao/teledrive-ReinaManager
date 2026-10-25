use axum::extract::{Query, State};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::api::auth::AuthUser;
use crate::app::AppState;
use crate::error::ApiError;
use crate::hgamefree::index::{Hit, META_SYNCED_AT};

const DEFAULT_LIMIT: usize = 8;

pub fn routes() -> Router<AppState> {
    Router::new().route("/hgamefree/search", get(search))
}

#[derive(Deserialize)]
struct SearchQuery {
    q: Option<String>,
    id: Option<i64>,
    /// 逗号分隔的外部作品 ID，如 `steam:3329430,getchu:1065742`
    ext: Option<String>,
    limit: Option<usize>,
}

#[derive(Serialize)]
struct SearchResponse {
    /// 第一次同步完成前为 false，前端此时改用站台的即时搜索。
    ready: bool,
    total: i64,
    items: Vec<Item>,
}

#[derive(Serialize)]
struct Item {
    id: String,
    /// 原始标题，尚未去掉 `[大小]`、`官方中文` 等标记
    title: String,
    image: Option<String>,
    file_names: Vec<String>,
    file_url: Vec<String>,
    external_ids: Vec<String>,
}

impl From<Hit> for Item {
    fn from(hit: Hit) -> Self {
        Self {
            id: hit.id.to_string(),
            title: hit.title,
            image: hit.image_url,
            file_names: hit.file_names,
            file_url: hit.file_url,
            external_ids: hit.external_ids,
        }
    }
}

/// `?q=` 依关键字搜索；`?id=` 取单篇；`?ext=` 依外部作品 ID 反查。都没有时回空清单。
async fn search(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<SearchResponse>, ApiError> {
    let index = &state.hgamefree;
    let ready = index.get_meta(META_SYNCED_AT).await?.is_some();
    let total = index.count().await?;

    let hits = if !ready {
        Vec::new()
    } else if let Some(id) = query.id {
        index.get(id).await?.into_iter().collect()
    } else if let Some(ext) = query.ext.as_deref() {
        let ids: Vec<String> = ext
            .split(',')
            .map(str::trim)
            .filter(|id| !id.is_empty())
            .map(str::to_string)
            .collect();
        index.find_by_external(&ids).await?
    } else if let Some(text) = query.q.as_deref() {
        index
            .search(text, query.limit.unwrap_or(DEFAULT_LIMIT))
            .await?
    } else {
        Vec::new()
    };

    Ok(Json(SearchResponse {
        ready,
        total,
        items: hits.into_iter().map(Item::from).collect(),
    }))
}
