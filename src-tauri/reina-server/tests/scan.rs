mod support;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::Query;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use axum::routing::get;
use axum::{Json, Router};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde_json::{Value, json};
use support::{OWNER_ID, SECRET, TestApp};

type Listing = Arc<Mutex<Vec<Value>>>;

fn forwarded_owner_token(headers: &HeaderMap) -> bool {
    let Some(token) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };

    decode::<Value>(
        token,
        &DecodingKey::from_secret(SECRET.as_bytes()),
        &Validation::new(Algorithm::HS256),
    )
    .map(|data| data.claims["user_id"] == json!(OWNER_ID))
    .unwrap_or(false)
}

async fn spawn(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

async fn fake_teledrive(listing: Listing, accept_owner: bool) -> String {
    spawn(
        Router::new()
            .route(
                "/api/v1/folders",
                get({
                    let listing = listing.clone();
                    move |headers: HeaderMap, Query(query): Query<HashMap<String, String>>| {
                        let listing = listing.clone();
                        async move {
                            if !accept_owner || !forwarded_owner_token(&headers) {
                                return Err(StatusCode::UNAUTHORIZED);
                            }
                            let files: Vec<Value> = if query.get("parent_id").is_none() {
                                vec![json!({
                                    "file_id": "g",
                                    "filename": "game",
                                    "isDir": true,
                                    "created_at": "2026-01-01T00:00:00"
                                })]
                            } else {
                                listing
                                    .lock()
                                    .unwrap()
                                    .iter()
                                    .filter(|value| value["isDir"] == true)
                                    .cloned()
                                    .collect()
                            };
                            Ok(Json(json!({
                                "total": files.len(),
                                "files": files,
                                "page": 1,
                                "page_size": 0
                            })))
                        }
                    }
                }),
            )
            .route(
                "/api/v1/files",
                get({
                    let listing = listing.clone();
                    move |headers: HeaderMap| {
                        let listing = listing.clone();
                        async move {
                            if !accept_owner || !forwarded_owner_token(&headers) {
                                return Err(StatusCode::UNAUTHORIZED);
                            }
                            let files: Vec<Value> = listing
                                .lock()
                                .unwrap()
                                .iter()
                                .filter(|value| value["isDir"] == false)
                                .cloned()
                                .collect();
                            Ok(Json(json!({
                                "total": files.len(),
                                "files": files,
                                "page": 1,
                                "page_size": 10000
                            })))
                        }
                    }
                }),
            ),
    )
    .await
}

fn item(name: &str, is_dir: bool) -> Value {
    json!({
        "file_id": format!("id-{name}"),
        "filename": name,
        "isDir": is_dir,
        "created_at": "2026-01-01T00:00:00"
    })
}

async fn call(app: &TestApp, method: Method, uri: &str) -> (StatusCode, Value) {
    let response = app
        .send(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", app.owner_token()),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    (
        response.status,
        serde_json::from_slice(&response.body).unwrap_or(Value::Null),
    )
}

async fn app_with(listing: Listing) -> TestApp {
    let base = fake_teledrive(listing, true).await;
    TestApp::with_config(move |config| config.teledrive_api = base).await
}

#[tokio::test]
async fn 掃描建立_pending_條目_重掃不重複() {
    let listing: Listing = Arc::new(Mutex::new(vec![
        item("Foo", true),
        item("Bar.zip", false),
        item("Baz.ZIP", false),
        item("notes.txt", false),
    ]));
    let app = app_with(listing.clone()).await;
    let before = app.data_version().await;

    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["added_ids"].as_array().unwrap().len(), 3);
    assert_eq!(json["pending_ids"].as_array().unwrap().len(), 3);
    assert_eq!(app.data_version().await, before + 1);

    let (_, pending) = call(&app, Method::GET, "/game/api/scan/pending").await;
    let mut paths: Vec<String> = pending
        .as_array()
        .unwrap()
        .iter()
        .map(|row| row["teledrive_path"].as_str().unwrap().to_string())
        .collect();
    paths.sort();
    assert_eq!(paths, vec!["game/Bar", "game/Baz", "game/Foo"]);
    assert!(
        pending
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["scan_status"] == "pending")
    );

    listing.lock().unwrap().push(item("New.zip", false));
    let (_, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(json["added_ids"].as_array().unwrap().len(), 1);
    assert_eq!(json["pending_ids"].as_array().unwrap().len(), 4);
}

