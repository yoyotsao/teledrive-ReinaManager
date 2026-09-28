//! 以明确路径建立 SQLite 连接。桌面版与服务器共用，不依赖桌面数据目录。

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, DbErr,
    RuntimeErr, Statement,
};
use std::path::Path;
use std::time::Duration;
use url::Url;

use migration::MigratorTrait;

/// 打开指定路径的数据库（不执行 migration）。
///
/// - 目录不存在时自动创建
/// - 单一连接：SQLite 写入本来就是序列化的，多连接只会带来 busy 错误
/// - 必须成功启用外键，否则拒绝返回连接
pub async fn open_database(path: &Path) -> Result<DatabaseConnection, DbErr> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            DbErr::Conn(RuntimeErr::Internal(format!(
                "无法创建数据库目录 {}: {}",
                parent.display(),
                error
            )))
        })?;
    }

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| DbErr::Conn(RuntimeErr::Internal(error.to_string())))?
            .join(path)
    };
    let db_url = Url::from_file_path(&absolute).map_err(|_| {
        DbErr::Conn(RuntimeErr::Internal(format!(
            "Invalid database path: {}",
            absolute.display()
        )))
    })?;

    let mut options = ConnectOptions::new(format!("sqlite:{}?mode=rwc", db_url.path()));
    options
        .max_connections(1)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(8))
        .sqlx_logging(false);

    let connection = Database::connect(options).await?;
    connection
        .execute_unprepared("PRAGMA foreign_keys = ON")
        .await?;

    let foreign_keys = connection
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Sqlite,
            "PRAGMA foreign_keys".to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("无法读取 SQLite 外键状态".to_string()))?
        .try_get::<i32>("", "foreign_keys")?;
    if foreign_keys != 1 {
        return Err(DbErr::Custom("SQLite 外键约束未启用".to_string()));
    }

    Ok(connection)
}

/// 打开数据库并执行全部 migration；服务器启动时使用。
pub async fn connect_database(path: &Path) -> Result<DatabaseConnection, DbErr> {
    let connection = open_database(path).await?;
    migration::Migrator::up(&connection, None).await?;
    Ok(connection)
}
