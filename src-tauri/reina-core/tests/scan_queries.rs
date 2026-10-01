use reina_core::database::connection::connect_database;
use reina_core::database::dto::InsertGameData;
use reina_core::database::repository::games_repository::GamesRepository;

#[tokio::test]
async fn 依_teledrive_path_查出既有_id_與_pending_清單() {
    let dir = tempfile::tempdir().unwrap();
    let db = connect_database(&dir.path().join("t.db")).await.unwrap();

    let foo = GamesRepository::insert(
        &db,
        InsertGameData::cloud_placeholder("Foo", Some("game/Foo".into())),
    )
    .await
    .unwrap();
    GamesRepository::insert(&db, InsertGameData::cloud_placeholder("Manual", None))
        .await
        .unwrap();

    let found = GamesRepository::find_ids_by_teledrive_paths(
        &db,
        &["game/Foo".into(), "game/Missing".into()],
    )
    .await
    .unwrap();
    assert_eq!(found.get("game/Foo"), Some(&foo.id));
    assert!(!found.contains_key("game/Missing"));

    let pending = GamesRepository::find_scan_pending(&db).await.unwrap();
    assert_eq!(
        pending.len(),
        1,
        "手動新增的條目沒有 teledrive_path，不算掃描待處理"
    );
    assert_eq!(pending[0].name, "Foo");
    assert_eq!(pending[0].scan_status, "pending");
    assert!(pending[0].scan_candidates.is_empty());
}

#[tokio::test]
async fn 已手動補過資料的條目不算_pending() {
    use reina_core::database::dto::UpdateGameData;
    use reina_core::entity::custom_data::CustomData;

    let dir = tempfile::tempdir().unwrap();
    let db = connect_database(&dir.path().join("t.db")).await.unwrap();

    let mut ids = Vec::new();
    for name in ["Plain", "Renamed", "Filled", "Sourced"] {
        let game = GamesRepository::insert(
            &db,
            InsertGameData::cloud_placeholder(name, Some(format!("game/{name}"))),
        )
        .await
        .unwrap();
        ids.push(game.id);
    }

    // 改名
    GamesRepository::update(
        &db,
        ids[1],
        UpdateGameData {
            custom_data: Some(Some(CustomData {
                name: Some("正式名稱".into()),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    // 填了開發商，名稱不變
    GamesRepository::update(
        &db,
        ids[2],
        UpdateGameData {
            custom_data: Some(Some(CustomData {
                name: Some("Filled".into()),
                summary: Some("手動簡介".into()),
                ..Default::default()
            })),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    // 換了資料來源
    GamesRepository::update(
        &db,
        ids[3],
        UpdateGameData {
            id_type: Some("vndb".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();

    let pending = GamesRepository::find_scan_pending(&db).await.unwrap();
    let names: Vec<_> = pending.iter().map(|row| row.name.as_str()).collect();
    assert_eq!(names, vec!["Plain"]);
}
