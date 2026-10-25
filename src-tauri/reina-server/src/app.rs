//! 服务器状态与最外层路由。

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::response::Redirect;
use axum::routing::get;

use crate::config::Config;
use crate::hgamefree::index::HgamefreeIndex;
use crate::stores::UserStores;
use crate::tx::CommitFault;
use crate::{api, static_files};

#[derive(Clone)]
pub struct AppState {
    /// 每位使用者各自的数据库与封面目录；没有全域连线，所有数据访问都要先经过 `AuthUser`
    pub stores: Arc<UserStores>,
    /// HGameFree 文章索引：全站共用，放在 `<data_dir>/hgamefree.db`，不属于任何使用者
    pub hgamefree: Arc<HgamefreeIndex>,
    pub config: Arc<Config>,
    /// 对外请求（TeleDrive API、元数据来源、封面下载）共用的 client
    pub http: reqwest::Client,
    /// 只给测试注入 commit 失败；正式环境永远不触发
    #[doc(hidden)]
    pub fault: Arc<CommitFault>,
}

impl AppState {
    pub fn new(config: Config) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("ReinaManager-server/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("建立 HTTP client 失败");
        Self {
            stores: Arc::new(UserStores::new(config.data_dir.clone(), config.max_users)),
            hgamefree: Arc::new(HgamefreeIndex::new(config.data_dir.join("hgamefree.db"))),
            config: Arc::new(config),
            http,
            fault: Arc::new(CommitFault::default()),
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/game", get(redirect_to_slash))
        .route("/game/healthz", get(healthz))
        .nest("/game/api", api::routes())
        .route("/game/", get(static_files::serve_index))
        .route("/game/{*path}", get(static_files::serve_path))
        .with_state(state)
}

async fn redirect_to_slash() -> Redirect {
    Redirect::permanent("/game/")
}

async fn healthz() -> &'static str {
    "ok"
}
