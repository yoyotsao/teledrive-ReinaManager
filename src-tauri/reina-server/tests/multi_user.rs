//! 多使用者隔离：每位 TeleDrive 使用者只看得到自己的游戏库、封面与 data_version。
mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use serde_json::json;
use support::{OWNER_ID, TestApp, user_token};

/// 使用者 A 是 `OWNER_ID`，使用者 B 是另一位 TeleDrive 使用者
const USER_B: i64 = 7;

#[tokio::test]
async fn 使用者看不到别人的游戏() {
    let app = TestApp::new().await;
    let game_a = app.insert_game("A 的游戏").await;

    assert_eq!(app.rpc("count_games", json!({})).await.json(), json!(1));
    assert_eq!(
        app.rpc_as(USER_B, "count_games", json!({})).await.json(),
        json!(0)
    );
    // 各库 id 各自从 1 起算：B 拿 A 的 id 查不到东西
    assert_eq!(
        app.rpc_as(USER_B, "find_game_by_id", json!({ "id": game_a }))
            .await
            .json(),
        json!(null)
    );
}

#[tokio::test]
async fn 使用者写入不会改变别人的_data_version() {
    let app = TestApp::new().await;

    let created = app
        .rpc(
            "create_collection",
            json!({"name": "A 的合集", "sortOrder": 0}),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());

    assert_eq!(app.data_version_of(OWNER_ID).await, 1);
    assert_eq!(app.data_version_of(USER_B).await, 0);
    assert_eq!(
        app.rpc_as(USER_B, "find_root_collections", json!({}))
            .await
            .json(),
        json!([])
    );
}

#[tokio::test]
async fn 封面按使用者存放而且互相读不到() {
    let app = TestApp::new().await;
    let game_a = app.insert_game("A 的游戏").await;
    let version = app
        .seed_source_cover(game_a, b"\x89PNG\r\n\x1a\nowner-cover")
        .await;
    // B 也有一个 id 相同的游戏，但没有封面
    let game_b = app.insert_game_for(USER_B, "B 的游戏").await;
    assert_eq!(
        game_a, game_b,
        "两个库的第一个游戏 id 应该相同，才能测出隔离"
    );

    let response = app
        .send(
            Request::builder()
                .uri(format!("/game/api/covers/{game_b}?v={version}"))
                .header(
                    header::AUTHORIZATION,
                    format!("Bearer {}", user_token(USER_B)),
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["code"], "cover_not_found");

    let a_covers = app.data_dir().join(format!("users/{OWNER_ID}/covers"));
    let b_covers = app.data_dir().join(format!("users/{USER_B}/covers"));
    assert!(a_covers.exists(), "A 的封面应存在自己的目录");
    assert!(
        !b_covers.exists() || std::fs::read_dir(&b_covers).unwrap().next().is_none(),
        "B 的封面目录不应出现 A 的文件"
    );
}

#[tokio::test]
async fn 超过人数上限的新使用者回_403_但既有使用者照常() {
    let app = TestApp::with_config(|config| config.max_users = 1).await;
    assert_eq!(app.data_version_of(OWNER_ID).await, 0);

    let response = app
        .get(
            "/game/api/version",
            Some(&format!("Bearer {}", user_token(USER_B))),
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.json()["code"], "user_limit_reached");
    assert!(!app.data_dir().join(format!("users/{USER_B}")).exists());

    assert_eq!(app.data_version_of(OWNER_ID).await, 0);
}
