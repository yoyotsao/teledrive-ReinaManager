//! 汇总 `/game/api` 的路由。任务 7、8、9 在标记处挂上自己的子路由。

use axum::Router;
use axum::routing::{any, get, post};

use crate::api::{covers, rpc, version};
use crate::app::AppState;
use crate::error::ApiError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/version", get(version::get_version))
        .route("/rpc/{command}", post(rpc::call))
        .merge(covers::handlers::routes())
        // 任务 8：.merge(crate::api::metadata::routes())
        // 任务 9：.merge(crate::api::scan::routes())
        // 用真实的通配符路由（而不是 `Router::fallback`）承接 `/game/api` 下未匹配的路径：
        // `.fallback()` 会被 axum 存进独立的 fallback_router，一旦嵌套进带有
        // `/game/{*path}` 通配符路由的外层 Router，两者在 matchit 里都是通配符匹配，
        // 外层会在这里“没有命中真实路由”时抢先匹配，导致 `/game/api/xxx` 落到静态文件
        // 兜底而不是这里的 JSON 404。改成一个真正注册在这棵路由树里的通配符路由，
        // 就能让它在 `/game/api/` 这个更长的静态前缀下正常优先匹配。
        .route("/{*rest}", any(api_not_found))
}

/// `/game/api` 底下没有对应路由时回 JSON，而不是前端的 index.html
async fn api_not_found() -> ApiError {
    ApiError::not_found("找不到这个 API")
}
