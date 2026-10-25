//! 网页版写入的组合性：外部 transaction、版本递增与 rollback 必须一致。

use reina_core::database::connect_database;
use reina_core::database::dto::{InsertCollectionData, InsertGameData, UpdateGameData};
use reina_core::database::repository::collections_repository::CollectionsRepository;
use reina_core::database::repository::game_stats_repository::GameStatsRepository;
use reina_core::database::repository::games_repository::GamesRepository;
use reina_core::database::repository::version_repository::VersionRepository;
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde_json::json;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "reina_web_tx_{}_{}_{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn database(name: &str) -> DatabaseConnection {
    connect_database(&unique_dir(name).join("reina_manager.db"))
        .await
        .unwrap()
}

/// InsertGameData 没有 Default；用 JSON 构建，只填测试关心的字段。
fn game(value: serde_json::Value) -> InsertGameData {
    let mut base = json!({ "id_type": "custom" });
    base.as_object_mut()
        .unwrap()
        .extend(value.as_object().unwrap().clone());
    serde_json::from_value(base).unwrap()
}

#[tokio::test]
async fn version_starts_at_zero_and_bump_returns_new_value() {
    let db = database("version").await;
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 0);
    assert_eq!(VersionRepository::bump(&db).await.unwrap(), 1);
    assert_eq!(VersionRepository::bump(&db).await.unwrap(), 2);
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 2);
}

#[tokio::test]
async fn write_and_version_roll_back_together() {
    let db = database("rollback").await;

    let tx = db.begin().await.unwrap();
    let inserted =
        GamesRepository::insert_in_connection(&tx, game(json!({ "teledrive_path": "game/A" })))
            .await
            .unwrap();
    assert_eq!(VersionRepository::bump(&tx).await.unwrap(), 1);
    tx.rollback().await.unwrap();

    assert!(
        GamesRepository::find_by_id(&db, inserted.id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 0);

    let tx = db.begin().await.unwrap();
    let committed =
        GamesRepository::insert_in_connection(&tx, game(json!({ "teledrive_path": "game/A" })))
            .await
            .unwrap();
    VersionRepository::bump(&tx).await.unwrap();
    tx.commit().await.unwrap();

    let stored = GamesRepository::find_by_id(&db, committed.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stored.teledrive_path.as_deref(), Some("game/A"));
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 1);
}

