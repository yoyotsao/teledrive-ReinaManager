//! 保存 bridge 会话的幂等 UUID、设备名称与精确秒数。

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, TransactionTrait};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        add_bridge_sessions(&transaction).await?;
        transaction.commit().await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        remove_bridge_sessions(&transaction).await?;
        transaction.commit().await
    }
}

async fn add_bridge_sessions<C>(connection: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    connection
        .execute_unprepared(
            r#"
            ALTER TABLE game_sessions ADD COLUMN external_id TEXT;
            ALTER TABLE game_sessions ADD COLUMN device TEXT;
            ALTER TABLE game_sessions ADD COLUMN duration_seconds INTEGER;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_game_sessions_external_id
                ON game_sessions(external_id) WHERE external_id IS NOT NULL;
            "#,
        )
        .await?;
    Ok(())
}

async fn remove_bridge_sessions<C>(connection: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    connection
        .execute_unprepared(
            r#"
            DROP INDEX IF EXISTS idx_game_sessions_external_id;
            ALTER TABLE game_sessions DROP COLUMN duration_seconds;
            ALTER TABLE game_sessions DROP COLUMN device;
            ALTER TABLE game_sessions DROP COLUMN external_id;
            "#,
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{Database, DatabaseBackend, Statement};

    async fn database() -> sea_orm_migration::sea_orm::DatabaseConnection {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE games (id INTEGER PRIMARY KEY); \
                 CREATE TABLE game_sessions (session_id INTEGER PRIMARY KEY, game_id INTEGER NOT NULL, \
                    start_time INTEGER NOT NULL, end_time INTEGER NOT NULL, duration INTEGER NOT NULL, date TEXT NOT NULL); \
                 INSERT INTO games VALUES (1); \
                 INSERT INTO game_sessions VALUES (1, 1, 100, 160, 1, '2026-01-01');",
            )
            .await
            .unwrap();
        database
    }

    #[tokio::test]
    async fn adds_nullable_unique_fields_and_preserves_old_rows() {
        let database = database().await;
        add_bridge_sessions(&database).await.unwrap();

        let old_row = database
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT external_id, device, duration_seconds, duration FROM game_sessions WHERE session_id = 1",
            ))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            old_row
                .try_get::<Option<String>>("", "external_id")
                .unwrap(),
            None
        );
        assert_eq!(
            old_row.try_get::<Option<String>>("", "device").unwrap(),
            None
        );
        assert_eq!(
            old_row
                .try_get::<Option<i32>>("", "duration_seconds")
                .unwrap(),
            None
        );
        assert_eq!(old_row.try_get::<i32>("", "duration").unwrap(), 1);

        database
            .execute_unprepared(
                "INSERT INTO game_sessions VALUES (2, 1, 200, 260, 1, '2026-01-01', NULL, NULL, NULL); \
                 INSERT INTO game_sessions VALUES (3, 1, 300, 360, 1, '2026-01-01', 'same-id', 'PC', 60);",
            )
            .await
            .unwrap();
        assert!(database
            .execute_unprepared(
                "INSERT INTO game_sessions VALUES (4, 1, 400, 460, 1, '2026-01-01', 'same-id', 'PC', 60)",
            )
            .await
            .is_err());
    }

    #[tokio::test]
    async fn down_removes_bridge_fields() {
        let database = database().await;
        add_bridge_sessions(&database).await.unwrap();
        remove_bridge_sessions(&database).await.unwrap();
        assert!(database
            .execute_unprepared("SELECT external_id FROM game_sessions")
            .await
            .is_err());
    }
}
