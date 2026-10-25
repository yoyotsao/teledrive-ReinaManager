//! 每位使用者一份独立的 SQLite 与封面目录：`<data_dir>/users/<user_id>/`。
//!
//! 目录名只来自 JWT 解出的正整数，不含任何使用者输入的字符串，所以没有路径穿越问题。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use sea_orm::DatabaseConnection;
use tokio::sync::Mutex;

#[derive(Debug)]
pub enum StoreError {
    /// 使用者 id 不是正整数
    InvalidUser,
    /// 已达 `REINA_MAX_USERS`，且这位是新使用者
    LimitReached,
    /// 建立目录或开启数据库失败；内容只写日志，不回给客户端
    Open(String),
}

/// 某位使用者的数据库连线与封面目录。
#[derive(Clone)]
pub struct UserStore {
    db: DatabaseConnection,
    dir: PathBuf,
}

impl UserStore {
    pub fn db(&self) -> &DatabaseConnection {
        &self.db
    }

    pub fn covers_dir(&self) -> PathBuf {
        self.dir.join("covers")
    }
}

/// 依使用者延迟开启并快取 `UserStore`。
pub struct UserStores {
    data_dir: PathBuf,
    max_users: usize,
    cache: Mutex<HashMap<i64, UserStore>>,
}

impl UserStores {
    pub fn new(data_dir: PathBuf, max_users: usize) -> Self {
        Self {
            data_dir,
            max_users,
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn users_dir(&self) -> PathBuf {
        self.data_dir.join("users")
    }

    pub async fn open(&self, user_id: i64) -> Result<UserStore, StoreError> {
        if user_id <= 0 {
            return Err(StoreError::InvalidUser);
        }
        // 锁住整个首次开启流程：同一使用者只开一次，新使用者的人数检查也不会互相抢
        let mut cache = self.cache.lock().await;
        if let Some(store) = cache.get(&user_id) {
            return Ok(store.clone());
        }

        let dir = self.users_dir().join(user_id.to_string());
        let existed = dir.exists();
        // 上限以磁盘上的目录数为准，服务重启后快取是空的也不会失准
        if !existed && count_dirs(&self.users_dir()).await? >= self.max_users {
            return Err(StoreError::LimitReached);
        }
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|error| StoreError::Open(error.to_string()))?;

        let db = match reina_core::database::connect_database(&dir.join("reina_manager.db")).await {
            Ok(db) => db,
            Err(error) => {
                // 别留下空目录占用名额
                if !existed {
                    let _ = tokio::fs::remove_dir_all(&dir).await;
                }
                return Err(StoreError::Open(error.to_string()));
            }
        };

        let store = UserStore { db, dir };
        cache.insert(user_id, store.clone());
        Ok(store)
    }

    #[cfg(test)]
    async fn cached_count(&self) -> usize {
        self.cache.lock().await.len()
    }
}

async fn count_dirs(path: &Path) -> Result<usize, StoreError> {
    let mut entries = match tokio::fs::read_dir(path).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(StoreError::Open(error.to_string())),
    };
    let mut count = 0;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| StoreError::Open(error.to_string()))?
    {
        if entry.path().is_dir() {
            count += 1;
        }
    }
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[tokio::test]
    async fn 首次开启时建立使用者目录与数据库() {
        let dir = tempfile::tempdir().unwrap();
        let stores = UserStores::new(dir.path().to_path_buf(), 10);

        let store = stores.open(7).await.unwrap();

        let user_dir = dir.path().join("users").join("7");
        assert!(user_dir.join("reina_manager.db").is_file());
        assert_eq!(store.covers_dir(), user_dir.join("covers"));
    }

    #[tokio::test]
    async fn 同一使用者并发首次开启只建立一份连线() {
        let dir = tempfile::tempdir().unwrap();
        let stores = Arc::new(UserStores::new(dir.path().to_path_buf(), 10));

        let handles: Vec<_> = (0..8)
            .map(|_| {
                let stores = stores.clone();
                tokio::spawn(async move { stores.open(7).await.unwrap() })
            })
            .collect();
        for handle in handles {
            handle.await.unwrap();
        }

        assert_eq!(stores.cached_count().await, 1);
    }

    #[tokio::test]
    async fn 不同使用者的数据库互相独立() {
        let dir = tempfile::tempdir().unwrap();
        let stores = UserStores::new(dir.path().to_path_buf(), 10);

        let a = stores.open(1).await.unwrap();
        let b = stores.open(2).await.unwrap();

        assert_ne!(a.covers_dir(), b.covers_dir());
        assert!(dir.path().join("users/1/reina_manager.db").is_file());
        assert!(dir.path().join("users/2/reina_manager.db").is_file());
    }

    #[tokio::test]
    async fn 达到上限后新使用者被拒绝而既有使用者不受影响() {
        let dir = tempfile::tempdir().unwrap();
        let stores = UserStores::new(dir.path().to_path_buf(), 2);
        stores.open(1).await.unwrap();
        stores.open(2).await.unwrap();

        assert!(matches!(
            stores.open(3).await,
            Err(StoreError::LimitReached)
        ));
        assert!(stores.open(1).await.is_ok());
        assert!(!dir.path().join("users/3").exists());
    }

    #[tokio::test]
    async fn 上限以磁盘上的目录为准而不是内存快取() {
        let dir = tempfile::tempdir().unwrap();
        UserStores::new(dir.path().to_path_buf(), 1)
            .open(1)
            .await
            .unwrap();

        // 模拟服务重启：快取是空的，但磁盘上已有 1 位使用者
        let restarted = UserStores::new(dir.path().to_path_buf(), 1);
        assert!(matches!(
            restarted.open(2).await,
            Err(StoreError::LimitReached)
        ));
        assert!(restarted.open(1).await.is_ok());
    }

    #[tokio::test]
    async fn 非正整数的使用者_id_被拒绝且不建立目录() {
        let dir = tempfile::tempdir().unwrap();
        let stores = UserStores::new(dir.path().to_path_buf(), 10);

        for id in [0, -1, i64::MIN] {
            assert!(matches!(
                stores.open(id).await,
                Err(StoreError::InvalidUser)
            ));
        }
        assert!(!dir.path().join("users").exists());
    }
}
