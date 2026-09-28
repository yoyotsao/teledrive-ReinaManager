//! 网页版（TeleDrive）所需的游戏位置、封面版本、扫描状态与全局资料版本。

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, TransactionTrait};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        add_web_library(&transaction).await?;
        transaction.commit().await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        remove_web_library(&transaction).await?;
        transaction.commit().await
    }
}

async fn add_web_library<C>(connection: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    connection
        .execute_unprepared(
            r#"
            ALTER TABLE games ADD COLUMN teledrive_path TEXT
                CHECK (teledrive_path IS NULL OR length(trim(teledrive_path)) > 0);
            ALTER TABLE games ADD COLUMN exe_relpath TEXT
                CHECK (exe_relpath IS NULL OR teledrive_path IS NOT NULL);
            ALTER TABLE games ADD COLUMN cover_version TEXT;
            ALTER TABLE games ADD COLUMN source_cover_hash TEXT;
            ALTER TABLE games ADD COLUMN custom_cover_hash TEXT;
            ALTER TABLE games ADD COLUMN scan_status TEXT
                CHECK (
                    scan_status IS NULL
                    OR scan_status IN ('pending', 'needs_confirmation', 'complete')
                );
            ALTER TABLE games ADD COLUMN scan_candidates TEXT
                CHECK (scan_candidates IS NULL OR json_valid(scan_candidates));
            CREATE UNIQUE INDEX IF NOT EXISTS idx_games_teledrive_path
                ON games(teledrive_path) WHERE teledrive_path IS NOT NULL;
            CREATE TABLE IF NOT EXISTS server_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data_version INTEGER NOT NULL DEFAULT 0 CHECK (data_version >= 0)
            );
            INSERT OR IGNORE INTO server_state (id, data_version) VALUES (1, 0);
            "#,
        )
        .await?;
    Ok(())
}

async fn remove_web_library<C>(connection: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    // DROP COLUMN 不能删被索引或被其他栏位 CHECK 引用的栏位：先删索引与 exe_relpath，最后删 teledrive_path。
    connection
        .execute_unprepared(
            r#"
            DROP INDEX IF EXISTS idx_games_teledrive_path;
            DROP TABLE IF EXISTS server_state;
            ALTER TABLE games DROP COLUMN exe_relpath;
            ALTER TABLE games DROP COLUMN scan_candidates;
            ALTER TABLE games DROP COLUMN scan_status;
            ALTER TABLE games DROP COLUMN custom_cover_hash;
            ALTER TABLE games DROP COLUMN source_cover_hash;
            ALTER TABLE games DROP COLUMN cover_version;
            ALTER TABLE games DROP COLUMN teledrive_path;
            "#,
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{Database, DatabaseBackend, DatabaseConnection, Statement};

    async fn games_table() -> DatabaseConnection {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE games (id INTEGER PRIMARY KEY, id_type TEXT NOT NULL); \
                 INSERT INTO games(id, id_type) VALUES (1, 'custom');",
            )
            .await
            .unwrap();
        database
    }

    #[tokio::test]
    async fn adds_columns_with_defaults_and_version_row() {
        let database = games_table().await;
        add_web_library(&database).await.unwrap();

        let existing = database
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT teledrive_path, exe_relpath, cover_version, source_cover_hash, custom_cover_hash, scan_status, scan_candidates \
                 FROM games WHERE id = 1"
                    .to_string(),
            ))
            .await
            .unwrap()
            .unwrap();
        for column in [
            "teledrive_path",
            "exe_relpath",
            "cover_version",
            "source_cover_hash",
            "custom_cover_hash",
            "scan_status",
            "scan_candidates",
        ] {
            assert_eq!(
                existing.try_get::<Option<String>>("", column).unwrap(),
                None,
                "{column}"
            );
        }

        let version = database
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT data_version FROM server_state WHERE id = 1".to_string(),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<i64>("", "data_version")
            .unwrap();
        assert_eq!(version, 0);
    }

    #[tokio::test]
    async fn enforces_constraints() {
        let database = games_table().await;
        add_web_library(&database).await.unwrap();

        // 非空 teledrive_path 唯一；多个 NULL 允许（手动新增的游戏没有云端位置）。
        database
            .execute_unprepared(
                "INSERT INTO games(id, id_type, teledrive_path) VALUES (2, 'custom', 'game/A'); \
                 INSERT INTO games(id, id_type) VALUES (3, 'custom');",
            )
            .await
            .unwrap();
        for invalid in [
            "INSERT INTO games(id, id_type, teledrive_path) VALUES (10, 'custom', 'game/A')",
            "INSERT INTO games(id, id_type, teledrive_path) VALUES (11, 'custom', '   ')",
            "INSERT INTO games(id, id_type, exe_relpath) VALUES (12, 'custom', 'a.exe')",
            "INSERT INTO games(id, id_type, scan_status) VALUES (13, 'custom', 'done')",
            "INSERT INTO games(id, id_type, scan_candidates) VALUES (14, 'custom', '{not json')",
            "INSERT INTO server_state(id, data_version) VALUES (2, 0)",
            "UPDATE server_state SET data_version = -1 WHERE id = 1",
        ] {
            assert!(
                database.execute_unprepared(invalid).await.is_err(),
                "{invalid}"
            );
        }
    }

    #[tokio::test]
    async fn down_removes_everything() {
        let database = games_table().await;
        add_web_library(&database).await.unwrap();
        remove_web_library(&database).await.unwrap();

        let columns = database
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "PRAGMA table_info(games)".to_string(),
            ))
            .await
            .unwrap();
        assert!(columns.iter().all(|column| {
            !matches!(
                column.try_get::<String>("", "name").unwrap().as_str(),
                "teledrive_path"
                    | "exe_relpath"
                    | "cover_version"
                    | "source_cover_hash"
                    | "custom_cover_hash"
                    | "scan_status"
                    | "scan_candidates"
            )
        }));
        assert!(database
            .execute_unprepared("SELECT 1 FROM server_state")
            .await
            .is_err());
    }
}
