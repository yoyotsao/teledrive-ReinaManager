mod support;

use std::net::SocketAddr;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::routing::get;
use reina_server::hgamefree::sync::{HttpPostSource, run_sync};
use serde_json::{Value, json};
use support::TestApp;

async fn spawn(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

/// 假的 WordPress：只有一页，两篇文章。
async fn fake_site() -> SocketAddr {
    spawn(Router::new().route(
        "/wp-json/wp/v2/posts",
        get(|| async {
            let mut headers = HeaderMap::new();
            headers.insert("x-wp-totalpages", "1".parse().unwrap());
            headers.insert(header::CONTENT_TYPE, "application/json".parse().unwrap());
            let body = json!([
                {
                    "id": 680535,
                    "modified": "2026-09-27T17:38:59",
                    "title": {"rendered": "與你流落荒島 官方中文 無修版 [420m]"},
                    "content": {"rendered": "<a href=\"https://store.steampowered.com/app/3329430/_/\">Steam</a><a href=\"http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar\">k2s</a>"},
                    "_embedded": {"wp:featuredmedia": [{"source_url": "https://hgamefree.info/c.webp"}]}
                },
                {
                    "id": 682020,
                    "modified": "2026-09-30T20:44:00",
                    "title": {"rendered": "爆弾解体 [免費空間]"},
                    "content": {"rendered": "<a href=\"https://mega.nz/file/pQ00nT5T#key\">MEGA</a>"}
                }
            ]);
            (headers, body.to_string())
        }),
    ))
    .await
}

async fn search(app: &TestApp, query: &str) -> (StatusCode, Value) {
    let response = app
        .send(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/game/api/hgamefree/search?{query}"))
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", app.owner_token()),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let status = response.status;
    (status, serde_json::from_slice(&response.body).unwrap_or(Value::Null))
}

#[tokio::test]
async fn 尚未同步时回报未就绪且不回任何文章() {
    let app = TestApp::new().await;

    let (status, body) = search(&app, "q=Stranded").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ready"], false);
    assert_eq!(body["items"], json!([]));
}

#[tokio::test]
async fn 同步后可用压缩包文件名搜到并带回原始下载连结() {
    let addr = fake_site().await;
    let app = TestApp::with_config(|config| {
        config
            .upstream_overrides
            .insert("hgamefree.info".into(), addr);
    })
    .await;

    let report = run_sync(
        &app.state.hgamefree,
        &HttpPostSource::new(app.state.config.clone()),
        1_000,
    )
    .await
    .unwrap();
    assert!(report.full);
    assert_eq!(report.fetched, 2);

    let (status, body) = search(&app, "q=stranded%20with%20you").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["ready"], true);
    assert_eq!(body["total"], 2);
    assert_eq!(body["items"][0]["id"], "680535");
    assert_eq!(body["items"][0]["file_names"], json!(["Stranded with You"]));
    assert_eq!(
        body["items"][0]["file_url"],
        json!(["http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar"])
    );
    assert_eq!(body["items"][0]["image"], "https://hgamefree.info/c.webp");

    // 用 Steam App ID 反查到同一篇文章
    let (_, by_ext) = search(&app, "ext=getchu:1,steam:3329430").await;
    assert_eq!(by_ext["items"][0]["id"], "680535");
    assert_eq!(by_ext["items"][0]["external_ids"], json!(["steam:3329430"]));
    assert_eq!(search(&app, "ext=steam:1").await.1["items"], json!([]));

    // MEGA 没有文件名，但原始连结仍会保存
    let (_, by_id) = search(&app, "id=682020").await;
    assert_eq!(by_id["items"][0]["file_names"], json!([]));
    assert_eq!(
        by_id["items"][0]["file_url"],
        json!(["https://mega.nz/file/pQ00nT5T#key"])
    );
}

#[tokio::test]
async fn 没有有效_token_回_401() {
    let app = TestApp::new().await;
    let response = app
        .send(
            Request::builder()
                .method(Method::GET)
                .uri("/game/api/hgamefree/search?q=x")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}
