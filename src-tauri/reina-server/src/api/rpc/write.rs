//! Write command 分派：一律在调用端传入的 transaction 里执行，
//! 不能自行 begin/commit，否则 data_version 无法和业务数据一起 commit。

use reina_core::database::dto::{InsertCollectionData, UpdateCollectionData};
use reina_core::database::repository::collections_repository::CollectionsRepository;
use reina_core::database::repository::game_stats_repository::GameStatsRepository;
use reina_core::database::repository::games_repository::GamesRepository;
use reina_core::database::repository::settings_repository::SettingsRepository;
use sea_orm::DatabaseTransaction;
use serde_json::Value;

use super::args::*;
use super::commands::WriteCommand;
use super::read::{fail, to_json};
use crate::error::ApiError;

pub async fn dispatch_write(
    txn: &DatabaseTransaction,
    command: WriteCommand,
    args: Value,
) -> Result<Value, ApiError> {
    match command {
        WriteCommand::InsertGame => {
            let a: InsertGameArgs = parse(args)?;
            to_json(
                GamesRepository::insert_in_connection(txn, a.game)
                    .await
                    .map_err(fail("插入游戏数据失败"))?,
            )
        }
        WriteCommand::InsertGamesBatch => {
            let a: InsertGamesArgs = parse(args)?;
            // 批次结果本身记录每笔成败（savepoint），外层仍视为成功
            to_json(GamesRepository::insert_batch_in_connection(txn, a.games).await)
        }
        WriteCommand::UpdateGame => {
            let a: UpdateGameArgs = parse(args)?;
            to_json(
                GamesRepository::update_in_connection(txn, a.game_id, a.updates)
                    .await
                    .map_err(fail("更新游戏数据失败"))?,
            )
        }
        WriteCommand::UpdateGamesBatch => {
            let a: UpdateGamesArgs = parse(args)?;
            to_json(
                GamesRepository::update_batch_in_connection(txn, a.updates)
                    .await
                    .map_err(fail("批量更新数据失败"))?,
            )
        }
        WriteCommand::DeleteGame => {
            let a: IdArgs = parse(args)?;
            to_json(
                GamesRepository::delete(txn, a.id)
                    .await
                    .map_err(fail("删除游戏失败"))?
                    .rows_affected,
            )
        }
        WriteCommand::DeleteGamesBatch => {
            let a: IdsArgs = parse(args)?;
            to_json(
                GamesRepository::delete_many(txn, a.ids)
                    .await
                    .map_err(fail("批量删除游戏失败"))?
                    .rows_affected,
            )
        }
        WriteCommand::CreateManualGameSession => {
            let a: ManualSessionArgs = parse(args)?;
            to_json(
                GameStatsRepository::create_manual_session_in_connection(
                    txn,
                    a.game_id,
                    a.start_time,
                    a.duration,
                )
                .await
                .map_err(fail("创建游戏会话失败"))?
                .session_id,
            )
        }
        WriteCommand::DeleteGameSession => {
            let a: SessionIdArgs = parse(args)?;
            to_json(
                GameStatsRepository::delete_session_with_statistics_in_connection(
                    txn,
                    a.session_id,
                )
                .await
                .map_err(fail("删除游戏会话失败"))?,
            )
        }
        WriteCommand::UpdateSettings => {
            let a: SettingsArgs = parse(args)?;
            to_json(
                SettingsRepository::update_settings(txn, a.data.cleaned())
                    .await
                    .map_err(fail("更新设置失败"))?,
            )
        }
        WriteCommand::CreateCollection => {
            let a: CreateCollectionArgs = parse(args)?;
            let data = InsertCollectionData {
                name: a.name,
                parent_id: a.parent_id,
                sort_order: a.sort_order,
                icon: a.icon,
            }
            .cleaned();
            to_json(
                CollectionsRepository::create(txn, data)
                    .await
                    .map_err(fail("创建合集失败"))?,
            )
        }
        WriteCommand::UpdateCollection => {
            let a: UpdateCollectionArgs = parse(args)?;
            let data = UpdateCollectionData {
                name: a.name,
                parent_id: a.parent_id,
                sort_order: a.sort_order,
                icon: a.icon,
            }
            .cleaned();
            to_json(
                CollectionsRepository::update(txn, a.id, data)
                    .await
                    .map_err(fail("更新合集失败"))?,
            )
        }
        WriteCommand::DeleteCollection => {
            let a: IdArgs = parse(args)?;
            to_json(
                CollectionsRepository::delete(txn, a.id)
                    .await
                    .map_err(fail("删除合集失败"))?
                    .rows_affected,
            )
        }
        WriteCommand::RemoveGamesFromCollection => {
            let a: GamesInCollectionArgs = parse(args)?;
            to_json(
                CollectionsRepository::remove_games_from_collection(
                    txn,
                    a.game_ids,
                    a.collection_id,
                )
                .await
                .map_err(fail("从合集中批量移除游戏失败"))?
                .rows_affected,
            )
        }
        WriteCommand::AddGamesToCollections => {
            let a: GamesToCollectionsArgs = parse(args)?;
            to_json(
                CollectionsRepository::add_games_to_collections_in_connection(
                    txn,
                    a.game_ids,
                    a.collection_ids,
                )
                .await
                .map_err(fail("批量添加游戏到合集失败"))?,
            )
        }
        WriteCommand::SetGameCollections => {
            let a: GameCollectionsArgs = parse(args)?;
            to_json(
                CollectionsRepository::set_game_collections_in_connection(
                    txn,
                    a.game_id,
                    a.collection_ids,
                )
                .await
                .map_err(fail("设置游戏合集失败"))?,
            )
        }
        WriteCommand::UpdateCategoryGames => {
            let a: GamesInCollectionArgs = parse(args)?;
            to_json(
                CollectionsRepository::update_category_games_in_connection(
                    txn,
                    a.game_ids,
                    a.collection_id,
                )
                .await
                .map_err(fail("批量更新分类游戏失败"))?,
            )
        }
    }
}
