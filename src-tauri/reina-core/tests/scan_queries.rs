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
