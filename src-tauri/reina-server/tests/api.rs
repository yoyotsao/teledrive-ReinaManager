mod support;

use axum::http::{StatusCode, header};
use jsonwebtoken::Algorithm;
use serde_json::json;
use support::{OWNER_ID, SECRET, owner_token, spawn_app, token_for, token_with};

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

#[tokio::test]
async fn 版本端点需要_bearer_token() {
    let app = spawn_app().await;

    let missing = app.get("/game/api/version", None).await;
    assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
    assert_eq!(missing.json()["code"], "unauthorized");

    let wrong_scheme = app
        .get(
            "/game/api/version",
            Some(&format!("Basic {}", owner_token())),
        )
        .await;
    assert_eq!(wrong_scheme.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn 过期_签名错误_算法错误都回_401() {
    let app = spawn_app().await;
    let tokens = [
        token_for(json!(OWNER_ID), -1),
        token_with(
            json!({"user_id": OWNER_ID, "exp": 4_102_444_800i64}),
            Algorithm::HS256,
            "wrong",
        ),
        token_with(
            json!({"user_id": OWNER_ID, "exp": 4_102_444_800i64}),
            Algorithm::HS512,
            SECRET,
        ),
        token_with(json!({"user_id": OWNER_ID}), Algorithm::HS256, SECRET),
    ];
    for token in tokens {
        let response = app.get("/game/api/version", Some(&bearer(&token))).await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "token {token}");
        assert_eq!(
            response.header(header::CACHE_CONTROL).as_deref(),
            Some("no-store")
        );
    }
}

#[tokio::test]
async fn 不是拥有者回_403() {
    let app = spawn_app().await;
    let response = app
        .get(
            "/game/api/version",
            Some(&bearer(&token_for(json!(7), 3600))),
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.json()["code"], "forbidden");
}

#[tokio::test]
async fn 版本从_0_开始而且不可缓存() {
    let app = spawn_app().await;
    let response = app
        .get(
            "/game/api/version",
            Some(&bearer(&token_for(json!("42"), 3600))),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({"data_version": 0}));
    assert_eq!(
        response.header(header::CACHE_CONTROL).as_deref(),
        Some("no-store")
    );
}

fn list_args() -> serde_json::Value {
    json!({"gameType": "all", "sortOption": "addtime", "sortOrder": "asc", "language": null})
}

#[tokio::test]
async fn rpc_需要登入() {
    let app = spawn_app().await;
    let response = app.post_raw("/game/api/rpc/count_games", "{}", None).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn 未知或桌面专属的_command_回_404_且不改版本() {
    let app = spawn_app().await;
    for name in [
        "no_such_command",
        "launch_game",
        "copy_file",
        "import_database",
        "update_proxy_config",
    ] {
        let response = app.rpc(name, json!({})).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{name}");
        assert_eq!(response.json()["code"], "not_found");
    }
    assert_eq!(app.data_version().await, 0);
}

#[tokio::test]
async fn 参数错误回_400_且不改版本() {
    let app = spawn_app().await;
    let bearer = bearer(&owner_token());

    let wrong_type = app
        .rpc("create_collection", json!({"name": 1, "sortOrder": 0}))
        .await;
    assert_eq!(wrong_type.status, StatusCode::BAD_REQUEST);
    assert_eq!(wrong_type.json()["code"], "invalid_arguments");

    let not_object = app
        .post_raw("/game/api/rpc/count_games", "[]", Some(&bearer))
        .await;
    assert_eq!(not_object.status, StatusCode::BAD_REQUEST);

    let malformed = app
        .post_raw("/game/api/rpc/count_games", "{", Some(&bearer))
        .await;
    assert_eq!(malformed.status, StatusCode::BAD_REQUEST);

    assert_eq!(app.data_version().await, 0);
}

#[tokio::test]
async fn 空_body_视为没有参数() {
    let app = spawn_app().await;
    let response = app
        .post_raw(
            "/game/api/rpc/count_games",
            "",
            Some(&bearer(&owner_token())),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.json(), json!(0));
}

#[tokio::test]
async fn 连续读取不会改变版本() {
    let app = spawn_app().await;
    for _ in 0..10 {
        let games = app.rpc("find_all_games", list_args()).await;
        assert_eq!(games.status, StatusCode::OK, "{}", games.text());
        assert_eq!(games.json(), json!([]));
        assert_eq!(
            app.rpc("find_game_ids", list_args()).await.status,
            StatusCode::OK
        );
        assert_eq!(
            app.rpc("find_game_by_id", json!({"id": 1})).await.json(),
            json!(null)
        );
        assert_eq!(app.rpc("count_games", json!({})).await.json(), json!(0));
        assert_eq!(
            app.rpc("get_all_settings", json!({})).await.status,
            StatusCode::OK
        );
        assert_eq!(
            app.rpc("find_root_collections", json!({})).await.json(),
            json!([])
        );
        assert_eq!(
            app.rpc("get_all_game_statistics", json!({})).await.status,
            StatusCode::OK
        );
    }
    assert_eq!(app.data_version().await, 0);
}

#[tokio::test]
async fn 写入成功时版本恰好加_1() {
    let app = spawn_app().await;

    let created = app
        .rpc(
            "create_collection",
            json!({"name": "合集A", "parentId": null, "sortOrder": 0}),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    assert_eq!(created.json()["name"], "合集A");
    assert_eq!(app.data_version().await, 1);

    let roots = app.rpc("find_root_collections", json!({})).await.json();
    assert_eq!(roots.as_array().unwrap().len(), 1);
    assert_eq!(app.data_version().await, 1);

    let id = created.json()["id"].as_i64().unwrap();
    let deleted = app.rpc("delete_collection", json!({"id": id})).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert_eq!(deleted.json(), json!(1));
    assert_eq!(app.data_version().await, 2);
}

#[tokio::test]
async fn 写入失败时_rollback_且版本不变() {
    let app = spawn_app().await;
    // 不存在的会话：仓库回传 RecordNotFound
    let response = app
        .rpc("delete_game_session", json!({"sessionId": 999_999}))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.json()["code"], "command_failed");
    assert!(
        response.json()["message"]
            .as_str()
            .unwrap()
            .starts_with("删除游戏会话失败"),
        "错误消息沿用桌面版前缀：{}",
        response.text()
    );
    assert_eq!(app.data_version().await, 0);
}

#[tokio::test]
async fn 注入_commit_失败时数据与版本都不变() {
    let app = spawn_app().await;
    app.fail_next_write_commit();
    let response = app
        .rpc(
            "create_collection",
            json!({"name": "合集A", "parentId": null, "sortOrder": 0}),
        )
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(
        app.rpc("find_root_collections", json!({})).await.json(),
        json!([])
    );
    assert_eq!(app.data_version().await, 0);

    // 故障只作用一次：下一次写入正常 commit
    let retried = app
        .rpc(
            "create_collection",
            json!({"name": "合集A", "parentId": null, "sortOrder": 0}),
        )
        .await;
    assert_eq!(retried.status, StatusCode::OK, "{}", retried.text());
    assert_eq!(app.data_version().await, 1);
}

#[tokio::test]
async fn 未知的_api_路径回_json_404() {
    let app = spawn_app().await;
    let response = app
        .get("/game/api/nope", Some(&bearer(&owner_token())))
        .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["code"], "not_found");
}
