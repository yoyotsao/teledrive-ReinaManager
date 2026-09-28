//! Write 操作的 transaction 边界：业务数据与 `data_version` 在同一次 commit。

use std::sync::atomic::{AtomicBool, Ordering};

use reina_core::database::repository::version_repository::VersionRepository;
use sea_orm::{DatabaseConnection, DatabaseTransaction, TransactionTrait};

use crate::app::AppState;
use crate::error::ApiError;

/// 测试用的 commit 故障注入点：`fail_next()` 之后的下一次 `finish` 会在 commit 前 rollback 并回传 500。
/// 正式环境从不调用 `fail_next`，所以永远是 false。
#[doc(hidden)]
#[derive(Debug, Default)]
pub struct CommitFault(AtomicBool);

impl CommitFault {
    pub fn fail_next(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

pub async fn begin(db: &DatabaseConnection) -> Result<DatabaseTransaction, ApiError> {
    Ok(db.begin().await?)
}

/// 结束一个 Write transaction。
///
/// - `result` 成功且 `bump` 回传 true：递增 `data_version` 后 commit。
/// - `result` 成功但 `bump` 回传 false：只 commit，不递增（游玩记录重送、没有变更的扫描时使用）。
/// - `result` 失败：rollback，数据与版本都不变。
/// - 测试以 `state.fault.fail_next()` 注入失败时：rollback 并回传 500，模拟 commit 失败。
pub async fn finish<T>(
    state: &AppState,
    txn: DatabaseTransaction,
    result: Result<T, ApiError>,
    bump: impl FnOnce(&T) -> bool,
) -> Result<T, ApiError> {
    match result {
        Ok(value) => {
            if bump(&value) {
                VersionRepository::bump(&txn).await?;
            }
            if state.fault.take() {
                txn.rollback().await?;
                return Err(ApiError::internal("测试注入的 commit 失败"));
            }
            txn.commit().await?;
            Ok(value)
        }
        Err(error) => {
            txn.rollback().await?;
            Err(error)
        }
    }
}
