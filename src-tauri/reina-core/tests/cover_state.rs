//! 封面字段只能通过 set_cover_hashes_in_connection 写入；自定义封面优先于来源封面。
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use reina_core::database::connect_database;
use reina_core::database::dto::{InsertGameData, UpdateGameData};
use reina_core::database::repository::games_repository::GamesRepository;
use sea_orm::{DatabaseConnection, DbErr, TransactionTrait};
use serde_json::json;

fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "reina_core_cover_{}_{}_{}",
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

/// InsertGameData 没有 Default；与任务 2 的测试相同，用 JSON 建立
async fn insert_game(db: &DatabaseConnection) -> i32 {
    let data: InsertGameData = serde_json::from_value(json!({ "id_type": "custom" })).unwrap();
    GamesRepository::insert(db, data).await.unwrap().id
}

#[tokio::test]
async fn 自定义封面优先于来源封面_清除自定义后回到来源() {
    let db = database("priority").await;
    let id = insert_game(&db).await;

    let txn = db.begin().await.unwrap();
    let version =
        GamesRepository::set_cover_hashes_in_connection(&txn, id, Some(Some("a".repeat(64))), None)
            .await
            .unwrap();
    txn.commit().await.unwrap();
    assert_eq!(version.as_deref(), Some("a".repeat(64).as_str()));

    let txn = db.begin().await.unwrap();
    let version =
        GamesRepository::set_cover_hashes_in_connection(&txn, id, None, Some(Some("b".repeat(64))))
            .await
            .unwrap();
    txn.commit().await.unwrap();
    assert_eq!(version.as_deref(), Some("b".repeat(64).as_str()));

    let state = GamesRepository::find_cover_state(&db, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.current(), Some("b".repeat(64).as_str()));

    let txn = db.begin().await.unwrap();
    let version = GamesRepository::set_cover_hashes_in_connection(&txn, id, None, Some(None))
        .await
        .unwrap();
    txn.commit().await.unwrap();
    assert_eq!(version.as_deref(), Some("a".repeat(64).as_str()));
}

#[tokio::test]
async fn rollback_后封面字段不变() {
    let db = database("rollback").await;
    let id = insert_game(&db).await;
    let txn = db.begin().await.unwrap();
    GamesRepository::set_cover_hashes_in_connection(&txn, id, Some(Some("c".repeat(64))), None)
        .await
        .unwrap();
    txn.rollback().await.unwrap();
    let state = GamesRepository::find_cover_state(&db, id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(state.current(), None);
}

#[tokio::test]
async fn 不存在的游戏() {
    let db = database("missing").await;
    assert!(
        GamesRepository::find_cover_state(&db, 404)
            .await
            .unwrap()
            .is_none()
    );
    let error = GamesRepository::set_cover_hashes_in_connection(&db, 404, Some(None), None)
        .await
        .unwrap_err();
    assert!(matches!(error, DbErr::RecordNotFound(_)));
}

#[tokio::test]
async fn cover_version_只能由封面函数设定() {
    let db = database("only_setter").await;
    // 客户端 DTO 没有 cover_version：多传的字段被忽略
    let data: InsertGameData =
        serde_json::from_value(json!({ "id_type": "custom", "cover_version": "evil" })).unwrap();
    let stored = GamesRepository::insert(&db, data).await.unwrap();
    assert_eq!(stored.cover_version, None);

    let updates: UpdateGameData =
        serde_json::from_value(json!({ "cover_version": "evil" })).unwrap();
    let updated = GamesRepository::update(&db, stored.id, updates)
        .await
        .unwrap();
    assert_eq!(updated.cover_version, None);

    let txn = db.begin().await.unwrap();
    GamesRepository::set_cover_hashes_in_connection(
        &txn,
        stored.id,
        Some(Some("d".repeat(64))),
        None,
    )
    .await
    .unwrap();
    txn.commit().await.unwrap();
    let reloaded = GamesRepository::find_by_id(&db, stored.id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        reloaded.cover_version.as_deref(),
        Some("d".repeat(64).as_str())
    );
}
