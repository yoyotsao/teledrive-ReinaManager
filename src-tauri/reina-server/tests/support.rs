//! 集成测试共用：临时 SQLite、签 JWT、送请求。
#![allow(dead_code)]

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::{Body, Bytes};
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use http_body_util::BodyExt;
use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
use reina_core::database::dto::InsertGameData;
use reina_core::database::repository::games_repository::GamesRepository;
use reina_server::{AppState, Config, build_router};
use serde_json::{Value, json};
use tempfile::TempDir;
use tower::ServiceExt;

/// 必须与 `Config::for_tests()` 一致（config.rs 有测试守住）
pub const SECRET: &str = "reina-test-secret";
pub const OWNER_ID: i64 = 42;

pub struct TestApp {
    pub router: Router,
    /// 与 router 共用同一个数据库连接、设定与故障注入点
    pub state: AppState,
    pub dir: TempDir,
}

pub struct TestResponse {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl TestResponse {
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).expect("响应必须是 JSON")
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: header::HeaderName) -> Option<String> {
        self.headers
            .get(name)
            .map(|value| value.to_str().unwrap().to_string())
    }
}

pub async fn spawn_app() -> TestApp {
    TestApp::new().await
}

impl TestApp {
    pub async fn new() -> Self {
        Self::with_config(|_| {}).await
    }

    /// 先以 `Config::for_tests()` 加上临时目录建立设定，再交给 `configure` 覆写
    ///（例如把 `teledrive_api` 指到假的 TeleDrive）
    pub async fn with_config(configure: impl FnOnce(&mut Config)) -> Self {
        let dir = tempfile::tempdir().expect("建立临时目录");
        let data_dir = dir.path().join("data");
        let static_dir = dir.path().join("static");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::create_dir_all(static_dir.join("assets")).unwrap();
        std::fs::write(
            static_dir.join("index.html"),
            "<!doctype html><title>reina</title>",
        )
        .unwrap();
        std::fs::write(static_dir.join("assets/app.js"), "console.log('reina');").unwrap();
        std::fs::write(static_dir.join("favicon.ico"), [0u8, 0, 1, 0]).unwrap();
        std::fs::write(dir.path().join("secret.txt"), "outside static dir").unwrap();

        let mut config = Config {
            data_dir,
            static_dir,
            ..Config::for_tests()
        };
        configure(&mut config);
        let db = reina_core::database::connect_database(&config.db_path())
            .await
            .expect("连接测试数据库");
        let state = AppState::new(db, config);

        TestApp {
            router: build_router(state.clone()),
            state,
            dir,
        }
    }

    pub fn owner_token(&self) -> String {
        owner_token()
    }

    pub fn data_dir(&self) -> PathBuf {
        self.state.config.data_dir.clone()
    }

    /// 直接写入数据库建立一个自定义游戏（不经过 RPC，所以不改变 data_version）
    pub async fn insert_game(&self, name: &str) -> i32 {
        let data: InsertGameData = serde_json::from_value(json!({
            "id_type": "custom",
            "custom_data": { "name": name },
        }))
        .expect("建立测试游戏数据");
        GamesRepository::insert(&self.state.db, data)
            .await
            .expect("写入测试游戏")
            .id
    }

    /// 让下一次 `tx::finish` 在 commit 前 rollback 并回传 500
    pub fn fail_next_write_commit(&self) {
        self.state.fault.fail_next();
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}

pub fn token_with(claims: Value, alg: Algorithm, secret: &str) -> String {
    encode(
        &Header::new(alg),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .unwrap()
}

pub fn token_for(user_id: Value, exp_offset_secs: i64) -> String {
    token_with(
        json!({ "user_id": user_id, "exp": now() + exp_offset_secs }),
        Algorithm::HS256,
        SECRET,
    )
}

pub fn owner_token() -> String {
    token_for(json!(OWNER_ID), 3600)
}

impl TestApp {
    pub async fn send(&self, request: Request<Body>) -> TestResponse {
        let response = self.router.clone().oneshot(request).await.unwrap();
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.into_body().collect().await.unwrap().to_bytes();
        TestResponse {
            status,
            headers,
            body,
        }
    }

    pub async fn get(&self, uri: &str, authorization: Option<&str>) -> TestResponse {
        let mut builder = Request::builder().method(Method::GET).uri(uri);
        if let Some(value) = authorization {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        self.send(builder.body(Body::empty()).unwrap()).await
    }

    pub async fn post_raw(
        &self,
        uri: &str,
        body: impl Into<Body>,
        authorization: Option<&str>,
    ) -> TestResponse {
        let mut builder = Request::builder()
            .method(Method::POST)
            .uri(uri)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(value) = authorization {
            builder = builder.header(header::AUTHORIZATION, value);
        }
        self.send(builder.body(body.into()).unwrap()).await
    }

    /// 以拥有者身份调用 RPC
    pub async fn rpc(&self, command: &str, args: Value) -> TestResponse {
        let bearer = format!("Bearer {}", owner_token());
        self.post_raw(
            &format!("/game/api/rpc/{command}"),
            args.to_string(),
            Some(&bearer),
        )
        .await
    }

    pub async fn data_version(&self) -> i64 {
        let bearer = format!("Bearer {}", owner_token());
        let response = self.get("/game/api/version", Some(&bearer)).await;
        assert_eq!(response.status, StatusCode::OK, "{}", response.text());
        response.json()["data_version"]
            .as_i64()
            .expect("data_version 必须是整数")
    }
}

impl TestApp {
    /// 直接写入一张来源封面（不经网络），返回 cover_version。
    pub async fn seed_source_cover(&self, game_id: i32, bytes: &[u8]) -> String {
        let kind = reina_server::api::covers::sniff::sniff(bytes).expect("image");
        let staged = reina_server::api::covers::handlers::cover_store(&self.state)
            .put(game_id, bytes, kind)
            .await
            .unwrap();
        let txn = sea_orm::TransactionTrait::begin(&self.state.db)
            .await
            .unwrap();
        reina_core::database::repository::games_repository::GamesRepository::set_cover_hashes_in_connection(
            &txn,
            game_id,
            Some(Some(staged.hash.clone())),
            None,
        )
        .await
        .unwrap();
        txn.commit().await.unwrap();
        staged.hash
    }
}
