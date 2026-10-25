//! connect_database 的行为测试：路径隔离、外键、重新开启、备份位置。

use reina_core::database::connect_database;
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 每个测试使用独立的临时目录，避免并行执行时互相干扰。
fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "reina_core_{}_{}_{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn scalar_i64(db: &DatabaseConnection, sql: &str, column: &str) -> i64 {
    db.query_one_raw(Statement::from_string(
        DatabaseBackend::Sqlite,
        sql.to_string(),
    ))
    .await
    .unwrap()
    .unwrap()
    .try_get::<i64>("", column)
    .unwrap()
}

fn same_file(left: &Path, right: &Path) -> bool {
    std::fs::canonicalize(left).unwrap() == std::fs::canonicalize(right).unwrap()
}

#[tokio::test]
async fn creates_independent_databases_at_the_given_paths() {
    let first_dir = unique_dir("first");
    let second_dir = unique_dir("second");
    let first_path = first_dir.join("nested").join("reina_manager.db");
    let second_path = second_dir.join("reina_manager.db");

    let first = connect_database(&first_path).await.unwrap();
    let second = connect_database(&second_path).await.unwrap();

    first
        .execute_unprepared("INSERT INTO games (id_type) VALUES ('custom')")
        .await
        .unwrap();

    assert!(first_path.is_file(), "应自动创建嵌套目录与数据库文件");
    assert!(second_path.is_file());
    assert_eq!(
        scalar_i64(&first, "SELECT COUNT(*) AS n FROM games", "n").await,
        1
    );
    assert_eq!(
        scalar_i64(&second, "SELECT COUNT(*) AS n FROM games", "n").await,
        0
    );

    first.close().await.unwrap();
    second.close().await.unwrap();
}

#[tokio::test]
async fn enables_foreign_keys() {
    let dir = unique_dir("fk");
    let db = connect_database(&dir.join("reina_manager.db"))
        .await
        .unwrap();

    assert_eq!(
        scalar_i64(&db, "PRAGMA foreign_keys", "foreign_keys").await,
        1
    );
    // game_sources.game_id 参照 games.id，外键生效时必须拒绝孤儿数据。
    let orphan = db
        .execute_unprepared(
            "INSERT INTO game_sources (game_id, source, external_id) VALUES (999, 'bgm', '1')",
        )
        .await;
    assert!(orphan.is_err(), "外键启用时应拒绝不存在的 game_id");

    db.close().await.unwrap();
}

#[tokio::test]
async fn reopening_a_migrated_database_keeps_data() {
    let dir = unique_dir("reopen");
    let path = dir.join("reina_manager.db");

    let db = connect_database(&path).await.unwrap();
    db.execute_unprepared("INSERT INTO games (id_type) VALUES ('custom')")
        .await
        .unwrap();
    db.close().await.unwrap();

    let reopened = connect_database(&path).await.unwrap();
    assert_eq!(
        scalar_i64(&reopened, "SELECT COUNT(*) AS n FROM games", "n").await,
        1
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn migration_backups_target_the_database_being_migrated() {
    let dir = unique_dir("backup");
    let path = dir.join("reina_manager.db");

    let db = connect_database(&path).await.unwrap();

    // migration 的备份必须针对“这个”数据库，而不是桌面版 %APPDATA% 里的那个。
    let file = migration::backup::database_file_path(&db)
        .await
        .unwrap()
        .expect("文件型数据库应返回路径");
    assert!(same_file(&file, &path));
    // m20251229_000004 与 m20260201_000007 在新数据库上也会备份，备份应落在同目录的 backups/。
    let backups = dir.join("backups");
    assert!(backups.is_dir(), "备份目录应创建在数据库旁边");
    assert!(std::fs::read_dir(&backups).unwrap().next().is_some());

    db.close().await.unwrap();
}

#[tokio::test]
async fn in_memory_connection_has_no_file_path() {
    let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
    assert_eq!(
        migration::backup::database_file_path(&db).await.unwrap(),
        None
    );
}
