//! 网页版的全局资料版本（server_state 单行表）。
//!
//! 版本只由 reina-server 的 Write command 在同一个 transaction 内递增，
//! 前端轮询它来判断其他装置是否改过资料。

use sea_orm::{ConnectionTrait, DbErr, Statement};

pub struct VersionRepository;

impl VersionRepository {
    /// 读取目前的资料版本。
    pub async fn get(db: &impl ConnectionTrait) -> Result<i64, DbErr> {
        db.query_one_raw(Statement::from_string(
            db.get_database_backend(),
            "SELECT data_version FROM server_state WHERE id = 1".to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("server_state 缺少 id = 1 的版本记录".to_string()))?
        .try_get::<i64>("", "data_version")
    }

    /// 版本加 1 并回传新值；必须和业务写入使用同一个 transaction。
    pub async fn bump(db: &impl ConnectionTrait) -> Result<i64, DbErr> {
        db.query_one_raw(Statement::from_string(
            db.get_database_backend(),
            "UPDATE server_state SET data_version = data_version + 1 WHERE id = 1 \
             RETURNING data_version"
                .to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("server_state 缺少 id = 1 的版本记录".to_string()))?
        .try_get::<i64>("", "data_version")
    }
}
