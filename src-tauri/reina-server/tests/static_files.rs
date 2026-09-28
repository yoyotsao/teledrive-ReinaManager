mod support;

use axum::http::{StatusCode, header};
use support::spawn_app;

#[tokio::test]
async fn 健康检查不需要登入() {
    let app = spawn_app().await;
    let response = app.get("/game/healthz", None).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.text(), "ok");
}

#[tokio::test]
async fn 没有斜线的_game_导向_game_斜线() {
    let app = spawn_app().await;
    let response = app.get("/game", None).await;
    assert_eq!(response.status, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(response.header(header::LOCATION).as_deref(), Some("/game/"));
}

#[tokio::test]
async fn 首页与深层路由都回_index_html() {
    let app = spawn_app().await;
    for uri in [
        "/game/",
        "/game/libraries/12",
        "/game/settings/account",
        "/game/libraries/12/",
    ] {
        let response = app.get(uri, None).await;
        assert_eq!(response.status, StatusCode::OK, "{uri}");
        assert!(response.text().contains("<title>reina</title>"), "{uri}");
        assert_eq!(
            response.header(header::CACHE_CONTROL).as_deref(),
            Some("no-cache"),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn 静态资源带正确类型与长缓存() {
    let app = spawn_app().await;
    let response = app.get("/game/assets/app.js", None).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.text(), "console.log('reina');");
    assert!(
        response
            .header(header::CONTENT_TYPE)
            .unwrap()
            .contains("javascript"),
        "{:?}",
        response.header(header::CONTENT_TYPE)
    );
    assert_eq!(
        response.header(header::CACHE_CONTROL).as_deref(),
        Some("public, max-age=31536000, immutable")
    );

    let icon = app.get("/game/favicon.ico", None).await;
    assert_eq!(icon.status, StatusCode::OK);
    assert_eq!(
        icon.header(header::CACHE_CONTROL).as_deref(),
        Some("no-cache")
    );
}

#[tokio::test]
async fn 不存在的资源文件回_404_不回首页() {
    let app = spawn_app().await;
    for uri in ["/game/assets/missing.js", "/game/logo.png"] {
        let response = app.get(uri, None).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{uri}");
        assert!(!response.text().contains("<title>reina</title>"), "{uri}");
    }
}

#[tokio::test]
async fn 路径穿越被拒绝() {
    let app = spawn_app().await;
    for uri in [
        "/game/../secret.txt",
        "/game/%2e%2e/secret.txt",
        "/game/assets/..%2f..%2fsecret.txt",
        "/game/..%5csecret.txt",
    ] {
        let response = app.get(uri, None).await;
        assert_ne!(response.status, StatusCode::OK, "{uri}");
        assert!(!response.text().contains("outside static dir"), "{uri}");
    }
}

#[tokio::test]
async fn api_路径不会回前端首页() {
    let app = spawn_app().await;
    let response = app.get("/game/api/unknown/deep", None).await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["code"], "not_found");
}