#[tokio::test]
async fn 沒有新遊戲時重掃不改變版本() {
    let listing: Listing = Arc::new(Mutex::new(vec![item("Foo", true)]));
    let app = app_with(listing).await;
    call(&app, Method::POST, "/game/api/scan").await;
    let before = app.data_version().await;

    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::OK);
    assert!(json["added_ids"].as_array().unwrap().is_empty());
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn 並行掃描只會建立一次() {
    let listing: Listing = Arc::new(Mutex::new(vec![item("Foo", true), item("Bar.zip", false)]));
    let app = app_with(listing).await;

    let (a, b) = tokio::join!(
        call(&app, Method::POST, "/game/api/scan"),
        call(&app, Method::POST, "/game/api/scan")
    );
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    let total =
        a.1["added_ids"].as_array().unwrap().len() + b.1["added_ids"].as_array().unwrap().len();
    assert_eq!(total, 2);

    let (_, pending) = call(&app, Method::GET, "/game/api/scan/pending").await;
    assert_eq!(pending.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn teledrive_拒絕_token_時回_401_且版本不變() {
    let listing: Listing = Arc::new(Mutex::new(vec![]));
    let base = fake_teledrive(listing, false).await;
    let app = TestApp::with_config(move |config| config.teledrive_api = base).await;
    let before = app.data_version().await;

    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(json["code"], "teledrive_unauthorized");
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn 讀取_pending_不改變版本() {
    let listing: Listing = Arc::new(Mutex::new(vec![item("Foo", true)]));
    let app = app_with(listing).await;
    call(&app, Method::POST, "/game/api/scan").await;
    let before = app.data_version().await;

    for _ in 0..3 {
        call(&app, Method::GET, "/game/api/scan/pending").await;
    }
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn 第一次使用沒有_game_資料夾時回_404_且版本不變() {
    let base = spawn(
        Router::new()
            .route(
                "/api/v1/folders",
                get(|| async {
                    Json(json!({
                        "total": 1,
                        "files": [{
                            "file_id": "x",
                            "filename": "photos",
                            "isDir": true,
                            "created_at": "2026-01-01T00:00:00"
                        }],
                        "page": 1,
                        "page_size": 0
                    }))
                }),
            )
            .route(
                "/api/v1/files",
                get(|| async {
                    Json(json!({
                        "total": 0,
                        "files": [],
                        "page": 1,
                        "page_size": 10000
                    }))
                }),
            ),
    )
    .await;
    let app = TestApp::with_config(move |config| config.teledrive_api = base).await;
    let before = app.data_version().await;

    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json["code"], "game_folder_missing");
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn teledrive_列表中途失敗時回_502_不留下任何條目() {
    let base = spawn(
        Router::new()
            .route(
                "/api/v1/folders",
                get(|Query(query): Query<HashMap<String, String>>| async move {
                    if query.get("parent_id").is_none() {
                        Json(json!({
                            "total": 1,
                            "files": [{
                                "file_id": "g",
                                "filename": "game",
                                "isDir": true,
                                "created_at": "2026-01-01T00:00:00"
                            }],
                            "page": 1,
                            "page_size": 0
                        }))
                    } else {
                        Json(json!({
                            "total": 1,
                            "files": [{
                                "file_id": "id-Foo",
                                "filename": "Foo",
                                "isDir": true,
                                "created_at": "2026-01-01T00:00:00"
                            }],
                            "page": 1,
                            "page_size": 0
                        }))
                    }
                }),
            )
            .route(
                "/api/v1/files",
                get(|| async { StatusCode::INTERNAL_SERVER_ERROR }),
            ),
    )
    .await;
    let app = TestApp::with_config(move |config| config.teledrive_api = base).await;
    let before = app.data_version().await;

    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json["code"], "teledrive_unavailable");
    assert_eq!(app.data_version().await, before);

    let (_, pending) = call(&app, Method::GET, "/game/api/scan/pending").await;
    assert!(
        pending.as_array().unwrap().is_empty(),
        "列表失敗時不能寫入任何遊戲"
    );
}
