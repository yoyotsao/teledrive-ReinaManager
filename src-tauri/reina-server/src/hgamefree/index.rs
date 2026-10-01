//! 文章索引的 SQLite 表与搜索。放在 `<data_dir>/hgamefree.db`，与各使用者的数据库分开。

use std::collections::HashSet;
use std::path::PathBuf;

use sea_orm::{
    ConnectionTrait, DatabaseBackend, DatabaseConnection, DbErr, QueryResult, Statement,
    TransactionTrait, Value,
};
use tokio::sync::OnceCell;

use super::parse::{ParsedPost, fold};

const CREATE_POSTS: &str = "CREATE TABLE IF NOT EXISTS posts (
    post_id INTEGER PRIMARY KEY,
    title TEXT NOT NULL,
    file_names TEXT NOT NULL,
    file_url TEXT NOT NULL DEFAULT '[]',
    external_ids TEXT NOT NULL DEFAULT '[]',
    image_url TEXT,
    modified TEXT NOT NULL
)";
const CREATE_META: &str = "CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
)";

/// 已同步文章中最新的 `modified`，增量同步从这里开始。
pub const META_CURSOR: &str = "cursor";
/// 上次成功同步的时间（Unix 秒）。有值才代表索引可用。
pub const META_SYNCED_AT: &str = "synced_at";
/// 上次完整同步的时间（Unix 秒）；完整同步才能发现站台上被删除的文章。
pub const META_LAST_FULL_AT: &str = "last_full_at";

/// 单次搜索的候选池上限，避免前端一次要太多。
pub const MAX_SEARCH_LIMIT: usize = 20;
/// 包含关系至少要有这么多个字符才算相关，避免 "h" 这类名称命中一大堆。
const MIN_CONTAINS_CHARS: usize = 4;
/// 拆词比对时，单个词至少的字符数。
const MIN_TOKEN_CHARS: usize = 2;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub id: i64,
    pub title: String,
    pub file_names: Vec<String>,
    pub file_url: Vec<String>,
    /// `steam:<app id>`、`getchu:<id>`、`dlsite:RJxxxxxx`
    pub external_ids: Vec<String>,
    pub image_url: Option<String>,
}

pub struct HgamefreeIndex {
    path: PathBuf,
    db: OnceCell<DatabaseConnection>,
}

