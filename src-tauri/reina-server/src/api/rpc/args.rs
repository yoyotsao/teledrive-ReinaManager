//! 各 command 的参数。字段名称沿用前端 invoke 传送的 camelCase，
//! 与 Tauri 对 command 参数的默认转换相同；嵌套 DTO 仍用各自的 serde 设定。

use reina_core::database::dto::{InsertGameData, UpdateGameData, UpdateSettingsData};
use reina_core::database::repository::collections_repository::CollectionBackendSortField;
use reina_core::database::repository::games_repository::{GameType, SortOption, SortOrder};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::ApiError;

pub fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args)
        .map_err(|error| ApiError::bad_request(format!("参数格式错误: {error}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Empty {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdsArgs {
    pub ids: Vec<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameIdArgs {
    pub game_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameListArgs {
    pub game_type: GameType,
    pub sort_option: SortOption,
    pub sort_order: SortOrder,
    pub language: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArgs {
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSessionsArgs {
    pub game_id: i32,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSessionsArgs {
    pub game_ids: Vec<i32>,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionArgs {
    pub game_ids: Vec<i32>,
    pub start_date: String,
    pub end_date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionIdArgs {
    pub collection_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupIdArgs {
    pub group_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSortArgs {
    pub sort_field: Option<CollectionBackendSortField>,
    pub sort_order: Option<SortOrder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSortArgs {
    pub group_id: i32,
    pub sort_field: Option<CollectionBackendSortField>,
    pub sort_order: Option<SortOrder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertGameArgs {
    pub game: InsertGameData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertGamesArgs {
    pub games: Vec<InsertGameData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGameArgs {
    pub game_id: i32,
    pub updates: UpdateGameData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGamesArgs {
    pub updates: Vec<(i32, UpdateGameData)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualSessionArgs {
    pub game_id: i32,
    pub start_time: i32,
    pub duration: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdArgs {
    pub session_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsArgs {
    pub data: UpdateSettingsData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCollectionArgs {
    pub name: String,
    pub parent_id: Option<i32>,
    pub sort_order: i32,
    pub icon: Option<String>,
}

/// 与桌面版相同：`parentId: null` 反序列化成 `None`（不修改），不是 `Some(None)`
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCollectionArgs {
    pub id: i32,
    pub name: Option<String>,
    pub parent_id: Option<Option<i32>>,
    pub sort_order: Option<i32>,
    pub icon: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamesInCollectionArgs {
    pub game_ids: Vec<i32>,
    pub collection_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamesToCollectionsArgs {
    pub game_ids: Vec<i32>,
    pub collection_ids: Vec<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCollectionsArgs {
    pub game_id: i32,
    pub collection_ids: Vec<i32>,
}
