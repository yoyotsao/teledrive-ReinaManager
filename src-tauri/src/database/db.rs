use sea_orm::{DatabaseConnection, DbErr, RuntimeErr};

use reina_path::{get_db_path, is_portable_mode};

// ==================== 数据库连接管理 ====================

/// Establish a SeaORM database connection.
pub async fn establish_connection() -> Result<DatabaseConnection, DbErr> {
    // 1. 获取数据库路径（自动判断便携模式）
    let db_path = get_db_path().map_err(|e| DbErr::Conn(RuntimeErr::Internal(e)))?;

    let mode = if is_portable_mode() {
        "便携"
    } else {
        "标准"
    };
    if !db_path.exists() {
        log::info!("首次启动，创建{}模式数据库: {}", mode, db_path.display());
    }

    // 2. 连接细节（建目录、单连接、外键）与服务器共用；migration 仍由 lib.rs 执行
    reina_core::database::open_database(&db_path).await
}

/// 关闭数据库连接
pub async fn close_connection(conn: DatabaseConnection) -> Result<(), DbErr> {
    conn.close().await?;
    Ok(())
}
