mod support;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode, header};
use support::TestApp;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\ncover-one";
const JPG: &[u8] = b"\xFF\xD8\xFF\xE0cover-two";

async fn put_cover(
    app: &TestApp,
    id: i32,
    bytes: &'static [u8],
) -> (StatusCode, serde_json::Value) {
    let request = Request::builder()
        .method(Method::PUT)
        .uri(format!("/game/api/covers/{id}"))
        .header(
            header::AUTHORIZATION,
            format!("Bearer {}", app.owner_token()),
        )
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(bytes))
        .unwrap();
    let response = app.send(request).await;
    let status = response.status;
    let body = response.body.clone();
    (
        status,
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
    )
}

async fn get_cover(app: &TestApp, id: i32, v: &str) -> support::TestResponse {
    app.send(
        Request::builder()
            .uri(format!("/game/api/covers/{id}?v={v}"))
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", app.owner_token()),
            )
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn 未登入被拒() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let response = app
        .send(
            Request::builder()
                .uri(format!("/game/api/covers/{id}?v=x"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn 上传后以版本网址取得且缓存为_immutable() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let before = app.data_version().await;
    let (status, json) = put_cover(&app, id, PNG).await;
    assert_eq!(status, StatusCode::OK);
    let version = json["cover_version"].as_str().unwrap().to_string();
    assert_eq!(app.data_version().await, before + 1);

    let response = get_cover(&app, id, &version).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(
        response.headers[header::CACHE_CONTROL],
        "private, max-age=31536000, immutable"
    );
    assert_eq!(response.headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(response.headers[header::ETAG], format!("\"{version}\""));
    assert_eq!(response.body.clone().as_ref(), PNG);
}

#[tokio::test]
async fn 旧版本返回_302_到目前版本且_no_store() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let (_, first) = put_cover(&app, id, PNG).await;
    let (_, second) = put_cover(&app, id, JPG).await;
    let old = first["cover_version"].as_str().unwrap();
    let new = second["cover_version"].as_str().unwrap();
    let response = get_cover(&app, id, old).await;
    assert_eq!(response.status, StatusCode::FOUND);
    assert_eq!(
        response.headers[header::LOCATION],
        format!("/game/api/covers/{id}?v={new}")
    );
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn 非图片_415_超过上限_413_版本都不变() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let before = app.data_version().await;
    let (status, _) = put_cover(&app, id, b"<html>nope</html>").await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let big: &'static [u8] = Box::leak(vec![0xFFu8; 10 * 1024 * 1024 + 1].into_boxed_slice());
    let (status, _) = put_cover(&app, id, big).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn 删除自定义封面后回到来源封面() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let source_version = app.seed_source_cover(id, JPG).await;
    let (_, custom) = put_cover(&app, id, PNG).await;
    assert_ne!(custom["cover_version"].as_str().unwrap(), source_version);
    let response = app
        .send(
            Request::builder()
                .method(Method::DELETE)
                .uri(format!("/game/api/covers/{id}"))
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", app.owner_token()),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&response.body.clone()).unwrap();
    assert_eq!(json["cover_version"].as_str().unwrap(), source_version);
}

#[tokio::test]
async fn 写入_transaction_失败时新文件被删除且旧封面仍可取得() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let (_, first) = put_cover(&app, id, PNG).await;
    let first = first["cover_version"].as_str().unwrap().to_string();
    app.fail_next_write_commit(); // 任务 3 测试工具：让下一次 tx::finish 在 commit 前 rollback 并回 500
    let (status, _) = put_cover(&app, id, JPG).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let covers_dir = app.data_dir().join(format!("covers/game_{id}"));
    let files: Vec<_> = std::fs::read_dir(&covers_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .collect();
    assert_eq!(files.len(), 1, "只剩原本的封面文件");
    assert_eq!(get_cover(&app, id, &first).await.status, StatusCode::OK);
}

#[tokio::test]
async fn 删除游戏在_commit_成功后才清除封面目录() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    put_cover(&app, id, PNG).await;
    let covers_dir = app.data_dir().join(format!("covers/game_{id}"));
    assert!(covers_dir.exists());

    app.fail_next_write_commit();
    let failed = app
        .rpc("delete_game", serde_json::json!({ "id": id }))
        .await;
    assert_eq!(failed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(covers_dir.exists(), "commit 失败时封面必须保留");

    let deleted = app
        .rpc("delete_game", serde_json::json!({ "id": id }))
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert!(!covers_dir.exists());
}

#[tokio::test]
async fn 批量删除游戏也会清除每个封面目录() {
    let app = TestApp::new().await;
    let a = app.insert_game("A").await;
    let b = app.insert_game("B").await;
    put_cover(&app, a, PNG).await;
    put_cover(&app, b, JPG).await;
    let deleted = app
        .rpc("delete_games_batch", serde_json::json!({ "ids": [a, b] }))
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    for id in [a, b] {
        assert!(!app.data_dir().join(format!("covers/game_{id}")).exists());
    }
}

#[tokio::test]
async fn 不存在的游戏返回_404() {
    let app = TestApp::new().await;
    let (status, _) = put_cover(&app, 999, PNG).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        get_cover(&app, 999, "x").await.status,
        StatusCode::NOT_FOUND
    );
}

/// 依 302 的 Location 找到目前版本并取得；返回最终状态码
async fn get_current_cover(app: &TestApp, id: i32, any_version: &str) -> StatusCode {
    let first = get_cover(app, id, any_version).await;
    if first.status != StatusCode::FOUND {
        return first.status;
    }
    let location = first.headers[header::LOCATION]
        .to_str()
        .unwrap()
        .to_string();
    let current = location
        .rsplit_once("v=")
        .map(|(_, v)| v.to_string())
        .unwrap();
    get_cover(app, id, &current).await.status
}

#[tokio::test]
async fn 同一个游戏并行更换封面_目前封面的文件一定存在() {
    // A、B 同时上传不同图片：没有逐游戏的锁时，先 commit 的一方清理旧文件会删掉
    // 另一方刚写好、尚未 commit 的文件，之后数据库会指向不存在的文件
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    for _ in 0..20 {
        let ((sa, ja), (sb, jb)) = tokio::join!(put_cover(&app, id, PNG), put_cover(&app, id, JPG));
        assert_eq!(sa, StatusCode::OK);
        assert_eq!(sb, StatusCode::OK);
        let va = ja["cover_version"].as_str().unwrap().to_string();
        let vb = jb["cover_version"].as_str().unwrap().to_string();
        assert_eq!(get_current_cover(&app, id, &va).await, StatusCode::OK);
        assert_eq!(get_current_cover(&app, id, &vb).await, StatusCode::OK);
    }
}
