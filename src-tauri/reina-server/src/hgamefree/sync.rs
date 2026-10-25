//! 把站台文章同步进本机索引：第一次完整同步，之后只抓有更新的文章。

use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sea_orm::DbErr;

use super::index::{HgamefreeIndex, META_CURSOR, META_LAST_FULL_AT, META_SYNCED_AT};
use super::parse::{ParsedPost, WpPost};
use crate::config::Config;
use crate::upstream::fetch::{UpstreamRequest, fetch_bytes};
use crate::upstream::limiter::Limiters;
use crate::upstream::target::{HostRule, UpstreamError, resolve_target};

const POSTS_API: &str = "https://hgamefree.info/wp-json/wp/v2/posts";
const SOURCE: &str = "hgamefree";
const PER_PAGE: u32 = 100;
// 100 篇约 1～2MB（含内文与封面），留足余量
const MAX_PAGE_BYTES: usize = 16 * 1024 * 1024;
const PAGE_ATTEMPTS: u32 = 3;
/// 增量同步的间隔。
const SYNC_INTERVAL: Duration = Duration::from_secs(30 * 60);
/// 同步失败后重试的间隔。
const RETRY_DELAY: Duration = Duration::from_secs(5 * 60);
/// 超过这个时间就重做一次完整同步，才能发现站台上被删除的文章。
const FULL_RESYNC_SECS: u64 = 7 * 24 * 3600;

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("fetch failed: {0}")]
    Fetch(String),
    #[error("database error: {0}")]
    Db(#[from] DbErr),
}

pub struct Page {
    pub posts: Vec<WpPost>,
    pub total_pages: u32,
}

/// 抓文章的来源；测试可以换成假的。
pub trait PostSource {
    fn fetch_page(
        &self,
        page: u32,
        modified_after: Option<&str>,
    ) -> impl std::future::Future<Output = Result<Page, SyncError>> + Send;
}

#[derive(Debug, PartialEq, Eq)]
pub struct SyncReport {
    pub full: bool,
    pub fetched: usize,
    pub removed: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_secs())
}

pub async fn run_sync(
    index: &HgamefreeIndex,
    source: &impl PostSource,
    now: u64,
) -> Result<SyncReport, SyncError> {
    let cursor = index.get_meta(META_CURSOR).await?;
    let last_full = index
        .get_meta(META_LAST_FULL_AT)
        .await?
        .and_then(|value| value.parse::<u64>().ok());
    let full = cursor.is_none()
        || last_full.is_none_or(|at| now.saturating_sub(at) >= FULL_RESYNC_SECS);
    let modified_after = if full { None } else { cursor.clone() };

    let mut seen = HashSet::new();
    let mut newest = cursor.unwrap_or_default();
    let mut fetched = 0;
    let mut page = 1;
    loop {
        let result = source.fetch_page(page, modified_after.as_deref()).await?;
        let posts: Vec<ParsedPost> = result.posts.into_iter().map(WpPost::parse).collect();
        // 一页一页写入：中途失败或重启，已抓到的文章不必重抓
        index.upsert(&posts).await?;
        for post in &posts {
            seen.insert(post.id);
            // `modified` 是 ISO 8601 字串，可以直接比较大小
            if post.modified > newest {
                newest = post.modified.clone();
            }
        }
        fetched += posts.len();

        if posts.is_empty() || page >= result.total_pages {
            break;
        }
        page += 1;
    }

    // 只有完整走完才能判断“没看到的就是被删了”
    let removed = if full {
        index.delete_missing(&seen).await?
    } else {
        0
    };
    if !newest.is_empty() {
        index.set_meta(META_CURSOR, &newest).await?;
    }
    if full {
        index.set_meta(META_LAST_FULL_AT, &now.to_string()).await?;
    }
    index.set_meta(META_SYNCED_AT, &now.to_string()).await?;
    Ok(SyncReport {
        full,
        fetched,
        removed,
    })
}

/// 透过 `upstream` 层连到站台，与元数据代理共用 host 白名单、公开 IP 检查与限速规则。
pub struct HttpPostSource {
    config: Arc<Config>,
    limiters: Limiters,
}