impl HgamefreeIndex {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            db: OnceCell::new(),
        }
    }

    async fn db(&self) -> Result<&DatabaseConnection, DbErr> {
        self.db
            .get_or_try_init(|| async {
                let db = reina_core::database::open_database(&self.path).await?;
                db.execute_unprepared(CREATE_POSTS).await?;
                db.execute_unprepared(CREATE_META).await?;
                add_missing_external_ids(&db).await?;
                Ok(db)
            })
            .await
    }

    fn statement(sql: &str, values: impl IntoIterator<Item = Value>) -> Statement {
        Statement::from_sql_and_values(DatabaseBackend::Sqlite, sql, values)
    }

    pub async fn get_meta(&self, key: &str) -> Result<Option<String>, DbErr> {
        let row = self
            .db()
            .await?
            .query_one_raw(Self::statement(
                "SELECT value FROM meta WHERE key = ?",
                [key.into()],
            ))
            .await?;
        row.map(|row| row.try_get("", "value")).transpose()
    }

    pub async fn set_meta(&self, key: &str, value: &str) -> Result<(), DbErr> {
        self.db()
            .await?
            .execute_raw(Self::statement(
                "INSERT INTO meta (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                [key.into(), value.into()],
            ))
            .await?;
        Ok(())
    }

    pub async fn count(&self) -> Result<i64, DbErr> {
        let row = self
            .db()
            .await?
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT COUNT(*) AS n FROM posts".to_string(),
            ))
            .await?;
        row.map(|row| row.try_get("", "n")).unwrap_or(Ok(0))
    }

    /// 一次同步批次在同一个 transaction 里写入，中途失败不会留下半批。
    pub async fn upsert(&self, posts: &[ParsedPost]) -> Result<(), DbErr> {
        let txn = self.db().await?.begin().await?;
        for post in posts {
            let to_json = |values: &Vec<String>| {
                serde_json::to_string(values).map_err(|error| DbErr::Custom(error.to_string()))
            };
            txn.execute_raw(Self::statement(
                "INSERT INTO posts (post_id, title, file_names, file_url, external_ids, image_url, modified)
                 VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(post_id) DO UPDATE SET
                     title = excluded.title,
                     file_names = excluded.file_names,
                     file_url = excluded.file_url,
                     external_ids = excluded.external_ids,
                     image_url = excluded.image_url,
                     modified = excluded.modified",
                [
                    post.id.into(),
                    post.title.clone().into(),
                    to_json(&post.file_names)?.into(),
                    to_json(&post.file_url)?.into(),
                    to_json(&post.external_ids)?.into(),
                    post.image_url.clone().into(),
                    post.modified.clone().into(),
                ],
            ))
            .await?;
        }
        txn.commit().await
    }

    /// 完整同步结束后，删除站台上已经不存在的文章。
    pub async fn delete_missing(&self, keep: &HashSet<i64>) -> Result<u64, DbErr> {
        let db = self.db().await?;
        let rows = db
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT post_id FROM posts".to_string(),
            ))
            .await?;
        let mut stale = Vec::new();
        for row in rows {
            let id: i64 = row.try_get("", "post_id")?;
            if !keep.contains(&id) {
                stale.push(id);
            }
        }

        let txn = db.begin().await?;
        for id in &stale {
            txn.execute_raw(Self::statement(
                "DELETE FROM posts WHERE post_id = ?",
                [(*id).into()],
            ))
            .await?;
        }
        txn.commit().await?;
        Ok(stale.len() as u64)
    }

    pub async fn get(&self, id: i64) -> Result<Option<Hit>, DbErr> {
        let row = self
            .db()
            .await?
            .query_one_raw(Self::statement(
                "SELECT post_id, title, file_names, file_url, external_ids, image_url FROM posts WHERE post_id = ?",
                [id.into()],
            ))
            .await?;
        row.map(|row| to_hit(&row)).transpose()
    }

    /// 依外部作品 ID（如 `steam:3329430`）反查文章；任一 ID 相符即算，新文章排前面。
    pub async fn find_by_external(&self, ids: &[String]) -> Result<Vec<Hit>, DbErr> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = self
            .db()
            .await?
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT post_id, title, file_names, file_url, external_ids, image_url FROM posts"
                    .to_string(),
            ))
            .await?;
        let mut hits = Vec::new();
        for row in rows {
            let hit = to_hit(&row)?;
            if hit.external_ids.iter().any(|id| ids.contains(id)) {
                hits.push(hit);
            }
        }
        hits.sort_by(|a, b| b.id.cmp(&a.id));
        Ok(hits)
    }

    /// 依相关度排序取前 `limit` 篇。文章只有几千篇，整表读进来再比对，
    /// 这样不必处理 LIKE 的转义，排序规则也都写在 Rust 里。
    pub async fn search(&self, query: &str, limit: usize) -> Result<Vec<Hit>, DbErr> {
        let query = fold(query);
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let tokens: Vec<&str> = query
            .split(' ')
            .filter(|token| token.chars().count() >= MIN_TOKEN_CHARS)
            .collect();

        let rows = self
            .db()
            .await?
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT post_id, title, file_names, file_url, external_ids, image_url FROM posts".to_string(),
            ))
            .await?;

        let mut ranked = Vec::new();
        for row in rows {
            let hit = to_hit(&row)?;
            if let Some(rank) = rank(&query, &tokens, &hit) {
                ranked.push((rank, hit));
            }
        }
        ranked.sort_by(|(a, hit_a), (b, hit_b)| a.cmp(b).then(hit_b.id.cmp(&hit_a.id)));
        Ok(ranked
            .into_iter()
            .take(limit.min(MAX_SEARCH_LIMIT))
            .map(|(_, hit)| hit)
            .collect())
    }
}

/// 旧版索引没有 `external_ids` 字段：补上字段，并清掉同步游标，
/// 让下一次同步重新完整抓一遍来填入外部 ID。`synced_at` 保留，搜索在重新同步期间仍可用。
async fn add_missing_external_ids(db: &DatabaseConnection) -> Result<(), DbErr> {
    let columns = db
        .query_all_raw(Statement::from_string(
            DatabaseBackend::Sqlite,
            "PRAGMA table_info(posts)".to_string(),
        ))
        .await?;
    for column in columns {
        let name: String = column.try_get("", "name")?;
        if name == "external_ids" {
            return Ok(());
        }
    }
    db.execute_unprepared("ALTER TABLE posts ADD COLUMN external_ids TEXT NOT NULL DEFAULT '[]'")
        .await?;
    db.execute_unprepared(&format!(
        "DELETE FROM meta WHERE key IN ('{META_CURSOR}', '{META_LAST_FULL_AT}')"
    ))
    .await?;
    Ok(())
}

