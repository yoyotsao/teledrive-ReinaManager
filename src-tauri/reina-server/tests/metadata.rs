mod support;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::routing::{get, post};
use serde_json::{Value, json};
use support::TestApp;

async fn spawn(router: Router) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    addr
}

async fn proxy(app: &TestApp, body: Value) -> (StatusCode, Value) {
    let response = app
        .send(
            Request::builder()
                .method(Method::POST)
                .uri("/game/api/metadata/request")
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", app.owner_token()),
                )
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await;
    let status = response.status;
    let bytes = response.body.clone();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn 轉送請求且不外洩_teledrive_token_也不改變版本() {
    let seen: Arc<Mutex<Vec<HeaderMap>>> = Arc::default();
    let seen2 = seen.clone();
    let addr = spawn(Router::new().route(
        "/kana/vn",
        post(move |headers: HeaderMap, body: String| {
            seen2.lock().unwrap().push(headers);
            async move {
                (
                    [(header::CONTENT_TYPE, "application/json")],
                    format!("{{\"echo\":{body}}}"),
                )
            }
        }),
    ))
    .await;
    let app = TestApp::with_config(|config| {
        config
            .upstream_overrides
            .insert("api.vndb.org".into(), addr);
    })
    .await;

    let before = app.data_version().await;
    let (status, json) = proxy(
        &app,
        json!({
            "source": "vndb",
            "method": "POST",
            "url": "https://api.vndb.org/kana/vn",
            "headers": {"Content-Type": "application/json", "Accept": "application/json"},
            "body": "{\"filters\":[]}"
        }),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], 200);
    assert_eq!(json["body"], "{\"echo\":{\"filters\":[]}}");
    let headers = seen.lock().unwrap()[0].clone();
    let token = app.owner_token();
    assert!(
        headers
            .values()
            .all(|value| !value.to_str().unwrap_or("").contains(&token))
    );
    assert!(headers.get(header::AUTHORIZATION).is_none());
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn 拒絕白名單外_host_與來源不符() {
    let app = TestApp::new().await;
    let (status, json) = proxy(
        &app,
        json!({
            "source": null,
            "method": "GET",
            "url": "https://example.com/",
            "headers": {},
            "body": null
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(json["code"], "upstream_forbidden");

    let (status, _) = proxy(
        &app,
        json!({
            "source": "bgm",
            "method": "GET",
            "url": "https://api.vndb.org/kana/vn",
            "headers": {},
            "body": null
        }),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = proxy(
        &app,
        json!({
            "source": null,
            "method": "DELETE",
            "url": "https://api.bgm.tv/v0/me",
            "headers": {},
            "body": null
        }),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn 同一來源的請求在伺服器端被節流() {
    let addr = spawn(Router::new().route("/v0/subjects/1", get(|| async { "{}" }))).await;
    let app = TestApp::with_config(|config| {
        config.upstream_overrides.insert("api.bgm.tv".into(), addr);
    })
    .await;
    let body = json!({
        "source": "bgm",
        "method": "GET",
        "url": "https://api.bgm.tv/v0/subjects/1",
        "headers": {},
        "body": null
    });

    let start = Instant::now();
    let (a, b) = tokio::join!(proxy(&app, body.clone()), proxy(&app, body));
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert!(start.elapsed() >= Duration::from_millis(250));
}

#[tokio::test]
async fn vndb_429_依_retry_after_重試最多兩次_其他來源直接回傳_429() {
    let hits = Arc::new(Mutex::new(0u32));
    let hits2 = hits.clone();
    let vndb = spawn(Router::new().route(
        "/kana/vn",
        post(move || {
            let hits = hits2.clone();
            async move {
                let mut count = hits.lock().unwrap();
                *count += 1;
                if *count <= 2 {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(header::RETRY_AFTER, "1")],
                        "slow down",
                    )
                } else {
                    (StatusCode::OK, [(header::RETRY_AFTER, "0")], "{}")
                }
            }
        }),
    ))
    .await;
    let bgm = spawn(Router::new().route(
        "/v0/subjects/2",
        get(|| async {
            (
                StatusCode::TOO_MANY_REQUESTS,
                [(header::RETRY_AFTER, "3600")],
                "limited",
            )
        }),
    ))
    .await;
    let app = TestApp::with_config(|config| {
        config
            .upstream_overrides
            .insert("api.vndb.org".into(), vndb);
        config.upstream_overrides.insert("api.bgm.tv".into(), bgm);
    })
    .await;

    let (status, json) = proxy(
        &app,
        json!({
            "source": "vndb",
            "method": "POST",
            "url": "https://api.vndb.org/kana/vn",
            "headers": {},
            "body": "{}"
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], 200);
    assert_eq!(*hits.lock().unwrap(), 3);

    let (status, json) = proxy(
        &app,
        json!({
            "source": "bgm",
            "method": "GET",
            "url": "https://api.bgm.tv/v0/subjects/2",
            "headers": {},
            "body": null
        }),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], 429);
    let retry_after = json["headers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|pair| pair[0] == "retry-after")
        .unwrap();
    assert_eq!(retry_after[1], "3600");
}

#[tokio::test]
async fn vndb_退避期間其他請求也不會打到上游() {
    let hits: Arc<Mutex<Vec<std::time::Instant>>> = Arc::default();
    let hits2 = hits.clone();
    let vndb = spawn(Router::new().route(
        "/kana/vn",
        post(move || {
            let hits = hits2.clone();
            async move {
                let mut hits = hits.lock().unwrap();
                hits.push(std::time::Instant::now());
                if hits.len() == 1 {
                    (
                        StatusCode::TOO_MANY_REQUESTS,
                        [(header::RETRY_AFTER, "3")],
                        "slow down",
                    )
                } else {
                    (StatusCode::OK, [(header::RETRY_AFTER, "0")], "{}")
                }
            }
        }),
    ))
    .await;
    let app = TestApp::with_config(|config| {
        config
            .upstream_overrides
            .insert("api.vndb.org".into(), vndb);
    })
    .await;
    let body = json!({
        "source": "vndb",
        "method": "POST",
        "url": "https://api.vndb.org/kana/vn",
        "headers": {},
        "body": "{}"
    });

    let (a, b) = tokio::join!(proxy(&app, body.clone()), proxy(&app, body));
    assert_eq!(a.1["status"], 200);
    assert_eq!(b.1["status"], 200);
    let hits = hits.lock().unwrap();
    assert_eq!(hits.len(), 3);
    let limited_at = hits[0];
    for later in &hits[1..] {
        assert!(*later - limited_at >= Duration::from_secs(3));
    }
}

#[tokio::test]
async fn 圖片代理只接受圖床_host_且內容必須是圖片() {
    let addr = spawn(
        Router::new()
            .route(
                "/cv/1.jpg",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "image/jpeg")],
                        b"\xFF\xD8\xFF\xE0jpeg".to_vec(),
                    )
                }),
            )
            .route("/cv/html", get(|| async { "<html></html>" })),
    )
    .await;
    let app = TestApp::with_config(|config| {
        config.upstream_overrides.insert("t.vndb.org".into(), addr);
    })
    .await;

    let encoded_image: String =
        url::form_urlencoded::byte_serialize(b"https://t.vndb.org/cv/1.jpg").collect();
    let encoded_html: String =
        url::form_urlencoded::byte_serialize(b"https://t.vndb.org/cv/html").collect();
    let encoded_bad: String =
        url::form_urlencoded::byte_serialize(b"https://example.com/a.jpg").collect();

    let request = |encoded: &str| {
        Request::builder()
            .uri(format!("/game/api/metadata/image?url={encoded}"))
            .header(
                header::AUTHORIZATION,
                format!("Bearer {}", app.owner_token()),
            )
            .body(Body::empty())
            .unwrap()
    };

    let ok = app.send(request(&encoded_image)).await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(ok.headers[header::CACHE_CONTROL], "private, max-age=86400");
    assert_eq!(
        app.send(request(&encoded_html)).await.status,
        StatusCode::UNSUPPORTED_MEDIA_TYPE
    );
    assert_eq!(
        app.send(request(&encoded_bad)).await.status,
        StatusCode::FORBIDDEN
    );
}