impl HttpPostSource {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            config,
            limiters: Limiters::from_policies(),
        }
    }

    async fn fetch_once(
        &self,
        page: u32,
        modified_after: Option<&str>,
    ) -> Result<Page, SyncError> {
        let mut params = vec![
            ("per_page", PER_PAGE.to_string()),
            ("page", page.to_string()),
            ("orderby", "modified".to_string()),
            ("order", "asc".to_string()),
            ("_embed", "wp:featuredmedia".to_string()),
            ("_fields", "id,modified,title,content,_embedded,_links".to_string()),
        ];
        if let Some(after) = modified_after {
            params.push(("modified_after", after.to_string()));
        }
        let url = url::Url::parse_with_params(POSTS_API, &params)
            .map_err(|error| SyncError::Fetch(error.to_string()))?;

        let target = resolve_target(url.as_str(), &self.config, HostRule::MetadataApi)
            .await
            .map_err(fetch_error)?;
        let limiter = self.limiters.for_source(SOURCE);
        limiter.acquire().await;
        let mut request = UpstreamRequest::get();
        request
            .headers
            .push(("accept".to_string(), "application/json".to_string()));
        let response = fetch_bytes(&target, &self.config, request, MAX_PAGE_BYTES)
            .await
            .map_err(fetch_error)?;

        let total_pages = response
            .headers
            .iter()
            .find(|(name, _)| name == "x-wp-totalpages")
            .and_then(|(_, value)| value.parse::<u32>().ok())
            .unwrap_or(page);
        match response.status {
            200..=299 => limiter.record_success(),
            // 页码超出范围时 WordPress 回 400；视为已经没有更多文章
            400 if page > 1 => {
                return Ok(Page {
                    posts: Vec::new(),
                    total_pages: page - 1,
                });
            }
            status => return Err(SyncError::Fetch(format!("HTTP {status}"))),
        }

        let posts: Vec<WpPost> = serde_json::from_slice(&response.body)
            .map_err(|error| SyncError::Fetch(format!("bad response: {error}")))?;
        Ok(Page { posts, total_pages })
    }
}

fn fetch_error(error: UpstreamError) -> SyncError {
    SyncError::Fetch(error.to_string())
}

impl PostSource for HttpPostSource {
    async fn fetch_page(
        &self,
        page: u32,
        modified_after: Option<&str>,
    ) -> Result<Page, SyncError> {
        let mut attempt = 1;
        loop {
            match self.fetch_once(page, modified_after).await {
                Ok(result) => return Ok(result),
                Err(error) if attempt >= PAGE_ATTEMPTS => return Err(error),
                Err(error) => {
                    log::warn!("HGameFree 第 {page} 页抓取失败（第 {attempt} 次）：{error}");
                    tokio::time::sleep(Duration::from_secs(2 * u64::from(attempt))).await;
                    attempt += 1;
                }
            }
        }
    }
}

