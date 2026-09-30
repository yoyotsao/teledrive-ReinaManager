mod support;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use reina_core::database::repository::game_stats_repository::GameStatsRepository;
use sea_orm::{ColumnTrait, ConnectionTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::{Value, json};
use support::{TestApp, spawn_app};

fn request(body: &str, token: &str) -> Request<Body> {
    Request::builder()
        .method("POST")
        .uri("/game/api/sessions")
        .header("content-type", "application/json")
        .header("authorization", format!("Bearer {token}"))
        .body(Body::from(body.to_owned()))
        .unwrap()
}

fn record(id: &str, game_id: i32, seconds: i32, start: i32, end: i32) -> Value {
    json!({
        "id": id,
        "game_id": game_id,
        "device": "DESKTOP-ABC",
        "start": start,
        "end": end,
        "seconds": seconds,
    })
}

async fn session_count(app: &TestApp, game_id: i32) -> u64 {
    use reina_core::entity::game_sessions;
    game_sessions::Entity::find()
        .filter(game_sessions::Column::GameId.eq(game_id))
        .count(&app.state.db)
        .await
        .unwrap()
}

#[tokio::test]
async fn accepts_exact_seconds_and_deduplicates_concurrent_uuid() {
    let app = spawn_app().await;
    let game_id = app.insert_game("Bridge session").await;
    let token = app.owner_token();
    let id = "8b5d2a2d-0000-4000-8000-000000000001";
    let body = record(id, game_id, 30, 1_790_551_200, 1_790_551_230).to_string();
    let before = app.data_version().await;

    let (first, second) = tokio::join!(
        app.send(request(&body, &token)),
        app.send(request(&body, &token)),
    );

    assert_eq!(first.status, StatusCode::OK, "{}", first.text());
    assert_eq!(second.status, StatusCode::OK, "{}", second.text());
    let accepted = [
        first.json()["accepted"].as_bool(),
        second.json()["accepted"].as_bool(),
    ];
    assert_eq!(
        accepted
            .into_iter()
            .flatten()
            .filter(|value| *value)
            .count(),
        1
    );
    assert_eq!(session_count(&app, game_id).await, 1);
    assert_eq!(app.data_version().await, before + 1);

    let stats = GameStatsRepository::get_statistics(&app.state.db, game_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stats.session_count, Some(1));
    assert_eq!(stats.total_time, Some(1));

    let session = reina_core::entity::game_sessions::Entity::find()
        .one(&app.state.db)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.external_id.as_deref(), Some(id));
    assert_eq!(session.device.as_deref(), Some("DESKTOP-ABC"));
    assert_eq!(session.duration_seconds, Some(30));
}

#[tokio::test]
async fn zero_minute_bridge_session_updates_count_and_last_played() {
    let app = spawn_app().await;
    let game_id = app.insert_game("Zero minute bridge session").await;
    let body = record(
        "8b5d2a2d-0000-4000-8000-000000000002",
        game_id,
        1,
        1_790_551_200,
        1_790_551_201,
    );
    let response = app
        .post_raw(
            "/game/api/sessions",
            body.to_string(),
            Some(&format!("Bearer {}", app.owner_token())),
        )
        .await;

    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.json(), json!({"accepted": true}));
    let stats = GameStatsRepository::get_statistics(&app.state.db, game_id)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(stats.total_time, Some(0));
    assert_eq!(stats.session_count, Some(1));
    assert_eq!(stats.last_played, Some(1_790_551_201));
    assert_eq!(
        serde_json::from_str::<Value>(stats.daily_stats.as_deref().unwrap()).unwrap(),
        json!([])
    );
}

#[tokio::test]
async fn malformed_and_invalid_records_return_stable_client_error() {
    let app = spawn_app().await;
    let token = format!("Bearer {}", app.owner_token());
    let before = app.data_version().await;
    for body in [
        "{",
        r#"{"id":false,"game_id":1,"device":"PC","start":1,"end":1,"seconds":0}"#,
        r#"{"id":"bad","game_id":1,"device":"PC","start":1,"end":1,"seconds":0}"#,
        r#"{"id":"8b5d2a2d-0000-4000-8000-000000000003","game_id":1,"device":" ","start":1,"end":1,"seconds":0}"#,
        r#"{"id":"8b5d2a2d-0000-4000-8000-000000000004","game_id":1,"device":"PC","start":1,"end":1,"seconds":-1}"#,
        r#"{"id":"8b5d2a2d-0000-4000-8000-000000000005","game_id":1,"device":"PC","start":2,"end":1,"seconds":0}"#,
    ] {
        let response = app.post_raw("/game/api/sessions", body, Some(&token)).await;
        assert_eq!(
            response.status,
            StatusCode::BAD_REQUEST,
            "body={body} response={}",
            response.text()
        );
        assert_eq!(response.json()["code"], "invalid_arguments");
        assert_eq!(app.data_version().await, before);
    }
    assert_eq!(session_count(&app, 1).await, 0);
}

#[tokio::test]
async fn missing_game_and_commit_fault_do_not_write_or_bump_version() {
    let app = spawn_app().await;
    let token = format!("Bearer {}", app.owner_token());
    let body = record(
        "8b5d2a2d-0000-4000-8000-000000000006",
        999_999,
        30,
        1_790_551_200,
        1_790_551_230,
    );
    let before = app.data_version().await;
    let missing = app
        .post_raw("/game/api/sessions", body.to_string(), Some(&token))
        .await;
    assert_eq!(missing.status, StatusCode::NOT_FOUND);
    assert_eq!(missing.json()["code"], "not_found");
    assert_eq!(app.data_version().await, before);

    let game_id = app.insert_game("Commit fault").await;
    let body = record(
        "8b5d2a2d-0000-4000-8000-000000000007",
        game_id,
        30,
        1_790_551_200,
        1_790_551_230,
    );
    app.fail_next_write_commit();
    let failed = app
        .post_raw("/game/api/sessions", body.to_string(), Some(&token))
        .await;
    assert_eq!(failed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(failed.json()["code"], "command_failed");
    assert_eq!(session_count(&app, game_id).await, 0);
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn database_failure_returns_server_error_and_rolls_back_all_changes() {
    let app = spawn_app().await;
    let game_id = app.insert_game("Database failure").await;
    app.state
        .db
        .execute_unprepared(
            "CREATE TRIGGER reject_bridge_session BEFORE INSERT ON game_sessions \
             BEGIN SELECT RAISE(FAIL, 'forced session insert failure'); END",
        )
        .await
        .unwrap();
    let before = app.data_version().await;
    let response = app
        .post_raw(
            "/game/api/sessions",
            record(
                "8b5d2a2d-0000-4000-8000-000000000008",
                game_id,
                30,
                1_790_551_200,
                1_790_551_230,
            )
            .to_string(),
            Some(&format!("Bearer {}", app.owner_token())),
        )
        .await;

    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.json()["code"], "command_failed");
    assert_eq!(session_count(&app, game_id).await, 0);
    assert!(
        GameStatsRepository::get_statistics(&app.state.db, game_id)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(app.data_version().await, before);
}