fn to_hit(row: &QueryResult) -> Result<Hit, DbErr> {
    let file_names: String = row.try_get("", "file_names")?;
    let file_url: String = row.try_get("", "file_url")?;
    let external_ids: String = row.try_get("", "external_ids")?;
    Ok(Hit {
        id: row.try_get("", "post_id")?,
        title: row.try_get("", "title")?,
        file_names: serde_json::from_str(&file_names).unwrap_or_default(),
        file_url: serde_json::from_str(&file_url).unwrap_or_default(),
        external_ids: serde_json::from_str(&external_ids).unwrap_or_default(),
        image_url: row.try_get("", "image_url")?,
    })
}

/// 越小越相关；`None` 代表不相关。
/// 依序是：文件名或标题完全相同 → 互相包含 → 查询的每个词都出现。
/// 同一级里，长度越接近查询的越前面。
fn rank(query: &str, tokens: &[&str], hit: &Hit) -> Option<(u8, usize)> {
    let title = fold(&hit.title);
    let candidates: Vec<String> = std::iter::once(title)
        .chain(hit.file_names.iter().map(|name| fold(name)))
        .filter(|text| !text.is_empty())
        .collect();
    let query_len = query.chars().count();
    let distance = |text: &String| text.chars().count().abs_diff(query_len);

    if let Some(best) = candidates
        .iter()
        .filter(|text| text.as_str() == query)
        .map(distance)
        .min()
    {
        return Some((0, best));
    }

    let contains = candidates
        .iter()
        .filter(|text| {
            let (short, long) = if text.chars().count() < query_len {
                (text.as_str(), query)
            } else {
                (query, text.as_str())
            };
            short.chars().count() >= MIN_CONTAINS_CHARS && long.contains(short)
        })
        .map(distance)
        .min();
    if let Some(best) = contains {
        return Some((1, best));
    }

    if !tokens.is_empty() {
        let all = candidates
            .iter()
            .filter(|text| tokens.iter().all(|token| text.contains(token)))
            .map(distance)
            .min();
        if let Some(best) = all {
            return Some((2, best));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn post(id: i64, title: &str, files: &[&str]) -> ParsedPost {
        ParsedPost {
            id,
            title: title.into(),
            file_names: files.iter().map(|name| name.to_string()).collect(),
            file_url: files
                .iter()
                .map(|name| format!("http://k2s.cc/file/x/{name}.rar"))
                .collect(),
            external_ids: Vec::new(),
            image_url: None,
            modified: "2026-09-30T00:00:00".into(),
        }
    }

    async fn index_with(posts: &[ParsedPost]) -> (tempfile::TempDir, HgamefreeIndex) {
        let dir = tempfile::tempdir().unwrap();
        let index = HgamefreeIndex::new(dir.path().join("hgamefree.db"));
        index.upsert(posts).await.unwrap();
        (dir, index)
    }

    #[tokio::test]
    async fn 压缩包文件名完全相同排最前() {
        let (_dir, index) = index_with(&[
            post(1, "與你流落荒島 官方中文 [420m]", &["Stranded with You"]),
            post(2, "Stranded with You 2 官方中文", &["Stranded with You 2"]),
        ])
        .await;

        let hits = index.search("stranded WITH you", 8).await.unwrap();
        assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), [1, 2]);
    }

    #[tokio::test]
    async fn 资料夹名带杂讯时靠包含关系找到() {
        let (_dir, index) = index_with(&[post(1, "ThornSin 0.75 官方中文", &["ThornSin"])]).await;

        let hits = index.search("[Brand] ThornSin v0.75 汉化", 8).await.unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[tokio::test]
    async fn 太短的名称不会靠包含关系命中() {
        let (_dir, index) = index_with(&[post(1, "Ah Hello World", &[])]).await;

        // "h" 长度不足 4，也没有达到拆词门槛
        assert!(index.search("h", 8).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn 每个词都出现才算相关() {
        let (_dir, index) = index_with(&[
            post(1, "Dark Hunter Kuro 官方中文", &["DARK HUNTER KURO"]),
            post(2, "Dark Forest", &[]),
        ])
        .await;

        let hits = index.search("hunter kuro dark", 8).await.unwrap();
        assert_eq!(hits.iter().map(|h| h.id).collect::<Vec<_>>(), [1]);
    }

    #[tokio::test]
    async fn 重复写入同一篇会更新而不是新增() {
        let (_dir, index) = index_with(&[post(1, "旧标题", &[])]).await;
        index.upsert(&[post(1, "新标题", &["New"])]).await.unwrap();

        assert_eq!(index.count().await.unwrap(), 1);
        let hit = index.get(1).await.unwrap().unwrap();
        assert_eq!(hit.title, "新标题");
        assert_eq!(hit.file_names, ["New"]);
        assert_eq!(hit.file_url, ["http://k2s.cc/file/x/New.rar"]);
    }

    #[tokio::test]
    async fn 完整同步后删除站台上已不存在的文章() {
        let (_dir, index) = index_with(&[post(1, "A", &[]), post(2, "B", &[])]).await;

        let removed = index.delete_missing(&HashSet::from([2])).await.unwrap();
        assert_eq!(removed, 1);
        assert!(index.get(1).await.unwrap().is_none());
        assert!(index.get(2).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn 依外部_id_反查文章() {
        let mut steam = post(1, "瑪蒂達小姐", &[]);
        steam.external_ids = vec!["steam:3329430".into(), "dlsite:RJ01464205".into()];
        let mut getchu = post(2, "サキュありアパート", &[]);
        getchu.external_ids = vec!["getchu:1159372".into()];
        let (_dir, index) = index_with(&[steam, getchu, post(3, "无 ID", &[])]).await;

        let by_steam = index.find_by_external(&["steam:3329430".into()]).await.unwrap();
        assert_eq!(by_steam.iter().map(|h| h.id).collect::<Vec<_>>(), [1]);
        let any = index
            .find_by_external(&["getchu:1159372".into(), "dlsite:RJ01464205".into()])
            .await
            .unwrap();
        assert_eq!(any.iter().map(|h| h.id).collect::<Vec<_>>(), [2, 1]);
        assert!(index.find_by_external(&["steam:1".into()]).await.unwrap().is_empty());
        assert!(index.find_by_external(&[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn 旧版索引缺少_external_ids_时补字段并要求重新完整同步() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("hgamefree.db");
        {
            let old = reina_core::database::open_database(&path).await.unwrap();
            old.execute_unprepared(
                "CREATE TABLE posts (post_id INTEGER PRIMARY KEY, title TEXT NOT NULL,
                 file_names TEXT NOT NULL, file_url TEXT NOT NULL DEFAULT '[]',
                 image_url TEXT, modified TEXT NOT NULL)",
            )
            .await
            .unwrap();
            old.execute_unprepared(CREATE_META).await.unwrap();
            old.execute_unprepared(
                "INSERT INTO posts VALUES (1, '旧文章', '[]', '[]', NULL, '2026-01-01T00:00:00')",
            )
            .await
            .unwrap();
            old.execute_unprepared(
                "INSERT INTO meta VALUES ('cursor', '2026-01-01T00:00:00'),
                 ('last_full_at', '1'), ('synced_at', '1')",
            )
            .await
            .unwrap();
        }

        let index = HgamefreeIndex::new(path);
        let hit = index.get(1).await.unwrap().unwrap();
        assert_eq!(hit.title, "旧文章");
        assert!(hit.external_ids.is_empty());
        // 游标被清掉，下次同步会完整重抓；synced_at 保留，搜索仍可用
        assert_eq!(index.get_meta(META_CURSOR).await.unwrap(), None);
        assert_eq!(index.get_meta(META_LAST_FULL_AT).await.unwrap(), None);
        assert!(index.get_meta(META_SYNCED_AT).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn meta_可以读写覆盖() {
        let (_dir, index) = index_with(&[]).await;
        assert_eq!(index.get_meta(META_CURSOR).await.unwrap(), None);
        index.set_meta(META_CURSOR, "a").await.unwrap();
        index.set_meta(META_CURSOR, "b").await.unwrap();
        assert_eq!(
            index.get_meta(META_CURSOR).await.unwrap().as_deref(),
            Some("b")
        );
    }
}