#[tokio::test]
async fn teledrive_path_is_unique_but_optional() {
    let db = database("unique").await;
    GamesRepository::insert(&db, game(json!({ "teledrive_path": "game/A" })))
        .await
        .unwrap();
    assert!(
        GamesRepository::insert(&db, game(json!({ "teledrive_path": "game/A" })))
            .await
            .is_err()
    );
    // 手动新增的游戏没有云端位置，可以有很多条。
    GamesRepository::insert(&db, game(json!({}))).await.unwrap();
    GamesRepository::insert(&db, game(json!({}))).await.unwrap();

    assert!(
        GamesRepository::find_id_by_teledrive_path(&db, "game/A")
            .await
            .unwrap()
            .is_some()
    );
    assert_eq!(
        GamesRepository::find_id_by_teledrive_path(&db, "game/B")
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn exe_relpath_is_validated_and_normalized() {
    let db = database("exe").await;

    // 反斜线统一存成 "/"，让 bridge 在任何电脑上都用同一种分隔符号解析。
    let stored = GamesRepository::insert(
        &db,
        game(json!({ "teledrive_path": "game/01000250", "exe_relpath": "01000250\\haison.exe" })),
    )
    .await
    .unwrap();
    assert_eq!(stored.exe_relpath.as_deref(), Some("01000250/haison.exe"));

    // 控制者裁決：teledrive_path 必须合法、只有 exe_relpath 不合法，测试才能真的验证 exe_relpath 的检查
    // （若两者都不合法，即使没有验证 exe_relpath 也会因 teledrive_path 不合法而误判通过）。
    for (index, bad) in ["../haison.exe", "C:\\Games\\haison.exe", "/abs/haison.exe"]
        .into_iter()
        .enumerate()
    {
        let result = GamesRepository::insert(
            &db,
            game(json!({ "teledrive_path": format!("game/valid_exe_test_{index}"), "exe_relpath": bad })),
        )
        .await;
        assert!(result.is_err(), "{bad}");
    }
    // 没有 teledrive_path 就不能有 exe_relpath。
    assert!(
        GamesRepository::insert(&db, game(json!({ "exe_relpath": "a.exe" })))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn clearing_teledrive_path_also_clears_exe_relpath() {
    let db = database("clear").await;
    let stored = GamesRepository::insert(
        &db,
        game(json!({ "teledrive_path": "game/A", "exe_relpath": "A/a.exe", "scan_status": "complete" })),
    )
    .await
    .unwrap();

    let updated = GamesRepository::update(
        &db,
        stored.id,
        UpdateGameData {
            teledrive_path: Some(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(updated.teledrive_path, None);
    assert_eq!(updated.exe_relpath, None);
    assert_eq!(updated.scan_status.as_deref(), Some("complete"));
}

#[tokio::test]
async fn scan_fields_round_trip_and_reject_unknown_status() {
    let db = database("scan").await;
    let candidates = json!([{ "source": "vndb", "external_id": "v38037", "score": 0.92 }]);
    let stored = GamesRepository::insert(
        &db,
        game(json!({
            "teledrive_path": "game/Haison",
            "scan_status": "needs_confirmation",
            "scan_candidates": candidates
        })),
    )
    .await
    .unwrap();
    assert_eq!(stored.scan_status.as_deref(), Some("needs_confirmation"));
    assert_eq!(stored.scan_candidates, Some(candidates));

    assert!(
        GamesRepository::insert(
            &db,
            game(json!({ "teledrive_path": "game/X", "scan_status": "done" }))
        )
        .await
        .is_err()
    );
}

#[tokio::test]
async fn batch_insert_uses_savepoints_inside_outer_transaction() {
    let db = database("batch").await;
    let tx = db.begin().await.unwrap();
    let result = GamesRepository::insert_batch_in_connection(
        &tx,
        vec![
            game(json!({ "teledrive_path": "game/A" })),
            game(json!({ "teledrive_path": "game/A" })), // 重复，只有这条失败
            game(json!({ "teledrive_path": "game/B" })),
        ],
    )
    .await;
    assert_eq!(result.success, 2);
    assert_eq!(result.failed, 1);
    assert_eq!(result.errors[0].index, 1);
    tx.rollback().await.unwrap();

    // 外层 rollback 后，连成功的那两条也不存在。
    assert_eq!(
        GamesRepository::find_id_by_teledrive_path(&db, "game/A")
            .await
            .unwrap(),
        None
    );
    assert_eq!(
        GamesRepository::find_id_by_teledrive_path(&db, "game/B")
            .await
            .unwrap(),
        None
    );
}

#[tokio::test]
async fn update_batch_in_connection_is_all_or_nothing_with_outer_rollback() {
    let db = database("update_batch").await;
    let a = GamesRepository::insert(&db, game(json!({ "teledrive_path": "game/A" })))
        .await
        .unwrap();

    let tx = db.begin().await.unwrap();
    GamesRepository::update_batch_in_connection(
        &tx,
        vec![(
            a.id,
            UpdateGameData {
                scan_status: Some(Some("complete".to_string())),
                ..Default::default()
            },
        )],
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();

    let reloaded = GamesRepository::find_by_id(&db, a.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(reloaded.scan_status, None);
}

#[tokio::test]
async fn collections_and_sessions_compose_with_outer_transaction() {
    let db = database("compose").await;
    let g = GamesRepository::insert(&db, game(json!({}))).await.unwrap();
    let collection = CollectionsRepository::create(
        &db,
        InsertCollectionData {
            name: "合集".to_string(),
            parent_id: None,
            sort_order: 0,
            icon: None,
        },
    )
    .await
    .unwrap();

    let tx = db.begin().await.unwrap();
    CollectionsRepository::set_game_collections_in_connection(&tx, g.id, vec![collection.id])
        .await
        .unwrap();
    GameStatsRepository::record_session_with_statistics_in_connection(
        &tx,
        g.id,
        1_700_000_000,
        1_700_003_600,
        60,
    )
    .await
    .unwrap();
    VersionRepository::bump(&tx).await.unwrap();
    tx.rollback().await.unwrap();

    assert!(
        CollectionsRepository::get_game_collection_ids(&db, g.id)
            .await
            .unwrap()
            .is_empty()
    );
    assert!(
        GameStatsRepository::get_sessions(&db, g.id, 10, 0)
            .await
            .unwrap()
            .is_empty()
    );
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 0);
}
