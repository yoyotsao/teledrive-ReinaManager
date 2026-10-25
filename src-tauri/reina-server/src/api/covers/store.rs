//! 封面文件存放在 `<data_dir>/covers/game_<id>/<sha256>.<ext>`。
//! 同一内容永远对应同一文件名，所以写入是幂等的；
//! 失败清理只能删除“本次请求新建立”的文件，避免误删其他请求正在引用的同 hash 文件。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::api::covers::sniff::ImageKind;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 每个游戏的封面目录一把锁。“写档 → commit → 清理”必须整段串行：
/// 否则 A 请求 commit 后的 retain_only 会删掉 B 请求刚写好、尚未 commit 的文件，
/// 或 B commit 失败时 discard 掉 A 已经引用的同 hash 文件。
/// 以目录路径为键（测试各自用不同的 tempdir，互不干扰）；单人使用，游戏数量有限，不回收。
static GAME_LOCKS: LazyLock<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> =
    LazyLock::new(Default::default);

#[derive(Debug, Clone)]
pub struct StagedCover {
    pub hash: String,
    pub kind: ImageKind,
    /// 这次调用是否真的新建立了文件；只有新建的才允许在失败时删除。
    pub created: bool,
}

#[derive(Debug, Clone)]
pub struct CoverStore {
    root: PathBuf,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn is_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl CoverStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn game_dir(&self, game_id: i32) -> PathBuf {
        self.root.join(format!("game_{game_id}"))
    }

    /// 取得该游戏封面的独占锁；持有期间才能调用 put / discard / retain_only / remove_game
    pub async fn lock_game(&self, game_id: i32) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = GAME_LOCKS.lock().expect("cover lock map poisoned");
            locks.entry(self.game_dir(game_id)).or_default().clone()
        };
        lock.lock_owned().await
    }

    pub async fn put(
        &self,
        game_id: i32,
        bytes: &[u8],
        kind: ImageKind,
    ) -> std::io::Result<StagedCover> {
        let hash = sha256_hex(bytes);
        let dir = self.game_dir(game_id);
        tokio::fs::create_dir_all(&dir).await?;
        let target = dir.join(format!("{hash}.{}", kind.ext()));
        if tokio::fs::try_exists(&target).await? {
            return Ok(StagedCover {
                hash,
                kind,
                created: false,
            });
        }
        // 先写到本请求独占的临时文件再 rename，避免读者看到写一半的文件
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = dir.join(format!(".{hash}.{}.{seq}.tmp", std::process::id()));
        tokio::fs::write(&temp, bytes).await?;
        match tokio::fs::rename(&temp, &target).await {
            Ok(()) => Ok(StagedCover {
                hash,
                kind,
                created: true,
            }),
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp).await;
                if tokio::fs::try_exists(&target).await.unwrap_or(false) {
                    // 另一个请求同时写入了相同内容
                    Ok(StagedCover {
                        hash,
                        kind,
                        created: false,
                    })
                } else {
                    Err(error)
                }
            }
        }
    }

    pub async fn discard(&self, game_id: i32, staged: &StagedCover) {
        if staged.created {
            let path =
                self.game_dir(game_id)
                    .join(format!("{}.{}", staged.hash, staged.kind.ext()));
            let _ = tokio::fs::remove_file(path).await;
        }
    }

    pub async fn open(
        &self,
        game_id: i32,
        hash: &str,
    ) -> std::io::Result<Option<(Vec<u8>, ImageKind)>> {
        if !is_hash(hash) {
            return Ok(None);
        }
        let dir = self.game_dir(game_id);
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some((stem, ext)) = name.rsplit_once('.') else {
                continue;
            };
            if stem == hash
                && let Some(kind) = ImageKind::from_ext(ext)
            {
                return Ok(Some((tokio::fs::read(entry.path()).await?, kind)));
            }
        }
        Ok(None)
    }

    /// 删除不在 `keep` 里的封面文件；只在 commit 成功之后调用。
    pub async fn retain_only(&self, game_id: i32, keep: &[&str]) {
        let Ok(mut entries) = tokio::fs::read_dir(self.game_dir(game_id)).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue; // 其他请求的临时文件
            }
            let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
            if !keep.contains(&stem) {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    /// 删除整个游戏的封面目录；只在删除游戏的 transaction commit 成功之后调用。
    pub async fn remove_game(&self, game_id: i32) {
        match tokio::fs::remove_dir_all(self.game_dir(game_id)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("清理游戏 {game_id} 的封面目录失败: {error}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::covers::sniff::ImageKind;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake-png-body";

    #[tokio::test]
    async fn 写入后可以依_hash_读回() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let staged = store.put(7, PNG, ImageKind::Png).await.unwrap();
        assert!(staged.created);
        assert_eq!(staged.hash.len(), 64);
        let (bytes, kind) = store.open(7, &staged.hash).await.unwrap().unwrap();
        assert_eq!(bytes, PNG);
        assert_eq!(kind, ImageKind::Png);
        assert!(
            dir.path()
                .join("covers/game_7")
                .join(format!("{}.png", staged.hash))
                .exists()
        );
    }

    #[tokio::test]
    async fn 重复写入同内容不算新建_discard_不删既有文件() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let first = store.put(7, PNG, ImageKind::Png).await.unwrap();
        let second = store.put(7, PNG, ImageKind::Png).await.unwrap();
        assert_eq!(first.hash, second.hash);
        assert!(!second.created);
        store.discard(7, &second).await;
        assert!(store.open(7, &first.hash).await.unwrap().is_some());
        store.discard(7, &first).await;
        assert!(store.open(7, &first.hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn 清理只保留仍被引用的_hash() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let a = store.put(3, PNG, ImageKind::Png).await.unwrap();
        let b = store
            .put(3, b"\xFF\xD8\xFFjpeg-body", ImageKind::Jpeg)
            .await
            .unwrap();
        store.retain_only(3, &[a.hash.as_str()]).await;
        assert!(store.open(3, &a.hash).await.unwrap().is_some());
        assert!(store.open(3, &b.hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn 同一个游戏的锁互斥_不同游戏互不影响() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let held = store.lock_game(1).await;
        // 同一个游戏：持有期间拿不到
        let same =
            tokio::time::timeout(std::time::Duration::from_millis(50), store.lock_game(1)).await;
        assert!(
            same.is_err(),
            "同一个游戏的第二把锁不应该在第一把释放前取得"
        );
        // 不同游戏：立刻拿得到
        let other =
            tokio::time::timeout(std::time::Duration::from_millis(50), store.lock_game(2)).await;
        assert!(other.is_ok());
        drop(held);
        let again =
            tokio::time::timeout(std::time::Duration::from_millis(50), store.lock_game(1)).await;
        assert!(again.is_ok(), "释放后应该能再取得");
    }

    #[tokio::test]
    async fn 不存在的游戏或_hash_返回_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        assert!(store.open(99, &"0".repeat(64)).await.unwrap().is_none());
        assert!(store.open(99, "../../etc/passwd").await.unwrap().is_none());
    }
}
