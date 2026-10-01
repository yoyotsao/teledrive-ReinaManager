//! Read command 分派：直接用连接池，不开 transaction。
//! 错误消息前缀沿用 `src-tauri/src/database/service.rs`，前端显示与桌面版一致。

use reina_core::database::repository::collections_repository::{
    CollectionBackendSortField, CollectionsRepository,
};
use reina_core::database::repository::game_stats_repository::GameStatsRepository;
use reina_core::database::repository::games_repository::{GamesRepository, SortOrder};
use reina_core::database::repository::settings_repository::SettingsRepository;
use sea_orm::{DatabaseConnection, DbErr};
use serde::Serialize;
use serde_json::Value;

use super::args::*;
use super::commands::ReadCommand;
use crate::error::ApiError;

pub(super) fn to_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value)
        .map_err(|error| ApiError::internal(format!("序列化结果失败: {error}")))
}

pub(super) fn fail(prefix: &'static str) -> impl FnOnce(DbErr) -> ApiError {
    move |error| ApiError::internal(format!("{prefix}: {error}"))
}

/// 与桌面版 `validate_collection_sort` 相同：排序字段与方向必须同时提供
fn collection_sort(
    sort_field: Option<CollectionBackendSortField>,
    sort_order: Option<SortOrder>,
) -> Result<Option<(CollectionBackendSortField, SortOrder)>, ApiError> {
    match (sort_field, sort_order) {
        (None, None) => Ok(None),
        (Some(field), Some(order)) => Ok(Some((field, order))),
        _ => Err(ApiError::bad_request("排序字段和排序方向必须同时提供")),
    }
}

pub async fn dispatch_read(
    db: &DatabaseConnection,
    command: ReadCommand,
    args: Value,
) -> Result<Value, ApiError> {
    match command {
        ReadCommand::FindGameById => {
            let a: IdArgs = parse(args)?;
            to_json(
                GamesRepository::find_by_id(db, a.id)
                    .await
                    .map_err(fail("查询游戏数据失败"))?,
            )
        }
        ReadCommand::FindAllGames => {
            let a: GameListArgs = parse(args)?;
            to_json(
                GamesRepository::find_all(db, a.game_type, a.sort_option, a.sort_order, a.language)
                    .await
                    .map_err(fail("获取游戏数据失败"))?,
            )
        }
        ReadCommand::FindGameIds => {
            let a: GameListArgs = parse(args)?;
            to_json(
                GamesRepository::find_ids(db, a.game_type, a.sort_option, a.sort_order, a.language)
                    .await
                    .map_err(fail("获取游戏 ID 列表失败"))?,
            )
        }
        ReadCommand::CountGames => {
            let _: Empty = parse(args)?;
            to_json(
                GamesRepository::count(db)
                    .await
                    .map_err(fail("获取游戏总数失败"))?,
            )
        }
        ReadCommand::GetSourceBindings => {
            let a: SourceArgs = parse(args)?;
            to_json(
                GamesRepository::get_source_bindings(db, &a.source)
                    .await
                    .map_err(fail("获取 source ID 列表失败"))?,
            )
        }
        ReadCommand::GetGameSessions => {
            let a: GameSessionsArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_sessions(db, a.game_id, a.limit, a.offset)
                    .await
                    .map_err(fail("获取游戏会话历史失败"))?,
            )
        }
        ReadCommand::GetRecentSessionsForAll => {
            let a: RecentSessionsArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_recent_sessions_for_all(db, a.game_ids, a.limit, a.offset)
                    .await
                    .map_err(fail("获取最近会话失败"))?,
            )
        }
        ReadCommand::GetGameStatistics => {
            let a: GameIdArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_statistics(db, a.game_id)
                    .await
                    .map_err(fail("获取游戏统计失败"))?,
            )
        }
        ReadCommand::GetAllGameStatistics => {
            let _: Empty = parse(args)?;
            to_json(
                GameStatsRepository::get_all_statistics(db)
                    .await
                    .map_err(fail("获取所有游戏统计失败"))?,
            )
        }
        ReadCommand::GetAllGameLastPlayed => {
            let _: Empty = parse(args)?;
            to_json(
                GameStatsRepository::get_all_last_played(db)
                    .await
                    .map_err(fail("获取所有游戏最近游玩时间失败"))?,
            )
        }
        ReadCommand::GetStatisticsDistribution => {
            let a: DistributionArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_statistics_distribution(
                    db,
                    a.game_ids,
                    &a.start_date,
                    &a.end_date,
                )
                .await
                .map_err(fail("获取游玩时段分布失败"))?,
            )
        }
        ReadCommand::GetAllSettings => {
            let _: Empty = parse(args)?;
            to_json(
                SettingsRepository::get_all_settings(db)
                    .await
                    .map_err(fail("获取所有设置失败"))?,
            )
        }
        ReadCommand::FindRootCollections => {
            let _: Empty = parse(args)?;
            to_json(
                CollectionsRepository::find_root_collections(db)
                    .await
                    .map_err(fail("获取根合集失败"))?,
            )
        }
        ReadCommand::GetRootCollectionsWithCount => {
            let a: CollectionSortArgs = parse(args)?;
            let sort = collection_sort(a.sort_field, a.sort_order)?;
            to_json(
                CollectionsRepository::get_root_collections_with_count(db, sort)
                    .await
                    .map_err(fail("获取根分组列表失败"))?,
            )
        }
        ReadCommand::GetGamesInCollection => {
            let a: CollectionIdArgs = parse(args)?;
            to_json(
                CollectionsRepository::get_games_in_collection(db, a.collection_id)
                    .await
                    .map_err(fail("获取合集中的游戏失败"))?,
            )
        }
        ReadCommand::GetGameCollectionIds => {
            let a: GameIdArgs = parse(args)?;
            to_json(
                CollectionsRepository::get_game_collection_ids(db, a.game_id)
                    .await
                    .map_err(fail("获取游戏所在合集失败"))?,
            )
        }
        ReadCommand::CountGamesInGroup => {
            let a: GroupIdArgs = parse(args)?;
            to_json(
                CollectionsRepository::count_games_in_group(db, a.group_id)
                    .await
                    .map_err(fail("获取分组游戏数量失败"))?,
            )
        }
        ReadCommand::GetCategoriesWithCount => {
            let a: GroupSortArgs = parse(args)?;
            let sort = collection_sort(a.sort_field, a.sort_order)?;
            to_json(
                CollectionsRepository::get_categories_with_count(db, a.group_id, sort)
                    .await
                    .map_err(fail("获取分类列表失败"))?,
            )
        }
    }
}