/// 启动后立刻同步一次，之后定时增量同步。失败不影响服务，稍后重试。
pub fn spawn_background(index: Arc<HgamefreeIndex>, config: Arc<Config>) {
    tokio::spawn(async move {
        let source = HttpPostSource::new(config);
        loop {
            let delay = match run_sync(&index, &source, now_secs()).await {
                Ok(report) => {
                    log::info!(
                        "HGameFree 索引同步完成：{}，抓取 {} 篇，移除 {} 篇",
                        if report.full { "完整" } else { "增量" },
                        report.fetched,
                        report.removed
                    );
                    SYNC_INTERVAL
                }
                Err(error) => {
                    log::warn!("HGameFree 索引同步失败：{error}");
                    RETRY_DELAY
                }
            };
            tokio::time::sleep(delay).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// 假来源：按页回传预先准备好的文章，并记录每次请求的参数。
    struct FakeSource {
        pages: Vec<Vec<serde_json::Value>>,
        calls: Mutex<Vec<(u32, Option<String>)>>,
        fail_on_page: Option<u32>,
    }

    impl FakeSource {
        fn new(pages: Vec<Vec<serde_json::Value>>) -> Self {
            Self {
                pages,
                calls: Mutex::default(),
                fail_on_page: None,
            }
        }
    }

    impl PostSource for FakeSource {
        async fn fetch_page(
            &self,
            page: u32,
            modified_after: Option<&str>,
        ) -> Result<Page, SyncError> {
            self.calls
                .lock()
                .unwrap()
                .push((page, modified_after.map(str::to_string)));
            if self.fail_on_page == Some(page) {
                return Err(SyncError::Fetch("boom".into()));
            }
            let posts = self
                .pages
                .get(page as usize - 1)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .map(|value| serde_json::from_value(value).unwrap())
                .collect();
            Ok(Page {
                posts,
                total_pages: self.pages.len() as u32,
            })
        }
    }

    fn wp(id: i64, title: &str, modified: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id,
            "modified": modified,
            "title": {"rendered": title},
            "content": {"rendered": format!("<a href=\"http://k2s.cc/file/{id}/{title}.rar\">k</a>")},
        })
    }

    fn new_index() -> (tempfile::TempDir, HgamefreeIndex) {
        let dir = tempfile::tempdir().unwrap();
        let index = HgamefreeIndex::new(dir.path().join("hgamefree.db"));
        (dir, index)
    }

    #[tokio::test]
    async fn 第一次完整同步所有分页并记录游标() {
        let (_dir, index) = new_index();
        let source = FakeSource::new(vec![
            vec![wp(1, "A", "2026-01-01T00:00:00"), wp(2, "B", "2026-01-02T00:00:00")],
            vec![wp(3, "C", "2026-01-03T00:00:00")],
        ]);

        let report = run_sync(&index, &source, 1_000).await.unwrap();

        assert_eq!(
            report,
            SyncReport {
                full: true,
                fetched: 3,
                removed: 0
            }
        );
        assert_eq!(index.count().await.unwrap(), 3);
        assert_eq!(
            index.get_meta(META_CURSOR).await.unwrap().as_deref(),
            Some("2026-01-03T00:00:00")
        );
        assert_eq!(
            index.get_meta(META_SYNCED_AT).await.unwrap().as_deref(),
            Some("1000")
        );
        assert_eq!(
            *source.calls.lock().unwrap(),
            [(1, None), (2, None)]
        );
    }

    #[tokio::test]
    async fn 之后的同步只抓游标之后的文章() {
        let (_dir, index) = new_index();
        run_sync(
            &index,
            &FakeSource::new(vec![vec![wp(1, "A", "2026-01-01T00:00:00")]]),
            1_000,
        )
        .await
        .unwrap();

        let source = FakeSource::new(vec![vec![wp(2, "B", "2026-02-01T00:00:00")]]);
        let report = run_sync(&index, &source, 2_000).await.unwrap();

        assert!(!report.full);
        assert_eq!(
            *source.calls.lock().unwrap(),
            [(1, Some("2026-01-01T00:00:00".to_string()))]
        );
        assert_eq!(index.count().await.unwrap(), 2);
        assert_eq!(
            index.get_meta(META_CURSOR).await.unwrap().as_deref(),
            Some("2026-02-01T00:00:00")
        );
    }

    #[tokio::test]
    async fn 增量同步没有新文章时游标不变() {
        let (_dir, index) = new_index();
        run_sync(
            &index,
            &FakeSource::new(vec![vec![wp(1, "A", "2026-01-01T00:00:00")]]),
            1_000,
        )
        .await
        .unwrap();

        let report = run_sync(&index, &FakeSource::new(vec![vec![]]), 2_000)
            .await
            .unwrap();

        assert_eq!(report.fetched, 0);
        assert_eq!(
            index.get_meta(META_CURSOR).await.unwrap().as_deref(),
            Some("2026-01-01T00:00:00")
        );
    }

    #[tokio::test]
    async fn 超过一周会重做完整同步并移除已删除的文章() {
        let (_dir, index) = new_index();
        run_sync(
            &index,
            &FakeSource::new(vec![vec![
                wp(1, "A", "2026-01-01T00:00:00"),
                wp(2, "B", "2026-01-02T00:00:00"),
            ]]),
            1_000,
        )
        .await
        .unwrap();

        let later = 1_000 + FULL_RESYNC_SECS;
        let report = run_sync(
            &index,
            &FakeSource::new(vec![vec![wp(2, "B", "2026-01-02T00:00:00")]]),
            later,
        )
        .await
        .unwrap();

        assert!(report.full);
        assert_eq!(report.removed, 1);
        assert!(index.get(1).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn 中途失败不更新游标也不标记完成但已写入的页保留() {
        let (_dir, index) = new_index();
        let mut source = FakeSource::new(vec![
            vec![wp(1, "A", "2026-01-01T00:00:00")],
            vec![wp(2, "B", "2026-01-02T00:00:00")],
        ]);
        source.fail_on_page = Some(2);

        assert!(run_sync(&index, &source, 1_000).await.is_err());

        assert_eq!(index.get_meta(META_CURSOR).await.unwrap(), None);
        assert_eq!(index.get_meta(META_SYNCED_AT).await.unwrap(), None);
        assert_eq!(index.count().await.unwrap(), 1);
    }
}
