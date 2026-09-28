# 計畫 A：伺服器與網頁（任務 1–9）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 ReinaManager 以網頁形式運作在 `https://teledrive.yoyotsaoteledrive.dpdns.org/game/`：共用 TeleDrive 登入、在瀏覽器管理遊戲庫、掃描 TeleDrive 的 `game` 資料夾、顯示封面、跨裝置同步資料。

**Architecture:** 把 `src-tauri` 中不依賴 Tauri 的資料庫程式碼抽成 `reina-core` crate，另寫 axum 服務 `reina-server`，提供 `/game/` 靜態檔與 `/game/api/*`。所有 command 分成 Read／Write，Write 由路由層統一開 transaction 並在同一次 commit 裡遞增 `data_version`。前端同一套 React 依執行環境選擇 Tauri IPC 或 HTTP，網頁版以輪詢 `data_version` 做跨裝置刷新；中繼資料請求與外部圖片都由伺服器代理。

**Tech Stack:** Rust（sea-orm 2.0.2／SQLite、tokio、axum 0.8、jsonwebtoken 9.3）、React + TypeScript、TanStack Query、UnoCSS、Vitest + jsdom@29.1.1 + fake-indexeddb + Testing Library。

**Spec:** [2026-09-26-reinamanager-web-docker-design.md](../specs/2026-09-26-reinamanager-web-docker-design.md)
**總覽：** [2026-09-26-reinamanager-web-docker.md](2026-09-26-reinamanager-web-docker.md)（計畫 B：bridge 與計時、計畫 C：部署與驗收，A 完成後細化）

## Global Constraints

- **路徑與指令**：路徑未標註 repo 者一律相對 `D:/game/ReinaManager`；`reina-core/…`、`reina-server/…` 分別是 `src-tauri/reina-core/…`、`src-tauri/reina-server/…` 的簡寫。Rust 指令在 `src-tauri` 目錄下執行（或用 `--manifest-path src-tauri/Cargo.toml`），前端指令在 repo 根目錄執行。指令一條一條跑，不用 `&&` 串接（AGENTS.md 3.2）。
- **資料庫**：從空資料庫開始，不遷移桌面版資料。伺服器資料庫固定 `/data/reina_manager.db`，封面存 `/data/covers/game_<id>/`，都在 volume `reina-data:/data` 內。SQLite 只有 1 條連線（`max_connections(1)`）。
- **伺服器**：內部 port `8787`，容器不對主機開放 port。環境變數 `JWT_SECRET`（必填，和 teledrive-backend 同一個來源）、`REINA_OWNER_ID`（必填）、`TELEDRIVE_API`（預設 `http://backend:8000`）、`REINA_PORT`、`REINA_DATA_DIR`（預設 `/data`）、`REINA_STATIC_DIR`（預設 `/app/static`）、`REINA_GAME_FOLDER`（預設 `game`，任務 9 加入）。
- **JWT**：HS256，必須驗證 `exp`、`user_id`，`user_id` 必須等於 `REINA_OWNER_ID`；401 = 缺少／無效／過期，403 = 不是 owner。不在日誌記錄 token 或 `Authorization` 標頭。
- **瀏覽器登入**：jwt 從 IndexedDB `teledrive-credentials` → `credentials` → `active.jwt` 讀取；**只讀寫 `jwt` 欄位**，`accounts`（Telegram session）不讀取、不傳送、不記錄。寫回時在同一個 readwrite transaction 內 get → put。
- **版本**：Read command 不遞增 `data_version`；Write command 成功後恰好加 1，並和業務資料同一次 commit；前端「已同步版本」只由 `GET /game/api/version` 的輪詢結果更新，不用修改請求回傳的版本。輪詢：前景每 `60` 秒，focus／回到前景／重新連線時立刻檢查。
- **遊戲位置**：伺服器只存 `teledrive_path`（`game/<名稱>`）與 `exe_relpath`，不接受 Windows 絕對路徑。
- **網頁建置**：`pnpm build:web`（`vite build --mode web`）→ `dist-web/`，`base: "/game/"`；桌面 `pnpm build` 維持 `dist/`、`base: "./"`。Router 在網頁版用 `basename: "/game"`。
- **桌面版**：過渡期間必須仍可建置（`cargo check -p ReinaManager`、`pnpm build`）。網頁版不啟用系統匣、自動啟動、updater、視窗狀態、deep link 安裝協定、Magpie、以系統管理員身分執行。
- **程式碼慣例**（AGENTS.md）：Rust 模組用 `<模組>.rs` + `<模組>/`，不用 `mod.rs`，`<模組>.rs` 只放宣告；`invoke` 只在 service 層；元件不直接用 `useQuery`／`useQueryClient`；樣式優先 UnoCSS；程式碼註解沿用 repo 的簡體中文；新增 i18n 字串要補齊 `zh-CN`、`zh-TW`、`en-US`、`ja-JP`。
- **依賴**：新增 Rust 依賴只有 `axum 0.8`、`jsonwebtoken 9.3`、`env_logger 0.11`、`tempfile 3`、`http-body-util 0.1`；其餘沿用 `Cargo.lock` 既有版本，不升級既有工具鏈。
- **Commit**：每個任務結束時 commit，只 `git add` 該任務列出的檔案，禁止 `git add .`。`src-tauri/Cargo.toml` 在計畫開始前已有使用者未提交的修改，任務 1 commit 時用 `git add -p` 只暫存本任務的變更。根目錄 `test/` 是使用者的封面圖片資料，不是測試目錄，不要動它。commit message 結尾加：`Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`

## Review Focus

spec 沒有逐一列出、但最可能讓使用者遇到的情況。每一項都已在負責的任務裡加上測試：

1. **token 刷新期間，TeleDrive 分頁修改了 `accounts`**（例如剛好新增 Telegram 帳號）：寫回時只換 `jwt`，保留**新的** `accounts`。→ 任務 4，`auth.test.ts`「刷新期間 TeleDrive 分頁改了 accounts」。
2. **第一次使用，TeleDrive 上還沒有 `game` 資料夾**：掃描回 404 `game_folder_missing`，版本不變，前端顯示提示而不是當機。→ 任務 9，`tests/scan.rs`「第一次使用沒有 game 資料夾」。
3. **TeleDrive 在掃描列表途中失敗**（`/files` 5xx）：回 502 `teledrive_unavailable`，不留下只新增一半的遊戲，版本不變。→ 任務 9，`tests/scan.rs`「teledrive 列表中途失敗」。
4. **網頁版按「新增遊戲」**：不能出現依賴本機檔案對話框的「批量」分頁或「選擇啟動檔」按鈕；預設開啟「雲端掃描」，保留名稱／ID 手動搜尋。→ 任務 9，`addModalTabs.test.ts`。
5. **頁面在背景放很久、登入已失效**：版本輪詢失敗時不失效任何 query、畫面資料保持不動，也不會丟出未處理錯誤；重新登入後下一次輪詢補上期間的變更。→ 任務 6，`useServerVersion.test.tsx`「登入失效時不失效任何 query」。

---

### 任務 1：抽出 Linux 服務可用的共用資料庫核心 `reina-core`

把「不依賴 Tauri 的資料層」（entity、DTO、repository、純路徑驗證）搬到新的 workspace crate `src-tauri/reina-core`，桌面版改成重新匯出，行為不變。同時修掉一個會讓伺服器踩雷的既有問題：migration 在建立新資料庫時，會用 `reina_path::get_db_path()`（桌面版的 `%APPDATA%` 路徑）做備份，而不是正在遷移的那個資料庫。

**Files:**
- Create: `src-tauri/reina-core/Cargo.toml`
- Create: `src-tauri/reina-core/src/lib.rs`
- Create: `src-tauri/reina-core/src/database.rs`
- Create: `src-tauri/reina-core/src/database/connection.rs`
- Create: `src-tauri/reina-core/src/validation.rs`
- Create: `src-tauri/reina-core/tests/database.rs`
- Move（`git mv`）：
  - `src-tauri/src/entity.rs` → `src-tauri/reina-core/src/entity.rs`
  - `src-tauri/src/entity/`（11 個檔）→ `src-tauri/reina-core/src/entity/`
  - `src-tauri/src/database/dto.rs` → `src-tauri/reina-core/src/database/dto.rs`
  - `src-tauri/src/database/repository.rs` → `src-tauri/reina-core/src/database/repository.rs`
  - `src-tauri/src/database/repository/`（4 個檔）→ `src-tauri/reina-core/src/database/repository/`
- Create（搬走後在原位置重建為重新匯出）：`src-tauri/src/entity.rs`、`src-tauri/src/database/dto.rs`、`src-tauri/src/database/repository.rs`
- Modify: `src-tauri/Cargo.toml:2`（workspace members）、`[dependencies]` 區段
- Modify: `src-tauri/src/database/db.rs:13-84`（`establish_connection` 改呼叫 core）
- Modify: `src-tauri/src/utils/fs.rs:6`（import）、`:34-78`（三個純函式改為重新匯出）、`:486-509`（測試搬到 core）
- Modify（搬移後的檔案）：`reina-core/src/database/repository/games_repository.rs:9`、`settings_repository.rs:5`、`games_repository.rs:467,569`（`pub(crate)` → `pub`）
- Modify: `src-tauri/migration/Cargo.toml`（移除 `reina-path` 依賴）
- Modify: `src-tauri/migration/src/lib.rs:3`（`mod backup;` → `pub mod backup;`）
- Modify: `src-tauri/migration/src/backup.rs:1-40`
- Modify: `src-tauri/migration/src/m20250927_000001_baseline_migration.rs:5-6,27,33,267-277`
- Modify: `src-tauri/migration/src/m20251229_000004_hybrid_single_table.rs:150`
- Modify: `src-tauri/migration/src/m20260201_000007_clean_empty_strings.rs:24`
- Test: `src-tauri/reina-core/tests/database.rs`，以及跟著搬過去的既有單元測試（`games_repository.rs`、`game_stats_repository.rs`、`dto.rs` 內的 `mod tests`）

**Interfaces:**
- Consumes: 既有 `migration` crate（`migration::Migrator`）；既有 repository／DTO／entity 程式碼。
- Produces:
  - crate `reina-core`（Rust 路徑 `reina_core`），模組結構和桌面版原本一致，所以搬過去的檔案內的 `crate::entity::…`、`crate::database::…` 路徑不用改：
    - `reina_core::entity::{prelude, custom_data, collections, game_collection_link, game_sessions, game_sources, game_statistics, games, savedata, tasks, user}`
    - `reina_core::database::dto::*`（`FullGameData`、`InsertGameData`、`UpdateGameData`、`BatchOperationResult`、`InsertCollectionData`、`UpdateCollectionData`、`UpdateSettingsData`…）
    - `reina_core::database::repository::{games_repository::GamesRepository, collections_repository::CollectionsRepository, game_stats_repository::GameStatsRepository, settings_repository::{SettingsRepository, DbSettingsExt}}`
  - `reina_core::database::open_database(path: &std::path::Path) -> Result<sea_orm::DatabaseConnection, sea_orm::DbErr>`：建立目錄、以 `sqlite:<path>?mode=rwc` 連線（單一連線）、`PRAGMA foreign_keys = ON` 並驗證，**不跑 migration**。桌面版用它（migration 仍在 `lib.rs` 執行，維持原本的日誌與 panic 行為）。
  - `reina_core::database::connect_database(path: &std::path::Path) -> Result<sea_orm::DatabaseConnection, sea_orm::DbErr>`：`open_database` 之後執行 `migration::Migrator::up(&conn, None)`。伺服器用它。
  - `reina_core::validation::{validate_executable_name(&str) -> Result<(), String>, validate_safe_relative_path(&str) -> Result<(), String>, normalize_install_root_path(&str) -> Result<PathBuf, String>}`；桌面版 `crate::utils::fs::` 的同名函式改為重新匯出，呼叫端不用改。
  - `GamesRepository::insert_aggregate` / `update_aggregate` 由 `pub(crate)` 改為 `pub`（`src-tauri/src/install/workflow.rs:194,201` 跨 crate 呼叫它們）。
  - `migration::backup::database_file_path<C: ConnectionTrait>(conn: &C) -> Result<Option<PathBuf>, DbErr>`：回傳目前連線 `main` 資料庫的檔案路徑；記憶體資料庫回傳 `None`。
  - `migration::backup::backup_sqlite<C: ConnectionTrait>(conn: &C, version: &str) -> Result<PathBuf, DbErr>`：簽名改為接受連線，備份「正在遷移的那個資料庫」。

- [ ] **Step 1: 建立空的 crate 骨架並寫失敗的測試**

`src-tauri/reina-core/Cargo.toml`：

```toml
[package]
name = "reina-core"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
chrono = { version = "0.4.45", default-features = false, features = ["clock"] }
log = "0.4.33"
migration = { path = "../migration" }
sea-orm = { version = "2.0.2", default-features = false, features = [
    "sqlx-sqlite",
    "runtime-tokio",
    "macros",
    "with-json",
] }
serde = { version = "1.0.229", features = ["derive"] }
serde_json = "1.0.151"
url = "2.5.8"

[dev-dependencies]
tokio = { version = "1.53.1", features = ["macros", "rt-multi-thread"] }
```

`src-tauri/reina-core/src/lib.rs`（暫時是空的，Step 3 補上模組）：

```rust
//! ReinaManager 的共用資料層：entity、DTO、repository 與純驗證函式。
//!
//! 本 crate 不得依賴 Tauri、AppHandle 或任何桌面外掛，讓桌面版與 Linux 伺服器共用。
```

`src-tauri/Cargo.toml` 第 2 行改為：

```toml
members = ["reina-path", "migration", "reina-core"]
```

`src-tauri/reina-core/tests/database.rs`：

```rust
//! connect_database 的行為測試：路徑隔離、外鍵、重新開啟、備份位置。

use reina_core::database::connect_database;
use sea_orm::{ConnectionTrait, DatabaseBackend, DatabaseConnection, Statement};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// 每個測試使用獨立的暫存目錄，避免平行執行時互相干擾。
fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "reina_core_{}_{}_{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn scalar_i64(db: &DatabaseConnection, sql: &str, column: &str) -> i64 {
    db.query_one_raw(Statement::from_string(DatabaseBackend::Sqlite, sql.to_string()))
        .await
        .unwrap()
        .unwrap()
        .try_get::<i64>("", column)
        .unwrap()
}

fn same_file(left: &Path, right: &Path) -> bool {
    std::fs::canonicalize(left).unwrap() == std::fs::canonicalize(right).unwrap()
}

#[tokio::test]
async fn creates_independent_databases_at_the_given_paths() {
    let first_dir = unique_dir("first");
    let second_dir = unique_dir("second");
    let first_path = first_dir.join("nested").join("reina_manager.db");
    let second_path = second_dir.join("reina_manager.db");

    let first = connect_database(&first_path).await.unwrap();
    let second = connect_database(&second_path).await.unwrap();

    first
        .execute_unprepared("INSERT INTO games (id_type) VALUES ('custom')")
        .await
        .unwrap();

    assert!(first_path.is_file(), "應自動建立巢狀目錄與資料庫檔");
    assert!(second_path.is_file());
    assert_eq!(scalar_i64(&first, "SELECT COUNT(*) AS n FROM games", "n").await, 1);
    assert_eq!(scalar_i64(&second, "SELECT COUNT(*) AS n FROM games", "n").await, 0);

    first.close().await.unwrap();
    second.close().await.unwrap();
}

#[tokio::test]
async fn enables_foreign_keys() {
    let dir = unique_dir("fk");
    let db = connect_database(&dir.join("reina_manager.db")).await.unwrap();

    assert_eq!(scalar_i64(&db, "PRAGMA foreign_keys", "foreign_keys").await, 1);
    // game_sources.game_id 參照 games.id，外鍵生效時必須拒絕孤兒資料。
    let orphan = db
        .execute_unprepared(
            "INSERT INTO game_sources (game_id, source, external_id) VALUES (999, 'bgm', '1')",
        )
        .await;
    assert!(orphan.is_err(), "外鍵啟用時應拒絕不存在的 game_id");

    db.close().await.unwrap();
}

#[tokio::test]
async fn reopening_a_migrated_database_keeps_data() {
    let dir = unique_dir("reopen");
    let path = dir.join("reina_manager.db");

    let db = connect_database(&path).await.unwrap();
    db.execute_unprepared("INSERT INTO games (id_type) VALUES ('custom')")
        .await
        .unwrap();
    db.close().await.unwrap();

    let reopened = connect_database(&path).await.unwrap();
    assert_eq!(
        scalar_i64(&reopened, "SELECT COUNT(*) AS n FROM games", "n").await,
        1
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn migration_backups_target_the_database_being_migrated() {
    let dir = unique_dir("backup");
    let path = dir.join("reina_manager.db");

    let db = connect_database(&path).await.unwrap();

    // migration 的備份必須針對「這個」資料庫，而不是桌面版 %APPDATA% 裡的那個。
    let file = migration::backup::database_file_path(&db)
        .await
        .unwrap()
        .expect("檔案型資料庫應回傳路徑");
    assert!(same_file(&file, &path));
    // m20251229_000004 與 m20260201_000007 在新資料庫上也會備份，備份應落在同目錄的 backups/。
    let backups = dir.join("backups");
    assert!(backups.is_dir(), "備份目錄應建立在資料庫旁邊");
    assert!(std::fs::read_dir(&backups).unwrap().next().is_some());

    db.close().await.unwrap();
}

#[tokio::test]
async fn in_memory_connection_has_no_file_path() {
    let db = sea_orm::Database::connect("sqlite::memory:").await.unwrap();
    assert_eq!(migration::backup::database_file_path(&db).await.unwrap(), None);
}
```

- [ ] **Step 2: 執行確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-core --test database`

Expected: 編譯失敗，包含
`error[E0432]: unresolved import `reina_core::database``
以及 `could not find `backup` in `migration``（目前 `mod backup;` 是私有的）。

- [ ] **Step 3: 修正 migration 的備份來源**

`src-tauri/migration/src/lib.rs` 第 3 行：

```rust
pub mod backup;
```

`src-tauri/migration/src/backup.rs` 第 1–40 行（`use` 區塊與 `backup_sqlite`）替換為：

```rust
use std::fs;
use std::path::{Path, PathBuf};

use chrono::Local;
use sea_orm_migration::sea_orm::{ConnectionTrait, DatabaseBackend, DbErr, Statement};

/// 取得連線目前 `main` 資料庫的檔案路徑；記憶體資料庫回傳 None。
///
/// migration 必須備份「正在遷移的資料庫」。舊寫法用 `reina_path::get_db_path()`
/// 推導桌面路徑，伺服器（/data）或測試（暫存目錄）執行時會備份到錯誤的檔案。
pub async fn database_file_path<C>(conn: &C) -> Result<Option<PathBuf>, DbErr>
where
    C: ConnectionTrait,
{
    let row = conn
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Sqlite,
            "SELECT file FROM pragma_database_list WHERE name = 'main'".to_string(),
        ))
        .await?;
    let file = match row {
        Some(row) => row.try_get::<String>("", "file")?,
        None => return Ok(None),
    };
    if file.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(PathBuf::from(file)))
}

/// 使用 SQLite 一致性快照备份数据库。
///
/// 自动读取数据库中 `user.db_backup_path` 字段：
/// - 若存在且非空，则备份到该路径下
/// - 否则备份到数据库所在目录的 `backups/` 子目录
/// - 自定义目录备份失败时记录警告并回退默认目录；默认目录备份失败则终止迁移
pub async fn backup_sqlite<C>(conn: &C, version: &str) -> Result<PathBuf, DbErr>
where
    C: ConnectionTrait,
{
    let db_path = database_file_path(conn)
        .await?
        .ok_or_else(|| DbErr::Custom("记忆体数据库无需备份".to_string()))?;
    let db_url = path_to_sqlite_url(&db_path)?;

    let pool = sqlx::SqlitePool::connect(&db_url)
        .await
        .map_err(|e| DbErr::Custom(format!("Failed to connect: {}", e)))?;

    verify_integrity(&pool, "源数据库").await?;

    let custom_path: Option<String> = sqlx::query_scalar("SELECT db_backup_path FROM user LIMIT 1")
        .fetch_optional(&pool)
        .await
        .ok()
        .flatten();

    let default_dir = db_path.parent().unwrap().join("backups");
    let custom_dir = custom_path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(Path::new);

    let backup_result = create_backup_with_fallback(&pool, version, custom_dir, &default_dir).await;
    pool.close().await;
    backup_result
}
```

`src-tauri/migration/src/m20251229_000004_hybrid_single_table.rs` 第 150 行：

```rust
        match backup_sqlite(manager.get_connection(), "v0.13.0").await {
```

`src-tauri/migration/src/m20260201_000007_clean_empty_strings.rs` 第 24 行：

```rust
        match backup_sqlite(manager.get_connection(), "v0.14.2").await {
```

`src-tauri/migration/src/m20250927_000001_baseline_migration.rs`：
- 第 5–6 行改為：

```rust
use crate::backup::{backup_sqlite, database_file_path, path_to_sqlite_url};
```

- 第 27 行：`match backup_sqlite(conn, "v0.6.9").await {`
- 第 33 行：`run_legacy_migrations_with_sqlx(conn).await?;`
- `run_legacy_migrations_with_sqlx` 的開頭（第 267–277 行）改為：

```rust
/// 为现有用户运行旧的 tauri-plugin-sql 迁移，使用 sqlx 执行
async fn run_legacy_migrations_with_sqlx<C>(conn: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    log::info!("[MIGRATION] Running legacy migrations with sqlx...");

    // 旧版数据库只可能是文件型；路径直接取自正在迁移的连接，不再从桌面目录推导。
    let db_path = database_file_path(conn)
        .await?
        .ok_or_else(|| DbErr::Custom("旧版数据迁移需要文件型数据库".to_string()))?;
    let database_url = path_to_sqlite_url(&db_path)?;
```

（函式其餘內容不變。）

`src-tauri/migration/Cargo.toml` 刪除這一行（migration 不再需要桌面路徑）：

```toml
reina-path = { path = "../reina-path" }
```

確認沒有殘留：

Run: `rg -n "reina_path" src-tauri/migration/src`
Expected: 沒有輸出。

- [ ] **Step 4: 搬移資料層檔案到 core**

在 repo 根目錄逐條執行：

```bash
mkdir -p src-tauri/reina-core/src/database
git mv src-tauri/src/entity.rs src-tauri/reina-core/src/entity.rs
git mv src-tauri/src/entity src-tauri/reina-core/src/entity
git mv src-tauri/src/database/dto.rs src-tauri/reina-core/src/database/dto.rs
git mv src-tauri/src/database/repository.rs src-tauri/reina-core/src/database/repository.rs
git mv src-tauri/src/database/repository src-tauri/reina-core/src/database/repository
```

搬過去的檔案內，`crate::entity::…`、`crate::database::…` 在 core 中仍然成立（模組結構相同），**只有下列兩處**要改（已用 `rg -n "crate::" src-tauri/src/entity src-tauri/src/database/dto.rs src-tauri/src/database/repository` 確認，其餘都是 `crate::entity` / `crate::database`）：

- `reina-core/src/database/repository/games_repository.rs` 第 9 行：

```rust
use crate::validation::{validate_executable_name, validate_safe_relative_path};
```

（`validate_safe_relative_path` 在任務 2 才用到；任務 1 先只匯入 `validate_executable_name`，避免 unused warning：`use crate::validation::validate_executable_name;`。）

- `reina-core/src/database/repository/settings_repository.rs` 第 5 行：

```rust
use crate::validation::normalize_install_root_path;
```

- `reina-core/src/database/repository/games_repository.rs` 第 467 行與第 569 行的 `pub(crate) async fn insert_aggregate` / `pub(crate) async fn update_aggregate` 改為 `pub async fn`（桌面版 `src/install/workflow.rs:194,201` 會跨 crate 呼叫）。

`src-tauri/reina-core/src/validation.rs`（從 `src-tauri/src/utils/fs.rs:34-78` 原樣搬來，連同測試 `:486-509`）：

```rust
//! 与平台无关的路径与文件名校验，桌面版与伺服器共用。

use std::path::{Component, Path, PathBuf};

/// 清洗并校验游戏安装根目录，确保任务和默认设置使用相同规则。
pub fn normalize_install_root_path(value: &str) -> Result<PathBuf, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("请先选择游戏安装目录".to_string());
    }
    let path: PathBuf = PathBuf::from(trimmed).components().collect();
    if !path.is_absolute() {
        return Err("游戏安装目录必须是绝对路径".to_string());
    }
    Ok(path)
}

/// 校验跨协议、压缩包和数据库共用的安全相对文件路径。
pub fn validate_safe_relative_path(value: &str) -> Result<(), String> {
    if value.is_empty() || value.contains('\0') || value.starts_with(['/', '\\']) {
        return Err("路径必须是安全相对路径".to_string());
    }
    let normalized = value.replace('\\', "/");
    if normalized
        .split('/')
        .any(|part| part.is_empty() || matches!(part, "." | "..") || part.contains(':'))
    {
        return Err("路径包含不安全组件".to_string());
    }
    if Path::new(&normalized)
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("路径包含不安全组件".to_string());
    }
    Ok(())
}

/// 校验游戏启动程序字段，只允许保存单个文件名。
pub fn validate_executable_name(value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    let is_single_file_name = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !value.contains(['/', '\\']);
    if !is_single_file_name {
        return Err("executable 必须是单个文件名，不能包含路径".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{normalize_install_root_path, validate_executable_name, validate_safe_relative_path};
    use std::path::PathBuf;

    #[test]
    fn install_root_path_must_be_absolute() {
        assert!(normalize_install_root_path("games").is_err());
        assert!(normalize_install_root_path("   ").is_err());
    }

    #[test]
    fn install_root_path_is_trimmed_and_normalized() {
        #[cfg(windows)]
        let root = r"C:\Games";
        #[cfg(not(windows))]
        let root = "/games";

        assert_eq!(
            normalize_install_root_path(&format!("  {root}/.  ")),
            Ok(PathBuf::from(root))
        );
    }

    #[test]
    fn safe_relative_path_rejects_escapes_and_drive_letters() {
        assert!(validate_safe_relative_path("01000250/haison.exe").is_ok());
        assert!(validate_safe_relative_path(r"01000250\haison.exe").is_ok());
        for bad in ["", "/abs.exe", r"\abs.exe", "../x.exe", "a/../x.exe", "a//x.exe", r"C:\x.exe", "a/./x"] {
            assert!(validate_safe_relative_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn executable_name_must_be_single_file() {
        assert!(validate_executable_name("game.exe").is_ok());
        assert!(validate_executable_name("dir/game.exe").is_err());
        assert!(validate_executable_name(r"dir\game.exe").is_err());
    }
}
```

> 注意：`normalize_install_root_path` 在 Linux 上只接受 `/` 開頭的絕對路徑，所以網頁版若把 Windows 路徑（`D:\Games`）寫入 `install_root_path` 會被拒絕。這是預期行為（spec：伺服器不接受 Windows 絕對路徑）。

`src-tauri/reina-core/src/database/connection.rs`：

```rust
//! 以明确路径建立 SQLite 连线。桌面版与伺服器共用，不依赖桌面资料目录。

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseBackend, DatabaseConnection, DbErr,
    RuntimeErr, Statement,
};
use std::path::Path;
use std::time::Duration;
use url::Url;

use migration::MigratorTrait;

/// 开启指定路径的数据库（不执行 migration）。
///
/// - 目录不存在时自动建立
/// - 单一连线：SQLite 写入本来就是序列化的，多连线只会带来 busy 错误
/// - 必须成功启用外键，否则拒绝回传连线
pub async fn open_database(path: &Path) -> Result<DatabaseConnection, DbErr> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            DbErr::Conn(RuntimeErr::Internal(format!(
                "无法创建数据库目录 {}: {}",
                parent.display(),
                error
            )))
        })?;
    }

    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| DbErr::Conn(RuntimeErr::Internal(error.to_string())))?
            .join(path)
    };
    let db_url = Url::from_file_path(&absolute).map_err(|_| {
        DbErr::Conn(RuntimeErr::Internal(format!(
            "Invalid database path: {}",
            absolute.display()
        )))
    })?;

    let mut options = ConnectOptions::new(format!("sqlite:{}?mode=rwc", db_url.path()));
    options
        .max_connections(1)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(8))
        .sqlx_logging(false);

    let connection = Database::connect(options).await?;
    connection
        .execute_unprepared("PRAGMA foreign_keys = ON")
        .await?;

    let foreign_keys = connection
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Sqlite,
            "PRAGMA foreign_keys".to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::Custom("无法读取 SQLite 外键状态".to_string()))?
        .try_get::<i32>("", "foreign_keys")?;
    if foreign_keys != 1 {
        return Err(DbErr::Custom("SQLite 外键约束未启用".to_string()));
    }

    Ok(connection)
}

/// 开启数据库并执行全部 migration；伺服器启动使用。
pub async fn connect_database(path: &Path) -> Result<DatabaseConnection, DbErr> {
    let connection = open_database(path).await?;
    migration::Migrator::up(&connection, None).await?;
    Ok(connection)
}
```

`src-tauri/reina-core/src/database.rs`：

```rust
pub mod connection;
pub mod dto;
pub mod repository;

pub use connection::{connect_database, open_database};
```

`src-tauri/reina-core/src/lib.rs`（覆寫 Step 1 的版本）：

```rust
//! ReinaManager 的共用資料層：entity、DTO、repository 與純驗證函式。
//!
//! 本 crate 不得依賴 Tauri、AppHandle 或任何桌面外掛，讓桌面版與 Linux 伺服器共用。

pub mod database;
pub mod entity;
pub mod validation;
```

- [ ] **Step 5: 桌面版改成重新匯出**

`src-tauri/Cargo.toml` 在 `[dependencies]` 的 `migration = { path = "migration" }` 下一行加入：

```toml
reina-core = { path = "reina-core" }
```

重建 `src-tauri/src/entity.rs`：

```rust
//! 数据实体模块：实际定义位于共用 crate `reina_core::entity`，此处重新导出以保持既有路径。

pub use reina_core::entity::*;
```

重建 `src-tauri/src/database/dto.rs`：

```rust
//! DTO 实际定义位于 `reina_core::database::dto`，此处重新导出以保持既有路径。

pub use reina_core::database::dto::*;
```

重建 `src-tauri/src/database/repository.rs`：

```rust
//! Repository 实际定义位于 `reina_core::database::repository`，此处重新导出以保持既有路径。

pub use reina_core::database::repository::*;
```

`src-tauri/src/database.rs` 不需修改（仍是 `pub mod db; pub mod dto; pub mod repository; pub mod service;`）。

`src-tauri/src/database/db.rs` 的 `establish_connection`（第 13–84 行）替換為：

```rust
/// Establish a SeaORM database connection.
pub async fn establish_connection() -> Result<DatabaseConnection, DbErr> {
    // 1. 获取数据库路径（自动判断便携模式）
    let db_path = get_db_path().map_err(|e| DbErr::Conn(RuntimeErr::Internal(e)))?;

    let mode = if is_portable_mode() { "便携" } else { "标准" };
    if !db_path.exists() {
        log::info!("首次启动，创建{}模式数据库: {}", mode, db_path.display());
    }

    // 2. 连线细节（建目录、单连线、外键）与伺服器共用；migration 仍由 lib.rs 执行
    reina_core::database::open_database(&db_path).await
}
```

並把 `db.rs` 開頭的 import 改為（移除不再使用的項目）：

```rust
use sea_orm::{DatabaseConnection, DbErr, RuntimeErr};

use reina_path::{get_db_path, is_portable_mode};
```

`src-tauri/src/utils/fs.rs`：
- 第 6 行改為 `use std::path::{Path, PathBuf};`（`Component` 只被搬走的函式使用）。
- 刪除第 34–78 行（`normalize_install_root_path`、`validate_safe_relative_path`、`validate_executable_name` 三個函式及其文件註解），在原位置放：

```rust
pub use reina_core::validation::{
    normalize_install_root_path, validate_executable_name, validate_safe_relative_path,
};
```

- 刪除第 486–509 行的 `#[cfg(test)] mod tests`（已搬到 `reina-core/src/validation.rs`）。

`src-tauri/src/install/archive.rs`、`install/commands.rs`、`install/protocol.rs`、`install/workflow.rs` 透過 `crate::utils::fs::…` 使用這三個函式，重新匯出後不用改。

- [ ] **Step 6: 執行確認通過**

逐條執行：

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-core --test database`
Expected: `test result: ok. 5 passed`

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-core`
Expected: 全部通過（含搬過來的 `games_repository`、`game_stats_repository`、`dto`、`validation` 單元測試）。

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p migration`
Expected: 全部通過。

Run: `cargo check --manifest-path src-tauri/Cargo.toml -p ReinaManager`
Expected: `Finished`，沒有 error。若出現 `unused import`，依提示刪除該 import。

Run: `rg -n "tauri|AppHandle" src-tauri/reina-core/src`
Expected: 沒有輸出（core 不得依賴 Tauri）。

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/reina-core src-tauri/src/entity.rs src-tauri/src/entity src-tauri/src/database/dto.rs src-tauri/src/database/repository.rs src-tauri/src/database/repository src-tauri/src/database/db.rs src-tauri/src/utils/fs.rs src-tauri/migration/Cargo.toml src-tauri/migration/src/lib.rs src-tauri/migration/src/backup.rs src-tauri/migration/src/m20250927_000001_baseline_migration.rs src-tauri/migration/src/m20251229_000004_hybrid_single_table.rs src-tauri/migration/src/m20260201_000007_clean_empty_strings.rs
git status --short
git commit -m "refactor: extract shared database core crate

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

（`git status --short` 用來確認 `src-tauri/Cargo.toml` 以外沒有誤加使用者原本就有的修改；使用者在本計畫開始前已修改 `src-tauri/Cargo.toml`，若那份修改不屬於本任務，先用 `git add -p src-tauri/Cargo.toml` 只暫存 workspace members 與 `reina-core` 依賴兩處。）

---

### 任務 2：網頁版欄位、全域資料版本與可組合的 transaction

新增 migration（遊戲的 TeleDrive 位置、封面版本、掃描狀態；`server_state` 版本表）、`VersionRepository`，並把所有「自己開 transaction」的 repository 寫入函式拆出接受外部 transaction 的 `*_in_connection` 版本，讓 reina-server 的 `Write` command 能把業務寫入與 `data_version` 遞增放在同一次 commit。

**Files:**
- Create: `src-tauri/migration/src/m20260926_000020_web_library.rs`
- Modify: `src-tauri/migration/src/lib.rs`（`mod` 宣告與 `migrations()` 清單）
- Create: `src-tauri/reina-core/src/database/repository/version_repository.rs`
- Modify: `src-tauri/reina-core/src/database/repository.rs`（加 `pub mod version_repository;`）
- Modify: `src-tauri/reina-core/src/entity/games.rs:16-42`（Model 欄位）
- Modify: `src-tauri/reina-core/src/database/dto.rs`：`FullGameData`（:273）、`InsertGameData`（:295）、`UpdateGameData`（:338）、`impl InsertGameData::cleaned`（:113）、`impl UpdateGameData::cleaned`（:132）
- Modify: `src-tauri/reina-core/src/database/repository/games_repository.rs`：`FULL_GAME_SELECT`（:56-90）、`build_insert_active_model`（:365）、`build_update_active_model`（:387）、`insert_aggregate`（:467）、`update_aggregate`（:569）、`insert`/`insert_batch`/`update`/`update_batch`（:492-642）、`full_game_from_row`（:717）、`delete`/`delete_many`（:750-762）、測試的 `setup_database`（:1121）與 `insert_data`（:1192）
- Modify: `src-tauri/reina-core/src/database/repository/collections_repository.rs`：私有 helper（:203-280）、`create`/`update`/`delete`/`remove_games_from_collection`（:313-410）、`add_games_to_collections`/`set_game_collections`/`update_category_games`（:440-535）
- Modify: `src-tauri/reina-core/src/database/repository/game_stats_repository.rs`：`record_session_with_statistics`（:436）、`create_manual_session`（:466）、`rebuild_statistics`（:484）、`delete_session_with_statistics`（:534）、`upsert_projection`（:612）
- Modify: `src-tauri/reina-core/src/database/repository/settings_repository.rs`：`ensure_user_exists`（:26）、`update_settings`（:59）
- Modify: `src/types/types.ts`：`FullGameData`（:284）、`InsertGameParams`（:311）、`UpdateGameParams`（:338）
- Test: `src-tauri/reina-core/tests/web_transactions.rs`；migration 檔內的 `mod tests`

**Interfaces:**
- Consumes（任務 1）：`reina_core::database::connect_database`；`GamesRepository::insert_aggregate` / `update_aggregate`（已是 `pub`）；`reina_core::validation::validate_safe_relative_path`。
- Produces：
  - 資料表 `games` 新欄位：`teledrive_path TEXT`（非空時唯一，部分唯一索引 `idx_games_teledrive_path`）、`exe_relpath TEXT`（必須有 `teledrive_path`）、`cover_version TEXT`、`source_cover_hash TEXT`、`custom_cover_hash TEXT`（來源封面與自訂封面內容的 SHA-256 hex；三個封面欄位都只由任務 7 的封面 repository 函式寫入）、`scan_status TEXT`（`pending`/`needs_confirmation`/`complete`/NULL）、`scan_candidates TEXT`（合法 JSON 或 NULL）。
  - 資料表 `server_state(id = 1, data_version INTEGER NOT NULL DEFAULT 0)`，migration 時插入初始列。
  - `reina_core::database::repository::version_repository::VersionRepository::get(db: &impl ConnectionTrait) -> Result<i64, DbErr>`
  - `VersionRepository::bump(db: &impl ConnectionTrait) -> Result<i64, DbErr>`（回傳遞增後的值）
  - DTO：
    - `FullGameData` 新增 `teledrive_path: Option<String>`、`exe_relpath: Option<String>`、`cover_version: Option<String>`、`scan_status: Option<String>`、`scan_candidates: Option<serde_json::Value>`
    - `InsertGameData` 新增（皆 `#[serde(default)]`）`teledrive_path`、`exe_relpath`、`scan_status: Option<String>`、`scan_candidates: Option<Value>`（**不含** `cover_version`，封面版本只能由伺服器設定）
    - `UpdateGameData` 新增三態欄位 `teledrive_path`、`exe_relpath`、`scan_status: Option<Option<String>>`、`scan_candidates: Option<Option<Value>>`
  - 可組合寫入（第一個參數都是外部連線或 transaction；**不 begin、不 commit**）：
    - `GamesRepository::insert_in_connection<C: ConnectionTrait>(db: &C, game: InsertGameData) -> Result<FullGameData, DbErr>`
    - `GamesRepository::insert_batch_in_connection<C: ConnectionTrait + TransactionTrait>(db: &C, games: Vec<InsertGameData>) -> BatchOperationResult`（每筆用 savepoint，單筆失敗不影響其他筆）
    - `GamesRepository::update_in_connection<C: ConnectionTrait>(db: &C, game_id: i32, updates: UpdateGameData) -> Result<FullGameData, DbErr>`
    - `GamesRepository::update_batch_in_connection<C: ConnectionTrait>(db: &C, updates: Vec<(i32, UpdateGameData)>) -> Result<Vec<FullGameData>, DbErr>`
    - `GamesRepository::find_id_by_teledrive_path<C: ConnectionTrait>(db: &C, teledrive_path: &str) -> Result<Option<i32>, DbErr>`
    - `CollectionsRepository::add_games_to_collections_in_connection<C: ConnectionTrait>(db: &C, game_ids: Vec<i32>, collection_ids: Vec<i32>) -> Result<(), DbErr>`
    - `CollectionsRepository::set_game_collections_in_connection<C: ConnectionTrait>(db: &C, game_id: i32, collection_ids: Vec<i32>) -> Result<(), DbErr>`
    - `CollectionsRepository::update_category_games_in_connection<C: ConnectionTrait>(db: &C, new_game_ids: Vec<i32>, collection_id: i32) -> Result<(), DbErr>`
    - `GameStatsRepository::record_session_with_statistics_in_connection<C: ConnectionTrait>(db: &C, game_id: i32, start_time: i32, end_time: i32, duration: i32) -> Result<game_sessions::Model, DbErr>`
    - `GameStatsRepository::create_manual_session_in_connection<C: ConnectionTrait>(db: &C, game_id: i32, start_time: i32, duration: i32) -> Result<game_sessions::Model, DbErr>`
    - `GameStatsRepository::rebuild_statistics_in_connection<C: ConnectionTrait>(db: &C, game_id: i32) -> Result<(), DbErr>`
    - `GameStatsRepository::delete_session_with_statistics_in_connection<C: ConnectionTrait>(db: &C, session_id: i32) -> Result<i32, DbErr>`
  - 本來就不開 transaction 的寫入函式，**保留原名、改為泛型** `<C: ConnectionTrait>(db: &C, …)`：`GamesRepository::{delete, delete_many}`、`CollectionsRepository::{create, update, delete, remove_games_from_collection}`、`SettingsRepository::update_settings`。既有呼叫端傳 `&DatabaseConnection` 照常編譯。
  - 原本的公開函式（`insert`、`update`…）保留簽名，內部改為「begin → 呼叫 `_in_connection` → commit」，桌面版行為不變。
  - TypeScript：`FullGameData` 新增 `teledrive_path?: Nullable<string>`、`exe_relpath?: Nullable<string>`、`cover_version?: Nullable<string>`、`scan_status?: Nullable<ScanStatus>`、`scan_candidates?: JsonValue | null`；`export type ScanStatus = "pending" | "needs_confirmation" | "complete";`；`InsertGameParams`、`UpdateGameParams` 新增對應欄位（不含 `cover_version`）。

- [ ] **Step 1: 寫 migration 與它的失敗測試**

`src-tauri/migration/src/m20260926_000020_web_library.rs`：

```rust
//! 网页版（TeleDrive）所需的游戏位置、封面版本、扫描状态与全局资料版本。

use sea_orm_migration::prelude::*;
use sea_orm_migration::sea_orm::{ConnectionTrait, TransactionTrait};

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        add_web_library(&transaction).await?;
        transaction.commit().await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let transaction = manager.get_connection().begin().await?;
        remove_web_library(&transaction).await?;
        transaction.commit().await
    }
}

async fn add_web_library<C>(connection: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    connection
        .execute_unprepared(
            r#"
            ALTER TABLE games ADD COLUMN teledrive_path TEXT
                CHECK (teledrive_path IS NULL OR length(trim(teledrive_path)) > 0);
            ALTER TABLE games ADD COLUMN exe_relpath TEXT
                CHECK (exe_relpath IS NULL OR teledrive_path IS NOT NULL);
            ALTER TABLE games ADD COLUMN cover_version TEXT;
            ALTER TABLE games ADD COLUMN source_cover_hash TEXT;
            ALTER TABLE games ADD COLUMN custom_cover_hash TEXT;
            ALTER TABLE games ADD COLUMN scan_status TEXT
                CHECK (
                    scan_status IS NULL
                    OR scan_status IN ('pending', 'needs_confirmation', 'complete')
                );
            ALTER TABLE games ADD COLUMN scan_candidates TEXT
                CHECK (scan_candidates IS NULL OR json_valid(scan_candidates));
            CREATE UNIQUE INDEX IF NOT EXISTS idx_games_teledrive_path
                ON games(teledrive_path) WHERE teledrive_path IS NOT NULL;
            CREATE TABLE IF NOT EXISTS server_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                data_version INTEGER NOT NULL DEFAULT 0 CHECK (data_version >= 0)
            );
            INSERT OR IGNORE INTO server_state (id, data_version) VALUES (1, 0);
            "#,
        )
        .await?;
    Ok(())
}

async fn remove_web_library<C>(connection: &C) -> Result<(), DbErr>
where
    C: ConnectionTrait,
{
    // DROP COLUMN 不能删被索引或被其他栏位 CHECK 引用的栏位：先删索引与 exe_relpath，最后删 teledrive_path。
    connection
        .execute_unprepared(
            r#"
            DROP INDEX IF EXISTS idx_games_teledrive_path;
            DROP TABLE IF EXISTS server_state;
            ALTER TABLE games DROP COLUMN exe_relpath;
            ALTER TABLE games DROP COLUMN scan_candidates;
            ALTER TABLE games DROP COLUMN scan_status;
            ALTER TABLE games DROP COLUMN custom_cover_hash;
            ALTER TABLE games DROP COLUMN source_cover_hash;
            ALTER TABLE games DROP COLUMN cover_version;
            ALTER TABLE games DROP COLUMN teledrive_path;
            "#,
        )
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm_migration::sea_orm::{Database, DatabaseBackend, DatabaseConnection, Statement};

    async fn games_table() -> DatabaseConnection {
        let database = Database::connect("sqlite::memory:").await.unwrap();
        database
            .execute_unprepared(
                "CREATE TABLE games (id INTEGER PRIMARY KEY, id_type TEXT NOT NULL); \
                 INSERT INTO games(id, id_type) VALUES (1, 'custom');",
            )
            .await
            .unwrap();
        database
    }

    #[tokio::test]
    async fn adds_columns_with_defaults_and_version_row() {
        let database = games_table().await;
        add_web_library(&database).await.unwrap();

        let existing = database
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT teledrive_path, exe_relpath, cover_version, source_cover_hash, custom_cover_hash, scan_status, scan_candidates \
                 FROM games WHERE id = 1"
                    .to_string(),
            ))
            .await
            .unwrap()
            .unwrap();
        for column in [
            "teledrive_path",
            "exe_relpath",
            "cover_version",
            "source_cover_hash",
            "custom_cover_hash",
            "scan_status",
            "scan_candidates",
        ] {
            assert_eq!(existing.try_get::<Option<String>>("", column).unwrap(), None, "{column}");
        }

        let version = database
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "SELECT data_version FROM server_state WHERE id = 1".to_string(),
            ))
            .await
            .unwrap()
            .unwrap()
            .try_get::<i64>("", "data_version")
            .unwrap();
        assert_eq!(version, 0);
    }

    #[tokio::test]
    async fn enforces_constraints() {
        let database = games_table().await;
        add_web_library(&database).await.unwrap();

        // 非空 teledrive_path 唯一；多個 NULL 允許（手動新增的遊戲沒有雲端位置）。
        database
            .execute_unprepared(
                "INSERT INTO games(id, id_type, teledrive_path) VALUES (2, 'custom', 'game/A'); \
                 INSERT INTO games(id, id_type) VALUES (3, 'custom');",
            )
            .await
            .unwrap();
        for invalid in [
            "INSERT INTO games(id, id_type, teledrive_path) VALUES (10, 'custom', 'game/A')",
            "INSERT INTO games(id, id_type, teledrive_path) VALUES (11, 'custom', '   ')",
            "INSERT INTO games(id, id_type, exe_relpath) VALUES (12, 'custom', 'a.exe')",
            "INSERT INTO games(id, id_type, scan_status) VALUES (13, 'custom', 'done')",
            "INSERT INTO games(id, id_type, scan_candidates) VALUES (14, 'custom', '{not json')",
            "INSERT INTO server_state(id, data_version) VALUES (2, 0)",
            "UPDATE server_state SET data_version = -1 WHERE id = 1",
        ] {
            assert!(database.execute_unprepared(invalid).await.is_err(), "{invalid}");
        }
    }

    #[tokio::test]
    async fn down_removes_everything() {
        let database = games_table().await;
        add_web_library(&database).await.unwrap();
        remove_web_library(&database).await.unwrap();

        let columns = database
            .query_all_raw(Statement::from_string(
                DatabaseBackend::Sqlite,
                "PRAGMA table_info(games)".to_string(),
            ))
            .await
            .unwrap();
        assert!(columns.iter().all(|column| {
            !matches!(
                column.try_get::<String>("", "name").unwrap().as_str(),
                "teledrive_path"
                    | "exe_relpath"
                    | "cover_version"
                    | "source_cover_hash"
                    | "custom_cover_hash"
                    | "scan_status"
                    | "scan_candidates"
            )
        }));
        assert!(database
            .execute_unprepared("SELECT 1 FROM server_state")
            .await
            .is_err());
    }
}
```

`src-tauri/migration/src/lib.rs`：在 `mod m20260809_000019_add_steam_launch;` 下一行加入

```rust
mod m20260926_000020_web_library;
```

並在 `migrations()` 清單最後一項後加入

```rust
            Box::new(m20260926_000020_web_library::Migration),
```

- [ ] **Step 2: 執行 migration 測試確認通過（純 SQL，先確保 schema 正確）**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p migration m20260926_000020_web_library`
Expected: `test result: ok. 3 passed`

（若 `adds_columns_with_defaults_and_version_row` 失敗於 `ALTER TABLE ... CHECK`，表示 SQLite 版本過舊；專案 sqlx 內建的 SQLite 已支援，照理不會發生。）

- [ ] **Step 3: 寫 repository 層的失敗測試**

`src-tauri/reina-core/tests/web_transactions.rs`：

```rust
//! 網頁版寫入的組合性：外部 transaction、版本遞增與 rollback 必須一致。

use reina_core::database::connect_database;
use reina_core::database::dto::{InsertCollectionData, InsertGameData, UpdateGameData};
use reina_core::database::repository::collections_repository::CollectionsRepository;
use reina_core::database::repository::game_stats_repository::GameStatsRepository;
use reina_core::database::repository::games_repository::GamesRepository;
use reina_core::database::repository::version_repository::VersionRepository;
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde_json::json;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "reina_web_tx_{}_{}_{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn database(name: &str) -> DatabaseConnection {
    connect_database(&unique_dir(name).join("reina_manager.db"))
        .await
        .unwrap()
}

/// InsertGameData 沒有 Default；用 JSON 建立，只填測試關心的欄位。
fn game(value: serde_json::Value) -> InsertGameData {
    let mut base = json!({ "id_type": "custom" });
    base.as_object_mut()
        .unwrap()
        .extend(value.as_object().unwrap().clone());
    serde_json::from_value(base).unwrap()
}

#[tokio::test]
async fn version_starts_at_zero_and_bump_returns_new_value() {
    let db = database("version").await;
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 0);
    assert_eq!(VersionRepository::bump(&db).await.unwrap(), 1);
    assert_eq!(VersionRepository::bump(&db).await.unwrap(), 2);
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 2);
}

#[tokio::test]
async fn write_and_version_roll_back_together() {
    let db = database("rollback").await;

    let tx = db.begin().await.unwrap();
    let inserted = GamesRepository::insert_in_connection(&tx, game(json!({ "teledrive_path": "game/A" })))
        .await
        .unwrap();
    assert_eq!(VersionRepository::bump(&tx).await.unwrap(), 1);
    tx.rollback().await.unwrap();

    assert!(GamesRepository::find_by_id(&db, inserted.id).await.unwrap().is_none());
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 0);

    let tx = db.begin().await.unwrap();
    let committed = GamesRepository::insert_in_connection(&tx, game(json!({ "teledrive_path": "game/A" })))
        .await
        .unwrap();
    VersionRepository::bump(&tx).await.unwrap();
    tx.commit().await.unwrap();

    let stored = GamesRepository::find_by_id(&db, committed.id).await.unwrap().unwrap();
    assert_eq!(stored.teledrive_path.as_deref(), Some("game/A"));
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 1);
}

#[tokio::test]
async fn teledrive_path_is_unique_but_optional() {
    let db = database("unique").await;
    GamesRepository::insert(&db, game(json!({ "teledrive_path": "game/A" }))).await.unwrap();
    assert!(GamesRepository::insert(&db, game(json!({ "teledrive_path": "game/A" }))).await.is_err());
    // 手動新增的遊戲沒有雲端位置，可以有很多筆。
    GamesRepository::insert(&db, game(json!({}))).await.unwrap();
    GamesRepository::insert(&db, game(json!({}))).await.unwrap();

    assert_eq!(
        GamesRepository::find_id_by_teledrive_path(&db, "game/A").await.unwrap().is_some(),
        true
    );
    assert_eq!(
        GamesRepository::find_id_by_teledrive_path(&db, "game/B").await.unwrap(),
        None
    );
}

#[tokio::test]
async fn exe_relpath_is_validated_and_normalized() {
    let db = database("exe").await;

    // 反斜線統一存成 "/"，讓 bridge 在任何電腦上都用同一種分隔符號解析。
    let stored = GamesRepository::insert(
        &db,
        game(json!({ "teledrive_path": "game/01000250", "exe_relpath": "01000250\\haison.exe" })),
    )
    .await
    .unwrap();
    assert_eq!(stored.exe_relpath.as_deref(), Some("01000250/haison.exe"));

    for bad in ["../haison.exe", "C:\\Games\\haison.exe", "/abs/haison.exe"] {
        let result = GamesRepository::insert(
            &db,
            game(json!({ "teledrive_path": format!("game/{bad}x"), "exe_relpath": bad })),
        )
        .await;
        assert!(result.is_err(), "{bad}");
    }
    // 沒有 teledrive_path 就不能有 exe_relpath。
    assert!(GamesRepository::insert(&db, game(json!({ "exe_relpath": "a.exe" }))).await.is_err());
}

#[tokio::test]
async fn clearing_teledrive_path_also_clears_exe_relpath() {
    let db = database("clear").await;
    let stored = GamesRepository::insert(
        &db,
        game(json!({ "teledrive_path": "game/A", "exe_relpath": "A/a.exe", "scan_status": "complete" })),
    )
    .await
    .unwrap();

    let updated = GamesRepository::update(
        &db,
        stored.id,
        UpdateGameData {
            teledrive_path: Some(None),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(updated.teledrive_path, None);
    assert_eq!(updated.exe_relpath, None);
    assert_eq!(updated.scan_status.as_deref(), Some("complete"));
}

#[tokio::test]
async fn scan_fields_round_trip_and_reject_unknown_status() {
    let db = database("scan").await;
    let candidates = json!([{ "source": "vndb", "external_id": "v38037", "score": 0.92 }]);
    let stored = GamesRepository::insert(
        &db,
        game(json!({
            "teledrive_path": "game/Haison",
            "scan_status": "needs_confirmation",
            "scan_candidates": candidates
        })),
    )
    .await
    .unwrap();
    assert_eq!(stored.scan_status.as_deref(), Some("needs_confirmation"));
    assert_eq!(stored.scan_candidates, Some(candidates));

    assert!(GamesRepository::insert(
        &db,
        game(json!({ "teledrive_path": "game/X", "scan_status": "done" }))
    )
    .await
    .is_err());
}

#[tokio::test]
async fn batch_insert_uses_savepoints_inside_outer_transaction() {
    let db = database("batch").await;
    let tx = db.begin().await.unwrap();
    let result = GamesRepository::insert_batch_in_connection(
        &tx,
        vec![
            game(json!({ "teledrive_path": "game/A" })),
            game(json!({ "teledrive_path": "game/A" })), // 重複，只有這筆失敗
            game(json!({ "teledrive_path": "game/B" })),
        ],
    )
    .await;
    assert_eq!(result.success, 2);
    assert_eq!(result.failed, 1);
    assert_eq!(result.errors[0].index, 1);
    tx.rollback().await.unwrap();

    // 外層 rollback 後，連成功的那兩筆也不存在。
    assert_eq!(GamesRepository::find_id_by_teledrive_path(&db, "game/A").await.unwrap(), None);
    assert_eq!(GamesRepository::find_id_by_teledrive_path(&db, "game/B").await.unwrap(), None);
}

#[tokio::test]
async fn update_batch_in_connection_is_all_or_nothing_with_outer_rollback() {
    let db = database("update_batch").await;
    let a = GamesRepository::insert(&db, game(json!({ "teledrive_path": "game/A" }))).await.unwrap();

    let tx = db.begin().await.unwrap();
    GamesRepository::update_batch_in_connection(
        &tx,
        vec![(a.id, UpdateGameData { scan_status: Some(Some("complete".to_string())), ..Default::default() })],
    )
    .await
    .unwrap();
    tx.rollback().await.unwrap();

    let reloaded = GamesRepository::find_by_id(&db, a.id).await.unwrap().unwrap();
    assert_eq!(reloaded.scan_status, None);
}

#[tokio::test]
async fn collections_and_sessions_compose_with_outer_transaction() {
    let db = database("compose").await;
    let g = GamesRepository::insert(&db, game(json!({}))).await.unwrap();
    let collection = CollectionsRepository::create(
        &db,
        InsertCollectionData { name: "合集".to_string(), parent_id: None, sort_order: 0, icon: None },
    )
    .await
    .unwrap();

    let tx = db.begin().await.unwrap();
    CollectionsRepository::set_game_collections_in_connection(&tx, g.id, vec![collection.id])
        .await
        .unwrap();
    GameStatsRepository::record_session_with_statistics_in_connection(&tx, g.id, 1_700_000_000, 1_700_003_600, 60)
        .await
        .unwrap();
    VersionRepository::bump(&tx).await.unwrap();
    tx.rollback().await.unwrap();

    assert!(CollectionsRepository::get_game_collection_ids(&db, g.id).await.unwrap().is_empty());
    assert!(GameStatsRepository::get_sessions(&db, g.id, 10, 0).await.unwrap().is_empty());
    assert_eq!(VersionRepository::get(&db).await.unwrap(), 0);
}
```

> `get_game_collection_ids(db, game_id)` 與 `get_sessions(db, game_id, limit, offset)` 是既有的公開讀取函式（`collections_repository.rs:426`、`game_stats_repository.rs:496`）。

- [ ] **Step 4: 執行確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-core --test web_transactions`
Expected: 編譯失敗，包含 `unresolved import ... version_repository`、`no function or associated item named `insert_in_connection``、`struct `UpdateGameData` has no field named `teledrive_path``。

- [ ] **Step 5: 實作版本 repository**

`src-tauri/reina-core/src/database/repository/version_repository.rs`：

```rust
//! 网页版的全局资料版本（server_state 单行表）。
//!
//! 版本只由 reina-server 的 Write command 在同一个 transaction 内递增，
//! 前端轮询它来判断其他装置是否改过资料。

use sea_orm::{ConnectionTrait, DbErr, Statement};

pub struct VersionRepository;

impl VersionRepository {
    /// 读取目前的资料版本。
    pub async fn get(db: &impl ConnectionTrait) -> Result<i64, DbErr> {
        db.query_one_raw(Statement::from_string(
            db.get_database_backend(),
            "SELECT data_version FROM server_state WHERE id = 1".to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("server_state 缺少 id = 1 的版本记录".to_string()))?
        .try_get::<i64>("", "data_version")
    }

    /// 版本加 1 并回传新值；必须和业务写入使用同一个 transaction。
    pub async fn bump(db: &impl ConnectionTrait) -> Result<i64, DbErr> {
        db.query_one_raw(Statement::from_string(
            db.get_database_backend(),
            "UPDATE server_state SET data_version = data_version + 1 WHERE id = 1 \
             RETURNING data_version"
                .to_string(),
        ))
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("server_state 缺少 id = 1 的版本记录".to_string()))?
        .try_get::<i64>("", "data_version")
    }
}
```

`src-tauri/reina-core/src/database/repository.rs` 最後加一行：

```rust
pub mod version_repository;
```

- [ ] **Step 6: entity 與 DTO 加欄位**

`src-tauri/reina-core/src/entity/games.rs`：在 `pub user_rating: Option<f64>,` 之後、`// === 时间戳 ===` 之前插入：

```rust
    // === 网页版（TeleDrive）位置、封面版本与扫描状态 ===
    #[sea_orm(column_type = "Text", nullable)]
    pub teledrive_path: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub exe_relpath: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub cover_version: Option<String>,
    /// 来源封面与自定义封面内容的 SHA-256；只由任务 7 的 set_cover_hashes_in_connection 写入
    #[sea_orm(column_type = "Text", nullable)]
    pub source_cover_hash: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub custom_cover_hash: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub scan_status: Option<String>,
    #[sea_orm(column_type = "Json", nullable)]
    pub scan_candidates: Option<Json>,
```

`src-tauri/reina-core/src/database/dto.rs`：

`FullGameData` 在 `pub sources: Vec<GameSourceData>,` 之前插入：

```rust
    pub teledrive_path: Option<String>,
    pub exe_relpath: Option<String>,
    pub cover_version: Option<String>,
    pub scan_status: Option<String>,
    pub scan_candidates: Option<Value>,
```

`InsertGameData` 在 `pub custom_data: Option<CustomData>,` 之前插入：

```rust
    // === 网页版位置与扫描状态（封面版本只能由伺服器设定，不接受客户端写入）===
    #[serde(default)]
    pub teledrive_path: Option<String>,
    #[serde(default)]
    pub exe_relpath: Option<String>,
    #[serde(default)]
    pub scan_status: Option<String>,
    #[serde(default)]
    pub scan_candidates: Option<Value>,
```

`UpdateGameData` 在 `pub custom_data: Option<Option<CustomData>>,` 之前插入：

```rust
    #[serde(default, deserialize_with = "double_option")]
    pub teledrive_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub exe_relpath: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub scan_status: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option")]
    pub scan_candidates: Option<Option<Value>>,
```

在 `clean_double_option_string` 函式之後新增：

```rust
/// 清洗相对路径：去空白、空字串转 None，反斜线统一为 "/"。
fn clean_option_relpath(s: Option<String>) -> Option<String> {
    clean_option_string(s).map(|v| v.trim().replace('\\', "/"))
}

fn clean_double_option_relpath(s: Option<Option<String>>) -> Option<Option<String>> {
    s.map(clean_option_relpath)
}
```

`impl InsertGameData::cleaned` 在 `self.savepath = …;` 之後加入：

```rust
        self.teledrive_path = clean_option_relpath(self.teledrive_path);
        self.exe_relpath = clean_option_relpath(self.exe_relpath);
        self.scan_status = clean_option_string(self.scan_status).map(|v| v.trim().to_string());
```

`impl UpdateGameData::cleaned` 在 `self.savepath = …;` 之後加入：

```rust
        self.teledrive_path = clean_double_option_relpath(self.teledrive_path);
        self.exe_relpath = clean_double_option_relpath(self.exe_relpath);
        self.scan_status = self
            .scan_status
            .map(|inner| clean_option_string(inner).map(|v| v.trim().to_string()));
```

- [ ] **Step 7: games repository 的讀寫與可組合版本**

`games_repository.rs` 第 9 行改為（任務 1 只匯入了一個）：

```rust
use crate::validation::{validate_executable_name, validate_safe_relative_path};
```

`FULL_GAME_SELECT` 在 `g.updated_at,` 之後插入：

```sql
            g.teledrive_path,
            g.exe_relpath,
            g.cover_version,
            g.scan_status,
            g.scan_candidates,
```

在 `validate_path_state` 之後新增：

```rust
    /// 网页版位置：exe_relpath 必须挂在 teledrive_path 之下，两者都必须是安全相对路径。
    fn validate_web_location(
        teledrive_path: Option<&str>,
        exe_relpath: Option<&str>,
    ) -> Result<(), DbErr> {
        if teledrive_path.is_none() && exe_relpath.is_some() {
            return Err(DbErr::Custom(
                "exe_relpath 不能在 teledrive_path 为空时单独存在".to_string(),
            ));
        }
        if let Some(path) = teledrive_path {
            validate_safe_relative_path(path)
                .map_err(|error| DbErr::Custom(format!("teledrive_path 无效: {error}")))?;
        }
        if let Some(path) = exe_relpath {
            validate_safe_relative_path(path)
                .map_err(|error| DbErr::Custom(format!("exe_relpath 无效: {error}")))?;
        }
        Ok(())
    }

    async fn normalize_update_web_location<C>(
        db: &C,
        game_id: i32,
        mut updates: UpdateGameData,
    ) -> Result<UpdateGameData, DbErr>
    where
        C: ConnectionTrait,
    {
        if updates.teledrive_path.is_none() && updates.exe_relpath.is_none() {
            return Ok(updates);
        }

        let current = Games::find_by_id(game_id)
            .one(db)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("game {game_id} not found")))?;

        // 清空云端位置代表游戏不再对应 TeleDrive 资料夹，执行档相对路径必须一起清空。
        if matches!(updates.teledrive_path, Some(None)) {
            updates.exe_relpath = Some(None);
        }

        let final_path = updates.teledrive_path.clone().unwrap_or(current.teledrive_path);
        let final_exe = updates.exe_relpath.clone().unwrap_or(current.exe_relpath);
        Self::validate_web_location(final_path.as_deref(), final_exe.as_deref())?;
        Ok(updates)
    }
```

`build_insert_active_model` 的 struct literal 在 `user_rating: NotSet,` 之後插入：

```rust
            teledrive_path: Set(game.teledrive_path.clone()),
            exe_relpath: Set(game.exe_relpath.clone()),
            cover_version: NotSet,
            source_cover_hash: NotSet,
            custom_cover_hash: NotSet,
            scan_status: Set(game.scan_status.clone()),
            scan_candidates: Set(game.scan_candidates.clone()),
```

`build_update_active_model` 在 `user_rating: NotSet,` 之後插入：

```rust
            teledrive_path: updates.teledrive_path.clone().map_or(NotSet, Set),
            exe_relpath: updates.exe_relpath.clone().map_or(NotSet, Set),
            scan_status: updates.scan_status.clone().map_or(NotSet, Set),
            scan_candidates: updates.scan_candidates.clone().map_or(NotSet, Set),
```

`insert_aggregate` 在 `Self::validate_path_state(...)?;` 之後加一行：

```rust
        Self::validate_web_location(game.teledrive_path.as_deref(), game.exe_relpath.as_deref())?;
```

`update_aggregate` 在 `let updates = Self::normalize_update_launch_state(db, game_id, updates).await?;` 之後加一行：

```rust
        let updates = Self::normalize_update_web_location(db, game_id, updates).await?;
```

`full_game_from_row` 在 `let sources_json …` 之前加入，並在回傳的 `FullGameData { … }` 的 `custom_data,` 之後加五個欄位：

```rust
        let scan_candidates = row
            .try_get::<Option<String>>("", "scan_candidates")?
            .map(|data| {
                serde_json::from_str(&data)
                    .map_err(|error| DbErr::Custom(format!("scan_candidates 解析失败: {}", error)))
            })
            .transpose()?;
```

```rust
            teledrive_path: row.try_get("", "teledrive_path")?,
            exe_relpath: row.try_get("", "exe_relpath")?,
            cover_version: row.try_get("", "cover_version")?,
            scan_status: row.try_get("", "scan_status")?,
            scan_candidates,
```

把 `insert` 到 `update_batch`（第 492–642 行，`update_aggregate` 本體除外）替換為以下內容。`update_aggregate` 本體保留在 `insert_batch_in_connection` 與 `update` 之間原位不動：

```rust
    // ==================== 游戏 CRUD 操作 ====================

    /// 在外部连线或 transaction 内新增游戏；不 begin、不 commit。
    pub async fn insert_in_connection<C>(db: &C, game: InsertGameData) -> Result<FullGameData, DbErr>
    where
        C: ConnectionTrait,
    {
        Self::insert_aggregate(db, game.cleaned(), chrono::Utc::now().timestamp() as i32).await
    }

    pub async fn insert(
        db: &DatabaseConnection,
        game: InsertGameData,
    ) -> Result<FullGameData, DbErr> {
        let transaction = db.begin().await?;
        let result = Self::insert_in_connection(&transaction, game).await?;
        transaction.commit().await?;
        Ok(result)
    }

    /// 在外部 transaction 内批次新增；每笔使用 savepoint，单笔失败不影响其他笔。
    pub async fn insert_batch_in_connection<C>(
        db: &C,
        games: Vec<InsertGameData>,
    ) -> BatchOperationResult
    where
        C: ConnectionTrait + TransactionTrait,
    {
        let total = games.len();
        let now = chrono::Utc::now().timestamp() as i32;
        let mut ids = Vec::with_capacity(total);
        let mut inserted_games = Vec::with_capacity(total);
        let mut errors = Vec::new();

        for (index, game) in games.into_iter().enumerate() {
            let nested = match db.begin().await {
                Ok(nested) => nested,
                Err(error) => {
                    errors.push(BatchOperationError {
                        index,
                        message: error.to_string(),
                    });
                    continue;
                }
            };

            match Self::insert_aggregate(&nested, game.cleaned(), now).await {
                Ok(result) => {
                    if let Err(error) = nested.commit().await {
                        errors.push(BatchOperationError {
                            index,
                            message: error.to_string(),
                        });
                    } else {
                        ids.push(result.id);
                        inserted_games.push(result);
                    }
                }
                Err(error) => {
                    let _ = nested.rollback().await;
                    errors.push(BatchOperationError {
                        index,
                        message: error.to_string(),
                    });
                }
            }
        }

        BatchOperationResult {
            total,
            success: ids.len(),
            failed: errors.len(),
            ids,
            games: inserted_games,
            errors,
        }
    }

    pub async fn insert_batch(
        db: &DatabaseConnection,
        games: Vec<InsertGameData>,
    ) -> BatchOperationResult {
        let total = games.len();
        let transaction = match db.begin().await {
            Ok(transaction) => transaction,
            Err(error) => return Self::build_batch_failure_result(total, error.to_string()),
        };
        let result = Self::insert_batch_in_connection(&transaction, games).await;
        if let Err(error) = transaction.commit().await {
            return Self::build_batch_failure_result(total, error.to_string());
        }
        result
    }

    // （此處保留原本的 `pub async fn update_aggregate<C>(…)` 本體，內容不變）

    /// 在外部连线或 transaction 内更新游戏；不 begin、不 commit。
    pub async fn update_in_connection<C>(
        db: &C,
        game_id: i32,
        updates: UpdateGameData,
    ) -> Result<FullGameData, DbErr>
    where
        C: ConnectionTrait,
    {
        Self::update_aggregate(
            db,
            game_id,
            updates.cleaned(),
            chrono::Utc::now().timestamp() as i32,
        )
        .await
    }

    pub async fn update(
        db: &DatabaseConnection,
        game_id: i32,
        updates: UpdateGameData,
    ) -> Result<FullGameData, DbErr> {
        let transaction = db.begin().await?;
        let result = Self::update_in_connection(&transaction, game_id, updates).await?;
        transaction.commit().await?;
        Ok(result)
    }

    /// 在外部连线或 transaction 内批次更新；任何一笔失败即回传错误，由呼叫端决定 rollback。
    pub async fn update_batch_in_connection<C>(
        db: &C,
        updates: Vec<(i32, UpdateGameData)>,
    ) -> Result<Vec<FullGameData>, DbErr>
    where
        C: ConnectionTrait,
    {
        let now = chrono::Utc::now().timestamp() as i32;
        let mut updated_games = Vec::with_capacity(updates.len());
        for (game_id, update) in updates {
            updated_games.push(Self::update_aggregate(db, game_id, update.cleaned(), now).await?);
        }
        Ok(updated_games)
    }

    pub async fn update_batch(
        db: &DatabaseConnection,
        updates: Vec<(i32, UpdateGameData)>,
    ) -> Result<Vec<FullGameData>, DbErr> {
        if updates.is_empty() {
            return Ok(Vec::new());
        }
        let transaction = db.begin().await?;
        let result = Self::update_batch_in_connection(&transaction, updates).await?;
        transaction.commit().await?;
        Ok(result)
    }

    /// 依 TeleDrive 路径找游戏 ID；扫描时用来判断资料夹是否已入库。
    pub async fn find_id_by_teledrive_path<C>(
        db: &C,
        teledrive_path: &str,
    ) -> Result<Option<i32>, DbErr>
    where
        C: ConnectionTrait,
    {
        Ok(Games::find()
            .filter(games::Column::TeledrivePath.eq(teledrive_path))
            .one(db)
            .await?
            .map(|game| game.id))
    }
```

`delete` / `delete_many`（第 750–762 行）改為泛型：

```rust
    pub async fn delete<C>(db: &C, id: i32) -> Result<DeleteResult, DbErr>
    where
        C: ConnectionTrait,
    {
        Games::delete_by_id(id).exec(db).await
    }

    pub async fn delete_many<C>(db: &C, ids: Vec<i32>) -> Result<DeleteResult, DbErr>
    where
        C: ConnectionTrait,
    {
        Games::delete_many()
            .filter(games::Column::Id.is_in(ids))
            .exec(db)
            .await
    }
```

測試模組 `setup_database`（第 1127 行起的 `CREATE TABLE games`）在 `updated_at INTEGER` 之後加上：

```sql
                    ,
                    teledrive_path TEXT,
                    exe_relpath TEXT,
                    cover_version TEXT,
                    source_cover_hash TEXT,
                    custom_cover_hash TEXT,
                    scan_status TEXT,
                    scan_candidates TEXT
```

（也就是把原本的 `updated_at INTEGER` 改為 `updated_at INTEGER,` 並接上這七行，不要留下多餘的逗號。）

測試 helper `insert_data`（第 1197 行的 `InsertGameData { … }`）在 `magpie: None,` 之後加入：

```rust
            teledrive_path: None,
            exe_relpath: None,
            scan_status: None,
            scan_candidates: None,
```

- [ ] **Step 8: collections、stats、settings 的可組合版本**

`collections_repository.rs` 四個私有 helper（`delete_game_collection_links`、`insert_game_collection_links`、`update_game_collection_sort_orders`、`build_append_inserts`，第 203、219、243、271 行）的參數由 `txn: &DatabaseTransaction` 改為泛型，例如：

```rust
    async fn delete_game_collection_links<C>(
        txn: &C,
        link_ids: Vec<i32>,
    ) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
```

（四個函式本體不變，只換簽名。）

`create`、`update`、`delete`、`remove_games_from_collection` 的 `db: &DatabaseConnection` 改為 `db: &C`，並加 `where C: ConnectionTrait`，例如：

```rust
    pub async fn create<C>(db: &C, data: InsertCollectionData) -> Result<collections::Model, DbErr>
    where
        C: ConnectionTrait,
    {
```

（本體不變。）

`add_games_to_collections`、`set_game_collections`、`update_category_games`（第 440–535 行）替換為：

```rust
    /// 批量将多个游戏添加到多个合集，已存在的关联会跳过（外部 transaction 版本）
    pub async fn add_games_to_collections_in_connection<C>(
        db: &C,
        game_ids: Vec<i32>,
        collection_ids: Vec<i32>,
    ) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
        let game_ids = Self::unique_ids(game_ids);
        let collection_ids = Self::unique_ids(collection_ids);
        if game_ids.is_empty() || collection_ids.is_empty() {
            return Ok(());
        }

        let current_links = GameCollectionLink::find()
            .filter(game_collection_link::Column::GameId.is_in(game_ids.clone()))
            .filter(game_collection_link::Column::CollectionId.is_in(collection_ids.clone()))
            .all(db)
            .await?;
        let target_pairs = collection_ids
            .iter()
            .flat_map(|collection_id| {
                game_ids.iter().map(|game_id| GameCollectionPair {
                    game_id: *game_id,
                    collection_id: *collection_id,
                })
            })
            .collect::<Vec<_>>();
        let diff = Self::diff_game_collection_pairs(&current_links, &target_pairs);
        let inserts = Self::build_append_inserts(db, diff.to_insert).await?;
        Self::insert_game_collection_links(db, inserts).await?;
        Ok(())
    }

    /// 批量将多个游戏添加到多个合集，已存在的关联会跳过
    pub async fn add_games_to_collections(
        db: &DatabaseConnection,
        game_ids: Vec<i32>,
        collection_ids: Vec<i32>,
    ) -> Result<(), DbErr> {
        let txn = db.begin().await?;
        Self::add_games_to_collections_in_connection(&txn, game_ids, collection_ids).await?;
        txn.commit().await
    }

    /// 设置单个游戏所在的合集列表（外部 transaction 版本）
    pub async fn set_game_collections_in_connection<C>(
        db: &C,
        game_id: i32,
        collection_ids: Vec<i32>,
    ) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
        let current_links = GameCollectionLink::find()
            .filter(game_collection_link::Column::GameId.eq(game_id))
            .all(db)
            .await?;
        let target_pairs = Self::unique_ids(collection_ids)
            .into_iter()
            .map(|collection_id| GameCollectionPair {
                game_id,
                collection_id,
            })
            .collect::<Vec<_>>();
        let diff = Self::diff_game_collection_pairs(&current_links, &target_pairs);
        Self::delete_game_collection_links(db, diff.to_delete_link_ids).await?;
        let inserts = Self::build_append_inserts(db, diff.to_insert).await?;
        Self::insert_game_collection_links(db, inserts).await?;
        Ok(())
    }

    /// 设置单个游戏所在的合集列表
    pub async fn set_game_collections(
        db: &DatabaseConnection,
        game_id: i32,
        collection_ids: Vec<i32>,
    ) -> Result<(), DbErr> {
        let txn = db.begin().await?;
        Self::set_game_collections_in_connection(&txn, game_id, collection_ids).await?;
        txn.commit().await
    }

    /// 批量更新分类中的游戏列表（外部 transaction 版本）
    pub async fn update_category_games_in_connection<C>(
        db: &C,
        new_game_ids: Vec<i32>,
        collection_id: i32,
    ) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
        let current_links = GameCollectionLink::find()
            .filter(game_collection_link::Column::CollectionId.eq(collection_id))
            .all(db)
            .await?;
        let diff = Self::build_category_games_diff(&current_links, new_game_ids, collection_id);

        Self::delete_game_collection_links(db, diff.to_delete_link_ids).await?;
        Self::insert_game_collection_links(db, diff.to_insert).await?;
        Self::update_game_collection_sort_orders(db, diff.to_update_sort_orders).await?;
        Ok(())
    }

    /// 批量更新分类中的游戏列表（差异计算优化版）
    /// 将分类中的游戏完全替换为 game_ids
    ///
    /// 算法策略：
    /// 1. 查询现有游戏列表
    /// 2. 计算差异：找出需要删除、新增、更新排序的游戏
    /// 3. 只执行必要的数据库操作
    pub async fn update_category_games(
        db: &DatabaseConnection,
        new_game_ids: Vec<i32>,
        collection_id: i32,
    ) -> Result<(), DbErr> {
        let txn = db.begin().await?;
        Self::update_category_games_in_connection(&txn, new_game_ids, collection_id).await?;
        txn.commit().await
    }
```

`game_stats_repository.rs`：`upsert_projection`（第 612 行）的 `db: &DatabaseTransaction` 改為泛型 `db: &C` 並加 `where C: ConnectionTrait`（本體不變）。`record_session_with_statistics`、`create_manual_session`、`rebuild_statistics`、`delete_session_with_statistics`（第 436–572 行）替換為：

```rust
    /// 在外部 transaction 内写入会话并增量更新统计
    pub async fn record_session_with_statistics_in_connection<C>(
        db: &C,
        game_id: i32,
        start_time: i32,
        end_time: i32,
        duration: i32,
    ) -> Result<game_sessions::Model, DbErr>
    where
        C: ConnectionTrait,
    {
        let date = local_date_from_timestamp(end_time)?;
        let session =
            Self::insert_session(db, game_id, start_time, end_time, duration, date).await?;

        let projection = match Self::get_projection(db, game_id).await {
            Ok(Some(mut projection)) => {
                if apply_session_insert(&mut projection, &session, &Local).is_ok() {
                    projection
                } else {
                    Self::calculate_projection(db, game_id).await?
                }
            }
            Ok(None) | Err(_) => Self::calculate_projection(db, game_id).await?,
        };

        Self::upsert_projection(db, game_id, projection).await?;
        Ok(session)
    }

    /// 在同一事务内写入会话并增量更新统计
    pub async fn record_session_with_statistics(
        db: &DatabaseConnection,
        game_id: i32,
        start_time: i32,
        end_time: i32,
        duration: i32,
    ) -> Result<game_sessions::Model, DbErr> {
        let transaction = db.begin().await?;
        let session = Self::record_session_with_statistics_in_connection(
            &transaction,
            game_id,
            start_time,
            end_time,
            duration,
        )
        .await?;
        transaction.commit().await?;
        Ok(session)
    }

    /// 根据开始时间和分钟数创建手动会话（外部 transaction 版本）
    pub async fn create_manual_session_in_connection<C>(
        db: &C,
        game_id: i32,
        start_time: i32,
        duration: i32,
    ) -> Result<game_sessions::Model, DbErr>
    where
        C: ConnectionTrait,
    {
        if game_id <= 0 {
            return Err(custom_error("游戏 ID 必须大于零"));
        }

        let current_time = i32::try_from(chrono::Utc::now().timestamp())
            .map_err(|_| custom_error("当前时间超出数据库整数范围"))?;
        let end_time = manual_session_end_time(start_time, duration, current_time)?;

        Self::record_session_with_statistics_in_connection(db, game_id, start_time, end_time, duration)
            .await
    }

    /// 根据开始时间和分钟数创建手动会话
    pub async fn create_manual_session(
        db: &DatabaseConnection,
        game_id: i32,
        start_time: i32,
        duration: i32,
    ) -> Result<game_sessions::Model, DbErr> {
        let transaction = db.begin().await?;
        let session =
            Self::create_manual_session_in_connection(&transaction, game_id, start_time, duration)
                .await?;
        transaction.commit().await?;
        Ok(session)
    }

    /// 从事实会话重建指定游戏的统计投影（外部 transaction 版本）
    pub async fn rebuild_statistics_in_connection<C>(db: &C, game_id: i32) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
        if game_id <= 0 {
            return Err(custom_error("游戏 ID 必须大于零"));
        }
        let projection = Self::calculate_projection(db, game_id).await?;
        Self::upsert_projection(db, game_id, projection).await
    }

    /// 从事实会话重建指定游戏的统计投影
    pub async fn rebuild_statistics(db: &DatabaseConnection, game_id: i32) -> Result<(), DbErr> {
        let transaction = db.begin().await?;
        Self::rebuild_statistics_in_connection(&transaction, game_id).await?;
        transaction.commit().await
    }
```

> 注意 `create_manual_session` 原本直接呼叫 `record_session_with_statistics(db, …)`（在那裡才開 transaction）；新寫法改成外層開 transaction 再呼叫 `_in_connection`，語意相同。`get_sessions`、`get_recent_sessions_for_all` 這兩個讀取函式保持原位不動（它們位於 `rebuild_statistics` 與 `delete_session_with_statistics` 之間，替換時不要刪掉）。

`delete_session_with_statistics`（第 534–572 行）替換為：

```rust
    /// 在外部 transaction 内删除会话并增量更新统计；回传该会话的 game_id
    pub async fn delete_session_with_statistics_in_connection<C>(
        db: &C,
        session_id: i32,
    ) -> Result<i32, DbErr>
    where
        C: ConnectionTrait,
    {
        let session = GameSessions::find_by_id(session_id)
            .one(db)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("会话不存在: {session_id}")))?;
        let statistics = GameStatistics::find_by_id(session.game_id).one(db).await?;

        GameSessions::delete_by_id(session_id).exec(db).await?;

        let projection = match statistics.map(projection_from_model).transpose() {
            Ok(Some(mut projection)) => {
                let remaining_last_played = if projection.last_played == Some(session.end_time) {
                    Self::get_latest_session_end(db, session.game_id).await?
                } else {
                    projection.last_played
                };

                if apply_session_delete(&mut projection, &session, remaining_last_played, &Local)
                    .is_ok()
                {
                    projection
                } else {
                    Self::calculate_projection(db, session.game_id).await?
                }
            }
            Ok(None) | Err(_) => Self::calculate_projection(db, session.game_id).await?,
        };

        Self::upsert_projection(db, session.game_id, projection).await?;
        Ok(session.game_id)
    }

    /// 在同一事务内删除会话并增量更新统计
    pub async fn delete_session_with_statistics(
        db: &DatabaseConnection,
        session_id: i32,
    ) -> Result<i32, DbErr> {
        let transaction = db.begin().await?;
        let game_id =
            Self::delete_session_with_statistics_in_connection(&transaction, session_id).await?;
        transaction.commit().await?;
        Ok(game_id)
    }
```

`settings_repository.rs`：`ensure_user_exists`（第 26 行）與 `update_settings`（第 59 行）改為泛型（本體不變）：

```rust
    async fn ensure_user_exists<C>(db: &C) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
```

```rust
    pub async fn update_settings<C>(db: &C, data: UpdateSettingsData) -> Result<(), DbErr>
    where
        C: ConnectionTrait,
    {
```

- [ ] **Step 9: 執行確認通過**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-core --test web_transactions`
Expected: `test result: ok. 11 passed`

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-core`
Expected: 全部通過（包含任務 1 的 `database` 測試與搬移過來的單元測試）。

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p migration`
Expected: 全部通過。

Run: `cargo check --manifest-path src-tauri/Cargo.toml -p ReinaManager`
Expected: `Finished`，沒有 error（桌面版呼叫的都是保留原簽名的公開函式）。

- [ ] **Step 10: TypeScript 型別**

`src/types/types.ts` 在 `export type GameLaunchType = "local" | "steam";`（第 60 行）之後新增：

```ts
/** 网页版扫描状态：待补全、需要使用者确认、已完成。 */
export type ScanStatus = "pending" | "needs_confirmation" | "complete";
```

`FullGameData`（第 284 行）在 `updated_at?: number;` 之後加入：

```ts
	// --- 网页版（TeleDrive）位置、封面版本与扫描状态 ---
	teledrive_path?: Nullable<string>;
	exe_relpath?: Nullable<string>;
	cover_version?: Nullable<string>;
	scan_status?: Nullable<ScanStatus>;
	scan_candidates?: JsonValue | null;
```

`InsertGameParams` 在 `custom_data?: Nullable<CustomData>;` 之後加入（不含 `cover_version`）：

```ts
	teledrive_path?: string;
	exe_relpath?: string;
	scan_status?: ScanStatus;
	scan_candidates?: JsonValue;
```

`UpdateGameParams` 在 `magpie?: Nullable<number>;` 之後加入：

```ts
	teledrive_path?: Nullable<string>;
	exe_relpath?: Nullable<string>;
	scan_status?: Nullable<ScanStatus>;
	scan_candidates?: JsonValue | null;
```

Run: `pnpm typecheck`
Expected: 沒有錯誤。

- [ ] **Step 11: Commit**

```bash
git add src-tauri/migration/src/m20260926_000020_web_library.rs src-tauri/migration/src/lib.rs src-tauri/reina-core/src/database/repository.rs src-tauri/reina-core/src/database/repository/version_repository.rs src-tauri/reina-core/src/database/repository/games_repository.rs src-tauri/reina-core/src/database/repository/collections_repository.rs src-tauri/reina-core/src/database/repository/game_stats_repository.rs src-tauri/reina-core/src/database/repository/settings_repository.rs src-tauri/reina-core/src/entity/games.rs src-tauri/reina-core/src/database/dto.rs src-tauri/reina-core/tests/web_transactions.rs src/types/types.ts
git commit -m "feat: add web library schema and composable transactions

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### 任務 3：reina-server（axum、JWT、RPC 讀寫分類、版本端點、靜態檔與深層路由回退）

**Files:**
- Modify: `src-tauri/Cargo.toml:1-2`（workspace `members` 加上 `"reina-server"`）
- Create: `src-tauri/reina-server/Cargo.toml`
- Create: `src-tauri/reina-server/src/lib.rs`（crate 根：只宣告模組與 re-export）
- Create: `src-tauri/reina-server/src/main.rs`（啟動程式）
- Create: `src-tauri/reina-server/src/config.rs`（環境變數設定）
- Create: `src-tauri/reina-server/src/error.rs`（`ApiError`，統一 `{code, message}` 回應）
- Create: `src-tauri/reina-server/src/tx.rs`（Write transaction 的開始／結束與 `data_version` 遞增）
- Create: `src-tauri/reina-server/src/app.rs`（`AppState`、`build_router`）
- Create: `src-tauri/reina-server/src/static_files.rs`（`/game/` 靜態檔與深層路由回退）
- Create: `src-tauri/reina-server/src/api.rs`（只宣告子模組並 re-export `routes`）
- Create: `src-tauri/reina-server/src/api/router.rs`（`/game/api` 路由彙總與 JSON 404；任務 7、8、9 在這裡掛載）
- Create: `src-tauri/reina-server/src/api/auth.rs`（JWT 驗證與 `AuthUser` extractor）
- Create: `src-tauri/reina-server/src/api/version.rs`（`GET /game/api/version`）
- Create: `src-tauri/reina-server/src/api/rpc.rs`（只宣告子模組並 re-export `call`）
- Create: `src-tauri/reina-server/src/api/rpc/commands.rs`（`ReadCommand`／`WriteCommand` 白名單與分類）
- Create: `src-tauri/reina-server/src/api/rpc/args.rs`（各 command 的參數結構）
- Create: `src-tauri/reina-server/src/api/rpc/read.rs`（Read 分派）
- Create: `src-tauri/reina-server/src/api/rpc/write.rs`（Write 分派）
- Create: `src-tauri/reina-server/src/api/rpc/handler.rs`（`POST /game/api/rpc/{command}`）
- Test: `src-tauri/reina-server/tests/support.rs`（測試共用：暫存 SQLite、簽 JWT、送請求）
- Test: `src-tauri/reina-server/tests/api.rs`（驗證、版本、RPC）
- Test: `src-tauri/reina-server/tests/static_files.rs`（靜態檔、深層路由、健康檢查）
- 單元測試：`config.rs`、`api/auth.rs`、`api/rpc/commands.rs` 內的 `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes（任務 1、2 產出，名稱與簽名固定）：
  - `reina_core::database::connect_database(path: &std::path::Path) -> Result<sea_orm::DatabaseConnection, sea_orm::DbErr>`：建立目錄外的連線、啟用外鍵、執行全部 migration。
  - `reina_core::database::repository::version_repository::VersionRepository::get(db: &impl ConnectionTrait) -> Result<i64, DbErr>`、`::bump(db: &impl ConnectionTrait) -> Result<i64, DbErr>`。
  - `reina_core::database::dto::{InsertGameData, UpdateGameData, UpdateSettingsData, InsertCollectionData, UpdateCollectionData}`（後兩者欄位 `pub`，並有 `cleaned(self) -> Self`；`UpdateSettingsData::cleaned(self) -> Self`）。
  - `reina_core::database::repository::games_repository::{GamesRepository, GameType, SortOption, SortOrder}`。
  - `reina_core::database::repository::collections_repository::{CollectionsRepository, CollectionBackendSortField}`。
  - `reina_core::database::repository::game_stats_repository::GameStatsRepository`。
  - `reina_core::database::repository::settings_repository::SettingsRepository`。
  - Read 端直接使用現有函式（參數型別 `&DatabaseConnection`）：`GamesRepository::{find_by_id, find_all, find_ids, count, get_source_bindings}`、`GameStatsRepository::{get_sessions, get_recent_sessions_for_all, get_statistics, get_all_statistics, get_all_last_played, get_statistics_distribution}`、`SettingsRepository::get_all_settings`、`CollectionsRepository::{find_root_collections, get_root_collections_with_count, get_games_in_collection, get_game_collection_ids, count_games_in_group, get_categories_with_count}`。
  - Write 端使用任務 2 新增的 `*_in_connection`（精確簽名見任務 2 的 Interfaces → Produces；原本不開 transaction 的函式保留原名、改為泛型，規則見文末「給執行者的備註」）。
- Produces（任務 4–9 依賴）：
  - `reina_server::Config { pub jwt_secret: String, pub owner_id: i64, pub teledrive_api: String, pub port: u16, pub data_dir: PathBuf, pub static_dir: PathBuf }`、`Config::from_env() -> Result<Config, ConfigError>`、`Config::from_lookup(impl Fn(&str) -> Option<String>) -> Result<Config, ConfigError>`、`Config::db_path(&self) -> PathBuf`（`<data_dir>/reina_manager.db`）、`#[doc(hidden)] Config::for_tests() -> Config`（`jwt_secret = "reina-test-secret"`、`owner_id = 42`、`teledrive_api = "http://127.0.0.1:9"`；之後新增欄位的任務要一併更新它）。
  - `reina_server::AppState { pub db: DatabaseConnection, pub config: Arc<Config>, pub http: reqwest::Client, #[doc(hidden)] pub fault: Arc<tx::CommitFault> }`（`Clone`）、`AppState::new(db: DatabaseConnection, config: Config) -> AppState`。
  - `reina_server::build_router(state: AppState) -> axum::Router`。
  - `reina_server::api::auth::AuthUser { pub user_id: i64, pub token: String }`（axum extractor；401 = 缺少／無效／過期，403 = 不是 owner）、`reina_server::api::auth::verify_token(token: &str, secret: &str) -> Result<i64, ApiError>`。
  - `reina_server::error::ApiError { pub status: StatusCode, pub code: &'static str, pub message: String }`，建構子 `unauthorized()`、`forbidden()`、`not_found(msg)`、`bad_request(msg)`、`internal(msg)`、`new(status, code, msg)`；實作 `IntoResponse`（JSON `{code, message}`，`Cache-Control: no-store`）與 `From<DbErr>`。
  - `reina_server::tx::begin(db: &DatabaseConnection) -> Result<DatabaseTransaction, ApiError>`、`reina_server::tx::finish<T>(state: &AppState, txn: DatabaseTransaction, result: Result<T, ApiError>, bump: impl FnOnce(&T) -> bool) -> Result<T, ApiError>`、`#[doc(hidden)] reina_server::tx::CommitFault`（`fail_next(&self)`；`AppState.fault: Arc<CommitFault>`，`finish` 在 commit 前檢查，觸發時 rollback 並回 500）：任務 7（封面）、9（掃描）、15（遊玩紀錄）的寫入都要用這組函式，`bump` 回傳 `false` 時不遞增 `data_version`（只有遊玩紀錄去重命中時使用）。
  - `reina_server::api::rpc::commands::{CommandKind, ReadCommand, WriteCommand, Command, command_kind}`：`command_kind(name: &str) -> Option<CommandKind>`。
  - HTTP 契約：
    - `POST /game/api/rpc/{command}`：body 為 JSON 物件（空 body 視為 `{}`），參數名稱沿用前端 invoke 的 camelCase；成功 `200` + 原 command 回傳值；未知或未開放的 command `404 {code:"not_found"}`；參數錯誤 `400 {code:"invalid_arguments"}`；command 執行失敗 `500 {code:"command_failed"}`，`message` 沿用桌面版的錯誤前綴。
    - `GET /game/api/version` → `{"data_version": i64}`，`Cache-Control: no-store`，需要登入。
    - `GET /game/healthz` → `200 ok`，不需要登入。
    - `GET /game` → `308` 導向 `/game/`。
    - `/game/api/*` 沒有對應路由時一律回 JSON 404，不回 HTML。
    - `/game/<路徑>`：檔案存在就回檔案（`assets/` 底下 `Cache-Control: public, max-age=31536000, immutable`，其他 `no-cache`）；不存在且最後一段含 `.` 回 `404`；其餘（深層路由）回 `index.html`，`Cache-Control: no-cache`；含 `..`、`\`、`:` 的路徑回 `404`。
  - 掛載點：`reina_server::api::router::routes() -> Router<AppState>`，任務 7、8、9 在 `router.rs` 的標記處各加一行 `.merge(covers::routes())` 等。

**網頁版開放的 command（實際 grep `src/services/invoke/*.ts` 與 `src-tauri/src/lib.rs` 的 `generate_handler!` 得出）：**

| 類別 | Command（前端參數） |
|---|---|
| Read（18） | `find_game_by_id {id}`、`find_all_games {gameType, sortOption, sortOrder, language}`、`find_game_ids {gameType, sortOption, sortOrder, language}`、`count_games {}`、`get_source_bindings {source}`、`get_game_sessions {gameId, limit, offset}`、`get_recent_sessions_for_all {gameIds, limit, offset}`、`get_game_statistics {gameId}`、`get_all_game_statistics {}`、`get_all_game_last_played {}`、`get_statistics_distribution {gameIds, startDate, endDate}`、`get_all_settings {}`、`find_root_collections {}`、`get_root_collections_with_count {sortField, sortOrder}`、`get_games_in_collection {collectionId}`、`get_game_collection_ids {gameId}`、`count_games_in_group {groupId}`、`get_categories_with_count {groupId, sortField, sortOrder}` |
| Write（16） | `insert_game {game}`、`insert_games_batch {games}`、`update_game {gameId, updates}`、`update_games_batch {updates}`、`delete_game {id}`、`delete_games_batch {ids}`、`create_manual_game_session {gameId, startTime, duration}`、`delete_game_session {sessionId}`、`update_settings {data}`、`create_collection {name, parentId, sortOrder, icon}`、`update_collection {id, name, parentId, sortOrder, icon}`、`delete_collection {id}`、`remove_games_from_collection {gameIds, collectionId}`、`add_games_to_collections {gameIds, collectionIds}`、`set_game_collections {gameId, collectionIds}`、`update_category_games {gameIds, collectionId}` |
| 不開放（回 404） | `launch_game`、`stop_game`、`open_directory`、`resolve_dropped_local_path`、`resolve_bulk_import_paths`、`is_portable_mode`、`scan_directory_for_games`、`scan_steam_launch_targets`、`resolve_steam_shortcut_file`、`take_pending_install_requests`、`take_pending_install_rejections`、`create_game_install_task`、`list_tasks`、`retry_task`、`pause_task`、`resume_task`、`cancel_task`、`delete_task`、`complete_game_install_task`、`fail_game_install_metadata`、`move_backup_folder`、`copy_file`、`create_savedata_backup`、`delete_savedata_backup`、`restore_savedata_backup`、`delete_file`、`import_clipboard_image_to_temp`、`delete_game_covers`、`delete_cloud_cache`、`backup_database`、`backup_custom_covers`、`import_database`、`save_savedata_record`、`get_savedata_count`、`get_savedata_records`、`rebuild_game_statistics`、`update_proxy_config`、`bgm_oauth_start_login`、`bgm_oauth_cancel_login`、`bgm_oauth_exchange_code`、`bgm_oauth_refresh_token`、`hikarinagi_oauth_start_login`、`hikarinagi_oauth_cancel_login`、`hikarinagi_oauth_exchange_code`、`hikarinagi_oauth_refresh_token`、`set_reina_log_level`、`get_reina_log_level`、`restart_app` |

不開放的理由：前 32 個是本機檔案、程序、安裝、存檔備份或桌面資料庫匯入匯出；存檔紀錄（`save_savedata_record`、`get_savedata_count`、`get_savedata_records`）只對應桌面的本機備份檔，網頁版沒有備份檔；`rebuild_game_statistics` 前端沒有呼叫；代理、OAuth（桌面 loopback 回呼）、日誌等級與重啟是桌面程序功能。

---

- [ ] **Step 1：加入 workspace 成員與 crate 骨架**

修改 `src-tauri/Cargo.toml` 第 1–2 行：

```toml
[workspace]
members = ["reina-path", "migration", "reina-core", "reina-server"]
```

（`"reina-core"` 由任務 1 加入；若任務 1 已加入，只補 `"reina-server"`。）

建立 `src-tauri/reina-server/Cargo.toml`：

```toml
[package]
name = "reina-server"
version = "0.1.0"
edition = "2024"
publish = false

[dependencies]
reina-core = { path = "../reina-core" }
axum = "0.8"
tokio = { version = "1.53.1", features = ["rt-multi-thread", "macros", "net", "fs", "signal", "sync", "time"] }
tower = { version = "0.5.3", features = ["util"] }
tower-http = { version = "0.6.11", features = ["fs"] }
sea-orm = { version = "2.0.2", default-features = false, features = [
    "sqlx-sqlite",
    "runtime-tokio",
    "macros",
    "with-json",
] }
serde = { version = "1.0.229", features = ["derive"] }
serde_json = "1.0.151"
jsonwebtoken = "9.3"
reqwest = { version = "0.12.28", default-features = false, features = ["json", "rustls-tls"] }
log = "0.4.33"
env_logger = "0.11"

[dev-dependencies]
tempfile = "3"
http-body-util = "0.1"
# 任務 8 的節流器測試用 #[tokio::test(start_paused = true)] 快轉時間
tokio = { version = "1.53.1", features = ["test-util"] }
```

建立 `src-tauri/reina-server/src/lib.rs`：

```rust
//! ReinaManager 網頁版伺服器：提供 `/game/` 前端與 `/game/api/*`。

pub mod api;
pub mod app;
pub mod config;
pub mod error;
pub mod static_files;
pub mod tx;

pub use app::{AppState, build_router};
pub use config::Config;
```

其餘模組先建立成空檔（下一步才寫內容），讓 crate 能被解析：

```bash
cd /d/game/ReinaManager/src-tauri/reina-server
mkdir -p src/api/rpc tests
touch src/app.rs src/config.rs src/error.rs src/static_files.rs src/tx.rs src/api.rs
```

- [ ] **Step 2：寫 `Config` 的失敗測試**

`src-tauri/reina-server/src/config.rs`：

```rust
//! 從環境變數讀取伺服器設定。

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn 必填欄位齊全時套用預設值() {
        let config =
            Config::from_lookup(lookup(&[("JWT_SECRET", "s3cret"), ("REINA_OWNER_ID", "42")]))
                .unwrap();
        assert_eq!(config.jwt_secret, "s3cret");
        assert_eq!(config.owner_id, 42);
        assert_eq!(config.teledrive_api, "http://backend:8000");
        assert_eq!(config.port, 8787);
        assert_eq!(config.data_dir, PathBuf::from("/data"));
        assert_eq!(config.static_dir, PathBuf::from("/app/static"));
        assert_eq!(config.db_path(), PathBuf::from("/data").join("reina_manager.db"));
    }

    #[test]
    fn 可覆寫選填欄位並去掉網址結尾斜線() {
        let config = Config::from_lookup(lookup(&[
            ("JWT_SECRET", "s3cret"),
            ("REINA_OWNER_ID", "7"),
            ("TELEDRIVE_API", "http://backend:8000/"),
            ("REINA_PORT", "9000"),
            ("REINA_DATA_DIR", "/tmp/reina"),
            ("REINA_STATIC_DIR", "/tmp/static"),
        ]))
        .unwrap();
        assert_eq!(config.teledrive_api, "http://backend:8000");
        assert_eq!(config.port, 9000);
        assert_eq!(config.data_dir, PathBuf::from("/tmp/reina"));
        assert_eq!(config.static_dir, PathBuf::from("/tmp/static"));
    }

    #[test]
    fn 缺少金鑰或擁有者時啟動失敗() {
        assert!(Config::from_lookup(lookup(&[("REINA_OWNER_ID", "1")])).is_err());
        assert!(Config::from_lookup(lookup(&[("JWT_SECRET", "")])).is_err());
        assert!(Config::from_lookup(lookup(&[("JWT_SECRET", "s")])).is_err());
        assert!(
            Config::from_lookup(lookup(&[("JWT_SECRET", "s"), ("REINA_OWNER_ID", "abc")]))
                .is_err()
        );
        assert!(
            Config::from_lookup(lookup(&[
                ("JWT_SECRET", "s"),
                ("REINA_OWNER_ID", "1"),
                ("REINA_PORT", "99999"),
            ]))
            .is_err()
        );
    }

    #[test]
    fn 金鑰原樣保留而且除錯輸出不含金鑰() {
        let config = Config::from_lookup(lookup(&[
            ("JWT_SECRET", " spaced secret "),
            ("REINA_OWNER_ID", "1"),
        ]))
        .unwrap();
        // TeleDrive 端不會 trim 金鑰，這裡也不能 trim，否則簽章會對不上
        assert_eq!(config.jwt_secret, " spaced secret ");
        assert!(!format!("{config:?}").contains("spaced secret"));
    }

    #[test]
    fn 測試用設定使用固定的金鑰與擁有者() {
        // tests/support.rs 的 SECRET、OWNER_ID 必須與這裡一致
        let config = Config::for_tests();
        assert_eq!(config.jwt_secret, "reina-test-secret");
        assert_eq!(config.owner_id, 42);
        assert_eq!(config.teledrive_api, "http://127.0.0.1:9");
        assert_eq!(config.port, 0);
    }
}
```

- [ ] **Step 3：執行測試，確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib config`
Expected: 編譯失敗，錯誤包含 `cannot find type `Config` in this scope`（其他空模組不影響）。

- [ ] **Step 4：實作 `Config`**

在 `src-tauri/reina-server/src/config.rs` 測試模組上方加入：

```rust
use std::fmt;
use std::path::PathBuf;

/// 伺服器設定；金鑰只存在記憶體，除錯輸出一律遮蔽
#[derive(Clone)]
pub struct Config {
    pub jwt_secret: String,
    pub owner_id: i64,
    pub teledrive_api: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// 以查詢函式建立設定，測試時不必修改行程的環境變數
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // 選填欄位去除前後空白，空字串視為未設定
        let optional = |key: &str| {
            lookup(key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };

        // JWT_SECRET 必須和 TeleDrive backend 完全相同，所以不 trim
        let jwt_secret = lookup("JWT_SECRET")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConfigError("缺少 JWT_SECRET".to_string()))?;

        let owner_id = optional("REINA_OWNER_ID")
            .ok_or_else(|| ConfigError("缺少 REINA_OWNER_ID".to_string()))?
            .parse::<i64>()
            .map_err(|_| ConfigError("REINA_OWNER_ID 必須是整數".to_string()))?;

        let port = match optional("REINA_PORT") {
            Some(value) => value
                .parse::<u16>()
                .map_err(|_| ConfigError("REINA_PORT 必須是 1–65535 的整數".to_string()))?,
            None => 8787,
        };

        let teledrive_api = optional("TELEDRIVE_API")
            .unwrap_or_else(|| "http://backend:8000".to_string())
            .trim_end_matches('/')
            .to_string();

        Ok(Self {
            jwt_secret,
            owner_id,
            teledrive_api,
            port,
            data_dir: optional("REINA_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/data")),
            static_dir: optional("REINA_STATIC_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/app/static")),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("reina_manager.db")
    }

    /// 单元测试与整合测试共用的固定设定；目录由呼叫端覆写。
    /// 之后的任务新增栏位时（任务 8 的 upstream_overrides、任务 9 的 game_folder），
    /// 必须同时在这里给测试用的值，tests/support.rs 以 `..Config::for_tests()` 建构，不需跟着改。
    #[doc(hidden)]
    pub fn for_tests() -> Self {
        Self {
            jwt_secret: "reina-test-secret".to_string(),
            owner_id: 42,
            // 测试不会连到 TeleDrive；给一个不会有服务的位址，需要时由测试覆写
            teledrive_api: "http://127.0.0.1:9".to_string(),
            port: 0,
            data_dir: PathBuf::from("/nonexistent/reina-data"),
            static_dir: PathBuf::from("/nonexistent/reina-static"),
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("jwt_secret", &"<redacted>")
            .field("owner_id", &self.owner_id)
            .field("teledrive_api", &self.teledrive_api)
            .field("port", &self.port)
            .field("data_dir", &self.data_dir)
            .field("static_dir", &self.static_dir)
            .finish()
    }
}
```

- [ ] **Step 5：確認通過**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib config`
Expected: `5 passed`。

- [ ] **Step 6：寫 `ApiError` 與 `verify_token` 的失敗測試**

`src-tauri/reina-server/src/api.rs`：

```rust
//! `/game/api` 底下的所有端點。

pub mod auth;
pub mod router;
pub mod rpc;
pub mod version;

pub use router::routes;
```

先建立其他子模組空檔：

```bash
cd /d/game/ReinaManager/src-tauri/reina-server
touch src/api/router.rs src/api/rpc.rs src/api/version.rs
```

`src-tauri/reina-server/src/api/auth.rs`（先只放測試）：

```rust
//! TeleDrive JWT 驗證；規則與 TeleDrive backend 的 `decode_jwt` 一致。

#[cfg(test)]
mod tests {
    use super::*;
    use jsonwebtoken::{Algorithm, EncodingKey, Header, encode};
    use serde_json::{Value, json};
    use std::time::{SystemTime, UNIX_EPOCH};

    const SECRET: &str = "unit-secret";

    fn now() -> i64 {
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
    }

    fn sign(claims: Value, alg: Algorithm, secret: &str) -> String {
        encode(&Header::new(alg), &claims, &EncodingKey::from_secret(secret.as_bytes())).unwrap()
    }

    #[test]
    fn 有效的_hs256_token_回傳_user_id() {
        let token = sign(json!({"user_id": 42, "exp": now() + 60}), Algorithm::HS256, SECRET);
        assert_eq!(verify_token(&token, SECRET).unwrap(), 42);
    }

    #[test]
    fn 數字字串的_user_id_與_teledrive_的_int_轉換一致() {
        let token = sign(json!({"user_id": "42", "exp": now() + 60}), Algorithm::HS256, SECRET);
        assert_eq!(verify_token(&token, SECRET).unwrap(), 42);
    }

    #[test]
    fn 已過期的_token_不給任何寬限() {
        let token = sign(json!({"user_id": 42, "exp": now() - 1}), Algorithm::HS256, SECRET);
        assert_eq!(verify_token(&token, SECRET).unwrap_err().status, 401);
    }

    #[test]
    fn 缺少必要欄位或格式錯誤都回_401() {
        let cases = [
            sign(json!({"user_id": 42}), Algorithm::HS256, SECRET),
            sign(json!({"exp": now() + 60}), Algorithm::HS256, SECRET),
            sign(json!({"user_id": null, "exp": now() + 60}), Algorithm::HS256, SECRET),
            sign(json!({"user_id": "abc", "exp": now() + 60}), Algorithm::HS256, SECRET),
            sign(json!({"user_id": 42, "exp": now() + 60}), Algorithm::HS256, "other-secret"),
            sign(json!({"user_id": 42, "exp": now() + 60}), Algorithm::HS512, SECRET),
            "not-a-jwt".to_string(),
        ];
        for token in cases {
            let err = verify_token(&token, SECRET).unwrap_err();
            assert_eq!(err.status, 401, "token {token} 應該被拒絕");
            assert_eq!(err.code, "unauthorized");
        }
    }
}
```

- [ ] **Step 7：執行測試，確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib auth`
Expected: 編譯失敗，錯誤包含 `cannot find function `verify_token``。

- [ ] **Step 8：實作 `ApiError`**

`src-tauri/reina-server/src/error.rs`：

```rust
//! 統一的 API 錯誤格式：`{ "code": string, "message": string }`。

use axum::Json;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub code: &'static str,
    pub message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn unauthorized() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "unauthorized", "登入已失效，請重新登入 TeleDrive")
    }

    pub fn forbidden() -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", "這個帳號沒有權限使用 ReinaManager")
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "not_found", message)
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "invalid_arguments", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(StatusCode::INTERNAL_SERVER_ERROR, "command_failed", message)
    }
}

impl From<sea_orm::DbErr> for ApiError {
    fn from(error: sea_orm::DbErr) -> Self {
        Self::internal(format!("资料库错误: {error}"))
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({ "code": self.code, "message": self.message })),
        )
            .into_response();
        // 錯誤回應不能被瀏覽器或代理快取，否則登入恢復後仍會看到舊的 401
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        response
    }
}
```

- [ ] **Step 9：實作 `verify_token`**

在 `src-tauri/reina-server/src/api/auth.rs` 測試模組上方加入：

```rust
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde::Deserialize;
use serde_json::Value;

use crate::error::ApiError;

#[derive(Deserialize)]
struct Claims {
    // TeleDrive 用 Python 的 int() 轉換，所以同時接受整數與數字字串
    user_id: Value,
}

/// 驗證 TeleDrive 簽發的 JWT，回傳 `user_id`。
///
/// 與 TeleDrive `decode_jwt` 相同：只接受 HS256、必須有 `exp` 與 `user_id`、
/// 不給時間寬限（PyJWT 預設 leeway 為 0）。
pub fn verify_token(token: &str, secret: &str) -> Result<i64, ApiError> {
    let mut validation = Validation::new(Algorithm::HS256);
    validation.leeway = 0;
    validation.validate_exp = true;
    validation.set_required_spec_claims(&["exp"]);

    let data = decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &validation)
        .map_err(|_| ApiError::unauthorized())?;

    parse_user_id(&data.claims.user_id).ok_or_else(ApiError::unauthorized)
}

fn parse_user_id(value: &Value) -> Option<i64> {
    match value {
        Value::Number(number) => number.as_i64(),
        Value::String(text) => text.trim().parse::<i64>().ok(),
        _ => None,
    }
}
```

- [ ] **Step 10：確認通過**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib auth`
Expected: `4 passed`。

- [ ] **Step 11：寫測試共用模組 `tests/support.rs`**

```rust
//! 整合測試共用：暫存資料庫、簽 JWT、送請求。
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

/// 必須與 `Config::for_tests()` 一致（config.rs 有測試守住）
pub const SECRET: &str = "reina-test-secret";
pub const OWNER_ID: i64 = 42;

pub struct TestApp {
    pub router: Router,
    /// 與 router 共用同一個資料庫連線、設定與故障注入點
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
        serde_json::from_slice(&self.body).expect("回應必須是 JSON")
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

    /// 先以 `Config::for_tests()` 加上暫存目錄建立設定，再交給 `configure` 覆寫
    ///（例如把 `teledrive_api` 指到假的 TeleDrive）
    pub async fn with_config(configure: impl FnOnce(&mut Config)) -> Self {
        let dir = tempfile::tempdir().expect("建立暫存目錄");
        let data_dir = dir.path().join("data");
        let static_dir = dir.path().join("static");
        std::fs::create_dir_all(&data_dir).unwrap();
        std::fs::create_dir_all(static_dir.join("assets")).unwrap();
        std::fs::write(static_dir.join("index.html"), "<!doctype html><title>reina</title>").unwrap();
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
            .expect("連線測試資料庫");
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

    /// 直接寫入資料庫建立一個自訂遊戲（不經過 RPC，所以不改變 data_version）
    pub async fn insert_game(&self, name: &str) -> i32 {
        let data: InsertGameData = serde_json::from_value(json!({
            "id_type": "custom",
            "custom_data": { "name": name },
        }))
        .expect("建立測試遊戲資料");
        GamesRepository::insert(&self.state.db, data)
            .await
            .expect("寫入測試遊戲")
            .id
    }

    /// 讓下一次 `tx::finish` 在 commit 前 rollback 並回 500
    pub fn fail_next_write_commit(&self) {
        self.state.fault.fail_next();
    }
}

fn now() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

pub fn token_with(claims: Value, alg: Algorithm, secret: &str) -> String {
    encode(&Header::new(alg), &claims, &EncodingKey::from_secret(secret.as_bytes())).unwrap()
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

    /// 以擁有者身分呼叫 RPC
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
        response.json()["data_version"].as_i64().expect("data_version 必須是整數")
    }
}
```

- [ ] **Step 12：寫驗證與版本端點的失敗測試**

`src-tauri/reina-server/tests/api.rs`：

```rust
mod support;

use axum::http::{StatusCode, header};
use jsonwebtoken::Algorithm;
use serde_json::json;
use support::{OWNER_ID, SECRET, owner_token, spawn_app, token_for, token_with};

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

#[tokio::test]
async fn 版本端點需要_bearer_token() {
    let app = spawn_app().await;

    let missing = app.get("/game/api/version", None).await;
    assert_eq!(missing.status, StatusCode::UNAUTHORIZED);
    assert_eq!(missing.json()["code"], "unauthorized");

    let wrong_scheme = app
        .get("/game/api/version", Some(&format!("Basic {}", owner_token())))
        .await;
    assert_eq!(wrong_scheme.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn 過期_簽章錯誤_演算法錯誤都回_401() {
    let app = spawn_app().await;
    let tokens = [
        token_for(json!(OWNER_ID), -1),
        token_with(json!({"user_id": OWNER_ID, "exp": 4_102_444_800i64}), Algorithm::HS256, "wrong"),
        token_with(json!({"user_id": OWNER_ID, "exp": 4_102_444_800i64}), Algorithm::HS512, SECRET),
        token_with(json!({"user_id": OWNER_ID}), Algorithm::HS256, SECRET),
    ];
    for token in tokens {
        let response = app.get("/game/api/version", Some(&bearer(&token))).await;
        assert_eq!(response.status, StatusCode::UNAUTHORIZED, "token {token}");
        assert_eq!(response.header(header::CACHE_CONTROL).as_deref(), Some("no-store"));
    }
}

#[tokio::test]
async fn 不是擁有者回_403() {
    let app = spawn_app().await;
    let response = app
        .get("/game/api/version", Some(&bearer(&token_for(json!(7), 3600))))
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(response.json()["code"], "forbidden");
}

#[tokio::test]
async fn 版本從_0_開始而且不可快取() {
    let app = spawn_app().await;
    let response = app
        .get("/game/api/version", Some(&bearer(&token_for(json!("42"), 3600))))
        .await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.json(), json!({"data_version": 0}));
    assert_eq!(response.header(header::CACHE_CONTROL).as_deref(), Some("no-store"));
}
```

- [ ] **Step 13：執行測試，確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test api`
Expected: 編譯失敗，錯誤包含 `unresolved imports `reina_server::AppState`, `reina_server::build_router``（`app.rs` 仍是空檔）。

- [ ] **Step 14：實作 `tx`、`AppState`、`build_router`、`AuthUser`、版本端點與 API 路由**

`src-tauri/reina-server/src/tx.rs`：

```rust
//! Write 操作的 transaction 邊界：業務資料與 `data_version` 在同一次 commit。

use std::sync::atomic::{AtomicBool, Ordering};

use reina_core::database::repository::version_repository::VersionRepository;
use sea_orm::{DatabaseConnection, DatabaseTransaction, TransactionTrait};

use crate::app::AppState;
use crate::error::ApiError;

/// 测试用的 commit 故障注入点：`fail_next()` 之后的下一次 `finish` 会在 commit 前 rollback 并回传 500。
/// 正式环境从不呼叫 `fail_next`，所以永远是 false。
#[doc(hidden)]
#[derive(Debug, Default)]
pub struct CommitFault(AtomicBool);

impl CommitFault {
    pub fn fail_next(&self) {
        self.0.store(true, Ordering::SeqCst);
    }

    fn take(&self) -> bool {
        self.0.swap(false, Ordering::SeqCst)
    }
}

pub async fn begin(db: &DatabaseConnection) -> Result<DatabaseTransaction, ApiError> {
    Ok(db.begin().await?)
}

/// 結束一個 Write transaction。
///
/// - `result` 成功且 `bump` 回傳 true：遞增 `data_version` 後 commit。
/// - `result` 成功但 `bump` 回傳 false：只 commit，不遞增（遊玩紀錄重送、沒有變更的掃描時使用）。
/// - `result` 失敗：rollback，資料與版本都不變。
/// - 測試以 `state.fault.fail_next()` 注入失敗時：rollback 並回傳 500，模擬 commit 失敗。
pub async fn finish<T>(
    state: &AppState,
    txn: DatabaseTransaction,
    result: Result<T, ApiError>,
    bump: impl FnOnce(&T) -> bool,
) -> Result<T, ApiError> {
    match result {
        Ok(value) => {
            if bump(&value) {
                VersionRepository::bump(&txn).await?;
            }
            if state.fault.take() {
                txn.rollback().await?;
                return Err(ApiError::internal("测试注入的 commit 失败"));
            }
            txn.commit().await?;
            Ok(value)
        }
        Err(error) => {
            txn.rollback().await?;
            Err(error)
        }
    }
}
```

`src-tauri/reina-server/src/app.rs`：

```rust
//! 伺服器狀態與最外層路由。

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::response::Redirect;
use axum::routing::get;
use sea_orm::DatabaseConnection;

use crate::config::Config;
use crate::tx::CommitFault;
use crate::{api, static_files};

#[derive(Clone)]
pub struct AppState {
    pub db: DatabaseConnection,
    pub config: Arc<Config>,
    /// 對外請求（TeleDrive API、中繼資料來源、封面下載）共用的 client
    pub http: reqwest::Client,
    /// 只給測試注入 commit 失敗；正式環境永遠不觸發
    #[doc(hidden)]
    pub fault: Arc<CommitFault>,
}

impl AppState {
    pub fn new(db: DatabaseConnection, config: Config) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(concat!("ReinaManager-server/", env!("CARGO_PKG_VERSION")))
            .timeout(Duration::from_secs(30))
            .build()
            .expect("建立 HTTP client 失敗");
        Self {
            db,
            config: Arc::new(config),
            http,
            fault: Arc::new(CommitFault::default()),
        }
    }
}

pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/game", get(redirect_to_slash))
        .route("/game/healthz", get(healthz))
        .nest("/game/api", api::routes())
        .route("/game/", get(static_files::serve_index))
        .route("/game/{*path}", get(static_files::serve_path))
        .with_state(state)
}

async fn redirect_to_slash() -> Redirect {
    Redirect::permanent("/game/")
}

async fn healthz() -> &'static str {
    "ok"
}
```

`src-tauri/reina-server/src/static_files.rs` 先放暫時的最小實作，讓路由能編譯（Step 27 會換成完整版）：

```rust
//! `/game/` 前端靜態檔。

use axum::extract::{Path, State};
use axum::http::StatusCode;

use crate::app::AppState;

pub async fn serve_index(State(_state): State<AppState>) -> StatusCode {
    StatusCode::NOT_FOUND
}

pub async fn serve_path(State(_state): State<AppState>, Path(_path): Path<String>) -> StatusCode {
    StatusCode::NOT_FOUND
}
```

在 `src-tauri/reina-server/src/api/auth.rs` 的 `verify_token` 下方加入 extractor：

```rust
use axum::extract::FromRequestParts;
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;

use crate::app::AppState;

/// 已通過驗證的擁有者。`token` 保留原文，掃描時要用它轉呼叫 TeleDrive API。
#[derive(Debug, Clone)]
pub struct AuthUser {
    pub user_id: i64,
    pub token: String,
}

impl FromRequestParts<AppState> for AuthUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let header = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .ok_or_else(ApiError::unauthorized)?;
        // 與 TeleDrive 相同，只接受 "Bearer " 前綴
        let token = header.strip_prefix("Bearer ").ok_or_else(ApiError::unauthorized)?;
        let user_id = verify_token(token, &state.config.jwt_secret)?;
        if user_id != state.config.owner_id {
            return Err(ApiError::forbidden());
        }
        Ok(Self {
            user_id,
            token: token.to_string(),
        })
    }
}
```

`src-tauri/reina-server/src/api/version.rs`：

```rust
//! `GET /game/api/version`：跨裝置同步用的全域資料版本。

use axum::Json;
use axum::extract::State;
use axum::http::header::CACHE_CONTROL;
use axum::response::IntoResponse;
use reina_core::database::repository::version_repository::VersionRepository;
use serde_json::json;

use crate::api::auth::AuthUser;
use crate::app::AppState;
use crate::error::ApiError;

pub async fn get_version(
    State(state): State<AppState>,
    _user: AuthUser,
) -> Result<impl IntoResponse, ApiError> {
    let data_version = VersionRepository::get(&state.db).await?;
    Ok((
        [(CACHE_CONTROL, "no-store")],
        Json(json!({ "data_version": data_version })),
    ))
}
```

`src-tauri/reina-server/src/api/router.rs`（RPC 路由在 Step 23 加入）：

```rust
//! 彙總 `/game/api` 的路由。任務 7、8、9 在標記處掛上自己的子路由。

use axum::Router;
use axum::routing::get;

use crate::api::version;
use crate::app::AppState;
use crate::error::ApiError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/version", get(version::get_version))
        // 任務 7：.merge(crate::api::covers::routes())
        // 任務 8：.merge(crate::api::metadata::routes())
        // 任務 9：.merge(crate::api::scan::routes())
        .fallback(api_not_found)
}

/// `/game/api` 底下沒有對應路由時回 JSON，而不是前端的 index.html
async fn api_not_found() -> ApiError {
    ApiError::not_found("找不到这个 API")
}
```

`src-tauri/reina-server/src/api/rpc.rs` 暫時保持空檔（Step 16 才宣告子模組）。

- [ ] **Step 15：確認通過**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test api`
Expected: `4 passed`。

- [ ] **Step 16：寫 command 白名單的失敗測試**

`src-tauri/reina-server/src/api/rpc.rs`：

```rust
//! `POST /game/api/rpc/{command}`：對應原本的 Tauri command。

pub mod args;
pub mod commands;
pub mod handler;
pub mod read;
pub mod write;

pub use handler::call;
```

```bash
cd /d/game/ReinaManager/src-tauri/reina-server
touch src/api/rpc/args.rs src/api/rpc/handler.rs src/api/rpc/read.rs src/api/rpc/write.rs
```

`src-tauri/reina-server/src/api/rpc/commands.rs`（先只放測試）：

```rust
//! 網頁版開放的 command 白名單與讀寫分類。

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn 每個名稱都能解析回同一個_command() {
        for command in ReadCommand::ALL {
            assert_eq!(Command::parse(command.name()), Some(Command::Read(command)));
        }
        for command in WriteCommand::ALL {
            assert_eq!(Command::parse(command.name()), Some(Command::Write(command)));
        }
    }

    #[test]
    fn 名稱不重複而且數量正確() {
        let names: HashSet<&str> = ReadCommand::ALL
            .iter()
            .map(|c| c.name())
            .chain(WriteCommand::ALL.iter().map(|c| c.name()))
            .collect();
        assert_eq!(ReadCommand::ALL.len(), 18);
        assert_eq!(WriteCommand::ALL.len(), 16);
        assert_eq!(names.len(), 34);
    }

    #[test]
    fn 讀取與寫入分類正確() {
        assert_eq!(command_kind("find_all_games"), Some(CommandKind::Read));
        assert_eq!(command_kind("find_game_by_id"), Some(CommandKind::Read));
        assert_eq!(command_kind("get_all_settings"), Some(CommandKind::Read));
        assert_eq!(command_kind("insert_game"), Some(CommandKind::Write));
        assert_eq!(command_kind("update_settings"), Some(CommandKind::Write));
        assert_eq!(command_kind("delete_game_session"), Some(CommandKind::Write));
    }

    #[test]
    fn 桌面專屬_command_不開放() {
        let desktop_only = [
            "launch_game", "stop_game", "open_directory", "resolve_dropped_local_path",
            "resolve_bulk_import_paths", "is_portable_mode", "scan_directory_for_games",
            "scan_steam_launch_targets", "resolve_steam_shortcut_file",
            "take_pending_install_requests", "take_pending_install_rejections",
            "create_game_install_task", "list_tasks", "retry_task", "pause_task",
            "resume_task", "cancel_task", "delete_task", "complete_game_install_task",
            "fail_game_install_metadata", "move_backup_folder", "copy_file",
            "create_savedata_backup", "delete_savedata_backup", "restore_savedata_backup",
            "delete_file", "import_clipboard_image_to_temp", "delete_game_covers",
            "delete_cloud_cache", "backup_database", "backup_custom_covers",
            "import_database", "save_savedata_record", "get_savedata_count",
            "get_savedata_records", "rebuild_game_statistics", "update_proxy_config",
            "bgm_oauth_start_login", "bgm_oauth_cancel_login", "bgm_oauth_exchange_code",
            "bgm_oauth_refresh_token", "hikarinagi_oauth_start_login",
            "hikarinagi_oauth_cancel_login", "hikarinagi_oauth_exchange_code",
            "hikarinagi_oauth_refresh_token", "set_reina_log_level", "get_reina_log_level",
            "restart_app",
        ];
        for name in desktop_only {
            assert_eq!(command_kind(name), None, "{name} 不能開放給網頁版");
        }
        assert_eq!(command_kind(""), None);
        assert_eq!(command_kind("FIND_ALL_GAMES"), None);
    }
}
```

- [ ] **Step 17：執行測試，確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib commands`
Expected: 編譯失敗，錯誤包含 `cannot find type `ReadCommand``、`cannot find function `command_kind``。

- [ ] **Step 18：實作 command 白名單**

在 `src-tauri/reina-server/src/api/rpc/commands.rs` 測試模組上方加入：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandKind {
    Read,
    Write,
}

/// 只讀取資料的 command：不開 transaction，不遞增 data_version
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadCommand {
    FindGameById,
    FindAllGames,
    FindGameIds,
    CountGames,
    GetSourceBindings,
    GetGameSessions,
    GetRecentSessionsForAll,
    GetGameStatistics,
    GetAllGameStatistics,
    GetAllGameLastPlayed,
    GetStatisticsDistribution,
    GetAllSettings,
    FindRootCollections,
    GetRootCollectionsWithCount,
    GetGamesInCollection,
    GetGameCollectionIds,
    CountGamesInGroup,
    GetCategoriesWithCount,
}

/// 會修改資料的 command：在 transaction 裡執行，成功才遞增 data_version
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteCommand {
    InsertGame,
    InsertGamesBatch,
    UpdateGame,
    UpdateGamesBatch,
    DeleteGame,
    DeleteGamesBatch,
    CreateManualGameSession,
    DeleteGameSession,
    UpdateSettings,
    CreateCollection,
    UpdateCollection,
    DeleteCollection,
    RemoveGamesFromCollection,
    AddGamesToCollections,
    SetGameCollections,
    UpdateCategoryGames,
}

/// 讀寫性質由所屬的 enum 決定：新增 command 時必須選一個 enum，
/// 而 `name()` 與分派函式都是沒有萬用分支的 match，漏寫就無法編譯。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Command {
    Read(ReadCommand),
    Write(WriteCommand),
}

impl ReadCommand {
    pub const ALL: [ReadCommand; 18] = [
        Self::FindGameById,
        Self::FindAllGames,
        Self::FindGameIds,
        Self::CountGames,
        Self::GetSourceBindings,
        Self::GetGameSessions,
        Self::GetRecentSessionsForAll,
        Self::GetGameStatistics,
        Self::GetAllGameStatistics,
        Self::GetAllGameLastPlayed,
        Self::GetStatisticsDistribution,
        Self::GetAllSettings,
        Self::FindRootCollections,
        Self::GetRootCollectionsWithCount,
        Self::GetGamesInCollection,
        Self::GetGameCollectionIds,
        Self::CountGamesInGroup,
        Self::GetCategoriesWithCount,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::FindGameById => "find_game_by_id",
            Self::FindAllGames => "find_all_games",
            Self::FindGameIds => "find_game_ids",
            Self::CountGames => "count_games",
            Self::GetSourceBindings => "get_source_bindings",
            Self::GetGameSessions => "get_game_sessions",
            Self::GetRecentSessionsForAll => "get_recent_sessions_for_all",
            Self::GetGameStatistics => "get_game_statistics",
            Self::GetAllGameStatistics => "get_all_game_statistics",
            Self::GetAllGameLastPlayed => "get_all_game_last_played",
            Self::GetStatisticsDistribution => "get_statistics_distribution",
            Self::GetAllSettings => "get_all_settings",
            Self::FindRootCollections => "find_root_collections",
            Self::GetRootCollectionsWithCount => "get_root_collections_with_count",
            Self::GetGamesInCollection => "get_games_in_collection",
            Self::GetGameCollectionIds => "get_game_collection_ids",
            Self::CountGamesInGroup => "count_games_in_group",
            Self::GetCategoriesWithCount => "get_categories_with_count",
        }
    }
}

impl WriteCommand {
    pub const ALL: [WriteCommand; 16] = [
        Self::InsertGame,
        Self::InsertGamesBatch,
        Self::UpdateGame,
        Self::UpdateGamesBatch,
        Self::DeleteGame,
        Self::DeleteGamesBatch,
        Self::CreateManualGameSession,
        Self::DeleteGameSession,
        Self::UpdateSettings,
        Self::CreateCollection,
        Self::UpdateCollection,
        Self::DeleteCollection,
        Self::RemoveGamesFromCollection,
        Self::AddGamesToCollections,
        Self::SetGameCollections,
        Self::UpdateCategoryGames,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::InsertGame => "insert_game",
            Self::InsertGamesBatch => "insert_games_batch",
            Self::UpdateGame => "update_game",
            Self::UpdateGamesBatch => "update_games_batch",
            Self::DeleteGame => "delete_game",
            Self::DeleteGamesBatch => "delete_games_batch",
            Self::CreateManualGameSession => "create_manual_game_session",
            Self::DeleteGameSession => "delete_game_session",
            Self::UpdateSettings => "update_settings",
            Self::CreateCollection => "create_collection",
            Self::UpdateCollection => "update_collection",
            Self::DeleteCollection => "delete_collection",
            Self::RemoveGamesFromCollection => "remove_games_from_collection",
            Self::AddGamesToCollections => "add_games_to_collections",
            Self::SetGameCollections => "set_game_collections",
            Self::UpdateCategoryGames => "update_category_games",
        }
    }
}

impl Command {
    pub fn parse(name: &str) -> Option<Self> {
        ReadCommand::ALL
            .into_iter()
            .find(|command| command.name() == name)
            .map(Self::Read)
            .or_else(|| {
                WriteCommand::ALL
                    .into_iter()
                    .find(|command| command.name() == name)
                    .map(Self::Write)
            })
    }

    pub fn kind(self) -> CommandKind {
        match self {
            Self::Read(_) => CommandKind::Read,
            Self::Write(_) => CommandKind::Write,
        }
    }
}

pub fn command_kind(name: &str) -> Option<CommandKind> {
    Command::parse(name).map(Command::kind)
}
```

- [ ] **Step 19：確認通過**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib commands`
Expected: `4 passed`。

- [ ] **Step 20：寫 RPC 行為的失敗測試**

在 `src-tauri/reina-server/tests/api.rs` 末尾加入：

```rust
fn list_args() -> serde_json::Value {
    json!({"gameType": "all", "sortOption": "addtime", "sortOrder": "asc", "language": null})
}

#[tokio::test]
async fn rpc_需要登入() {
    let app = spawn_app().await;
    let response = app
        .post_raw("/game/api/rpc/count_games", "{}", None)
        .await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn 未知或桌面專屬的_command_回_404_且不改版本() {
    let app = spawn_app().await;
    for name in ["no_such_command", "launch_game", "copy_file", "import_database", "update_proxy_config"] {
        let response = app.rpc(name, json!({})).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{name}");
        assert_eq!(response.json()["code"], "not_found");
    }
    assert_eq!(app.data_version().await, 0);
}

#[tokio::test]
async fn 參數錯誤回_400_且不改版本() {
    let app = spawn_app().await;
    let bearer = bearer(&owner_token());

    let wrong_type = app.rpc("create_collection", json!({"name": 1, "sortOrder": 0})).await;
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
async fn 空_body_視為沒有參數() {
    let app = spawn_app().await;
    let response = app
        .post_raw("/game/api/rpc/count_games", "", Some(&bearer(&owner_token())))
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    assert_eq!(response.json(), json!(0));
}

#[tokio::test]
async fn 連續讀取不會改變版本() {
    let app = spawn_app().await;
    for _ in 0..10 {
        let games = app.rpc("find_all_games", list_args()).await;
        assert_eq!(games.status, StatusCode::OK, "{}", games.text());
        assert_eq!(games.json(), json!([]));
        assert_eq!(app.rpc("find_game_ids", list_args()).await.status, StatusCode::OK);
        assert_eq!(app.rpc("find_game_by_id", json!({"id": 1})).await.json(), json!(null));
        assert_eq!(app.rpc("count_games", json!({})).await.json(), json!(0));
        assert_eq!(app.rpc("get_all_settings", json!({})).await.status, StatusCode::OK);
        assert_eq!(app.rpc("find_root_collections", json!({})).await.json(), json!([]));
        assert_eq!(app.rpc("get_all_game_statistics", json!({})).await.status, StatusCode::OK);
    }
    assert_eq!(app.data_version().await, 0);
}

#[tokio::test]
async fn 寫入成功時版本恰好加_1() {
    let app = spawn_app().await;

    let created = app
        .rpc("create_collection", json!({"name": "合集A", "parentId": null, "sortOrder": 0}))
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
async fn 寫入失敗時_rollback_且版本不變() {
    let app = spawn_app().await;
    // 不存在的會話：repository 回傳 RecordNotFound
    let response = app.rpc("delete_game_session", json!({"sessionId": 999_999})).await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(response.json()["code"], "command_failed");
    assert!(
        response.json()["message"].as_str().unwrap().starts_with("删除游戏会话失败"),
        "錯誤訊息沿用桌面版前綴：{}",
        response.text()
    );
    assert_eq!(app.data_version().await, 0);
}

#[tokio::test]
async fn 注入_commit_失敗時資料與版本都不變() {
    let app = spawn_app().await;
    app.fail_next_write_commit();
    let response = app
        .rpc("create_collection", json!({"name": "合集A", "parentId": null, "sortOrder": 0}))
        .await;
    assert_eq!(response.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_eq!(app.rpc("find_root_collections", json!({})).await.json(), json!([]));
    assert_eq!(app.data_version().await, 0);

    // 故障只作用一次：下一次寫入正常 commit
    let retried = app
        .rpc("create_collection", json!({"name": "合集A", "parentId": null, "sortOrder": 0}))
        .await;
    assert_eq!(retried.status, StatusCode::OK, "{}", retried.text());
    assert_eq!(app.data_version().await, 1);
}

#[tokio::test]
async fn 未知的_api_路徑回_json_404() {
    let app = spawn_app().await;
    let response = app.get("/game/api/nope", Some(&bearer(&owner_token()))).await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["code"], "not_found");
}
```

- [ ] **Step 21：執行測試，確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test api`
Expected: `/rpc/{command}` 尚未註冊，所有 RPC 請求都由 `api_not_found` 回 JSON 404。因此 `rpc_需要登入`（預期 401）、`參數錯誤回_400_且不改版本`、`空_body_視為沒有參數`、`連續讀取不會改變版本`、`寫入成功時版本恰好加_1`、`寫入失敗時_rollback_且版本不變`、`注入_commit_失敗時資料與版本都不變` 共 `7 failed`，失敗訊息都是實際狀態碼 `404`；`未知或桌面專屬的_command_回_404_且不改版本` 與 `未知的_api_路徑回_json_404` 剛好通過；原本 4 個測試仍通過。

- [ ] **Step 22：實作參數結構與 Read／Write 分派**

`src-tauri/reina-server/src/api/rpc/args.rs`：

```rust
//! 各 command 的參數。欄位名稱沿用前端 invoke 傳送的 camelCase，
//! 與 Tauri 對 command 參數的預設轉換相同；巢狀 DTO 仍用各自的 serde 設定。

use reina_core::database::dto::{InsertGameData, UpdateGameData, UpdateSettingsData};
use reina_core::database::repository::collections_repository::CollectionBackendSortField;
use reina_core::database::repository::games_repository::{GameType, SortOption, SortOrder};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::error::ApiError;

pub fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args).map_err(|error| ApiError::bad_request(format!("参数格式错误: {error}")))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Empty {}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdArgs {
    pub id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IdsArgs {
    pub ids: Vec<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameIdArgs {
    pub game_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameListArgs {
    pub game_type: GameType,
    pub sort_option: SortOption,
    pub sort_order: SortOrder,
    pub language: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceArgs {
    pub source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSessionsArgs {
    pub game_id: i32,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentSessionsArgs {
    pub game_ids: Vec<i32>,
    pub limit: u64,
    pub offset: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DistributionArgs {
    pub game_ids: Vec<i32>,
    pub start_date: String,
    pub end_date: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionIdArgs {
    pub collection_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupIdArgs {
    pub group_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSortArgs {
    pub sort_field: Option<CollectionBackendSortField>,
    pub sort_order: Option<SortOrder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSortArgs {
    pub group_id: i32,
    pub sort_field: Option<CollectionBackendSortField>,
    pub sort_order: Option<SortOrder>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertGameArgs {
    pub game: InsertGameData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertGamesArgs {
    pub games: Vec<InsertGameData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGameArgs {
    pub game_id: i32,
    pub updates: UpdateGameData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateGamesArgs {
    pub updates: Vec<(i32, UpdateGameData)>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualSessionArgs {
    pub game_id: i32,
    pub start_time: i32,
    pub duration: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIdArgs {
    pub session_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsArgs {
    pub data: UpdateSettingsData,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCollectionArgs {
    pub name: String,
    pub parent_id: Option<i32>,
    pub sort_order: i32,
    pub icon: Option<String>,
}

/// 與桌面版相同：`parentId: null` 反序列化成 `None`（不修改），不是 `Some(None)`
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCollectionArgs {
    pub id: i32,
    pub name: Option<String>,
    pub parent_id: Option<Option<i32>>,
    pub sort_order: Option<i32>,
    pub icon: Option<Option<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamesInCollectionArgs {
    pub game_ids: Vec<i32>,
    pub collection_id: i32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GamesToCollectionsArgs {
    pub game_ids: Vec<i32>,
    pub collection_ids: Vec<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCollectionsArgs {
    pub game_id: i32,
    pub collection_ids: Vec<i32>,
}
```

`src-tauri/reina-server/src/api/rpc/read.rs`：

```rust
//! Read command 分派：直接用連線池，不開 transaction。
//! 錯誤訊息前綴沿用 `src-tauri/src/database/service.rs`，前端顯示與桌面版一致。

use reina_core::database::repository::collections_repository::{
    CollectionBackendSortField, CollectionsRepository,
};
use reina_core::database::repository::game_stats_repository::GameStatsRepository;
use reina_core::database::repository::games_repository::{GamesRepository, SortOrder};
use reina_core::database::repository::settings_repository::SettingsRepository;
use sea_orm::{DatabaseConnection, DbErr};
use serde::Serialize;
use serde_json::Value;

use super::args::*;
use super::commands::ReadCommand;
use crate::error::ApiError;

pub(super) fn to_json<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|error| ApiError::internal(format!("序列化结果失败: {error}")))
}

pub(super) fn fail(prefix: &'static str) -> impl FnOnce(DbErr) -> ApiError {
    move |error| ApiError::internal(format!("{prefix}: {error}"))
}

/// 與桌面版 `validate_collection_sort` 相同：排序欄位與方向必須同時提供
fn collection_sort(
    sort_field: Option<CollectionBackendSortField>,
    sort_order: Option<SortOrder>,
) -> Result<Option<(CollectionBackendSortField, SortOrder)>, ApiError> {
    match (sort_field, sort_order) {
        (None, None) => Ok(None),
        (Some(field), Some(order)) => Ok(Some((field, order))),
        _ => Err(ApiError::bad_request("排序字段和排序方向必须同时提供")),
    }
}

pub async fn dispatch_read(
    db: &DatabaseConnection,
    command: ReadCommand,
    args: Value,
) -> Result<Value, ApiError> {
    match command {
        ReadCommand::FindGameById => {
            let a: IdArgs = parse(args)?;
            to_json(GamesRepository::find_by_id(db, a.id).await.map_err(fail("查询游戏数据失败"))?)
        }
        ReadCommand::FindAllGames => {
            let a: GameListArgs = parse(args)?;
            to_json(
                GamesRepository::find_all(db, a.game_type, a.sort_option, a.sort_order, a.language)
                    .await
                    .map_err(fail("获取游戏数据失败"))?,
            )
        }
        ReadCommand::FindGameIds => {
            let a: GameListArgs = parse(args)?;
            to_json(
                GamesRepository::find_ids(db, a.game_type, a.sort_option, a.sort_order, a.language)
                    .await
                    .map_err(fail("获取游戏 ID 列表失败"))?,
            )
        }
        ReadCommand::CountGames => {
            let _: Empty = parse(args)?;
            to_json(GamesRepository::count(db).await.map_err(fail("获取游戏总数失败"))?)
        }
        ReadCommand::GetSourceBindings => {
            let a: SourceArgs = parse(args)?;
            to_json(
                GamesRepository::get_source_bindings(db, &a.source)
                    .await
                    .map_err(fail("获取 source ID 列表失败"))?,
            )
        }
        ReadCommand::GetGameSessions => {
            let a: GameSessionsArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_sessions(db, a.game_id, a.limit, a.offset)
                    .await
                    .map_err(fail("获取游戏会话历史失败"))?,
            )
        }
        ReadCommand::GetRecentSessionsForAll => {
            let a: RecentSessionsArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_recent_sessions_for_all(db, a.game_ids, a.limit, a.offset)
                    .await
                    .map_err(fail("获取最近会话失败"))?,
            )
        }
        ReadCommand::GetGameStatistics => {
            let a: GameIdArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_statistics(db, a.game_id)
                    .await
                    .map_err(fail("获取游戏统计失败"))?,
            )
        }
        ReadCommand::GetAllGameStatistics => {
            let _: Empty = parse(args)?;
            to_json(
                GameStatsRepository::get_all_statistics(db)
                    .await
                    .map_err(fail("获取所有游戏统计失败"))?,
            )
        }
        ReadCommand::GetAllGameLastPlayed => {
            let _: Empty = parse(args)?;
            to_json(
                GameStatsRepository::get_all_last_played(db)
                    .await
                    .map_err(fail("获取所有游戏最近游玩时间失败"))?,
            )
        }
        ReadCommand::GetStatisticsDistribution => {
            let a: DistributionArgs = parse(args)?;
            to_json(
                GameStatsRepository::get_statistics_distribution(db, a.game_ids, &a.start_date, &a.end_date)
                    .await
                    .map_err(fail("获取游玩时段分布失败"))?,
            )
        }
        ReadCommand::GetAllSettings => {
            let _: Empty = parse(args)?;
            to_json(SettingsRepository::get_all_settings(db).await.map_err(fail("获取所有设置失败"))?)
        }
        ReadCommand::FindRootCollections => {
            let _: Empty = parse(args)?;
            to_json(
                CollectionsRepository::find_root_collections(db)
                    .await
                    .map_err(fail("获取根合集失败"))?,
            )
        }
        ReadCommand::GetRootCollectionsWithCount => {
            let a: CollectionSortArgs = parse(args)?;
            let sort = collection_sort(a.sort_field, a.sort_order)?;
            to_json(
                CollectionsRepository::get_root_collections_with_count(db, sort)
                    .await
                    .map_err(fail("获取根分组列表失败"))?,
            )
        }
        ReadCommand::GetGamesInCollection => {
            let a: CollectionIdArgs = parse(args)?;
            to_json(
                CollectionsRepository::get_games_in_collection(db, a.collection_id)
                    .await
                    .map_err(fail("获取合集中的游戏失败"))?,
            )
        }
        ReadCommand::GetGameCollectionIds => {
            let a: GameIdArgs = parse(args)?;
            to_json(
                CollectionsRepository::get_game_collection_ids(db, a.game_id)
                    .await
                    .map_err(fail("获取游戏所在合集失败"))?,
            )
        }
        ReadCommand::CountGamesInGroup => {
            let a: GroupIdArgs = parse(args)?;
            to_json(
                CollectionsRepository::count_games_in_group(db, a.group_id)
                    .await
                    .map_err(fail("获取分组游戏数量失败"))?,
            )
        }
        ReadCommand::GetCategoriesWithCount => {
            let a: GroupSortArgs = parse(args)?;
            let sort = collection_sort(a.sort_field, a.sort_order)?;
            to_json(
                CollectionsRepository::get_categories_with_count(db, a.group_id, sort)
                    .await
                    .map_err(fail("获取分类列表失败"))?,
            )
        }
    }
}
```

`src-tauri/reina-server/src/api/rpc/write.rs`：

```rust
//! Write command 分派：一律在呼叫端傳入的 transaction 裡執行，
//! 不能自行 begin/commit，否則 data_version 無法和業務資料一起 commit。

use reina_core::database::dto::{InsertCollectionData, UpdateCollectionData};
use reina_core::database::repository::collections_repository::CollectionsRepository;
use reina_core::database::repository::game_stats_repository::GameStatsRepository;
use reina_core::database::repository::games_repository::GamesRepository;
use reina_core::database::repository::settings_repository::SettingsRepository;
use sea_orm::DatabaseTransaction;
use serde_json::Value;

use super::args::*;
use super::commands::WriteCommand;
use super::read::{fail, to_json};
use crate::error::ApiError;

pub async fn dispatch_write(
    txn: &DatabaseTransaction,
    command: WriteCommand,
    args: Value,
) -> Result<Value, ApiError> {
    match command {
        WriteCommand::InsertGame => {
            let a: InsertGameArgs = parse(args)?;
            to_json(
                GamesRepository::insert_in_connection(txn, a.game)
                    .await
                    .map_err(fail("插入游戏数据失败"))?,
            )
        }
        WriteCommand::InsertGamesBatch => {
            let a: InsertGamesArgs = parse(args)?;
            // 批次結果本身記錄每筆成敗（savepoint），外層仍視為成功
            to_json(GamesRepository::insert_batch_in_connection(txn, a.games).await)
        }
        WriteCommand::UpdateGame => {
            let a: UpdateGameArgs = parse(args)?;
            to_json(
                GamesRepository::update_in_connection(txn, a.game_id, a.updates)
                    .await
                    .map_err(fail("更新游戏数据失败"))?,
            )
        }
        WriteCommand::UpdateGamesBatch => {
            let a: UpdateGamesArgs = parse(args)?;
            to_json(
                GamesRepository::update_batch_in_connection(txn, a.updates)
                    .await
                    .map_err(fail("批量更新数据失败"))?,
            )
        }
        WriteCommand::DeleteGame => {
            let a: IdArgs = parse(args)?;
            to_json(
                GamesRepository::delete(txn, a.id)
                    .await
                    .map_err(fail("删除游戏失败"))?
                    .rows_affected,
            )
        }
        WriteCommand::DeleteGamesBatch => {
            let a: IdsArgs = parse(args)?;
            to_json(
                GamesRepository::delete_many(txn, a.ids)
                    .await
                    .map_err(fail("批量删除游戏失败"))?
                    .rows_affected,
            )
        }
        WriteCommand::CreateManualGameSession => {
            let a: ManualSessionArgs = parse(args)?;
            to_json(
                GameStatsRepository::create_manual_session_in_connection(
                    txn,
                    a.game_id,
                    a.start_time,
                    a.duration,
                )
                .await
                .map_err(fail("创建游戏会话失败"))?
                .session_id,
            )
        }
        WriteCommand::DeleteGameSession => {
            let a: SessionIdArgs = parse(args)?;
            to_json(
                GameStatsRepository::delete_session_with_statistics_in_connection(txn, a.session_id)
                    .await
                    .map_err(fail("删除游戏会话失败"))?,
            )
        }
        WriteCommand::UpdateSettings => {
            let a: SettingsArgs = parse(args)?;
            to_json(
                SettingsRepository::update_settings(txn, a.data.cleaned())
                    .await
                    .map_err(fail("更新设置失败"))?,
            )
        }
        WriteCommand::CreateCollection => {
            let a: CreateCollectionArgs = parse(args)?;
            let data = InsertCollectionData {
                name: a.name,
                parent_id: a.parent_id,
                sort_order: a.sort_order,
                icon: a.icon,
            }
            .cleaned();
            to_json(
                CollectionsRepository::create(txn, data)
                    .await
                    .map_err(fail("创建合集失败"))?,
            )
        }
        WriteCommand::UpdateCollection => {
            let a: UpdateCollectionArgs = parse(args)?;
            let data = UpdateCollectionData {
                name: a.name,
                parent_id: a.parent_id,
                sort_order: a.sort_order,
                icon: a.icon,
            }
            .cleaned();
            to_json(
                CollectionsRepository::update(txn, a.id, data)
                    .await
                    .map_err(fail("更新合集失败"))?,
            )
        }
        WriteCommand::DeleteCollection => {
            let a: IdArgs = parse(args)?;
            to_json(
                CollectionsRepository::delete(txn, a.id)
                    .await
                    .map_err(fail("删除合集失败"))?
                    .rows_affected,
            )
        }
        WriteCommand::RemoveGamesFromCollection => {
            let a: GamesInCollectionArgs = parse(args)?;
            to_json(
                CollectionsRepository::remove_games_from_collection(
                    txn,
                    a.game_ids,
                    a.collection_id,
                )
                .await
                .map_err(fail("从合集中批量移除游戏失败"))?
                .rows_affected,
            )
        }
        WriteCommand::AddGamesToCollections => {
            let a: GamesToCollectionsArgs = parse(args)?;
            to_json(
                CollectionsRepository::add_games_to_collections_in_connection(
                    txn,
                    a.game_ids,
                    a.collection_ids,
                )
                .await
                .map_err(fail("批量添加游戏到合集失败"))?,
            )
        }
        WriteCommand::SetGameCollections => {
            let a: GameCollectionsArgs = parse(args)?;
            to_json(
                CollectionsRepository::set_game_collections_in_connection(txn, a.game_id, a.collection_ids)
                    .await
                    .map_err(fail("设置游戏合集失败"))?,
            )
        }
        WriteCommand::UpdateCategoryGames => {
            let a: GamesInCollectionArgs = parse(args)?;
            to_json(
                CollectionsRepository::update_category_games_in_connection(
                    txn,
                    a.game_ids,
                    a.collection_id,
                )
                .await
                .map_err(fail("批量更新分类游戏失败"))?,
            )
        }
    }
}
```

- [ ] **Step 23：實作 RPC handler 並掛上路由**

`src-tauri/reina-server/src/api/rpc/handler.rs`：

```rust
//! `POST /game/api/rpc/{command}`。

use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use serde_json::{Value, json};

use super::commands::{Command, WriteCommand};
use super::{read, write};
use crate::api::auth::AuthUser;
use crate::app::AppState;
use crate::error::ApiError;
use crate::tx;

pub async fn call(
    State(state): State<AppState>,
    _user: AuthUser,
    Path(name): Path<String>,
    body: Bytes,
) -> Result<Json<Value>, ApiError> {
    let command = Command::parse(&name)
        .ok_or_else(|| ApiError::not_found(format!("不支援的指令: {name}")))?;
    let args = parse_body(&body)?;
    let value = match command {
        Command::Read(command) => read::dispatch_read(&state.db, command, args).await?,
        Command::Write(command) => run_write(&state, command, args).await?,
    };
    Ok(Json(value))
}

/// 空 body 視為 `{}`（對應前端不帶參數的 invoke）；其餘必須是 JSON 物件
fn parse_body(body: &Bytes) -> Result<Value, ApiError> {
    if body.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    let value: Value = serde_json::from_slice(body)
        .map_err(|error| ApiError::bad_request(format!("请求内容不是合法 JSON: {error}")))?;
    if !value.is_object() {
        return Err(ApiError::bad_request("参数必须是 JSON 对象"));
    }
    Ok(value)
}

async fn run_write(
    state: &AppState,
    command: WriteCommand,
    args: Value,
) -> Result<Value, ApiError> {
    let txn = tx::begin(&state.db).await?;
    let result = write::dispatch_write(&txn, command, args).await;
    tx::finish(state, txn, result, |_| true).await
}
```

修改 `src-tauri/reina-server/src/api/router.rs`，在 `/version` 之後加入 RPC 路由：

```rust
use axum::Router;
use axum::routing::{get, post};

use crate::api::{rpc, version};
use crate::app::AppState;
use crate::error::ApiError;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/version", get(version::get_version))
        .route("/rpc/{command}", post(rpc::call))
        // 任務 7：.merge(crate::api::covers::routes())
        // 任務 8：.merge(crate::api::metadata::routes())
        // 任務 9：.merge(crate::api::scan::routes())
        .fallback(api_not_found)
}

/// `/game/api` 底下沒有對應路由時回 JSON，而不是前端的 index.html
async fn api_not_found() -> ApiError {
    ApiError::not_found("找不到这个 API")
}
```

- [ ] **Step 24：確認通過**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test api`
Expected: `13 passed`。

- [ ] **Step 25：寫靜態檔與深層路由的失敗測試**

`src-tauri/reina-server/tests/static_files.rs`：

```rust
mod support;

use axum::http::{StatusCode, header};
use support::spawn_app;

#[tokio::test]
async fn 健康檢查不需要登入() {
    let app = spawn_app().await;
    let response = app.get("/game/healthz", None).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.text(), "ok");
}

#[tokio::test]
async fn 沒有斜線的_game_導向_game_斜線() {
    let app = spawn_app().await;
    let response = app.get("/game", None).await;
    assert_eq!(response.status, StatusCode::PERMANENT_REDIRECT);
    assert_eq!(response.header(header::LOCATION).as_deref(), Some("/game/"));
}

#[tokio::test]
async fn 首頁與深層路由都回_index_html() {
    let app = spawn_app().await;
    for uri in ["/game/", "/game/libraries/12", "/game/settings/account", "/game/libraries/12/"] {
        let response = app.get(uri, None).await;
        assert_eq!(response.status, StatusCode::OK, "{uri}");
        assert!(response.text().contains("<title>reina</title>"), "{uri}");
        assert_eq!(response.header(header::CACHE_CONTROL).as_deref(), Some("no-cache"), "{uri}");
    }
}

#[tokio::test]
async fn 靜態資源帶正確型別與長快取() {
    let app = spawn_app().await;
    let response = app.get("/game/assets/app.js", None).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.text(), "console.log('reina');");
    assert!(
        response.header(header::CONTENT_TYPE).unwrap().contains("javascript"),
        "{:?}",
        response.header(header::CONTENT_TYPE)
    );
    assert_eq!(
        response.header(header::CACHE_CONTROL).as_deref(),
        Some("public, max-age=31536000, immutable")
    );

    let icon = app.get("/game/favicon.ico", None).await;
    assert_eq!(icon.status, StatusCode::OK);
    assert_eq!(icon.header(header::CACHE_CONTROL).as_deref(), Some("no-cache"));
}

#[tokio::test]
async fn 不存在的資源檔回_404_不回首頁() {
    let app = spawn_app().await;
    for uri in ["/game/assets/missing.js", "/game/logo.png"] {
        let response = app.get(uri, None).await;
        assert_eq!(response.status, StatusCode::NOT_FOUND, "{uri}");
        assert!(!response.text().contains("<title>reina</title>"), "{uri}");
    }
}

#[tokio::test]
async fn 路徑穿越被拒絕() {
    let app = spawn_app().await;
    for uri in ["/game/../secret.txt", "/game/%2e%2e/secret.txt", "/game/assets/..%2f..%2fsecret.txt", "/game/..%5csecret.txt"] {
        let response = app.get(uri, None).await;
        assert_ne!(response.status, StatusCode::OK, "{uri}");
        assert!(!response.text().contains("outside static dir"), "{uri}");
    }
}

#[tokio::test]
async fn api_路徑不會回前端首頁() {
    let app = spawn_app().await;
    let response = app.get("/game/api/unknown/deep", None).await;
    assert_eq!(response.status, StatusCode::NOT_FOUND);
    assert_eq!(response.json()["code"], "not_found");
}
```

- [ ] **Step 26：執行測試，確認失敗**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test static_files`
Expected: `健康檢查不需要登入`、`沒有斜線的_game_導向_game_斜線`、`api_路徑不會回前端首頁`、`路徑穿越被拒絕` 通過；`首頁與深層路由都回_index_html`、`靜態資源帶正確型別與長快取` 失敗（暫時實作一律回 `404`）；`不存在的資源檔回_404_不回首頁` 通過（暫時實作剛好也是 404）。共 `2 failed`。

- [ ] **Step 27：實作靜態檔服務**

以下列內容取代 `src-tauri/reina-server/src/static_files.rs`：

```rust
//! `/game/` 前端靜態檔與 SPA 深層路由回退。

use std::path::{Path as FsPath, PathBuf};

use axum::body::Body;
use axum::extract::{Path, Request, State};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::app::AppState;
use crate::error::ApiError;

const ASSET_CACHE: &str = "public, max-age=31536000, immutable";
const NO_CACHE: &str = "no-cache";

pub async fn serve_index(State(state): State<AppState>, request: Request) -> Response {
    serve_relative(&state, "", request).await
}

pub async fn serve_path(
    State(state): State<AppState>,
    Path(path): Path<String>,
    request: Request,
) -> Response {
    serve_relative(&state, &path, request).await
}

async fn serve_relative(state: &AppState, relative: &str, request: Request) -> Response {
    // 防呆：API 路徑一律不回前端頁面（正常情況由 /game/api 的 fallback 處理）
    if relative == "api" || relative.starts_with("api/") {
        return ApiError::not_found("找不到这个 API").into_response();
    }
    let Some(safe) = sanitize(relative) else {
        return StatusCode::NOT_FOUND.into_response();
    };

    let root = &state.config.static_dir;
    if !safe.as_os_str().is_empty() {
        let candidate = root.join(&safe);
        let is_file = tokio::fs::metadata(&candidate)
            .await
            .map(|meta| meta.is_file())
            .unwrap_or(false);
        if is_file {
            let cache = if safe.starts_with("assets") { ASSET_CACHE } else { NO_CACHE };
            return serve_file(candidate, request, cache).await;
        }
        // 看起來像檔案（最後一段有副檔名）卻不存在：回 404，避免把 index.html 當成 JS 載入
        if has_extension(&safe) {
            return StatusCode::NOT_FOUND.into_response();
        }
    }

    // 其餘都是前端路由，交給 React Router
    serve_file(root.join("index.html"), request, NO_CACHE).await
}

/// 只接受一般路徑段；`..`、反斜線、磁碟代號一律拒絕。
/// axum 的 Path 已經做過 percent-decoding，所以 `%2e%2e` 也會在這裡被擋下。
fn sanitize(relative: &str) -> Option<PathBuf> {
    let mut out = PathBuf::new();
    for segment in relative.split('/') {
        match segment {
            "" | "." => continue,
            ".." => return None,
            s if s.contains('\\') || s.contains(':') || s.contains('\0') => return None,
            s => out.push(s),
        }
    }
    Some(out)
}

fn has_extension(path: &FsPath) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.contains('.'))
}

async fn serve_file(path: PathBuf, request: Request, cache: &'static str) -> Response {
    let response = match ServeFile::new(path).oneshot(request).await {
        Ok(response) => response,
        Err(never) => match never {},
    };
    let mut response = response.map(Body::new);
    if response.status().is_success() {
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static(cache));
    }
    response
}
```

- [ ] **Step 28：確認通過**

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test static_files`
Expected: `7 passed`。

- [ ] **Step 29：實作 `main.rs`**

`src-tauri/reina-server/src/main.rs`：

```rust
//! reina-server 啟動程式。設定全部來自環境變數（見 `Config::from_lookup`）。

use std::net::SocketAddr;

use reina_server::{AppState, Config, build_router};

#[tokio::main]
async fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    if let Err(error) = run().await {
        // 不輸出設定內容，避免金鑰出現在日誌
        log::error!("reina-server 启动失败: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let config = Config::from_env()?;
    tokio::fs::create_dir_all(&config.data_dir).await?;
    let db = reina_core::database::connect_database(&config.db_path()).await?;

    let address = SocketAddr::from(([0, 0, 0, 0], config.port));
    log::info!(
        "reina-server 监听 {address}，数据目录 {}，静态文件 {}",
        config.data_dir.display(),
        config.static_dir.display()
    );

    let listener = tokio::net::TcpListener::bind(address).await?;
    axum::serve(listener, build_router(AppState::new(db, config)))
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Docker 停止容器時送 SIGTERM；本機開發按 Ctrl+C
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
}
```

- [ ] **Step 30：手動啟動驗證（背景執行，驗證完關閉）**

在 Git Bash 以背景方式啟動（用暫存目錄，不碰正式資料）：

```bash
cd /d/game/ReinaManager
SMOKE=$(mktemp -d)
echo "$SMOKE"
mkdir -p "$SMOKE/static"
echo '<!doctype html><title>smoke</title>' > "$SMOKE/static/index.html"
JWT_SECRET=smoke-secret REINA_OWNER_ID=1 REINA_PORT=18787 \
  REINA_DATA_DIR="$SMOKE/data" REINA_STATIC_DIR="$SMOKE/static" \
  cargo run --manifest-path src-tauri/Cargo.toml -p reina-server
```

另開一個指令確認：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18787/game/healthz
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:18787/game/api/version
curl -s http://127.0.0.1:18787/game/libraries/1
```

Expected：依序輸出 `200`、`401`、`<!doctype html><title>smoke</title>`；`$SMOKE/data/reina_manager.db` 已建立。確認後停止背景程序，並刪除上面印出的 `$SMOKE` 目錄。

另外確認缺少金鑰時會失敗退出：

```bash
REINA_OWNER_ID=1 cargo run --manifest-path src-tauri/Cargo.toml -p reina-server; echo "exit=$?"
```

Expected：日誌出現 `reina-server 启动失败: 缺少 JWT_SECRET`，`exit=1`。

- [ ] **Step 31：整體檢查**

依序執行（一次一條）：

```bash
cargo fmt --manifest-path src-tauri/Cargo.toml -p reina-server
cargo clippy --manifest-path src-tauri/Cargo.toml -p reina-server --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml -p reina-server
cargo check --manifest-path src-tauri/Cargo.toml -p ReinaManager
```

Expected：clippy 無警告；`reina-server` 全部測試通過（lib 12 個、`api` 12 個、`static_files` 7 個）；桌面版 `ReinaManager` 仍可編譯。

- [ ] **Step 32：Commit**

```bash
cd /d/game/ReinaManager
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/reina-server
git status --short
git commit -m "feat(server): add authenticated reina-server with RPC and version API

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

`git status --short` 裡只能看到本任務的檔案被 stage；使用者原本就有的 `src-tauri/Cargo.toml` 修改如果不屬於本任務，先用 `git diff --cached src-tauri/Cargo.toml` 確認只包含 workspace `members` 這一行，否則改用 `git add -p src-tauri/Cargo.toml` 只 stage 這一段。

---

### 任務 4：瀏覽器登入（TeleDrive JWT）與 HTTP 傳輸

**Files:**
- Create: `vitest.config.ts`
- Create: `src/testing/setup.ts`
- Create: `src/services/web/auth.ts`
- Create: `src/services/web/auth.test.ts`
- Create: `src/services/web/http.ts`
- Create: `src/services/web/http.test.ts`
- Create: `src/services/invoke/base.test.ts`
- Create: `src/services/platform.ts`（本任務只放 `isWebRuntime`，任務 5 擴充）
- Modify: `src/services/invoke/base.ts:6-36`（整個 `invoke` 方法）
- Modify: `src/utils/errors.ts:8-17`（`AppErrorCode` 聯集）
- Modify: `package.json:5-24`（scripts）、`package.json:62-75`（devDependencies，由 `pnpm add` 產生）
- Modify: `pnpm-lock.yaml`（由 `pnpm add` 產生）
- Modify: `tsconfig.node.json:22`（`include` 加入 `vitest.config.ts`）

**Interfaces:**
- Consumes：TeleDrive 前端既有的 IndexedDB 紀錄（資料庫 `teledrive-credentials`、store `credentials`、鍵 `active`，值 `{ accounts, jwt }`）；TeleDrive `POST /api/v1/auth/refresh`（Bearer 舊 token → `{ token }`）；任務 3 的 `POST /game/api/rpc/:command`（成功回傳 command 的 JSON 值，失敗回傳 `{ code, message, detail? }`）。
- Produces：
  - `src/services/web/auth.ts`
    - `export const AUTH_REQUIRED_EVENT = "reina:auth-required"`
    - `export class NotLoggedInError extends AppError`（`AppError` 本身 `extends Error`；`code === "not_logged_in"`）
    - `export function notifyAuthRequired(): void`
    - `export function readTeleDriveJwt(): Promise<string | null>`
    - `export function refreshTeleDriveJwt(staleToken: string): Promise<string>`
  - `src/services/web/http.ts`
    - `export const SERVER_API_PREFIX = "/game/api/"`
    - `export const BRIDGE_ORIGIN = "http://127.0.0.1:8081"`
    - `export function authenticatedFetch(input: string, init?: RequestInit): Promise<Response>`
    - `export function serverRpc<T>(command: string, args?: Record<string, unknown>): Promise<T>`
  - `src/services/platform.ts`：`export function isWebRuntime(): boolean`
  - `AppErrorCode` 新增：`"not_logged_in" | "network_offline" | "forbidden" | "forbidden_destination" | "server_rpc_failed"`
  - `package.json` scripts：`"test:web": "vitest run"`

- [ ] **Step 1：安裝測試依賴**

版本已對照現有 `vite@8.2.1`、`react@18.3.1`、Node `v24.11.0` 檢查：`vitest@5.0.2` 的 peer 是 `vite ^6.4 || ^7 || ^8`；`jsdom@30` 要求 Node `^24.15`，所以選 `jsdom@29.1.1`（`>=24.0.0`）；`@testing-library/react@16.3.3` 支援 React 18。

Run（ReinaManager 根目錄）：
```bash
pnpm add -D vitest@5.0.2 jsdom@29.1.1 fake-indexeddb@6.2.5 @testing-library/react@16.3.3 @testing-library/dom@10.4.2
```
Expected：`devDependencies` 多出這五項，`pnpm-lock.yaml` 更新，沒有 peer 警告（忽略 AGENTS.md 提到的 `node_modules are out of sync` 警告）。

- [ ] **Step 2：加入 Vitest 設定與 script**

`vitest.config.ts`（新檔）：
```ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// 只跑 src 内的相邻测试；根目录 test/ 是用户的封面图片资料，不能被扫描
export default defineConfig({
	// 与网页版部署路径一致：任务 7–9 的断言依赖 import.meta.env.BASE_URL === "/game/"
	base: "/game/",
	plugins: [react()],
	resolve: {
		alias: [
			{ find: "@", replacement: resolve(import.meta.dirname, "./src") },
			{
				find: "@pkg",
				replacement: resolve(import.meta.dirname, "./package.json"),
			},
		],
	},
	test: {
		environment: "jsdom",
		include: ["src/**/*.test.{ts,tsx}"],
		setupFiles: ["src/testing/setup.ts"],
		restoreMocks: true,
		unstubEnvs: true,
		unstubGlobals: true,
	},
});
```

`src/testing/setup.ts`（新檔）：
```ts
// 为 jsdom 提供 IndexedDB 实现；各测试需要全新数据库时再用 vi.stubGlobal 覆盖
import "fake-indexeddb/auto";
```

`package.json` 的 `scripts` 在 `"typecheck"` 那行之後加入：
```json
		"test:web": "vitest run",
```

`tsconfig.node.json` 最後的 `include` 改為：
```json
	"include": ["vite.config.ts", "vitest.config.ts"]
```

Run：`pnpm test:web`
Expected：`No test files found, exiting with code 1`（尚未有測試，確認設定可載入且沒有掃到 `test/`）。

- [ ] **Step 3：寫 `auth.ts` 的失敗測試**

`src/services/web/auth.test.ts`（新檔）：
```ts
import { IDBFactory } from "fake-indexeddb";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	NotLoggedInError,
	readTeleDriveJwt,
	refreshTeleDriveJwt,
} from "./auth";

const DB = "teledrive-credentials";
const STORE = "credentials";
const KEY = "active";

// 模拟 TeleDrive 前端写入的凭证记录（accounts 内是 Telegram session）
const ACCOUNTS = [
	{ id: 1, label: "main", session: "1BQANOTE-session-bytes-不可改动" },
];

function seedCredentials(record: unknown): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB, 1);
		request.onupgradeneeded = () => {
			request.result.createObjectStore(STORE);
		};
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).put(record, KEY);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error);
		};
		request.onerror = () => reject(request.error);
	});
}

function readRecord(): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB);
		request.onsuccess = () => {
			const db = request.result;
			const get = db.transaction(STORE).objectStore(STORE).get(KEY);
			get.onsuccess = () => {
				db.close();
				resolve(get.result);
			};
			get.onerror = () => reject(get.error);
		};
		request.onerror = () => reject(request.error);
	});
}

function deleteRecord(): Promise<void> {
	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB);
		request.onsuccess = () => {
			const db = request.result;
			const tx = db.transaction(STORE, "readwrite");
			tx.objectStore(STORE).delete(KEY);
			tx.oncomplete = () => {
				db.close();
				resolve();
			};
			tx.onerror = () => reject(tx.error);
		};
		request.onerror = () => reject(request.error);
	});
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	vi.stubGlobal("indexedDB", new IDBFactory());
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

describe("readTeleDriveJwt", () => {
	it("资料库不存在时回传 null，且不替 TeleDrive 建立资料库", async () => {
		await expect(readTeleDriveJwt()).resolves.toBeNull();
		const names = (await indexedDB.databases()).map((db) => db.name);
		expect(names).not.toContain(DB);
	});

	it("回传 active.jwt", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "jwt-1" });
		await expect(readTeleDriveJwt()).resolves.toBe("jwt-1");
	});

	it("jwt 为 null 或空字串时视为未登入", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: null });
		await expect(readTeleDriveJwt()).resolves.toBeNull();
		await seedCredentials({ accounts: ACCOUNTS, jwt: "" });
		await expect(readTeleDriveJwt()).resolves.toBeNull();
	});
});

describe("refreshTeleDriveJwt", () => {
	it("20 个并发刷新只送出一次请求，写回后 accounts 完全不变", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		fetchMock.mockImplementation(async () =>
			Response.json({ token: "fresh" }),
		);

		const results = await Promise.all(
			Array.from({ length: 20 }, () => refreshTeleDriveJwt("stale")),
		);

		expect(results.every((token) => token === "fresh")).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("/api/v1/auth/refresh");
		expect(init?.method).toBe("POST");
		expect(new Headers(init?.headers).get("Authorization")).toBe(
			"Bearer stale",
		);
		expect(await readRecord()).toEqual({ accounts: ACCOUNTS, jwt: "fresh" });
	});

	it("IndexedDB 内已是别的 token（别的分页刷新过）时直接沿用，不再请求", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "already-fresh" });
		await expect(refreshTeleDriveJwt("stale")).resolves.toBe("already-fresh");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("刷新回 401 时丢 NotLoggedInError，纪录不变", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
		await expect(refreshTeleDriveJwt("stale")).rejects.toBeInstanceOf(
			NotLoggedInError,
		);
		expect(await readRecord()).toEqual({ accounts: ACCOUNTS, jwt: "stale" });
	});

	it("刷新期间使用者已登出：不写回、不复活纪录", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		fetchMock.mockImplementation(async () => {
			await deleteRecord();
			return Response.json({ token: "fresh" });
		});
		await expect(refreshTeleDriveJwt("stale")).rejects.toBeInstanceOf(
			NotLoggedInError,
		);
		expect(await readRecord()).toBeUndefined();
	});

	it("刷新期间 TeleDrive 分页改了 accounts：写回只换 jwt，保留新的 accounts", async () => {
		await seedCredentials({ accounts: ACCOUNTS, jwt: "stale" });
		// 模拟使用者在 TeleDrive 分页新增了一个 Telegram 帐号，发生在刷新请求进行中
		const updatedAccounts = [
			...ACCOUNTS,
			{ id: 999, label: "新帐号", session: "session-new" },
		];
		fetchMock.mockImplementation(async () => {
			await seedCredentials({ accounts: updatedAccounts, jwt: "stale" });
			return Response.json({ token: "fresh" });
		});
		await expect(refreshTeleDriveJwt("stale")).resolves.toBe("fresh");
		expect(await readRecord()).toEqual({
			accounts: updatedAccounts,
			jwt: "fresh",
		});
	});
});
```

- [ ] **Step 4：確認失敗**

Run：`pnpm test:web src/services/web/auth.test.ts`
Expected：FAIL，`Failed to resolve import "./auth"`。

- [ ] **Step 5：擴充錯誤碼**

`src/utils/errors.ts` 的 `AppErrorCode` 改為：
```ts
export type AppErrorCode =
	| "tauri_invoke_failed"
	| "unsupported_source"
	| "invalid_game_id"
	| "metadata_not_found"
	| "mixed_sources_failed"
	| "http_response_error"
	| "http_response_parse_failed"
	| "api_rate_limited"
	| "metadata_request_failed"
	| "not_logged_in"
	| "network_offline"
	| "forbidden"
	| "forbidden_destination"
	| "server_rpc_failed";
```

- [ ] **Step 6：實作 `auth.ts`**

`src/services/web/auth.ts`（新檔）：
```ts
/**
 * @file TeleDrive 登录凭证
 * @description 网页版沿用 TeleDrive 的登录：从同源 IndexedDB 读取 JWT，过期时刷新并写回。
 *
 * 安全约束：同一笔记录的 `accounts` 是 Telegram session（明文 bearer 凭证），
 * 本模块只读写 `jwt` 字段，绝不读取、传送或记录 `accounts`。
 */

import { AppError } from "@/utils/errors";

const CREDENTIAL_DB = "teledrive-credentials";
const CREDENTIAL_STORE = "credentials";
const CREDENTIAL_KEY = "active";
const REFRESH_URL = "/api/v1/auth/refresh";
const REFRESH_TIMEOUT_MS = 15_000;

export const AUTH_REQUIRED_EVENT = "reina:auth-required";

export class NotLoggedInError extends AppError {
	constructor(message = "TeleDrive login required") {
		super({ code: "not_logged_in", message, name: "NotLoggedInError" });
	}
}

/** 通知界面显示「请先登录 TeleDrive」 */
export function notifyAuthRequired(): void {
	window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
}

function openCredentialDb(): Promise<IDBDatabase | null> {
	return new Promise((resolve, reject) => {
		// 不指定版本：TeleDrive 升级资料库版本时这里也不会因 VersionError 失败
		const request = indexedDB.open(CREDENTIAL_DB);
		let creationAborted = false;
		request.onupgradeneeded = (event) => {
			// oldVersion 为 0 代表资料库原本不存在（TeleDrive 从未登录）：
			// 中止这次建立，避免替 TeleDrive 建出空资料库
			if (event.oldVersion === 0) {
				creationAborted = true;
				request.transaction?.abort();
			}
		};
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => {
			if (creationAborted) {
				resolve(null);
				return;
			}
			reject(
				request.error ?? new Error("TeleDrive credential database unavailable"),
			);
		};
	});
}

function extractJwt(record: unknown): string | null {
	if (!record || typeof record !== "object") return null;
	const jwt = (record as { jwt?: unknown }).jwt;
	return typeof jwt === "string" && jwt.length > 0 ? jwt : null;
}

export async function readTeleDriveJwt(): Promise<string | null> {
	const db = await openCredentialDb();
	if (!db) return null;
	try {
		if (!db.objectStoreNames.contains(CREDENTIAL_STORE)) return null;
		const record = await new Promise<unknown>((resolve, reject) => {
			const request = db
				.transaction(CREDENTIAL_STORE, "readonly")
				.objectStore(CREDENTIAL_STORE)
				.get(CREDENTIAL_KEY);
			request.onsuccess = () => resolve(request.result);
			request.onerror = () => reject(request.error);
		});
		return extractJwt(record);
	} finally {
		db.close();
	}
}

/**
 * 在同一个 readwrite transaction 内 get → put，只替换 jwt，
 * 保留当下的 accounts，避免覆盖 TeleDrive 分页同时做的修改。
 * @returns 是否真的写入；期间已登出（纪录或 jwt 不存在）时回传 false
 */
async function writeBackJwt(freshToken: string): Promise<boolean> {
	const db = await openCredentialDb();
	if (!db) return false;
	try {
		if (!db.objectStoreNames.contains(CREDENTIAL_STORE)) return false;
		return await new Promise<boolean>((resolve, reject) => {
			const tx = db.transaction(CREDENTIAL_STORE, "readwrite");
			const store = tx.objectStore(CREDENTIAL_STORE);
			let written = false;
			const getRequest = store.get(CREDENTIAL_KEY);
			getRequest.onsuccess = () => {
				const record = getRequest.result;
				// 期间已登出：不复活已经退出的登录
				if (!extractJwt(record)) return;
				store.put({ ...(record as object), jwt: freshToken }, CREDENTIAL_KEY);
				written = true;
			};
			tx.oncomplete = () => resolve(written);
			tx.onerror = () => reject(tx.error);
			tx.onabort = () => reject(tx.error);
		});
	} finally {
		db.close();
	}
}

async function performRefresh(staleToken: string): Promise<string> {
	// 其他分页（TeleDrive 或另一个 /game）可能已经刷新过：直接沿用，避免刷新风暴
	const current = await readTeleDriveJwt();
	if (!current) throw new NotLoggedInError();
	if (current !== staleToken) return current;

	let response: Response;
	try {
		// 网络请求在 IndexedDB transaction 之外完成，避免 transaction 因等待而自动提交
		response = await fetch(REFRESH_URL, {
			method: "POST",
			headers: { Authorization: `Bearer ${staleToken}` },
			signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
		});
	} catch (cause) {
		throw new AppError({
			code: "network_offline",
			message: "TeleDrive token refresh request failed",
			cause,
		});
	}

	if (response.status === 401 || response.status === 403) {
		throw new NotLoggedInError();
	}
	if (!response.ok) {
		throw new AppError({
			code: "server_rpc_failed",
			message: `TeleDrive token refresh failed: HTTP ${response.status}`,
		});
	}

	const body = (await response.json()) as { token?: unknown };
	if (typeof body.token !== "string" || body.token.length === 0) {
		throw new AppError({
			code: "http_response_parse_failed",
			message: "TeleDrive token refresh returned no token",
		});
	}

	if (!(await writeBackJwt(body.token))) {
		throw new NotLoggedInError();
	}
	return body.token;
}

let refreshInFlight: Promise<string> | null = null;

/** 同一时间只送一个刷新请求，其他呼叫者等待同一个结果 */
export function refreshTeleDriveJwt(staleToken: string): Promise<string> {
	if (!refreshInFlight) {
		refreshInFlight = performRefresh(staleToken).finally(() => {
			refreshInFlight = null;
		});
	}
	return refreshInFlight;
}
```

- [ ] **Step 7：確認 `auth` 測試通過**

Run：`pnpm test:web src/services/web/auth.test.ts`
Expected：PASS，8 個測試全部通過。

- [ ] **Step 8：寫 `http.ts` 的失敗測試**

`src/services/web/http.test.ts`（新檔）：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/utils/errors";
import { AUTH_REQUIRED_EVENT, NotLoggedInError } from "./auth";
import { authenticatedFetch, serverRpc } from "./http";

const readJwt = vi.fn<() => Promise<string | null>>();
const refreshJwt = vi.fn<(stale: string) => Promise<string>>();

vi.mock("./auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./auth")>();
	return {
		...actual,
		readTeleDriveJwt: () => readJwt(),
		refreshTeleDriveJwt: (stale: string) => refreshJwt(stale),
	};
});

const fetchMock = vi.fn<typeof fetch>();

function authOf(callIndex: number): string | null {
	return new Headers(fetchMock.mock.calls[callIndex][1]?.headers).get(
		"Authorization",
	);
}

beforeEach(() => {
	readJwt.mockReset().mockResolvedValue("jwt-1");
	refreshJwt.mockReset().mockResolvedValue("jwt-2");
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
});

describe("authenticatedFetch", () => {
	it("对 /game/api 附上 Bearer", async () => {
		fetchMock.mockResolvedValue(Response.json(1));
		await authenticatedFetch("/game/api/version");
		expect(authOf(0)).toBe("Bearer jwt-1");
	});

	it("对本机 bridge 的 /rpc/game/ 附上 Bearer", async () => {
		fetchMock.mockResolvedValue(Response.json({ games: [] }));
		await authenticatedFetch("http://127.0.0.1:8081/rpc/game/state");
		expect(authOf(0)).toBe("Bearer jwt-1");
	});

	it("拒绝把 token 送往白名单以外的目的地", async () => {
		for (const url of [
			"https://api.bgm.tv/v0/me",
			"/api/v1/folders",
			"http://127.0.0.1:8081/rpc/fetch-local",
			"http://127.0.0.1:9999/rpc/game/state",
		]) {
			await expect(authenticatedFetch(url)).rejects.toMatchObject({
				code: "forbidden_destination",
			});
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("401 时刷新一次后以新 token 重试", async () => {
		fetchMock
			.mockResolvedValueOnce(new Response(null, { status: 401 }))
			.mockResolvedValueOnce(Response.json("ok"));
		const response = await authenticatedFetch("/game/api/version");
		expect(response.status).toBe(200);
		expect(refreshJwt).toHaveBeenCalledWith("jwt-1");
		expect(authOf(1)).toBe("Bearer jwt-2");
	});

	it("重试后仍 401：丢 NotLoggedInError 并发出 auth-required 事件", async () => {
		const listener = vi.fn();
		window.addEventListener(AUTH_REQUIRED_EVENT, listener);
		fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
		await expect(authenticatedFetch("/game/api/version")).rejects.toBeInstanceOf(
			NotLoggedInError,
		);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(listener).toHaveBeenCalledTimes(1);
		window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
	});

	it("403 不刷新、不重试", async () => {
		fetchMock.mockResolvedValue(new Response(null, { status: 403 }));
		const response = await authenticatedFetch("/game/api/version");
		expect(response.status).toBe(403);
		expect(refreshJwt).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("没有 jwt：不送请求，直接 NotLoggedInError", async () => {
		readJwt.mockResolvedValue(null);
		await expect(authenticatedFetch("/game/api/version")).rejects.toBeInstanceOf(
			NotLoggedInError,
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("网络失败转为 network_offline", async () => {
		fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
		await expect(authenticatedFetch("/game/api/version")).rejects.toMatchObject({
			code: "network_offline",
		});
	});

	it("AbortSignal 中止时原样丢出 AbortError", async () => {
		const controller = new AbortController();
		controller.abort();
		fetchMock.mockRejectedValue(
			new DOMException("The operation was aborted.", "AbortError"),
		);
		await expect(
			authenticatedFetch("/game/api/version", { signal: controller.signal }),
		).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("serverRpc", () => {
	it("POST JSON 到 /game/api/rpc/<command> 并回传 JSON 值", async () => {
		fetchMock.mockResolvedValue(Response.json({ id: 7 }));
		await expect(
			serverRpc<{ id: number }>("find_game_by_id", { id: 7 }),
		).resolves.toEqual({ id: 7 });
		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("/game/api/rpc/find_game_by_id");
		expect(init?.method).toBe("POST");
		expect(init?.body).toBe(JSON.stringify({ id: 7 }));
		expect(new Headers(init?.headers).get("Content-Type")).toBe(
			"application/json",
		);
	});

	it("伺服器回传 null（Option::None）时回传 null", async () => {
		fetchMock.mockResolvedValue(Response.json(null));
		await expect(serverRpc("find_game_by_id", { id: 1 })).resolves.toBeNull();
	});

	it("错误回应 {code,message} 转为 AppError", async () => {
		fetchMock.mockResolvedValue(
			Response.json(
				{ code: "invalid_argument", message: "bad id" },
				{ status: 400 },
			),
		);
		const error = await serverRpc("find_game_by_id", { id: -1 }).catch(
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(AppError);
		expect(error).toMatchObject({
			code: "invalid_argument",
			message: "bad id",
			context: { command: "find_game_by_id", status: 400 },
		});
	});

	it("403 一律转为 code=forbidden", async () => {
		fetchMock.mockResolvedValue(
			Response.json({ code: "x", message: "not owner" }, { status: 403 }),
		);
		await expect(serverRpc("find_all_games")).rejects.toMatchObject({
			code: "forbidden",
		});
	});

	it("非 JSON 错误体保留 HTTP 状态资讯", async () => {
		fetchMock.mockResolvedValue(new Response("<html>502</html>", { status: 502 }));
		await expect(serverRpc("find_all_games")).rejects.toMatchObject({
			code: "server_rpc_failed",
			message: "HTTP 502: find_all_games",
		});
	});
});
```

- [ ] **Step 9：確認失敗**

Run：`pnpm test:web src/services/web/http.test.ts`
Expected：FAIL，`Failed to resolve import "./http"`。

- [ ] **Step 10：實作 `http.ts`**

`src/services/web/http.ts`（新檔）：
```ts
/**
 * @file 网页版 HTTP 传输
 * @description 带 TeleDrive JWT 呼叫 reina-server 与本机 bridge；401 刷新一次后重试。
 * token 只会送往白名单目的地，第三方元数据来源一律不带 TeleDrive 凭证。
 */

import { AppError } from "@/utils/errors";
import {
	NotLoggedInError,
	notifyAuthRequired,
	readTeleDriveJwt,
	refreshTeleDriveJwt,
} from "./auth";

export const SERVER_API_PREFIX = "/game/api/";
export const BRIDGE_ORIGIN = "http://127.0.0.1:8081";
const BRIDGE_PATH_PREFIX = "/rpc/game/";

function isAllowedDestination(input: string): boolean {
	let url: URL;
	try {
		url = new URL(input, window.location.origin);
	} catch {
		return false;
	}
	if (url.origin === BRIDGE_ORIGIN) {
		return url.pathname.startsWith(BRIDGE_PATH_PREFIX);
	}
	return (
		url.origin === window.location.origin &&
		url.pathname.startsWith(SERVER_API_PREFIX)
	);
}

async function sendWithToken(
	input: string,
	init: RequestInit,
	token: string,
): Promise<Response> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${token}`);
	try {
		return await fetch(input, { ...init, headers });
	} catch (cause) {
		// 呼叫方主动中止：原样丢出，交给呼叫方判断
		if (cause instanceof DOMException && cause.name === "AbortError") {
			throw cause;
		}
		throw new AppError({
			code: "network_offline",
			message: `Network request failed: ${input}`,
			cause,
		});
	}
}

/**
 * 注意：重试会重送同一个 init.body，所以 body 只能是字符串、Blob 或 FormData，
 * 不能是只能读一次的 ReadableStream。
 */
export async function authenticatedFetch(
	input: string,
	init: RequestInit = {},
): Promise<Response> {
	if (!isAllowedDestination(input)) {
		throw new AppError({
			code: "forbidden_destination",
			message: `Refusing to send TeleDrive token to ${input}`,
		});
	}

	const token = await readTeleDriveJwt();
	if (!token) {
		notifyAuthRequired();
		throw new NotLoggedInError();
	}

	const first = await sendWithToken(input, init, token);
	if (first.status !== 401) return first;

	let freshToken: string;
	try {
		freshToken = await refreshTeleDriveJwt(token);
	} catch (error) {
		if (error instanceof NotLoggedInError) notifyAuthRequired();
		throw error;
	}

	const second = await sendWithToken(input, init, freshToken);
	if (second.status === 401) {
		notifyAuthRequired();
		throw new NotLoggedInError();
	}
	return second;
}

async function toRpcError(
	response: Response,
	command: string,
	args?: Record<string, unknown>,
): Promise<AppError> {
	let code = "server_rpc_failed";
	let message = `HTTP ${response.status}: ${command}`;
	let detail: string | undefined;
	try {
		const body = (await response.json()) as Record<string, unknown>;
		if (typeof body.code === "string") code = body.code;
		if (typeof body.message === "string") message = body.message;
		if (typeof body.detail === "string") detail = body.detail;
	} catch {
		// 非 JSON 错误体（例如 nginx 502 页面）：保留 HTTP 状态信息
	}
	if (response.status === 403) code = "forbidden";
	return new AppError({
		code,
		message,
		detail,
		context: { command, args, status: response.status },
	});
}

export async function serverRpc<T>(
	command: string,
	args?: Record<string, unknown>,
): Promise<T> {
	const response = await authenticatedFetch(
		`${SERVER_API_PREFIX}rpc/${encodeURIComponent(command)}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(args ?? {}),
		},
	);
	if (!response.ok) {
		throw await toRpcError(response, command, args);
	}
	return (await response.json()) as T;
}
```

- [ ] **Step 11：確認 `http` 測試通過**

Run：`pnpm test:web src/services/web/http.test.ts`
Expected：PASS，14 個測試全部通過。

- [ ] **Step 12：寫 `BaseService` 分派的失敗測試**

`src/services/invoke/base.test.ts`（新檔）：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BaseService } from "./base";

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { serverRpcMock } = vi.hoisted(() => ({
	serverRpcMock: vi.fn(),
}));
vi.mock("@/services/web/http", () => ({
	serverRpc: (...args: unknown[]) => serverRpcMock(...args),
}));

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { tauriInvokeMock } = vi.hoisted(() => ({
	tauriInvokeMock: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({
	invoke: (...args: unknown[]) => tauriInvokeMock(...args),
	isTauri: () => false,
}));

class ProbeService extends BaseService {
	call<T>(command: string, args?: Record<string, unknown>) {
		return this.invoke<T>(command, args);
	}
}

beforeEach(() => {
	serverRpcMock.mockReset();
	tauriInvokeMock.mockReset();
});

describe("BaseService.invoke", () => {
	it("网页版改走 serverRpc，保留参数名称与回传型别", async () => {
		vi.stubEnv("MODE", "web");
		serverRpcMock.mockResolvedValue([{ id: 1 }]);
		await expect(
			new ProbeService().call("find_all_games", { gameType: "all" }),
		).resolves.toEqual([{ id: 1 }]);
		expect(serverRpcMock).toHaveBeenCalledWith("find_all_games", {
			gameType: "all",
		});
		expect(tauriInvokeMock).not.toHaveBeenCalled();
	});

	it("非网页、非 Tauri 时维持原本的 tauri_invoke_failed", async () => {
		vi.stubEnv("MODE", "test");
		await expect(new ProbeService().call("find_all_games")).rejects.toMatchObject(
			{ code: "tauri_invoke_failed" },
		);
		expect(serverRpcMock).not.toHaveBeenCalled();
	});
});
```

- [ ] **Step 13：確認失敗**

Run：`pnpm test:web src/services/invoke/base.test.ts`
Expected：FAIL，第一個測試 `expected [Function] to resolve ... tauri_invoke_failed`（尚未分派到 serverRpc）。

- [ ] **Step 14：實作 `isWebRuntime` 與分派**

`src/services/platform.ts`（新檔，任務 5 會擴充）：
```ts
/**
 * @file 执行环境判断
 * @description 网页版以 `vite --mode web` 建置；其余情况都是桌面版（Tauri）。
 */

export function isWebRuntime(): boolean {
	return import.meta.env.MODE === "web";
}
```

`src/services/invoke/base.ts` 整份改為：
```ts
/**
 * @file Service 基础类
 * @description 提供统一的错误归一化能力；网页版改走 reina-server 的 HTTP RPC
 */

import { invoke, isTauri } from "@tauri-apps/api/core";
import { isWebRuntime } from "@/services/platform";
import { serverRpc } from "@/services/web/http";
import { AppError, normalizeTauriError } from "@/utils/errors";

/**
 * 基础 Service 类
 */
export class BaseService {
	/**
	 * 调用后端 command（桌面版为 Tauri IPC，网页版为 HTTP RPC）
	 * @param command 命令名称
	 * @param args 参数
	 * @returns Promise 结果
	 */
	protected async invoke<T>(
		command: string,
		args?: Record<string, unknown>,
	): Promise<T> {
		if (isWebRuntime()) {
			// 参数名称与回传型别和 Tauri command 相同，由 reina-server 的白名单决定能否呼叫
			return serverRpc<T>(command, args);
		}

		if (!isTauri()) {
			throw new AppError({
				code: "tauri_invoke_failed",
				message: `Tauri runtime is unavailable: ${command}`,
			});
		}

		try {
			return await invoke<T>(command, args);
		} catch (error) {
			throw normalizeTauriError(error, { command, args });
		}
	}
}
```

- [ ] **Step 15：確認通過並做型別檢查**

Run：`pnpm test:web src/services`
Expected：PASS，`auth`、`http`、`base` 三個檔案共 24 個測試通過。

Run：`pnpm typecheck`
Expected：無錯誤。

Run：`pnpm lint`
Expected：無錯誤（有格式問題先跑 `pnpm format` 再重跑）。

- [ ] **Step 16：Commit**

```bash
git add vitest.config.ts src/testing/setup.ts src/services/web/auth.ts src/services/web/auth.test.ts src/services/web/http.ts src/services/web/http.test.ts src/services/invoke/base.ts src/services/invoke/base.test.ts src/services/platform.ts src/utils/errors.ts package.json pnpm-lock.yaml tsconfig.node.json
git commit -m "feat(web): add TeleDrive browser auth and HTTP RPC transport

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### 任務 5：網頁執行環境、`/game` 子路徑與平台能力邊界

**Files:**
- Modify: `src/services/platform.ts`（擴充任務 4 的檔案）
- Create: `src/services/platform.test.ts`
- Create: `src/components/WebAuthGate.tsx`
- Create: `src/components/WebAuthGate.test.tsx`
- Create: `src/hooks/common/useWebAuthRequired.ts`
- Create: `src/hooks/common/useWebAuthRequired.test.ts`
- Create: `src/store/appStore.web.test.ts`
- Create: `src/services/webImportSmoke.test.ts`
- Modify: `vite.config.ts:7-44`（改成依 mode 設定）
- Modify: `package.json:8`（新增 `build:web`）
- Modify: `.gitignore:3`（加 `dist-web`）
- Modify: `biome.json:10-18`（`includes` 加 `!dist-web`）
- Modify: `src/main.tsx`（整份改寫，見 Step 11）
- Modify: `src/App.tsx:3,40-44`
- Modify: `src/providers/router.tsx:8,160`
- Modify: `src/store/appStore.ts:515-526`（`initialize`）
- Modify: `src/pages/Detail/game-info/GameInfoEdit.tsx:31,106`（模組層級的 `sep()`）
- Modify: `src/pages/Detail/DetailPage.tsx`（存檔分頁 `Tab` 加 `disabled`）
- Modify: `src/components/Toolbar/Toolbar.tsx:54,268,526,537`
- Modify: `src/components/RightMenu/RightMenu.tsx:132-150,181-196`
- Modify: `src/components/AppLayout.tsx:36-60,237,357`
- Modify: `src/components/Cards/useCardsController.tsx:89`
- Modify: `src/pages/Settings/SettingsPage.tsx:138-199`
- Modify: `src/pages/Settings/AccountSettings.tsx:25,49,59,75,307-323`
- Modify: `src/pages/Settings/AboutSettings.tsx:10,85-101`
- Modify: `src/pages/Settings/useBgmAuthController.ts:2`、`src/pages/Settings/useHikarinagiAuthController.ts:2`
- Modify: `src/components/TaskManagerDialog.tsx:27`
- Modify: `src/utils/game/gameDisplay.ts:47,55`（只改預設圖片路徑；封面本身由任務 7 處理）
- Modify: `src/pages/Detail/game-info/gameInfoEditData.ts:22`
- Modify: `src/locales/zh-CN.json`、`zh-TW.json`、`en-US.json`、`ja-JP.json`（新增 `components.WebAuthGate.*`、`components.WebCapability.*`）

**Interfaces:**
- Consumes：任務 4 的 `isWebRuntime()`、`readTeleDriveJwt()`、`AUTH_REQUIRED_EVENT`。
- Produces：
  - `src/services/platform.ts`
    - `export function isWebRuntime(): boolean`（任務 4 已有）
    - `export const platformCapabilities: { readonly nativePaths: boolean; readonly nativeLaunch: boolean; readonly desktopShell: boolean }`（getter，執行時才判斷；網頁版三者皆 `false`，桌面 Tauri 皆 `true`）
    - `export function getRouterBasename(): string | undefined`（網頁版 `"/game"`，桌面 `undefined`）
    - `export function publicAssetUrl(path: string): string`（`"images/x.png"` → 網頁版 `"/game/images/x.png"`、桌面 `"/images/x.png"`）
    - `export function openExternal(url: string): Promise<void>`（網頁版 `window.open(url, "_blank", "noopener,noreferrer")`，桌面用 `@tauri-apps/plugin-shell` 的 `open`）
  - `src/hooks/common/useWebAuthRequired.ts`：`export function useWebAuthRequired(): boolean`
  - `src/components/WebAuthGate.tsx`：`export function WebAuthGate(props: { onRetry: () => void }): JSX.Element`
  - 建置：`pnpm build:web` → `dist-web/`，`base: "/game/"`；`pnpm build` 維持 `dist/`、`base: "./"`。

**Tauri 依賴盤點與歸屬**（`rg -n "@tauri-apps|convertFileSrc|listen\(" src` 的結果逐項分類）：

| 位置 | 用途 | 網頁版處理 | 歸屬 |
|---|---|---|---|
| `main.tsx`（`isTauri`、`initTray`、`initPathCache`、快捷鍵封鎖） | 桌面啟動 | 網頁分支完全不執行；不封鎖瀏覽器的重新整理與右鍵 | 本任務 |
| `App.tsx`（`WindowsHandler`、`InstallRequestHandler`） | 視窗、updater、deep link 安裝 | 改用 `platformCapabilities.desktopShell` 判斷，網頁不掛載 | 本任務 |
| `store/appStore.ts` `initialize`（`initializeGamePlayTracking`、`updateProxyConfig`） | 桌面計時事件、代理同步 | 網頁版直接略過 | 本任務 |
| `services/game/gameStats.ts`（`listen` 三個遊戲事件） | 桌面計時 | 只由上面的 `initialize` 觸發，網頁不會呼叫；統計刷新改由任務 6 | 本任務（隔離）／任務 6 |
| `store/gamePlayStore.ts`（`launchGameWithTracking`） | 桌面啟動遊戲 | 網頁不顯示啟動入口（`nativeLaunch`） | 本任務（隔離）／計畫 B |
| `components/Toolbar/Toolbar.tsx`（`getCurrentWindow().setTheme`、`openurl`、`LaunchModal`、`OpenFolder`） | 視窗主題、外部連結、啟動、開資料夾 | 主題已由 `isTauri()` 保護；`openurl` 換 `openExternal`；`LaunchModal`、`OpenFolder` 依能力隱藏 | 本任務 |
| `components/RightMenu/RightMenu.tsx`（啟動、開資料夾） | 本機動作 | 依能力隱藏 | 本任務／計畫 B 加 bridge 按鈕 |
| `components/AppLayout.tsx`（下載任務按鈕、`TaskManagerDialog`） | 桌面安裝任務 | 依 `desktopShell` 不掛載 | 本任務 |
| `components/TaskManagerDialog.tsx`（`openUrl`） | 外部連結 | 換 `openExternal`（網頁不會掛載，但保持一致） | 本任務 |
| `components/AddModal/useTauriDragDrop.ts` | 拖放 | 已由 `isTauri()` 保護，不動 | — |
| `components/Windows.tsx`、`components/InstallRequestHandler.tsx`、`services/plugins/*`、`services/appExit.ts` | 桌面專屬 | 只在 `desktopShell` 下掛載或呼叫，不動 | — |
| `services/fs/*`（`pathCache`、`fileDialog`、`dataMaintenance`） | 本機路徑與檔案對話框 | 呼叫端依 `nativePaths` 隱藏；`AddModal`／`BulkImportTab` 的本機路徑流程由任務 9（雲端掃描）取代 | 本任務（Toolbar/RightMenu/Settings）／任務 9 |
| `pages/Detail/game-info/GameInfoEdit.tsx`（模組層級 `sep()`） | 路徑分隔符 | **網頁載入模組就會丟錯**，改為依能力選擇 | 本任務 |
| `pages/Detail/game-info/GameInfoEdit.tsx`（`fileService.importClipboardImageToTemp` 等）、`useImagePreview.ts`（`convertFileSrc`）、`utils/game/gameDisplay.ts`（`convertFileSrc`、`reina-cover`） | 封面 | 改走 HTTP 封面 | 任務 7 |
| `metadata/api/http.ts`（`tauriFetch`）、`hooks/common/useProxyImageUrlResolver.ts` | 中繼資料請求 | 改走伺服器代理 | 任務 8 |
| `pages/Settings/SystemSettings.tsx`、`MaintenanceSettings.tsx`、`PathSettingsModal` | 自動啟動、代理、備份、路徑 | 整個「系統」「路徑與備份」分區在網頁隱藏 | 本任務 |
| `pages/Settings/AccountSettings.tsx`、`useBgmAuthController.ts`、`useHikarinagiAuthController.ts`（`openurl`、`listen` 的 OAuth 回呼） | 第三方 OAuth | `openurl` 換 `openExternal`；OAuth 按鈕在網頁隱藏，保留手動 token | 本任務 |
| `pages/Settings/AboutSettings.tsx`（`checkForUpdates`、`openurl`） | 更新檢查、外部連結 | 更新按鈕在網頁隱藏；`openurl` 換 `openExternal` | 本任務 |
| `pages/Detail/DetailPage.tsx`（`SaveData` 分頁） | 本機存檔備份 | 分頁在網頁 `disabled` | 本任務 |

- [ ] **Step 1：寫 `platform.ts` 的失敗測試**

`src/services/platform.test.ts`（新檔）：
```ts
import { afterEach, describe, expect, it, vi } from "vitest";

const shellOpen = vi.fn(async () => {});
vi.mock("@tauri-apps/plugin-shell", () => ({ open: shellOpen }));

let tauri = false;
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri }));

import {
	getRouterBasename,
	isWebRuntime,
	openExternal,
	platformCapabilities,
	publicAssetUrl,
} from "./platform";

afterEach(() => {
	tauri = false;
	shellOpen.mockClear();
});

describe("網頁版", () => {
	it("所有原生能力都是 false，basename 為 /game", () => {
		vi.stubEnv("MODE", "web");
		tauri = false;
		expect(isWebRuntime()).toBe(true);
		expect({ ...platformCapabilities }).toEqual({
			nativePaths: false,
			nativeLaunch: false,
			desktopShell: false,
		});
		expect(getRouterBasename()).toBe("/game");
		expect(publicAssetUrl("images/default.png")).toBe(
			"/game/images/default.png",
		);
		expect(publicAssetUrl("/images/default.png")).toBe(
			"/game/images/default.png",
		);
	});

	it("openExternal 以新分頁開啟，且不帶 opener", async () => {
		vi.stubEnv("MODE", "web");
		const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
		await openExternal("https://bgm.tv/subject/1");
		expect(openSpy).toHaveBeenCalledWith(
			"https://bgm.tv/subject/1",
			"_blank",
			"noopener,noreferrer",
		);
		expect(shellOpen).not.toHaveBeenCalled();
	});
});

describe("桌面版", () => {
	it("Tauri 下所有能力為 true，資源路徑維持 /images", async () => {
		vi.stubEnv("MODE", "production");
		tauri = true;
		expect(isWebRuntime()).toBe(false);
		expect({ ...platformCapabilities }).toEqual({
			nativePaths: true,
			nativeLaunch: true,
			desktopShell: true,
		});
		expect(getRouterBasename()).toBeUndefined();
		expect(publicAssetUrl("images/default.png")).toBe("/images/default.png");
		await openExternal("https://vndb.org/v1");
		expect(shellOpen).toHaveBeenCalledWith("https://vndb.org/v1");
	});

	it("既非網頁也非 Tauri（純 vite dev）時能力皆 false", () => {
		vi.stubEnv("MODE", "development");
		tauri = false;
		expect(platformCapabilities.desktopShell).toBe(false);
	});
});
```

- [ ] **Step 2：確認失敗**

Run：`pnpm test:web src/services/platform.test.ts`
Expected：FAIL，`platformCapabilities` 等匯出不存在（`does not provide an export named 'getRouterBasename'`）。

- [ ] **Step 3：擴充 `platform.ts`**

`src/services/platform.ts` 整份改為：
```ts
/**
 * @file 执行环境与平台能力
 * @description 网页版以 `vite --mode web` 建置；桌面版（Tauri）才具备本机路径、启动游戏与桌面壳能力。
 * 能力以 getter 在执行时判断，呼叫端不要在模块载入时缓存结果。
 */

import { isTauri } from "@tauri-apps/api/core";

export function isWebRuntime(): boolean {
	return import.meta.env.MODE === "web";
}

function isDesktopRuntime(): boolean {
	return !isWebRuntime() && isTauri();
}

export const platformCapabilities = {
	/** 能读写本机路径、开资料夹、选档案 */
	get nativePaths(): boolean {
		return isDesktopRuntime();
	},
	/** 能由本程式直接启动游戏并计时（网页版改由 bridge 负责，见计画 B） */
	get nativeLaunch(): boolean {
		return isDesktopRuntime();
	},
	/** 视窗、系统匣、自动启动、updater、deep link、第三方 OAuth 回呼 */
	get desktopShell(): boolean {
		return isDesktopRuntime();
	},
};

export function getRouterBasename(): string | undefined {
	return isWebRuntime() ? "/game" : undefined;
}

/** public/ 下的静态资源路径；网页版部署在 /game/ 子路径下 */
export function publicAssetUrl(path: string): string {
	const relative = path.replace(/^\/+/, "");
	return isWebRuntime() ? `/game/${relative}` : `/${relative}`;
}

export async function openExternal(url: string): Promise<void> {
	if (!isDesktopRuntime()) {
		window.open(url, "_blank", "noopener,noreferrer");
		return;
	}
	const { open } = await import("@tauri-apps/plugin-shell");
	await open(url);
}
```

- [ ] **Step 4：確認通過**

Run：`pnpm test:web src/services/platform.test.ts`
Expected：PASS，4 個測試通過。

- [ ] **Step 5：Vite 依 mode 建置**

`vite.config.ts` 整份改為：
```ts
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import UnoCSS from "unocss/vite";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
	// 网页版部署在 TeleDrive 的 /game/ 子路径，产物与桌面版分开存放
	const isWeb = mode === "web";

	return {
		base: isWeb ? "/game/" : "./",
		server: {
			// Tauri 工作于固定端口，如果端口不可用则报错
			strictPort: true,
			port: 5173,
			watch: {
				ignored: ["**/src-tauri/**"],
			},
		},
		clearScreen: false,
		// 添加有关当前构建目标的额外前缀，使这些 CLI 设置的 Tauri 环境变量可以在客户端代码中访问
		envPrefix: ["VITE_", "TAURI_ENV_"],
		build: {
			outDir: isWeb ? "dist-web" : "dist",
			minify: !process.env.TAURI_ENV_DEBUG,
			// 在 debug 构建中生成 sourcemap
			sourcemap: !!process.env.TAURI_ENV_DEBUG,
		},
		plugins: [react(), UnoCSS()],
		resolve: {
			// 设置文件./src路径为 @
			alias: [
				{
					find: "@",
					replacement: resolve(import.meta.dirname, "./src"),
				},
				{
					find: "@pkg",
					replacement: resolve(import.meta.dirname, "./package.json"),
				},
			],
		},
	};
});
```

`package.json` 的 `"build"` 那行之後加入：
```json
		"build:web": "tsc -b && vite build --mode web",
```

`.gitignore` 的 `dist` 那行之後加入 `dist-web`；`biome.json` 的 `files.includes` 在 `"!dist",` 之後加入 `"!dist-web",`。

- [ ] **Step 6：Router 使用 basename**

`src/providers/router.tsx` 加入 import（放在 `@/components/AppLayout` 之後）：
```ts
import { getRouterBasename } from "@/services/platform";
```
第 160 行改為：
```ts
export const routers = createBrowserRouter(routeConfig, {
	basename: getRouterBasename(),
});
```

- [ ] **Step 7：寫登入提示與事件 hook 的失敗測試**

`src/hooks/common/useWebAuthRequired.test.ts`（新檔）：
```ts
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AUTH_REQUIRED_EVENT } from "@/services/web/auth";
import { useWebAuthRequired } from "./useWebAuthRequired";

describe("useWebAuthRequired", () => {
	it("收到 auth-required 事件後回傳 true", () => {
		const { result, unmount } = renderHook(() => useWebAuthRequired());
		expect(result.current).toBe(false);
		act(() => {
			window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
		});
		expect(result.current).toBe(true);
		unmount();
	});
});
```

`src/components/WebAuthGate.test.tsx`（新檔）：
```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WebAuthGate } from "./WebAuthGate";

describe("WebAuthGate", () => {
	it("提供前往 TeleDrive 的連結與重新檢查按鈕", () => {
		const onRetry = vi.fn();
		render(<WebAuthGate onRetry={onRetry} />);
		expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
			"请先登录 TeleDrive",
		);
		expect(
			screen.getByRole("link", { name: "前往 TeleDrive 登录" }).getAttribute(
				"href",
			),
		).toBe("/");
		fireEvent.click(screen.getByRole("button", { name: "我已登录，重新检查" }));
		expect(onRetry).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 8：確認失敗**

Run：`pnpm test:web src/hooks/common/useWebAuthRequired.test.ts src/components/WebAuthGate.test.tsx`
Expected：FAIL，兩個檔案都是 `Failed to resolve import`。

- [ ] **Step 9：實作 hook 與元件**

`src/hooks/common/useWebAuthRequired.ts`（新檔）：
```ts
import { useEffect, useState } from "react";
import { AUTH_REQUIRED_EVENT } from "@/services/web/auth";

/**
 * 监听 HTTP 传输层发出的「需要登录」事件（token 缺失或刷新失败）
 * @returns 是否需要显示登录提示
 */
export function useWebAuthRequired(): boolean {
	const [required, setRequired] = useState(false);

	useEffect(() => {
		const handleAuthRequired = () => setRequired(true);
		window.addEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
		return () =>
			window.removeEventListener(AUTH_REQUIRED_EVENT, handleAuthRequired);
	}, []);

	return required;
}
```

`src/components/WebAuthGate.tsx`（新檔）：
```tsx
import { Box, Button, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";

interface WebAuthGateProps {
	onRetry: () => void;
}

/**
 * 网页版未登录提示
 * TeleDrive 登录后不会自动跳回 /game，由使用者自己回来（TeleDrive 不需要改程式）
 */
export function WebAuthGate({ onRetry }: WebAuthGateProps) {
	const { t } = useTranslation();

	return (
		<Box className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center">
			<Typography variant="h5" component="h1">
				{t("components.WebAuthGate.title", "请先登录 TeleDrive")}
			</Typography>
			<Typography variant="body2" color="text.secondary">
				{t(
					"components.WebAuthGate.description",
					"ReinaManager 网页版沿用 TeleDrive 的登录。请在 TeleDrive 登录后回到本页。",
				)}
			</Typography>
			<Box className="flex flex-wrap justify-center gap-3">
				<Button variant="contained" href="/">
					{t("components.WebAuthGate.openTeleDrive", "前往 TeleDrive 登录")}
				</Button>
				<Button variant="outlined" onClick={onRetry}>
					{t("components.WebAuthGate.retry", "我已登录，重新检查")}
				</Button>
			</Box>
		</Box>
	);
}
```

- [ ] **Step 10：確認通過**

Run：`pnpm test:web src/hooks/common/useWebAuthRequired.test.ts src/components/WebAuthGate.test.tsx`
Expected：PASS，2 個測試通過。

- [ ] **Step 11：改寫 `main.tsx` 的啟動流程**

`src/main.tsx` 整份改為（保留原本的註解與 Emotion 設定；桌面行為不變）：
```tsx
/**
 * @file main.tsx
 * @description 应用入口文件，初始化全局状态，设置全局事件监听，挂载根组件。
 * @author ReinaManager
 * @copyright AGPL-3.0
 *
 * Emotion 缓存配置:
 * - 使用官方推荐的 CacheProvider + prepend: true 方案
 * - 确保 MUI 的 Emotion 样式被正确注入到 <head> 的开头
 * - 防止后来加载的样式(如 @mui/x-charts)覆盖 MUI 基础样式
 *
 * 网页版（vite --mode web）：
 * - 先确认 TeleDrive 登录，未登录只显示登录提示，不发出任何 API 请求
 * - 不执行系统匣、路径缓存、快捷键封锁等桌面专属初始化
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { routers } from "@/providers/router";
import "virtual:uno.css";
import "@/providers/i18n";
import createCache from "@emotion/cache";
import { CacheProvider } from "@emotion/react";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { isTauri } from "@tauri-apps/api/core";
import { WebAuthGate } from "@/components/WebAuthGate";
import { queryClient } from "@/providers/queryClient";
import { initPathCache } from "@/services/fs/pathCache";
import { isWebRuntime } from "@/services/platform";
import { initTray } from "@/services/plugins/trayService";
import { readTeleDriveJwt } from "@/services/web/auth";
import { initializeStores, type StartupPage, useStore } from "./store/appStore";

// 创建 Emotion 缓存,确保样式注入顺序正确
// 根据官方文档: https://github.com/mui/material-ui/blob/master/docs/data/material/integrations/interoperability/interoperability.md
// prepend: true 会让 Emotion 的 <style> 标签插入到 <head> 的开头
// 这确保了 MUI 的基础样式优先级高于后来动态加载的组件样式(如 @mui/x-charts)
const emotionCache = createCache({
	key: "mui",
	prepend: true,
});

const DISABLED_FUNCTION_KEYS = ["F3", "F5", "F7"];
const DISABLED_CTRL_KEYS = ["r", "u", "p", "l", "j", "g", "f", "s"];
const STARTUP_PAGE_PATHS: Record<StartupPage, string> = {
	home: "/",
	libraries: "/libraries",
	collection: "/collection",
};

// 禁止拖拽、右键菜单和部分快捷键，提升桌面体验；网页版保留浏览器的重新整理与右键
function installDesktopInputGuards() {
	document.addEventListener("drop", (e) => e.preventDefault());
	document.addEventListener("dragover", (e) => e.preventDefault());
	document.addEventListener("contextmenu", (e) => e.preventDefault());
	document.addEventListener("keydown", (e) => {
		if (DISABLED_FUNCTION_KEYS.includes(e.key.toUpperCase())) {
			e.preventDefault();
		}

		if (e.ctrlKey && DISABLED_CTRL_KEYS.includes(e.key.toLowerCase())) {
			e.preventDefault();
		}
	});
}

const root = createRoot(document.getElementById("root") as HTMLElement);

function renderAuthGate() {
	root.render(
		<CacheProvider value={emotionCache}>
			<WebAuthGate onRetry={() => window.location.reload()} />
		</CacheProvider>,
	);
}

function renderApp() {
	root.render(
		<CacheProvider value={emotionCache}>
			<QueryClientProvider client={queryClient}>
				<ReactQueryDevtools initialIsOpen={false} />
				<RouterProvider router={routers} />
			</QueryClientProvider>
		</CacheProvider>,
	);
}

async function bootstrap() {
	if (isWebRuntime()) {
		const jwt = await readTeleDriveJwt().catch((error) => {
			console.error("读取 TeleDrive 登录凭证失败:", error);
			return null;
		});
		if (!jwt) {
			renderAuthGate();
			return;
		}
	} else {
		installDesktopInputGuards();
	}

	// 初始化全局状态后，挂载 React 应用
	await initializeStores();

	const currentLocation = routers.state.location;
	if (currentLocation.pathname === "/") {
		const startupPath = STARTUP_PAGE_PATHS[useStore.getState().startupPage];
		if (startupPath !== currentLocation.pathname) {
			await routers.navigate(startupPath, { replace: true });
		}
	}

	const trayReady =
		!isWebRuntime() && isTauri()
			? initTray().catch((error) => {
					console.error("托盘初始化失败:", error);
				})
			: Promise.resolve(null);

	// 封面路径依赖路径缓存，仍需在首屏挂载前完成
	if (!isWebRuntime() && isTauri()) {
		try {
			await initPathCache();
		} catch (error) {
			console.error("路径缓存初始化失败:", error);
		}
	}

	renderApp();

	void trayReady;
}

void bootstrap();
```

（原本 `@/providers/i18n` 只由 `App.tsx` 匯入；登入提示在 `App` 之外渲染，所以 `main.tsx` 也要匯入。重複匯入同一模組不會重複初始化。）

- [ ] **Step 12：`App.tsx` 掛載登入提示並以能力判斷桌面元件**

`src/App.tsx` 第 3 行 `import { isTauri } from "@tauri-apps/api/core";` 改為：
```ts
import { WebAuthGate } from "@/components/WebAuthGate";
import { useWebAuthRequired } from "@/hooks/common/useWebAuthRequired";
import { isWebRuntime, platformCapabilities } from "@/services/platform";
```
`const { t } = useTranslation();` 之後加入：
```ts
	const webAuthRequired = useWebAuthRequired();
```
`return (` 之前加入：
```tsx
	// 网页版执行中 token 失效且刷新失败：整页改为登录提示
	if (isWebRuntime() && webAuthRequired) {
		return <WebAuthGate onRetry={() => window.location.reload()} />;
	}
```
第 42–43 行改為：
```tsx
				{platformCapabilities.desktopShell && <WindowsHandler />}
				{platformCapabilities.desktopShell && <InstallRequestHandler />}
```

- [ ] **Step 13：寫 `appStore.initialize` 的失敗測試**

`src/store/appStore.web.test.ts`（新檔）：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const initializeGamePlayTracking = vi.fn(async () => {});
vi.mock("./gamePlayStore", () => ({ initializeGamePlayTracking }));

const updateProxyConfig = vi.fn(async () => {});
vi.mock("@/services/invoke", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/services/invoke")>();
	return {
		...actual,
		settingsService: { ...actual.settingsService, updateProxyConfig },
	};
});

import { initializeStores } from "./appStore";

beforeEach(() => {
	initializeGamePlayTracking.mockClear();
	updateProxyConfig.mockClear();
});

describe("initializeStores", () => {
	it("網頁版不初始化桌面計時事件，也不同步代理設定", async () => {
		vi.stubEnv("MODE", "web");
		await initializeStores();
		expect(initializeGamePlayTracking).not.toHaveBeenCalled();
		expect(updateProxyConfig).not.toHaveBeenCalled();
	});

	it("桌面版維持原本流程", async () => {
		vi.stubEnv("MODE", "production");
		await initializeStores();
		expect(initializeGamePlayTracking).toHaveBeenCalledTimes(1);
		expect(updateProxyConfig).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 14：確認失敗**

Run：`pnpm test:web src/store/appStore.web.test.ts`
Expected：FAIL，第一個測試 `expected "spy" to not be called at all, but actually been called 1 times`。

- [ ] **Step 15：實作 `initialize` 的網頁分支**

`src/store/appStore.ts` 在 import 區加入：
```ts
import { isWebRuntime } from "@/services/platform";
```
第 515–526 行的 `initialize` 改為：
```ts
			initialize: async () => {
				// 网页版：游玩计时由各台电脑的 bridge 负责，元数据代理由伺服器负责
				if (isWebRuntime()) return;

				// 初始化游戏时间跟踪（数据获取由 React Query 自动触发）
				await initializeGamePlayTracking().catch((error) => {
					console.error("初始化游戏时间跟踪失败:", error);
				});

				// 启动时同步代理设置到后端
				const { proxyConfig } = get();
				await settingsService
					.updateProxyConfig(proxyConfig)
					.catch(console.error);
			},
```

Run：`pnpm test:web src/store/appStore.web.test.ts`
Expected：PASS，2 個測試通過。

- [ ] **Step 16：寫「網頁載入模組不會丟錯」的失敗測試**

`src/services/webImportSmoke.test.ts`（新檔）：
```ts
import { describe, expect, it, vi } from "vitest";

describe("網頁版模組載入", () => {
	it("沒有 Tauri 全域物件時，遊戲編輯頁模組可以載入", async () => {
		vi.stubEnv("MODE", "web");
		// 确认测试环境真的没有 Tauri 注入
		expect(
			(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__,
		).toBeUndefined();
		await expect(
			import("@/pages/Detail/game-info/GameInfoEdit"),
		).resolves.toBeDefined();
	});
});
```

Run：`pnpm test:web src/services/webImportSmoke.test.ts`
Expected：FAIL，`TypeError: Cannot read properties of undefined (reading 'plugins')`（來自 `GameInfoEdit.tsx:106` 的模組層級 `sep()`）。

- [ ] **Step 17：修正模組層級的 `sep()`**

`src/pages/Detail/game-info/GameInfoEdit.tsx` 在 import 區加入：
```ts
import { platformCapabilities } from "@/services/platform";
```
第 106 行改為：
```ts
// 网页版没有 Tauri path 插件；在模块载入时呼叫 sep() 会直接丢错
const PATH_SEPARATOR = platformCapabilities.nativePaths ? sep() : "/";
```

Run：`pnpm test:web src/services/webImportSmoke.test.ts`
Expected：PASS。

- [ ] **Step 18：依能力隱藏本機入口**

`src/components/Toolbar/Toolbar.tsx`
- 第 54 行改為 `import { openExternal as openurl } from "@/services/platform";`，並在同一個 import 加上 `platformCapabilities`：
```ts
import {
	openExternal as openurl,
	platformCapabilities,
} from "@/services/platform";
```
- 第 526 行（詳情頁區塊）改為：
```tsx
							{platformCapabilities.nativeLaunch && <LaunchModal />}
							{platformCapabilities.nativePaths && (
								<OpenFolder selectedGame={selectedGame} />
							)}
```
- 第 537 行（遊戲庫區塊）改為：
```tsx
					{platformCapabilities.nativeLaunch && <LaunchModal />}
```

`src/components/RightMenu/RightMenu.tsx` 在 import 區加入 `import { platformCapabilities } from "@/services/platform";`，把第 132–150 行「啟動遊戲」的 `<MenuItem>` 包成：
```tsx
				{platformCapabilities.nativeLaunch && (
					<MenuItem
						disabled={!isThisGameCanRun}
						onClick={() => {
							if (selectedGame) {
								void onLaunchGame(selectedGame);
							}
							onClose();
						}}
					>
						<ListItemIcon>
							{hasLocalPath ? <PlayCircleOutlineIcon /> : <SyncIcon />}
						</ListItemIcon>
						<ListItemText
							primary={
								hasLocalPath
									? t("components.RightMenu.startGame", "启动游戏")
									: t("components.LaunchModal.syncLocalPath", "同步本地")
							}
						/>
					</MenuItem>
				)}
```
第 181–196 行「打開遊戲目錄」的 `<MenuItem>` 同樣包在 `{platformCapabilities.nativePaths && ( … )}` 內，內容不變。

`src/components/AppLayout.tsx`
- import 區加入 `import { platformCapabilities, publicAssetUrl } from "@/services/platform";`
- 把 `SidebarFooter` 內的下載任務按鈕抽成子元件，讓 `useActiveTaskCount()` 只在桌面版被呼叫（hook 不能條件式呼叫）：
```tsx
function DesktopTaskButton() {
	const { t } = useTranslation();
	const openTaskManager = useStore((s) => s.openTaskManager);
	const { data: activeTaskCount = 0 } = useActiveTaskCount();
	const taskManagerLabel = t("components.TaskManager.title", "下载任务");
	const accessibleLabel = activeTaskCount
		? `${taskManagerLabel} (${activeTaskCount})`
		: taskManagerLabel;

	return (
		<Tooltip title={accessibleLabel}>
			<IconButton
				onClick={openTaskManager}
				color="inherit"
				aria-label={accessibleLabel}
				size="large"
			>
				<Badge badgeContent={activeTaskCount} color="primary" max={99}>
					<DownloadRoundedIcon />
				</Badge>
			</IconButton>
		</Tooltip>
	);
}
```
  `SidebarFooter` 刪掉 `openTaskManager`、`activeTaskCount`、`taskManagerLabel`、`accessibleLabel` 四個變數，原本的 `<Tooltip>…</Tooltip>` 換成 `{platformCapabilities.desktopShell && <DesktopTaskButton />}`；若 `SidebarFooter` 刪完後不再使用 `t`，一併刪掉它的 `useTranslation()`。
- 第 237 行 `src="/images/reina.png"` 改為 `src={publicAssetUrl("images/reina.png")}`。
- 第 357 行改為：
```tsx
			{platformCapabilities.desktopShell && (
				<TaskManagerDialog open={taskManagerOpen} onClose={closeTaskManager} />
			)}
```

`src/pages/Detail/DetailPage.tsx`：import 區加入 `import { platformCapabilities } from "@/services/platform";`，存檔分頁的 `<Tab>`（`id="game-tab-3"` 那一個）加上屬性 `disabled={!platformCapabilities.nativePaths}`。分頁索引不變，所以 `TabPanel index={3}` 不用動。

`src/components/Cards/useCardsController.tsx` 第 89 行改為 `saveScrollPosition(path);`（`path` 是第 33 行的 `useLocation().pathname`，已去掉 basename；`window.location.pathname` 在網頁版會多出 `/game`，和 `useScrollRestore("/libraries")` 的鍵對不上）。

- [ ] **Step 19：外部連結改用 `openExternal`，靜態資源改用 `publicAssetUrl`**

以下每個檔案只改 import 那一行，呼叫端的名稱不變（`openExternal` 與 `@tauri-apps/plugin-shell` 的 `open` 簽名相同，都回傳 `Promise<void>`）：
- `src/pages/Settings/AccountSettings.tsx:25`：`import { openExternal as openurl, platformCapabilities, publicAssetUrl } from "@/services/platform";`
- `src/pages/Settings/AboutSettings.tsx:10`：`import { openExternal as openurl, platformCapabilities } from "@/services/platform";`
- `src/pages/Settings/useBgmAuthController.ts:2`：`import { openExternal as openurl, platformCapabilities } from "@/services/platform";`
- `src/pages/Settings/useHikarinagiAuthController.ts:2`：`import { openExternal as openurl, platformCapabilities } from "@/services/platform";`
- `src/components/TaskManagerDialog.tsx:27`：`import { openExternal as openUrl } from "@/services/platform";`

靜態資源：
- `src/pages/Settings/AccountSettings.tsx:49,59,75` 的 `src="/images/…"` 改為 `src={publicAssetUrl("images/bangumi-wordmark.png")}`、`src={publicAssetUrl("images/hikarinagi-wordmark.svg")}`、`src={publicAssetUrl("images/vndb-wordmark.svg")}`。
- `src/utils/game/gameDisplay.ts:47` 改為 `return publicAssetUrl("images/default.png");`，第 55 行的 `"/images/NR18.png"` 改為 `publicAssetUrl("images/NR18.png")`，並在 import 區加入 `import { publicAssetUrl } from "@/services/platform";`。
- `src/pages/Detail/game-info/gameInfoEditData.ts:22` 改為 `return sourceCoverImage ?? publicAssetUrl("images/default.png");`，並加入同樣的 import。

第三方 OAuth（網頁版沒有 deep link 回呼，保留手動 token）：
- `useBgmAuthController.ts` 與 `useHikarinagiAuthController.ts` 的 `handleOAuthLogin` 函式第一行加入：
```ts
		// 网页版没有 deep link 回呼，不支援 OAuth 快捷登录；按钮在网页版也不会显示
		if (!platformCapabilities.desktopShell) return;
```
- `AccountSettings.tsx` 第 307–323 行（BGM 的 OAuth `<Stack>`）包在 `{platformCapabilities.desktopShell && ( … )}` 內；Hikarinagi 區塊中呼叫 `handleOAuthLogin` 的 `<Button>`（約第 592 行）同樣包起來，並在它的位置於網頁版顯示：
```tsx
				{!platformCapabilities.desktopShell && (
					<Typography variant="body2" color="text.secondary">
						{t(
							"components.WebCapability.oauthUnavailable",
							"网页版不支持 OAuth 登录，请使用桌面版登录后再同步。",
						)}
					</Typography>
				)}
```

更新檢查：`AboutSettings.tsx` 第 85–101 行的「檢查更新」`<Button>` 包在 `{platformCapabilities.desktopShell && ( … )}` 內。

- [ ] **Step 20：隱藏桌面專屬的設定分區**

`src/pages/Settings/SettingsPage.tsx`：import 區加入 `import { platformCapabilities } from "@/services/platform";`；`SettingsSection` 型別加入欄位：
```ts
	/** 只有桌面版才有意义的分区（系统、路径与备份） */
	desktopOnly?: boolean;
```
`id: "system"` 與 `id: "storage"` 兩個分區物件各加上 `desktopOnly: true,`；`useMemo` 的回傳值結尾改為：
```ts
		].filter(
			(section) => !section.desktopOnly || platformCapabilities.desktopShell,
		),
		[t],
```
`PathSettingsModal` 只有「路徑與備份」會打開它，分區隱藏後網頁版不會被開啟，不用另外處理。

- [ ] **Step 21：新增 i18n 字串**

四個語言檔的 `components` 物件內加入以下兩個物件（放在 `"TaskManager"` 之前，維持字母順序）。

`src/locales/zh-CN.json`：
```json
		"WebAuthGate": {
			"description": "ReinaManager 网页版沿用 TeleDrive 的登录。请在 TeleDrive 登录后回到本页。",
			"openTeleDrive": "前往 TeleDrive 登录",
			"retry": "我已登录，重新检查",
			"title": "请先登录 TeleDrive"
		},
		"WebCapability": {
			"oauthUnavailable": "网页版不支持 OAuth 登录，请使用桌面版登录后再同步。"
		},
```
`src/locales/zh-TW.json`：
```json
		"WebAuthGate": {
			"description": "ReinaManager 網頁版沿用 TeleDrive 的登入。請在 TeleDrive 登入後回到本頁。",
			"openTeleDrive": "前往 TeleDrive 登入",
			"retry": "我已登入，重新檢查",
			"title": "請先登入 TeleDrive"
		},
		"WebCapability": {
			"oauthUnavailable": "網頁版不支援 OAuth 登入，請使用桌面版登入後再同步。"
		},
```
`src/locales/en-US.json`：
```json
		"WebAuthGate": {
			"description": "The ReinaManager web version uses your TeleDrive login. Sign in to TeleDrive, then come back to this page.",
			"openTeleDrive": "Sign in to TeleDrive",
			"retry": "I've signed in, check again",
			"title": "Please sign in to TeleDrive first"
		},
		"WebCapability": {
			"oauthUnavailable": "OAuth sign-in is not available on the web. Sign in with the desktop app, then sync."
		},
```
`src/locales/ja-JP.json`：
```json
		"WebAuthGate": {
			"description": "ReinaManager のウェブ版は TeleDrive のログインを使用します。TeleDrive にログインしてから、このページに戻ってください。",
			"openTeleDrive": "TeleDrive にログイン",
			"retry": "ログインしました。再確認する",
			"title": "先に TeleDrive にログインしてください"
		},
		"WebCapability": {
			"oauthUnavailable": "ウェブ版では OAuth ログインを利用できません。デスクトップ版でログインしてから同期してください。"
		},
```

依 `.agents/skills/i18n/SKILL.md` 檢查：
```bash
pnpm i18n:status
pnpm i18n:sync
pnpm i18n:extract
pnpm format
rg "__MISSING__" src/locales
```
Expected：`i18n:status` 四個語言都是 100%；最後的 `rg` 沒有任何輸出。

- [ ] **Step 22：建置驗證**

Run：`pnpm test:web`
Expected：PASS（任務 4、5 的所有測試）。

Run：`pnpm check`
Expected：format、lint、typecheck 全部通過。

Run：`pnpm build`
Expected：成功，輸出到 `dist/`，`dist/index.html` 內的資源路徑是 `./assets/…`（桌面版不變）。

Run：`pnpm build:web`
Expected：成功，輸出到 `dist-web/`。

Run：`rg -c "/game/assets/" dist-web/index.html`
Expected：輸出大於 0 的數字。

Run：`rg -l "__TAURI_INTERNALS__" dist-web/assets`
Expected：可以有輸出（`@tauri-apps/api` 仍被打包），這不是錯誤；重點是 Step 16 的載入測試與實機驗收（計畫 C）證明不會在網頁執行時被呼叫。

- [ ] **Step 23：Commit**

```bash
git add src/services/platform.ts src/services/platform.test.ts src/components/WebAuthGate.tsx src/components/WebAuthGate.test.tsx src/hooks/common/useWebAuthRequired.ts src/hooks/common/useWebAuthRequired.test.ts src/store/appStore.web.test.ts src/services/webImportSmoke.test.ts vite.config.ts package.json .gitignore biome.json src/main.tsx src/App.tsx src/providers/router.tsx src/store/appStore.ts src/pages/Detail/game-info/GameInfoEdit.tsx src/pages/Detail/DetailPage.tsx src/components/Toolbar/Toolbar.tsx src/components/RightMenu/RightMenu.tsx src/components/AppLayout.tsx src/components/Cards/useCardsController.tsx src/pages/Settings/SettingsPage.tsx src/pages/Settings/AccountSettings.tsx src/pages/Settings/AboutSettings.tsx src/pages/Settings/useBgmAuthController.ts src/pages/Settings/useHikarinagiAuthController.ts src/components/TaskManagerDialog.tsx src/utils/game/gameDisplay.ts src/pages/Detail/game-info/gameInfoEditData.ts src/locales/zh-CN.json src/locales/zh-TW.json src/locales/en-US.json src/locales/ja-JP.json
git commit -m "feat(web): run under /game subpath with platform capability gates

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### 任務 6：伺服器 query key 與跨裝置版本輪詢

**Files:**
- Create: `src/hooks/queries/serverKeys.ts`
- Create: `src/hooks/queries/serverKeys.test.ts`
- Create: `src/services/web/version.ts`
- Create: `src/services/web/version.test.ts`
- Create: `src/hooks/queries/useServerVersion.ts`
- Create: `src/hooks/queries/useServerVersion.test.tsx`
- Modify: `src/hooks/queries/useGames.ts:59-71,135,163,177-178,192-193`
- Modify: `src/hooks/queries/useCollections.ts:17-18`
- Modify: `src/hooks/queries/useStats.ts:19-20`
- Modify: `src/hooks/queries/useSettings.ts:27-28`
- Modify: `src/hooks/queries/usePlayStatus.ts:22-25`
- Modify: `src/hooks/queries/useSavedata.ts:28-32`
- Modify: `src/services/game/gameStats.ts:215`
- Modify: `src/components/InstallRequestHandler.tsx:237`
- Modify: `src/main.tsx`（任務 5 改寫後的 `bootstrap` 網頁分支）
- Modify: `src/App.tsx`（掛載 `ServerVersionSync`）
- Modify: `docs/architecture/game-library.md`（「失效规则」之後新增一節）

**Interfaces:**
- Consumes：任務 3 的 `GET /game/api/version → { data_version: number }`（`Cache-Control: no-store`）；任務 4 的 `authenticatedFetch`、`NotLoggedInError`；任務 5 的 `isWebRuntime()`、`bootstrap()`。
- Produces：
  - `src/hooks/queries/serverKeys.ts`
    - `export const SERVER_QUERY_ROOT = ["server"] as const`
    - `export function serverKey<const T extends readonly unknown[]>(...parts: T): readonly ["server", ...T]`
  - `src/services/web/version.ts`：`export function fetchServerVersion(): Promise<number>`
  - `src/hooks/queries/useServerVersion.ts`
    - `export const SERVER_VERSION_POLL_MS = 60_000`
    - `export interface ServerVersionSyncer { check(): Promise<void>; getSyncedVersion(): number | null }`
    - `export function createServerVersionSyncer(client: QueryClient, fetchVersion?: () => Promise<number>): ServerVersionSyncer`
    - `export function primeServerVersion(): Promise<void>`（啟動流程在首屏資料讀取前呼叫一次，只記錄版本）
    - `export function checkServerVersion(): Promise<void>`（綁定 app 的 `queryClient`，給計畫 B 的 bridge 狀態轉換呼叫；尚未成功採樣時會先重新讀取已載入的資料再記錄版本）
    - `export function useServerVersionSync(syncer?: ServerVersionSyncer): void`
  - query key 規則：資料庫來源的 factory `gameKeys`、`collectionKeys`、`statsKeys`、`settingsKeys`、`playStatusKeys`、`saveDataKeys` 的 `all` 都以 `"server"` 開頭；`taskKeys` 維持 `["tasks"]`（桌面安裝任務，不在伺服器上）；bridge 的 query 用 `["bridge", …]`（計畫 B）；版本輪詢不是 query，不佔用任何 key。

- [ ] **Step 1：寫 key 前綴的失敗測試**

`src/hooks/queries/serverKeys.test.ts`（新檔）：
```ts
import { describe, expect, it } from "vitest";
import { collectionKeys } from "./useCollections";
import { gameKeys } from "./useGames";
import { playStatusKeys } from "./usePlayStatus";
import { saveDataKeys } from "./useSavedata";
import { settingsKeys } from "./useSettings";
import { statsKeys } from "./useStats";
import { taskKeys } from "./useTasks";
import { SERVER_QUERY_ROOT, serverKey } from "./serverKeys";

describe("伺服器 query key", () => {
	it("serverKey 在前面加上 server", () => {
		expect(serverKey("games", 1)).toEqual(["server", "games", 1]);
		expect(SERVER_QUERY_ROOT).toEqual(["server"]);
	});

	it("所有資料庫來源的 key 都以 server 開頭", () => {
		const keys = [
			gameKeys.all,
			gameKeys.index(),
			gameKeys.idLists(),
			gameKeys.bgmIds(),
			collectionKeys.all,
			collectionKeys.games(3),
			statsKeys.all,
			statsKeys.gameStats(3),
			settingsKeys.all,
			settingsKeys.allSettings(),
			playStatusKeys.all,
			playStatusKeys.game(3),
			saveDataKeys.all,
			saveDataKeys.backups(3),
			saveDataKeys.backupCount(3),
		];
		for (const key of keys) {
			expect(key[0]).toBe("server");
		}
	});

	it("桌面安裝任務不屬於伺服器資料", () => {
		expect(taskKeys.all[0]).toBe("tasks");
	});
});
```

- [ ] **Step 2：確認失敗**

Run：`pnpm test:web src/hooks/queries/serverKeys.test.ts`
Expected：FAIL，`Failed to resolve import "./serverKeys"`。

- [ ] **Step 3：新增 `serverKeys.ts` 並改寫各 factory**

`src/hooks/queries/serverKeys.ts`（新檔）：
```ts
/**
 * @file 伺服器资料的 Query key 根
 * @description 网页版以资料版本做跨装置同步：版本改变时一次失效 ["server", ...] 下的所有 query。
 * 因此凡是资料来自 reina-server（桌面版则是本机 SQLite）的 key 都必须挂在这个前缀下。
 */

export const SERVER_QUERY_ROOT = ["server"] as const;

export function serverKey<const T extends readonly unknown[]>(
	...parts: T
): readonly ["server", ...T] {
	return ["server", ...parts] as const;
}
```

各 factory 的 `all` 改為（其他衍生 key 本來就從 `all` 展開，不用動）：
- `src/hooks/queries/useGames.ts:60`：`all: serverKey("games"),`
- `src/hooks/queries/useCollections.ts:18`：`all: serverKey("collections"),`
- `src/hooks/queries/useStats.ts:20`：`all: serverKey("stats"),`
- `src/hooks/queries/useSettings.ts:28`：`all: serverKey("settings"),`

以下兩個 factory 的衍生 key 原本是寫死的陣列，改成從 `all` 展開：

`src/hooks/queries/usePlayStatus.ts:22-25`：
```ts
export const playStatusKeys = {
	all: serverKey("playStatus"),
	game: (gameId: number) => [...playStatusKeys.all, "game", gameId] as const,
};
```
`src/hooks/queries/useSavedata.ts:28-32`：
```ts
export const saveDataKeys = {
	all: serverKey("saveData"),
	backups: (gameId: number) =>
		[...saveDataKeys.all, "backups", gameId] as const,
	backupCount: (gameId: number) =>
		[...saveDataKeys.all, "backupCount", gameId] as const,
};
```
這六個檔案都在 import 區加入 `import { serverKey } from "@/hooks/queries/serverKeys";`。

寫死的 key 字面值改用 `serverKey`（不 import 其他 factory，避免 `useGames ↔ useStats`、`gameStats ↔ useStats` 的循環 import）：
- `src/hooks/queries/useGames.ts:135,163,177,192`：`{ queryKey: ["collections"] }` → `{ queryKey: serverKey("collections") }`
- `src/hooks/queries/useGames.ts:178,193`：`{ queryKey: ["stats"] }` → `{ queryKey: serverKey("stats") }`
- `src/services/game/gameStats.ts:215`：`{ queryKey: ["stats"] }` → `{ queryKey: serverKey("stats") }`，並加入 import。
- `src/components/InstallRequestHandler.tsx:237`：`{ queryKey: ["games"] }` → `{ queryKey: serverKey("games") }`，並加入 import。

- [ ] **Step 4：確認通過且沒有殘留的字面 key**

Run：`pnpm test:web src/hooks/queries/serverKeys.test.ts`
Expected：PASS，3 個測試通過。

Run：
```bash
rg -n "queryKey: \[\"(games|collections|stats|settings|playStatus|saveData)\"" src
```
Expected：沒有任何輸出。

Run：`pnpm typecheck`
Expected：無錯誤（`GameCacheKeys` 用的是 `QueryKey`，`["server","games"]` 可以直接指定）。

- [ ] **Step 5：寫 `fetchServerVersion` 的失敗測試**

`src/services/web/version.test.ts`（新檔）：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchServerVersion } from "./version";

const authenticatedFetchMock = vi.fn<
	(input: string, init?: RequestInit) => Promise<Response>
>();
vi.mock("./http", () => ({
	authenticatedFetch: (input: string, init?: RequestInit) =>
		authenticatedFetchMock(input, init),
}));

beforeEach(() => {
	authenticatedFetchMock.mockReset();
});

describe("fetchServerVersion", () => {
	it("以 no-store GET /game/api/version 並回傳 data_version", async () => {
		authenticatedFetchMock.mockResolvedValue(Response.json({ data_version: 42 }));
		await expect(fetchServerVersion()).resolves.toBe(42);
		const [url, init] = authenticatedFetchMock.mock.calls[0];
		expect(url).toBe("/game/api/version");
		expect(init?.method).toBe("GET");
		expect(init?.cache).toBe("no-store");
	});

	it("回應不是整數版本時丟 http_response_parse_failed", async () => {
		authenticatedFetchMock.mockResolvedValue(
			Response.json({ data_version: "42" }),
		);
		await expect(fetchServerVersion()).rejects.toMatchObject({
			code: "http_response_parse_failed",
		});
	});

	it("非 2xx 時丟 server_rpc_failed", async () => {
		authenticatedFetchMock.mockResolvedValue(new Response(null, { status: 500 }));
		await expect(fetchServerVersion()).rejects.toMatchObject({
			code: "server_rpc_failed",
		});
	});
});
```

Run：`pnpm test:web src/services/web/version.test.ts`
Expected：FAIL，`Failed to resolve import "./version"`。

- [ ] **Step 6：實作 `version.ts`**

`src/services/web/version.ts`（新檔）：
```ts
/**
 * @file 伺服器资料版本
 * @description 读取 reina-server 的全域 data_version，供跨装置同步判断是否需要重新读取
 */

import { AppError } from "@/utils/errors";
import { authenticatedFetch } from "./http";

export async function fetchServerVersion(): Promise<number> {
	const response = await authenticatedFetch("/game/api/version", {
		method: "GET",
		// 版本必须每次都问伺服器，不能被浏览器快取
		cache: "no-store",
	});
	if (!response.ok) {
		throw new AppError({
			code: "server_rpc_failed",
			message: `HTTP ${response.status}: version`,
		});
	}
	const body = (await response.json()) as { data_version?: unknown };
	if (
		typeof body.data_version !== "number" ||
		!Number.isInteger(body.data_version)
	) {
		throw new AppError({
			code: "http_response_parse_failed",
			message: "Invalid data_version from reina-server",
		});
	}
	return body.data_version;
}
```

Run：`pnpm test:web src/services/web/version.test.ts`
Expected：PASS，3 個測試通過。

- [ ] **Step 7：寫版本同步器的失敗測試（含手機改 A、電腦改 B）**

`src/hooks/queries/useServerVersion.test.tsx`（新檔）：
```tsx
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotLoggedInError } from "@/services/web/auth";
import { serverKey } from "./serverKeys";
import {
	createServerVersionSyncer,
	SERVER_VERSION_POLL_MS,
	type ServerVersionSyncer,
	useServerVersionSync,
} from "./useServerVersion";

vi.mock("@/services/web/version", () => ({
	fetchServerVersion: vi.fn(async () => 0),
}));

// 模拟 reina-server：只保存资料与全域版本
interface FakeServer {
	version: number;
	games: Record<string, string>;
}

function createClient() {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: Number.POSITIVE_INFINITY,
				gcTime: Number.POSITIVE_INFINITY,
				retry: false,
				refetchOnWindowFocus: false,
				refetchOnReconnect: false,
			},
		},
	});
}

// 让 query 处于 active（有 observer）状态，失效时才会立刻重新读取
function observeGames(client: QueryClient, server: FakeServer) {
	const observer = new QueryObserver(client, {
		queryKey: serverKey("games"),
		queryFn: async () => ({ ...server.games }),
	});
	const unsubscribe = observer.subscribe(() => {});
	return { observer, unsubscribe };
}

describe("createServerVersionSyncer", () => {
	it("啟動採樣（prime）只記錄版本，不失效任何 query", async () => {
		const client = createClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const syncer = createServerVersionSyncer(client, async () => 10);
		await syncer.prime();
		expect(syncer.getSyncedVersion()).toBe(10);
		expect(invalidate).not.toHaveBeenCalled();
	});

	it("啟動採樣失敗後，第一次成功的檢查會先重新讀取已載入的資料，再記錄版本", async () => {
		// 頁面在版本 1 時讀到資料，但啟動採樣失敗；之後另一台裝置改成版本 2
		const server: FakeServer = { version: 1, games: { A: "a0", B: "b0" } };
		const client = createClient();
		const { unsubscribe } = observeGames(client, server);
		let reachable = false;
		const syncer = createServerVersionSyncer(client, async () => {
			if (!reachable) throw new Error("offline");
			return server.version;
		});
		await expect(syncer.prime()).rejects.toThrow("offline");
		await client.fetchQuery({
			queryKey: serverKey("games"),
			queryFn: async () => ({ ...server.games }),
		});
		expect(syncer.getSyncedVersion()).toBeNull();

		server.games.A = "a1";
		server.version = 2;
		reachable = true;
		await syncer.check();
		// 不能把版本 1 的舊資料當成已同步到版本 2
		expect(client.getQueryData(serverKey("games"))).toEqual({ A: "a1", B: "b0" });
		expect(syncer.getSyncedVersion()).toBe(2);
		unsubscribe();
	});

	it("手機改 A（10→11）、電腦改 B（回傳 12）：輪詢後 A、B 都是新值", async () => {
		const server: FakeServer = { version: 10, games: { A: "a0", B: "b0" } };
		const client = createClient();
		const { unsubscribe } = observeGames(client, server);
		await client.fetchQuery({
			queryKey: serverKey("games"),
			queryFn: async () => ({ ...server.games }),
		});
		const syncer = createServerVersionSyncer(client, async () => server.version);
		await syncer.prime(); // 首屏读取前的首次采样
		expect(syncer.getSyncedVersion()).toBe(10);

		// 手机修改 A：伺服器版本 11
		server.games.A = "a1";
		server.version = 11;

		// 电脑修改 B：伺服器回传版本 12，本机只 patch B
		server.games.B = "b1";
		server.version = 12;
		const mutationResponse = { game: "b1", data_version: 12 };
		client.setQueryData<Record<string, string>>(serverKey("games"), (old) => ({
			...(old ?? {}),
			B: mutationResponse.game,
		}));

		// 修改回应里的版本不能推进已同步版本
		expect(syncer.getSyncedVersion()).toBe(10);
		expect(client.getQueryData(serverKey("games"))).toEqual({
			A: "a0",
			B: "b1",
		});

		await syncer.check();
		expect(client.getQueryData(serverKey("games"))).toEqual({
			A: "a1",
			B: "b1",
		});
		expect(syncer.getSyncedVersion()).toBe(12);
		unsubscribe();
	});

	it("只失效 server 前綴，不影響 bridge 與其他 key", async () => {
		const client = createClient();
		client.setQueryData(serverKey("games"), []);
		client.setQueryData(["bridge", "states"], []);
		client.setQueryData(["tasks"], []);
		let version = 1;
		const syncer = createServerVersionSyncer(client, async () => version);
		await syncer.prime();
		version = 2;
		await syncer.check();
		expect(client.getQueryState(serverKey("games"))?.isInvalidated).toBe(true);
		expect(client.getQueryState(["bridge", "states"])?.isInvalidated).toBe(false);
		expect(client.getQueryState(["tasks"])?.isInvalidated).toBe(false);
	});

	it("重新讀取失敗時不推進已同步版本，下一次檢查會再試", async () => {
		const client = createClient();
		let fail = true;
		const observer = new QueryObserver(client, {
			queryKey: serverKey("games"),
			queryFn: async () => {
				if (fail) throw new Error("offline");
				return ["ok"];
			},
		});
		const unsubscribe = observer.subscribe(() => {});
		let version = 5;
		const syncer = createServerVersionSyncer(client, async () => version);
		await syncer.prime();
		version = 6;
		await expect(syncer.check()).rejects.toThrow("offline");
		expect(syncer.getSyncedVersion()).toBe(5);
		fail = false;
		await syncer.check();
		expect(syncer.getSyncedVersion()).toBe(6);
		expect(client.getQueryData(serverKey("games"))).toEqual(["ok"]);
		unsubscribe();
	});

	it("登入失效時不失效任何 query、不推進版本；重新登入後照常同步", async () => {
		const client = createClient();
		client.setQueryData(serverKey("games"), ["cached"]);
		let loggedIn = true;
		let version = 7;
		const syncer = createServerVersionSyncer(client, async () => {
			if (!loggedIn) throw new NotLoggedInError();
			return version;
		});
		await syncer.prime();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		// 背景分页放了很久，token 刷新也失败：检查失败，但画面上的快取资料保持不动
		loggedIn = false;
		version = 8;
		await expect(syncer.check()).rejects.toBeInstanceOf(NotLoggedInError);
		expect(invalidate).not.toHaveBeenCalled();
		expect(syncer.getSyncedVersion()).toBe(7);
		expect(client.getQueryData(serverKey("games"))).toEqual(["cached"]);

		// 使用者回 TeleDrive 登入后，下一次检查补上期间的变更
		loggedIn = true;
		await syncer.check();
		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(syncer.getSyncedVersion()).toBe(8);
	});

	it("同時多次檢查只送出一次版本請求", async () => {
		const client = createClient();
		const fetchVersion = vi.fn(async () => 3);
		const syncer = createServerVersionSyncer(client, fetchVersion);
		await Promise.all([syncer.check(), syncer.check(), syncer.check()]);
		expect(fetchVersion).toHaveBeenCalledTimes(1);
	});
});

describe("useServerVersionSync", () => {
	let visibility: DocumentVisibilityState = "visible";

	beforeEach(() => {
		vi.useFakeTimers();
		visibility = "visible";
		Object.defineProperty(document, "visibilityState", {
			configurable: true,
			get: () => visibility,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function createSpySyncer(): ServerVersionSyncer & {
		check: ReturnType<typeof vi.fn>;
	} {
		return {
			prime: vi.fn(async () => {}),
			check: vi.fn(async () => {}),
			getSyncedVersion: () => 1,
		};
	}

	it("讀取不改版本時，5 分鐘內不會全面失效，且每 60 秒只檢查一次", async () => {
		const client = createClient();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const fetchVersion = vi.fn(async () => 7);
		const syncer = createServerVersionSyncer(client, fetchVersion);
		await syncer.prime(); // 与正式启动流程一致：挂载前已完成首次采样
		fetchVersion.mockClear();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));

		await vi.advanceTimersByTimeAsync(5 * 60_000);

		expect(fetchVersion).toHaveBeenCalledTimes(1 + 5);
		expect(invalidate).not.toHaveBeenCalled();
		unmount();
	});

	it("頁面隱藏時暫停輪詢，回到前景立刻檢查並恢復", async () => {
		const syncer = createSpySyncer();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));
		expect(syncer.check).toHaveBeenCalledTimes(1);

		visibility = "hidden";
		document.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(3 * SERVER_VERSION_POLL_MS);
		expect(syncer.check).toHaveBeenCalledTimes(1);

		visibility = "visible";
		document.dispatchEvent(new Event("visibilitychange"));
		expect(syncer.check).toHaveBeenCalledTimes(2);
		await vi.advanceTimersByTimeAsync(SERVER_VERSION_POLL_MS);
		expect(syncer.check).toHaveBeenCalledTimes(3);
		unmount();
	});

	it("視窗聚焦與重新連線時立刻檢查", () => {
		const syncer = createSpySyncer();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));
		window.dispatchEvent(new Event("focus"));
		window.dispatchEvent(new Event("online"));
		expect(syncer.check).toHaveBeenCalledTimes(3);
		unmount();
	});

	it("卸載後不再檢查", async () => {
		const syncer = createSpySyncer();
		const { unmount } = renderHook(() => useServerVersionSync(syncer));
		unmount();
		window.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(2 * SERVER_VERSION_POLL_MS);
		expect(syncer.check).toHaveBeenCalledTimes(1);
	});
});
```

- [ ] **Step 8：確認失敗**

Run：`pnpm test:web src/hooks/queries/useServerVersion.test.tsx`
Expected：FAIL，`Failed to resolve import "./useServerVersion"`。

- [ ] **Step 9：實作 `useServerVersion.ts`**

`src/hooks/queries/useServerVersion.ts`（新檔）：
```ts
/**
 * @file 跨装置资料版本同步
 * @description 网页版定期读取 reina-server 的 data_version；版本改变时失效所有 ["server", ...] query。
 *
 * 规则（见 spec 3.7）：
 * - 已同步版本只由这里的轮询结果推进，绝不采用写入请求回传的版本；
 *   写入回应的版本可能已包含其他装置同时做的修改，直接采用会让那些修改永远看不到。
 * - 首次采样必须在首屏资料读取之前完成（见 main.tsx），否则中间发生的修改会被跳过。
 * - 只有全部重新读取成功才推进版本；失败时下一次轮询重试。
 */

import type { QueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { queryClient as appQueryClient } from "@/providers/queryClient";
import { fetchServerVersion } from "@/services/web/version";
import { SERVER_QUERY_ROOT } from "./serverKeys";

export const SERVER_VERSION_POLL_MS = 60_000;

export interface ServerVersionSyncer {
	/** 首屏资料读取之前的首次采样：只记录版本，不失效任何 query */
	prime(): Promise<void>;
	check(): Promise<void>;
	getSyncedVersion(): number | null;
}

export function createServerVersionSyncer(
	client: QueryClient,
	fetchVersion: () => Promise<number> = fetchServerVersion,
): ServerVersionSyncer {
	let syncedVersion: number | null = null;
	let inFlight: Promise<void> | null = null;

	// 只有在首屏资料读取之前才能「直接记录版本」：那时还没有任何快取，记录的版本必然不旧于之后读到的资料
	async function runPrime(): Promise<void> {
		const version = await fetchVersion();
		if (syncedVersion === null) syncedVersion = version;
	}

	async function runCheck(): Promise<void> {
		const version = await fetchVersion();
		// 已同步且版本未变：什么都不做。
		// 尚未成功采样（启动时采样失败）：已载入的资料版本未知，不能直接记录，必须先重新读取
		if (syncedVersion !== null && version === syncedVersion) return;

		// 失效后 active query 会立刻重新读取；throwOnError 让读取失败时不推进版本。
		// 先取得版本再重新读取，所以读到的资料一定不旧于 version，之后的修改会让版本再变
		await client.invalidateQueries(
			{ queryKey: SERVER_QUERY_ROOT },
			{ throwOnError: true },
		);
		syncedVersion = version;
	}

	function singleFlight(run: () => Promise<void>): Promise<void> {
		if (!inFlight) {
			inFlight = run().finally(() => {
				inFlight = null;
			});
		}
		return inFlight;
	}

	return {
		prime: () => singleFlight(runPrime),
		check: () => singleFlight(runCheck),
		getSyncedVersion: () => syncedVersion,
	};
}

const appSyncer = createServerVersionSyncer(appQueryClient);

/** 启动时、首屏资料读取之前呼叫一次 */
export function primeServerVersion(): Promise<void> {
	return appSyncer.prime();
}

/** 立刻检查一次（例如本机 bridge 发现游戏结束时，见计画 B） */
export function checkServerVersion(): Promise<void> {
	return appSyncer.check();
}

/**
 * 前景时每 60 秒检查；视窗聚焦、回到前景、重新连线时立刻检查；隐藏时暂停
 */
export function useServerVersionSync(
	syncer: ServerVersionSyncer = appSyncer,
): void {
	useEffect(() => {
		let timer: ReturnType<typeof setInterval> | null = null;

		const safeCheck = () => {
			void syncer.check().catch((error) => {
				console.warn("检查伺服器资料版本失败:", error);
			});
		};
		const startPolling = () => {
			if (timer === null) {
				timer = setInterval(safeCheck, SERVER_VERSION_POLL_MS);
			}
		};
		const stopPolling = () => {
			if (timer !== null) {
				clearInterval(timer);
				timer = null;
			}
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				safeCheck();
				startPolling();
			} else {
				stopPolling();
			}
		};

		window.addEventListener("focus", safeCheck);
		window.addEventListener("online", safeCheck);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		if (document.visibilityState === "visible") {
			safeCheck();
			startPolling();
		}

		return () => {
			stopPolling();
			window.removeEventListener("focus", safeCheck);
			window.removeEventListener("online", safeCheck);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [syncer]);
}
```

- [ ] **Step 10：確認通過**

Run：`pnpm test:web src/hooks/queries/useServerVersion.test.tsx`
Expected：PASS，11 個測試通過。

- [ ] **Step 11：在啟動流程中先採樣、在 App 中掛載輪詢**

`src/main.tsx`（任務 5 版本）的 `bootstrap` 網頁分支改為：
```tsx
	if (isWebRuntime()) {
		const jwt = await readTeleDriveJwt().catch((error) => {
			console.error("读取 TeleDrive 登录凭证失败:", error);
			return null;
		});
		if (!jwt) {
			renderAuthGate();
			return;
		}
		// 首次采样必须早于首屏资料读取，之后的任何修改都会让版本变化而被轮询发现
		try {
			await primeServerVersion();
		} catch (error) {
			if (error instanceof NotLoggedInError) {
				renderAuthGate();
				return;
			}
			// 伺服器暂时无法连线：照常挂载。之后第一次成功的检查会先重新读取已载入的资料，再记录版本
			console.error("首次读取伺服器资料版本失败:", error);
		}
	} else {
```
並在 import 區加入：
```ts
import { primeServerVersion } from "@/hooks/queries/useServerVersion";
import { NotLoggedInError, readTeleDriveJwt } from "@/services/web/auth";
```
（取代任務 5 的 `import { readTeleDriveJwt } from "@/services/web/auth";`。）

`src/App.tsx` 在 import 區加入 `import { useServerVersionSync } from "@/hooks/queries/useServerVersion";`，在 `App` 元件之前加入：
```tsx
// 只负责挂上版本轮询，不渲染任何内容
const ServerVersionSync: React.FC = () => {
	useServerVersionSync();
	return null;
};
```
並在 `<SnackbarUtilsConfigurator />` 之後加入：
```tsx
			{isWebRuntime() && <ServerVersionSync />}
```

- [ ] **Step 12：更新快取規範文件**

`docs/architecture/game-library.md` 在「## 失效规则」一節的清單之後、「## 禁止的做法」之前加入（文件原本是簡體中文，沿用）：
```markdown
## 网页版跨装置同步

网页版有多台装置同时修改同一份资料，另外提供一个全域版本：

- `src/hooks/queries/serverKeys.ts` 的 `serverKey(...)` 是所有伺服器资料 key 的根，`gameKeys`、`collectionKeys`、`statsKeys`、`settingsKeys`、`playStatusKeys`、`saveDataKeys` 都挂在 `["server", ...]` 下。新增来自伺服器的 query 时也必须使用它。
- `src/hooks/queries/useServerVersion.ts` 前景每 60 秒读取 `GET /game/api/version`；版本改变时失效整个 `["server"]` 前缀。这是「不因单个游戏更新而全量 refetch `gameKeys.all`」的**明确例外**：只在其他装置确实改过资料时发生。
- 已同步版本只由轮询结果推进，不采用写入回应里的版本。
- 本机写入仍照上面的规则用 `gameCachePatch.ts` 局部 patch；全量重新读取后，`useGameIndex` 会因 `rawList` 引用改变而重建 `GameIndex`。
- 桌面安装任务（`taskKeys`）与本机 bridge 状态（`["bridge", ...]`）不在这个前缀下，不受版本失效影响。
```

- [ ] **Step 13：全部驗證**

Run：`pnpm test:web`
Expected：PASS（任務 4、5、6 的所有測試）。

Run：`pnpm check`
Expected：format、lint、typecheck 全部通過。

Run：`pnpm build`
Expected：成功（桌面版行為不變；桌面版不會掛載 `ServerVersionSync`，`checkServerVersion` 只在網頁分支呼叫）。

Run：`pnpm build:web`
Expected：成功。

- [ ] **Step 14：Commit**

```bash
git add src/hooks/queries/serverKeys.ts src/hooks/queries/serverKeys.test.ts src/services/web/version.ts src/services/web/version.test.ts src/hooks/queries/useServerVersion.ts src/hooks/queries/useServerVersion.test.tsx src/hooks/queries/useGames.ts src/hooks/queries/useCollections.ts src/hooks/queries/useStats.ts src/hooks/queries/useSettings.ts src/hooks/queries/usePlayStatus.ts src/hooks/queries/useSavedata.ts src/services/game/gameStats.ts src/components/InstallRequestHandler.tsx src/main.tsx src/App.tsx docs/architecture/game-library.md
git commit -m "feat(web): synchronize server queries across devices via data version

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### 任務 7：封面服務與 Blob 生命週期

目標：伺服器以 SHA-256 版本化儲存與提供封面（來源封面由伺服器下載、自訂封面由使用者上傳），前端以帶 Bearer 的 `fetch` 取得 Blob、由 React Query 快取 Blob、每個元件自行建立與撤銷 object URL；所有顯示封面的地方在 Web 執行環境改走這條路徑，桌面版維持原狀。

**Files:**
- Create: `reina-server/src/upstream.rs`（只有宣告）
- Create: `reina-server/src/upstream/policy.rs`（來源 host 表、圖床 host 後綴表、限速數值）
- Create: `reina-server/src/upstream/target.rs`（URL 驗證、DNS 解析與私有網段拒絕、測試用覆寫）
- Create: `reina-server/src/upstream/fetch.rs`（固定解析位址的 client、同 host 轉址、大小上限）
- Create: `reina-server/src/api/covers.rs`（只有宣告）
- Create: `reina-server/src/api/covers/sniff.rs`
- Create: `reina-server/src/api/covers/store.rs`
- Create: `reina-server/src/api/covers/handlers.rs`
- Modify: `reina-server/src/lib.rs`（加 `pub mod upstream;`）
- Modify: `reina-server/src/api.rs`（加 `pub mod covers;` 與 `.merge(covers::handlers::routes())`）
- Modify: `reina-server/src/config.rs`（加 `upstream_overrides` 欄位，僅程式內設定；`from_lookup`、`for_tests`、`Debug` 同步）
- Modify: `reina-server/src/api/rpc/handler.rs`（`run_write` 在 commit 成功後清理被刪遊戲的封面目錄）
- Modify: `reina-server/tests/support.rs`（加 `TestApp::seed_source_cover`）
- Modify: `reina-core/src/database/repository/games_repository.rs`（`CoverState`、`find_cover_state`、`set_cover_hashes_in_connection`：三個封面欄位的唯一寫入點）
- Test: `reina-server/tests/covers.rs`、`reina-core/tests/cover_state.rs`
- Create: `src/services/web/covers.ts`、`src/services/web/covers.test.ts`
- Create: `src/hooks/queries/useCoverUrl.ts`、`src/hooks/queries/useCoverUrl.test.tsx`
- Create: `src/hooks/features/games/useGameCoverSrc.ts`、`src/hooks/features/games/useGameCoverSrc.test.tsx`
- Create: `src/components/GameCover/GameCoverImg.tsx`、`src/components/GameCover/index.ts`
- Modify: `src/components/Cards/CardItem.tsx:46`、`src/pages/Detail/DetailPage.tsx:266`、`src/pages/Stats/StatisticsRanking.tsx:59`、`src/pages/Home/homeData.ts:12-80`、`src/pages/Home/ActivityPanel.tsx:161-164`、`src/pages/Home/RandomGamePanel.tsx:62-66`、`src/pages/Home/FocusGamePanel.tsx:84-111,266`
- Modify: `src/pages/Detail/game-info/useImagePreview.ts`、`src/pages/Detail/game-info/gameInfoEditData.ts`、`src/pages/Detail/game-info/GameInfoEdit.tsx:167-176,360-385,555-625`
- Modify: `src/locales/*/`（新增文案）

**Interfaces:**
- Consumes：
  - 任務 2：games 表欄位 `source_cover_hash TEXT NULL`、`custom_cover_hash TEXT NULL`、`cover_version TEXT NULL`（entity 欄位 `games::Column::SourceCoverHash / CustomCoverHash / CoverVersion`）；TS `GameData.cover_version?: string | null`。
  - 任務 3：`AppState { db: DatabaseConnection, config: Arc<Config>, http: reqwest::Client, fault: Arc<tx::CommitFault> }`；`crate::api::auth::AuthUser { user_id: i64, token: String }` extractor；`crate::error::ApiError::new(StatusCode, &'static str, impl Into<String>)`、`ApiError::internal(msg)` 與 `impl From<DbErr> for ApiError`；`crate::tx::begin(db: &DatabaseConnection) -> Result<DatabaseTransaction, ApiError>` 與 `crate::tx::finish<T>(state: &AppState, txn, result: Result<T, ApiError>, bump: impl FnOnce(&T) -> bool) -> Result<T, ApiError>`（`bump` 為 true 時在同一 transaction 內 `VersionRepository::bump` 後 commit；失敗或注入故障時 rollback）；`Config::for_tests()`；`api/rpc/handler.rs` 的 `run_write(state, command, args)` 與 `WriteCommand::{DeleteGame, DeleteGamesBatch}`；整合測試共用模組 `tests/support.rs`：`TestApp::{new, with_config, owner_token, data_dir, insert_game, fail_next_write_commit, send, rpc, data_version}`、`TestResponse { status, headers, body }`（`json()`、`text()`）。
  - 任務 4：`authenticatedFetch(input: string, init?: RequestInit): Promise<Response>`（`src/services/web/http.ts`）。
  - 任務 5：`isWebRuntime(): boolean`（`src/services/platform.ts`）；Web 模式 `import.meta.env.BASE_URL === "/game/"`。
  - 任務 6：伺服器 query key 一律以 `"server"` 開頭。
- Produces：
  - Rust：`reina_server::upstream::policy::{SourcePolicy, SOURCE_POLICIES, IMAGE_HOST_SUFFIXES, policy_for_host(host: &str) -> Option<&'static SourcePolicy>, is_image_host(host: &str) -> bool}`；`reina_server::upstream::target::{Target, resolve_target(url: &str, config: &Config, allow: HostRule) -> Result<Target, UpstreamError>}`；`reina_server::upstream::fetch::{fetch_bytes(target: &Target, config: &Config, req: UpstreamRequest, max_bytes: usize) -> Result<UpstreamResponse, UpstreamError>}`（任務 8 使用）。
  - Rust：`reina_server::api::covers::sniff::{ImageKind, sniff(bytes: &[u8]) -> Option<ImageKind>}`（任務 8 圖片代理使用）。
  - HTTP：`GET /game/api/covers/{game_id}?v=<hash>`、`PUT /game/api/covers/{game_id}`（body 為圖片位元組）、`DELETE /game/api/covers/{game_id}`、`POST /game/api/covers/{game_id}/source`（body `{ "url": string | null }`）；後三者回應 `{ "cover_version": string | null }`。
  - Core：`GamesRepository::find_cover_state(conn: &impl ConnectionTrait, id: i32) -> Result<Option<CoverState>, DbErr>`；`GamesRepository::set_cover_hashes_in_connection(conn: &impl ConnectionTrait, id: i32, source: Option<Option<String>>, custom: Option<Option<String>>) -> Result<Option<String>, DbErr>`（回傳新的 `cover_version`）。
  - TS：`getCoverBlob(gameId: number, version: string, signal?: AbortSignal): Promise<Blob>`、`uploadCustomCover(gameId: number, file: Blob): Promise<CoverVersionResponse>`、`deleteCustomCover(gameId: number): Promise<CoverVersionResponse>`、`setSourceCover(gameId: number, url: string | null): Promise<CoverVersionResponse>`，`CoverVersionResponse = { cover_version: string | null }`。
  - TS：`coverKeys.cover(gameId, version)` = `["server", "cover", gameId, version]`；`COVER_GC_TIME = 30 * 60_000`；`useCoverUrl(gameId: number, version: string | null): string | undefined`。
  - TS：`useGameCoverSrc(game: GameData | undefined, replaceNsfwCover?: boolean): string`；元件 `<GameCoverImg game replaceNsfwCover? {...imgProps} />`（任務 9 的待確認清單使用）。

#### 7A：伺服器端

- [ ] **Step 1：寫圖片格式判斷的失敗測試**

建立 `reina-server/src/api/covers/sniff.rs`，先只放測試：

```rust
//! 依檔頭判斷圖片格式。只接受瀏覽器能顯示的常見格式，
//! 不依賴 `image` crate 的解碼功能（專案只開了 png feature）。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 認得常見格式() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]), Some(ImageKind::Jpeg));
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n0000"), Some(ImageKind::Png));
        assert_eq!(sniff(b"GIF89a000000"), Some(ImageKind::Gif));
        assert_eq!(sniff(b"RIFF\x10\x00\x00\x00WEBPVP8 "), Some(ImageKind::Webp));
        assert_eq!(sniff(b"BM\x00\x00\x00\x00\x00\x00"), Some(ImageKind::Bmp));
        assert_eq!(sniff(b"\x00\x00\x00\x1cftypavif0000"), Some(ImageKind::Avif));
    }

    #[test]
    fn 拒絕非圖片與過短內容() {
        assert_eq!(sniff(b"<html>not an image</html>"), None);
        assert_eq!(sniff(b"RIFF\x10\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff(&[0xFF, 0xD8]), None);
        assert_eq!(sniff(&[]), None);
    }

    #[test]
    fn 副檔名與_mime_對應() {
        assert_eq!(ImageKind::Jpeg.ext(), "jpg");
        assert_eq!(ImageKind::Webp.mime(), "image/webp");
        assert_eq!(ImageKind::from_ext("png"), Some(ImageKind::Png));
        assert_eq!(ImageKind::from_ext("exe"), None);
    }
}
```

`reina-server/src/api/covers.rs`：

```rust
pub mod handlers;
pub mod sniff;
pub mod store;
```

`reina-server/src/api.rs` 加一行 `pub mod covers;`（路由等 Step 9 再接）。暫時建立空的 `handlers.rs`、`store.rs`（內容各一行註解 `//! 見任務 7 Step 5 / Step 9`，下一步即會填入）。

- [ ] **Step 2：執行確認失敗**

Run: `cargo test -p reina-server --lib api::covers::sniff`
Expected: 編譯失敗，`cannot find function 'sniff'`、`cannot find type 'ImageKind'`。

- [ ] **Step 3：實作 `sniff`**

在 `sniff.rs` 測試模組上方加入：

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Jpeg,
    Png,
    Gif,
    Webp,
    Bmp,
    Avif,
}

impl ImageKind {
    pub fn ext(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
            Self::Avif => "avif",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Bmp => "image/bmp",
            Self::Avif => "image/avif",
        }
    }

    pub fn from_ext(ext: &str) -> Option<Self> {
        match ext {
            "jpg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "gif" => Some(Self::Gif),
            "webp" => Some(Self::Webp),
            "bmp" => Some(Self::Bmp),
            "avif" => Some(Self::Avif),
            _ => None,
        }
    }
}

pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    if bytes.len() < 8 {
        return None;
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageKind::Jpeg);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageKind::Png);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    if bytes.starts_with(b"BM") {
        return Some(ImageKind::Bmp);
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") {
        return Some(ImageKind::Avif);
    }
    None
}
```

- [ ] **Step 4：確認通過**

Run: `cargo test -p reina-server --lib api::covers::sniff`
Expected: 3 passed。

- [ ] **Step 5：寫封面檔案儲存的失敗測試**

`reina-server/src/api/covers/store.rs`：

```rust
//! 封面檔案存放在 `<data_dir>/covers/game_<id>/<sha256>.<ext>`。
//! 同一內容永遠對應同一檔名，所以寫入是冪等的；
//! 失敗清理只能刪除「本次請求新建立」的檔案，避免誤刪其他請求正在引用的同 hash 檔案。

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::covers::sniff::ImageKind;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake-png-body";

    #[tokio::test]
    async fn 寫入後可以依_hash_讀回() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let staged = store.put(7, PNG, ImageKind::Png).await.unwrap();
        assert!(staged.created);
        assert_eq!(staged.hash.len(), 64);
        let (bytes, kind) = store.open(7, &staged.hash).await.unwrap().unwrap();
        assert_eq!(bytes, PNG);
        assert_eq!(kind, ImageKind::Png);
        assert!(dir.path().join("covers/game_7").join(format!("{}.png", staged.hash)).exists());
    }

    #[tokio::test]
    async fn 重複寫入同內容不算新建_discard_不刪既有檔() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let first = store.put(7, PNG, ImageKind::Png).await.unwrap();
        let second = store.put(7, PNG, ImageKind::Png).await.unwrap();
        assert_eq!(first.hash, second.hash);
        assert!(!second.created);
        store.discard(7, &second).await;
        assert!(store.open(7, &first.hash).await.unwrap().is_some());
        store.discard(7, &first).await;
        assert!(store.open(7, &first.hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn 清理只保留仍被引用的_hash() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let a = store.put(3, PNG, ImageKind::Png).await.unwrap();
        let b = store.put(3, b"\xFF\xD8\xFFjpeg-body", ImageKind::Jpeg).await.unwrap();
        store.retain_only(3, &[a.hash.as_str()]).await;
        assert!(store.open(3, &a.hash).await.unwrap().is_some());
        assert!(store.open(3, &b.hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn 同一個遊戲的鎖互斥_不同遊戲互不影響() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        let held = store.lock_game(1).await;
        // 同一個遊戲：持有期間拿不到
        let same = tokio::time::timeout(std::time::Duration::from_millis(50), store.lock_game(1)).await;
        assert!(same.is_err(), "同一個遊戲的第二把鎖不應該在第一把釋放前取得");
        // 不同遊戲：立刻拿得到
        let other = tokio::time::timeout(std::time::Duration::from_millis(50), store.lock_game(2)).await;
        assert!(other.is_ok());
        drop(held);
        let again = tokio::time::timeout(std::time::Duration::from_millis(50), store.lock_game(1)).await;
        assert!(again.is_ok(), "釋放後應該能再取得");
    }

    #[tokio::test]
    async fn 不存在的遊戲或_hash_回傳_none() {
        let dir = tempfile::tempdir().unwrap();
        let store = CoverStore::new(dir.path().join("covers"));
        assert!(store.open(99, &"0".repeat(64)).await.unwrap().is_none());
        assert!(store.open(99, "../../etc/passwd").await.unwrap().is_none());
    }
}
```

`reina-server/Cargo.toml` 的 `[dev-dependencies]` 加 `tempfile = "3"`（若任務 3 已加則略過）；`[dependencies]` 加 `sha2 = "0.11.0"`（與 `src-tauri/Cargo.toml` 同版本）。

- [ ] **Step 6：執行確認失敗**

Run: `cargo test -p reina-server --lib api::covers::store`
Expected: 編譯失敗，`cannot find type 'CoverStore'`。

- [ ] **Step 7：實作 `CoverStore`**

在 `store.rs` 測試模組上方加入：

```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use sha2::{Digest, Sha256};
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};

use crate::api::covers::sniff::ImageKind;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

/// 每个游戏的封面目录一把锁。「写档 → commit → 清理」必须整段串行：
/// 否则 A 请求 commit 后的 retain_only 会删掉 B 请求刚写好、尚未 commit 的档案，
/// 或 B commit 失败时 discard 掉 A 已经引用的同 hash 档案。
/// 以目录路径为键（测试各自用不同的 tempdir，互不干扰）；单人使用，游戏数量有限，不回收。
static GAME_LOCKS: LazyLock<StdMutex<HashMap<PathBuf, Arc<AsyncMutex<()>>>>> = LazyLock::new(Default::default);

#[derive(Debug, Clone)]
pub struct StagedCover {
    pub hash: String,
    pub kind: ImageKind,
    /// 這次呼叫是否真的新建立了檔案；只有新建的才允許在失敗時刪除。
    pub created: bool,
}

#[derive(Debug, Clone)]
pub struct CoverStore {
    root: PathBuf,
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}

fn is_hash(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

impl CoverStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn game_dir(&self, game_id: i32) -> PathBuf {
        self.root.join(format!("game_{game_id}"))
    }

    /// 取得该游戏封面的独占锁；持有期间才能呼叫 put / discard / retain_only / remove_game
    pub async fn lock_game(&self, game_id: i32) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = GAME_LOCKS.lock().expect("cover lock map poisoned");
            locks.entry(self.game_dir(game_id)).or_default().clone()
        };
        lock.lock_owned().await
    }

    pub async fn put(&self, game_id: i32, bytes: &[u8], kind: ImageKind) -> std::io::Result<StagedCover> {
        let hash = sha256_hex(bytes);
        let dir = self.game_dir(game_id);
        tokio::fs::create_dir_all(&dir).await?;
        let target = dir.join(format!("{hash}.{}", kind.ext()));
        if tokio::fs::try_exists(&target).await? {
            return Ok(StagedCover { hash, kind, created: false });
        }
        // 先寫到本請求獨佔的暫存檔再 rename，避免讀者看到寫一半的檔案
        let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
        let temp = dir.join(format!(".{hash}.{}.{seq}.tmp", std::process::id()));
        tokio::fs::write(&temp, bytes).await?;
        match tokio::fs::rename(&temp, &target).await {
            Ok(()) => Ok(StagedCover { hash, kind, created: true }),
            Err(error) => {
                let _ = tokio::fs::remove_file(&temp).await;
                if tokio::fs::try_exists(&target).await.unwrap_or(false) {
                    // 另一個請求同時寫入了相同內容
                    Ok(StagedCover { hash, kind, created: false })
                } else {
                    Err(error)
                }
            }
        }
    }

    pub async fn discard(&self, game_id: i32, staged: &StagedCover) {
        if staged.created {
            let path = self.game_dir(game_id).join(format!("{}.{}", staged.hash, staged.kind.ext()));
            let _ = tokio::fs::remove_file(path).await;
        }
    }

    pub async fn open(&self, game_id: i32, hash: &str) -> std::io::Result<Option<(Vec<u8>, ImageKind)>> {
        if !is_hash(hash) {
            return Ok(None);
        }
        let dir = self.game_dir(game_id);
        let mut entries = match tokio::fs::read_dir(&dir).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            let Some((stem, ext)) = name.rsplit_once('.') else { continue };
            if stem == hash
                && let Some(kind) = ImageKind::from_ext(ext)
            {
                return Ok(Some((tokio::fs::read(entry.path()).await?, kind)));
            }
        }
        Ok(None)
    }

    /// 刪除不在 `keep` 裡的封面檔；只在 commit 成功之後呼叫。
    pub async fn retain_only(&self, game_id: i32, keep: &[&str]) {
        let Ok(mut entries) = tokio::fs::read_dir(self.game_dir(game_id)).await else {
            return;
        };
        while let Ok(Some(entry)) = entries.next_entry().await {
            let name = entry.file_name();
            let Some(name) = name.to_str() else { continue };
            if name.starts_with('.') {
                continue; // 其他請求的暫存檔
            }
            let stem = name.rsplit_once('.').map(|(stem, _)| stem).unwrap_or(name);
            if !keep.contains(&stem) {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }

    /// 删除整个游戏的封面目录；只在删除游戏的 transaction commit 成功之后呼叫。
    pub async fn remove_game(&self, game_id: i32) {
        match tokio::fs::remove_dir_all(self.game_dir(game_id)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => log::warn!("清理游戏 {game_id} 的封面目录失败: {error}"),
        }
    }
}
```

- [ ] **Step 8：確認通過**

Run: `cargo test -p reina-server --lib api::covers::store`
Expected: 5 passed。

- [ ] **Step 9：寫上游網址驗證（私有網段、白名單）的失敗測試**

`reina-server/src/upstream.rs`：

```rust
pub mod fetch;
pub mod policy;
pub mod target;
```

`reina-server/src/lib.rs` 加 `pub mod upstream;`。

`reina-server/src/upstream/policy.rs`（先放測試）：

```rust
//! 伺服器代為連線的外部來源。數值必須與 `src/metadata/api/rateLimit.ts`
//! 的 API_RATE_LIMIT_POLICIES 一致，host 必須與 `src/metadata/api/*.ts` 實際使用的一致。

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 依_host_找到來源與限速() {
        assert_eq!(policy_for_host("api.vndb.org").unwrap().source, "vndb");
        assert_eq!(policy_for_host("vndb.org").unwrap().source, "vndb");
        assert_eq!(policy_for_host("api.bgm.tv").unwrap().min_interval_ms, 250);
        assert_eq!(policy_for_host("bgm.tv").unwrap().source, "bgm");
        assert_eq!(policy_for_host("www.ymgal.games").unwrap().min_interval_ms, 500);
        assert_eq!(policy_for_host("www.kungal.com").unwrap().source, "kun");
        assert_eq!(policy_for_host("www.dlsite.com").unwrap().min_interval_ms, 2000);
        assert_eq!(policy_for_host("erogamescape.org").unwrap().min_interval_ms, 3000);
        assert_eq!(policy_for_host("api.hikarinagi.org").unwrap().source, "hikarinagi");
        assert_eq!(policy_for_host("www.hikarinagi.org").unwrap().source, "hikarinagi");
        assert!(policy_for_host("evil.example.com").is_none());
        assert!(policy_for_host("vndb.org.evil.com").is_none());
    }

    #[test]
    fn 只有_vndb_允許_429_重試() {
        let vndb = policy_for_host("api.vndb.org").unwrap();
        assert_eq!(vndb.max_429_retries, 2);
        assert_eq!(vndb.default_backoff_ms, 30_000);
        assert_eq!(vndb.max_backoff_ms, 300_000);
        for source in ["bgm", "ymgal", "kun", "dlsite", "erogamescape", "hikarinagi"] {
            let policy = SOURCE_POLICIES.iter().find(|p| p.source == source).unwrap();
            assert_eq!(policy.max_429_retries, 0, "{source}");
        }
    }

    #[test]
    fn 圖床_host_以後綴比對() {
        for host in ["lain.bgm.tv", "t.vndb.org", "cdn.ymgal.games", "img.dlsite.jp", "www.dlsite.com", "erogamescape.org", "img.kungal.com", "cdn.hikarinagi.org"] {
            assert!(is_image_host(host), "{host}");
        }
        for host in ["bgm.tv.evil.com", "evilvndb.org", "localhost", "127.0.0.1", "example.com"] {
            assert!(!is_image_host(host), "{host}");
        }
    }
}
```

`reina-server/src/upstream/target.rs`（先放測試）：

```rust
//! 驗證伺服器要代為連線的網址：只允許 http(s)、白名單 host、公開 IP。
//! DNS 解析結果會被固定下來交給 client，避免「驗證時是公開 IP、連線時變成內網」的 DNS rebinding。

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    #[test]
    fn 私有與保留位址都算不公開() {
        for ip in ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "255.255.255.255", "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(!is_public_ip(ip), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(is_public_ip(ip), "{ip}");
        }
    }

    #[tokio::test]
    async fn 拒絕非_http_與不在白名單的_host() {
        let config = crate::config::Config::for_tests();
        assert!(matches!(resolve_target("file:///etc/passwd", &config, HostRule::MetadataApi).await, Err(UpstreamError::Forbidden(_))));
        assert!(matches!(resolve_target("https://example.com/", &config, HostRule::MetadataApi).await, Err(UpstreamError::Forbidden(_))));
        assert!(matches!(resolve_target("https://127.0.0.1/", &config, HostRule::Image).await, Err(UpstreamError::Forbidden(_))));
        assert!(matches!(resolve_target("https://user:pw@api.vndb.org/kana", &config, HostRule::MetadataApi).await, Err(UpstreamError::Forbidden(_))));
    }

    #[tokio::test]
    async fn 測試覆寫會改寫到本機且保留路徑與查詢() {
        let mut config = crate::config::Config::for_tests();
        config.upstream_overrides.insert("api.vndb.org".into(), "127.0.0.1:40001".parse().unwrap());
        let target = resolve_target("https://api.vndb.org/kana/vn?x=1", &config, HostRule::MetadataApi).await.unwrap();
        assert_eq!(target.request_url.as_str(), "http://127.0.0.1:40001/kana/vn?x=1");
        assert_eq!(target.host, "api.vndb.org");
        assert_eq!(target.policy.unwrap().source, "vndb");
    }
}
```

`reina-server/src/config.rs`（任務 3 建立）加一個欄位，**不從環境變數讀取**，只給測試用。三處都要改：

1. `pub struct Config` 在 `pub static_dir: PathBuf,` 之後加入：

```rust
    /// 测试用：把指定的上游 host 导向本机假伺服器。正式环境永远是空的，不从环境变数读取。
    pub upstream_overrides: std::collections::HashMap<String, std::net::SocketAddr>,
```

2. `Config::from_lookup` 的 `Ok(Self { … })` 在 `static_dir: …,` 之後加入 `upstream_overrides: std::collections::HashMap::new(),`；`Config::for_tests()` 的 `Self { … }` 在 `static_dir: …,` 之後同樣加入 `upstream_overrides: std::collections::HashMap::new(),`。

3. `impl fmt::Debug for Config` 在 `.field("static_dir", &self.static_dir)` 之後加入 `.field("upstream_overrides", &self.upstream_overrides)`。

同檔測試模組的 `必填欄位齊全時套用預設值` 最後加一行，守住「正式設定永遠沒有覆寫」：

```rust
        assert!(config.upstream_overrides.is_empty());
```

- [ ] **Step 10：執行確認失敗**

Run: `cargo test -p reina-server --lib upstream`
Expected: 編譯失敗，`cannot find function 'policy_for_host'`、`cannot find function 'resolve_target'`。

- [ ] **Step 11：實作 policy 與 target**

`policy.rs` 測試模組上方：

```rust
#[derive(Debug)]
pub struct SourcePolicy {
    pub source: &'static str,
    pub hosts: &'static [&'static str],
    pub min_interval_ms: u64,
    pub max_429_retries: u32,
    pub default_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

pub static SOURCE_POLICIES: &[SourcePolicy] = &[
    SourcePolicy { source: "vndb", hosts: &["api.vndb.org", "vndb.org"], min_interval_ms: 1600, max_429_retries: 2, default_backoff_ms: 30_000, max_backoff_ms: 300_000 },
    SourcePolicy { source: "bgm", hosts: &["api.bgm.tv", "bgm.tv"], min_interval_ms: 250, max_429_retries: 0, default_backoff_ms: 0, max_backoff_ms: 0 },
    SourcePolicy { source: "ymgal", hosts: &["www.ymgal.games"], min_interval_ms: 500, max_429_retries: 0, default_backoff_ms: 0, max_backoff_ms: 0 },
    SourcePolicy { source: "kun", hosts: &["www.kungal.com"], min_interval_ms: 500, max_429_retries: 0, default_backoff_ms: 0, max_backoff_ms: 0 },
    SourcePolicy { source: "dlsite", hosts: &["www.dlsite.com"], min_interval_ms: 2000, max_429_retries: 0, default_backoff_ms: 0, max_backoff_ms: 0 },
    SourcePolicy { source: "erogamescape", hosts: &["erogamescape.org"], min_interval_ms: 3000, max_429_retries: 0, default_backoff_ms: 0, max_backoff_ms: 0 },
    SourcePolicy { source: "hikarinagi", hosts: &["api.hikarinagi.org", "www.hikarinagi.org"], min_interval_ms: 500, max_429_retries: 0, default_backoff_ms: 0, max_backoff_ms: 0 },
];

/// 封面與候選預覽圖可以來自這些網域（含子網域）。
/// Kungal、Hikarinagi 的圖床子網域目前未公開文件，因此以網域後綴放行。
pub static IMAGE_HOST_SUFFIXES: &[&str] = &[
    "bgm.tv", "vndb.org", "ymgal.games", "kungal.com", "hikarinagi.org", "dlsite.jp", "dlsite.com", "erogamescape.org",
];

/// 桌面版在 `src-tauri/src/game/cover/cloud.rs` 對 Bangumi/VNDB 圖床另有備援代理；伺服器下載來源封面時沿用。
pub const BANGUMI_IMAGE_PROXY_PREFIX: &str = "https://imagesp.yurari.moe/bangumi/";
pub const VNDB_IMAGE_PROXY_PREFIX: &str = "https://imagesp.yurari.moe/vndb/";

pub fn policy_for_host(host: &str) -> Option<&'static SourcePolicy> {
    SOURCE_POLICIES.iter().find(|policy| policy.hosts.contains(&host))
}

pub fn is_image_host(host: &str) -> bool {
    IMAGE_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}
```

`target.rs` 測試模組上方：

```rust
use std::net::{IpAddr, SocketAddr};

use url::Url;

use crate::config::Config;
use crate::upstream::policy::{is_image_host, policy_for_host, SourcePolicy};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostRule {
    /// 中繼資料 API：host 必須在 SOURCE_POLICIES。
    MetadataApi,
    /// 圖片：host 必須符合 IMAGE_HOST_SUFFIXES，或是桌面版使用的 yurari 備援代理。
    Image,
}

#[derive(Debug, thiserror::Error)]
pub enum UpstreamError {
    #[error("forbidden upstream: {0}")]
    Forbidden(String),
    #[error("upstream unreachable: {0}")]
    Unreachable(String),
    #[error("upstream response too large")]
    TooLarge,
}

#[derive(Debug, Clone)]
pub struct Target {
    /// 實際送出的網址（測試覆寫時會變成 http://127.0.0.1:port/...）
    pub request_url: Url,
    /// 原本的 host，用來比對白名單與轉址
    pub host: String,
    pub policy: Option<&'static SourcePolicy>,
    /// 固定的解析結果；None 代表測試覆寫，直接連 request_url
    pub pinned: Option<Vec<SocketAddr>>,
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

fn host_allowed(host: &str, rule: HostRule) -> bool {
    match rule {
        HostRule::MetadataApi => policy_for_host(host).is_some(),
        HostRule::Image => is_image_host(host) || host == "imagesp.yurari.moe",
    }
}

pub async fn resolve_target(raw: &str, config: &Config, rule: HostRule) -> Result<Target, UpstreamError> {
    let url = Url::parse(raw).map_err(|_| UpstreamError::Forbidden("invalid url".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UpstreamError::Forbidden("scheme".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UpstreamError::Forbidden("credentials in url".into()));
    }
    let host = url.host_str().ok_or_else(|| UpstreamError::Forbidden("host".into()))?.to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok() || !host_allowed(&host, rule) {
        return Err(UpstreamError::Forbidden(host));
    }
    let policy = policy_for_host(&host);

    if let Some(addr) = config.upstream_overrides.get(&host) {
        let mut request_url = url.clone();
        request_url.set_scheme("http").map_err(|_| UpstreamError::Forbidden("scheme".into()))?;
        request_url.set_host(Some(&addr.ip().to_string())).map_err(|_| UpstreamError::Forbidden("host".into()))?;
        request_url.set_port(Some(addr.port())).map_err(|_| UpstreamError::Forbidden("port".into()))?;
        return Ok(Target { request_url, host, policy, pinned: None });
    }

    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|error| UpstreamError::Unreachable(error.to_string()))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err(UpstreamError::Forbidden(format!("{host} resolves to a non-public address")));
    }
    Ok(Target { request_url: url, host, policy, pinned: Some(addrs) })
}
```

`reina-server/Cargo.toml` `[dependencies]` 補 `url = "2.5.8"`、`thiserror = "2"`（若任務 3 已有則略過）。

- [ ] **Step 12：確認通過**

Run: `cargo test -p reina-server --lib upstream`
Expected: 6 passed（policy 3、target 3）。

- [ ] **Step 13：寫上游下載（轉址、大小上限、不外洩標頭）的失敗測試**

`reina-server/src/upstream/fetch.rs`（先放測試）：

```rust
//! 對單一 Target 發出請求。轉址最多 3 次，而且只允許同一個 host；
//! 超過大小上限就中止；請求標頭只會帶呼叫端明確交進來的內容。

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{routing::get, Router, http::HeaderMap};
    use std::sync::{Arc, Mutex};

    async fn spawn(router: Router) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        addr
    }

    fn config_with(host: &str, addr: std::net::SocketAddr) -> crate::config::Config {
        let mut config = crate::config::Config::for_tests();
        config.upstream_overrides.insert(host.into(), addr);
        config
    }

    #[tokio::test]
    async fn 只轉送指定標頭() {
        let seen: Arc<Mutex<Option<HeaderMap>>> = Arc::default();
        let seen2 = seen.clone();
        let addr = spawn(Router::new().route("/kana/vn", get(move |headers: HeaderMap| {
            *seen2.lock().unwrap() = Some(headers);
            async { "ok" }
        }))).await;
        let config = config_with("api.vndb.org", addr);
        let target = crate::upstream::target::resolve_target("https://api.vndb.org/kana/vn", &config, HostRule::MetadataApi).await.unwrap();
        let request = UpstreamRequest {
            method: reqwest::Method::GET,
            headers: vec![("accept".into(), "application/json".into()), ("x-forwarded-for".into(), "1.2.3.4".into())],
            body: None,
        };
        let response = fetch_bytes(&target, &config, request, 1024).await.unwrap();
        assert_eq!(response.status, 200);
        let headers = seen.lock().unwrap().clone().unwrap();
        assert_eq!(headers.get("accept").unwrap(), "application/json");
        assert!(headers.get("x-forwarded-for").is_none());
        assert!(headers.get("authorization").is_none());
    }

    #[tokio::test]
    async fn 超過上限回傳_too_large() {
        let addr = spawn(Router::new().route("/big", get(|| async { vec![b'x'; 2048] }))).await;
        let config = config_with("t.vndb.org", addr);
        let target = crate::upstream::target::resolve_target("https://t.vndb.org/big", &config, HostRule::Image).await.unwrap();
        let result = fetch_bytes(&target, &config, UpstreamRequest::get(), 1024).await;
        assert!(matches!(result, Err(UpstreamError::TooLarge)));
    }

    #[tokio::test]
    async fn 拒絕跨_host_轉址_允許同_host_轉址() {
        let addr = spawn(Router::new()
            .route("/same", get(|| async { axum::response::Redirect::temporary("/final") }))
            .route("/final", get(|| async { "final" }))
            .route("/cross", get(|| async { axum::response::Redirect::temporary("https://evil.example.com/x") })))
            .await;
        let config = config_with("t.vndb.org", addr);
        let same = crate::upstream::target::resolve_target("https://t.vndb.org/same", &config, HostRule::Image).await.unwrap();
        assert_eq!(fetch_bytes(&same, &config, UpstreamRequest::get(), 1024).await.unwrap().body, b"final");
        let cross = crate::upstream::target::resolve_target("https://t.vndb.org/cross", &config, HostRule::Image).await.unwrap();
        assert!(matches!(fetch_bytes(&cross, &config, UpstreamRequest::get(), 1024).await, Err(UpstreamError::Forbidden(_))));
    }
}
```

- [ ] **Step 14：執行確認失敗**

Run: `cargo test -p reina-server --lib upstream::fetch`
Expected: 編譯失敗，`cannot find function 'fetch_bytes'`、`cannot find struct 'UpstreamRequest'`。

- [ ] **Step 15：實作 `fetch_bytes`**

`fetch.rs` 測試模組上方：

```rust
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{redirect, Method};

use crate::config::Config;
pub use crate::upstream::target::{HostRule, UpstreamError};
use crate::upstream::target::{resolve_target, Target};

/// 允許轉送給上游的請求標頭（小寫）。其他一律丟棄，
/// 尤其是瀏覽器送給我們的 TeleDrive Authorization——它從來不會進到這裡。
const FORWARDED_HEADERS: &[&str] = &[
    "accept", "accept-language", "authorization", "content-type", "cookie", "user-agent", "version", "referer", "x-requested-with",
];
const MAX_REDIRECTS: usize = 3;
const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone)]
pub struct UpstreamRequest {
    pub method: Method,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

impl UpstreamRequest {
    pub fn get() -> Self {
        Self { method: Method::GET, headers: Vec::new(), body: None }
    }
}

#[derive(Debug, Clone)]
pub struct UpstreamResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

fn client_for(target: &Target) -> Result<reqwest::Client, UpstreamError> {
    let mut builder = reqwest::Client::builder()
        .redirect(redirect::Policy::none())
        .timeout(UPSTREAM_TIMEOUT)
        .user_agent(concat!("ReinaManager-Server/", env!("CARGO_PKG_VERSION")));
    if let Some(addrs) = &target.pinned {
        builder = builder.resolve_to_addrs(&target.host, addrs);
    }
    builder.build().map_err(|error| UpstreamError::Unreachable(error.to_string()))
}

pub async fn fetch_bytes(target: &Target, config: &Config, request: UpstreamRequest, max_bytes: usize) -> Result<UpstreamResponse, UpstreamError> {
    let mut current = target.clone();
    for _ in 0..=MAX_REDIRECTS {
        let client = client_for(&current)?;
        let mut builder = client.request(request.method.clone(), current.request_url.clone());
        for (name, value) in &request.headers {
            let name = name.to_ascii_lowercase();
            if FORWARDED_HEADERS.contains(&name.as_str()) {
                builder = builder.header(name, value);
            }
        }
        if let Some(body) = &request.body {
            builder = builder.body(body.clone());
        }
        let response = builder.send().await.map_err(|error| UpstreamError::Unreachable(error.to_string()))?;
        let status = response.status();
        if status.is_redirection()
            && let Some(location) = response.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok())
        {
            // 以原始（未覆寫）的網址為基準解析相對轉址，再重新驗證
            let original = original_url(&current);
            let next = original.join(location).map_err(|_| UpstreamError::Forbidden("bad redirect".into()))?;
            if next.host_str().map(|h| h.to_ascii_lowercase()) != Some(current.host.clone()) {
                return Err(UpstreamError::Forbidden("cross-host redirect".into()));
            }
            let rule = if current.policy.is_some() { HostRule::MetadataApi } else { HostRule::Image };
            current = resolve_target(next.as_str(), config, rule).await?;
            continue;
        }
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| *name != reqwest::header::SET_COOKIE)
            .filter_map(|(name, value)| value.to_str().ok().map(|v| (name.as_str().to_string(), v.to_string())))
            .collect();
        let mut body = Vec::new();
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|error| UpstreamError::Unreachable(error.to_string()))?;
            if body.len() + chunk.len() > max_bytes {
                return Err(UpstreamError::TooLarge);
            }
            body.extend_from_slice(&chunk);
        }
        return Ok(UpstreamResponse { status: status.as_u16(), headers, body });
    }
    Err(UpstreamError::Forbidden("too many redirects".into()))
}

fn original_url(target: &Target) -> url::Url {
    let mut url = target.request_url.clone();
    if target.pinned.is_none() {
        // 測試覆寫：把 host 換回原本的名稱，讓相對轉址的 host 比對有意義
        let _ = url.set_host(Some(&target.host));
        let _ = url.set_scheme("https");
        let _ = url.set_port(None);
    }
    url
}
```

`reina-server/Cargo.toml` 的 reqwest 需要 `stream` feature，並加 `futures-util = "0.3"`（若任務 3 未開，於此補上；版本與任務 3 的 reqwest 一致）。

- [ ] **Step 16：確認通過**

Run: `cargo test -p reina-server --lib upstream::fetch`
Expected: 3 passed。

- [ ] **Step 17：寫 core 封面欄位存取的失敗測試**

封面三個欄位（`source_cover_hash`、`custom_cover_hash`、`cover_version`）由任務 2 的 migration `m20260926_000020_web_library` 建立，**本任務不新增 migration**；本任務提供唯一的寫入點 `set_cover_hashes_in_connection`。原本任務 2 的「cover_version 只能由專用函式設定」測試移到這裡（第 4 個測試）。

`reina-core/tests/cover_state.rs`：

```rust
//! 封面欄位只能透過 set_cover_hashes_in_connection 寫入；自訂封面優先於來源封面。
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use reina_core::database::connect_database;
use reina_core::database::dto::{InsertGameData, UpdateGameData};
use reina_core::database::repository::games_repository::GamesRepository;
use sea_orm::{DatabaseConnection, DbErr, TransactionTrait};
use serde_json::json;

fn unique_dir(name: &str) -> PathBuf {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!(
        "reina_core_cover_{}_{}_{}",
        name,
        std::process::id(),
        nanos
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

async fn database(name: &str) -> DatabaseConnection {
    connect_database(&unique_dir(name).join("reina_manager.db")).await.unwrap()
}

/// InsertGameData 沒有 Default；與任務 2 的測試相同，用 JSON 建立
async fn insert_game(db: &DatabaseConnection) -> i32 {
    let data: InsertGameData = serde_json::from_value(json!({ "id_type": "custom" })).unwrap();
    GamesRepository::insert(db, data).await.unwrap().id
}

#[tokio::test]
async fn 自訂封面優先於來源封面_清除自訂後回到來源() {
    let db = database("priority").await;
    let id = insert_game(&db).await;

    let txn = db.begin().await.unwrap();
    let version = GamesRepository::set_cover_hashes_in_connection(&txn, id, Some(Some("a".repeat(64))), None)
        .await
        .unwrap();
    txn.commit().await.unwrap();
    assert_eq!(version.as_deref(), Some("a".repeat(64).as_str()));

    let txn = db.begin().await.unwrap();
    let version = GamesRepository::set_cover_hashes_in_connection(&txn, id, None, Some(Some("b".repeat(64))))
        .await
        .unwrap();
    txn.commit().await.unwrap();
    assert_eq!(version.as_deref(), Some("b".repeat(64).as_str()));

    let state = GamesRepository::find_cover_state(&db, id).await.unwrap().unwrap();
    assert_eq!(state.current(), Some("b".repeat(64).as_str()));

    let txn = db.begin().await.unwrap();
    let version = GamesRepository::set_cover_hashes_in_connection(&txn, id, None, Some(None))
        .await
        .unwrap();
    txn.commit().await.unwrap();
    assert_eq!(version.as_deref(), Some("a".repeat(64).as_str()));
}

#[tokio::test]
async fn rollback_後封面欄位不變() {
    let db = database("rollback").await;
    let id = insert_game(&db).await;
    let txn = db.begin().await.unwrap();
    GamesRepository::set_cover_hashes_in_connection(&txn, id, Some(Some("c".repeat(64))), None)
        .await
        .unwrap();
    txn.rollback().await.unwrap();
    let state = GamesRepository::find_cover_state(&db, id).await.unwrap().unwrap();
    assert_eq!(state.current(), None);
}

#[tokio::test]
async fn 不存在的遊戲() {
    let db = database("missing").await;
    assert!(GamesRepository::find_cover_state(&db, 404).await.unwrap().is_none());
    let error = GamesRepository::set_cover_hashes_in_connection(&db, 404, Some(None), None)
        .await
        .unwrap_err();
    assert!(matches!(error, DbErr::RecordNotFound(_)));
}

#[tokio::test]
async fn cover_version_只能由封面函式設定() {
    let db = database("only_setter").await;
    // 客戶端 DTO 沒有 cover_version：多送的欄位被忽略
    let data: InsertGameData =
        serde_json::from_value(json!({ "id_type": "custom", "cover_version": "evil" })).unwrap();
    let stored = GamesRepository::insert(&db, data).await.unwrap();
    assert_eq!(stored.cover_version, None);

    let updates: UpdateGameData = serde_json::from_value(json!({ "cover_version": "evil" })).unwrap();
    let updated = GamesRepository::update(&db, stored.id, updates).await.unwrap();
    assert_eq!(updated.cover_version, None);

    let txn = db.begin().await.unwrap();
    GamesRepository::set_cover_hashes_in_connection(&txn, stored.id, Some(Some("d".repeat(64))), None)
        .await
        .unwrap();
    txn.commit().await.unwrap();
    let reloaded = GamesRepository::find_by_id(&db, stored.id).await.unwrap().unwrap();
    assert_eq!(reloaded.cover_version.as_deref(), Some("d".repeat(64).as_str()));
}
```

> 若任務 2 的 `InsertGameData` / `UpdateGameData` 標了 `#[serde(deny_unknown_fields)]`，第 4 個測試的兩處 `from_value` 會失敗；那是任務 2 的設計，請改成不帶 `cover_version` 的 JSON，只保留「insert／update 後仍為 None」與「setter 之後有值」兩個斷言。

- [ ] **Step 18：執行確認失敗**

Run: `cargo test -p reina-core --test cover_state`
Expected: 編譯失敗，`no function or associated item named 'set_cover_hashes_in_connection' found for struct 'GamesRepository'`。

- [ ] **Step 19：實作 core 函式**

在 `reina-core/src/database/repository/games_repository.rs` 的 `impl GamesRepository` 內（`// ==================== 游戏 CRUD 操作 ====================` 區塊之後）加入，檔案頂端補 `use sea_orm::{ActiveModelTrait, ConnectionTrait, EntityTrait, Set};`（已有的不重複）：

```rust
    pub async fn find_cover_state(
        conn: &impl ConnectionTrait,
        id: i32,
    ) -> Result<Option<CoverState>, DbErr> {
        Ok(games::Entity::find_by_id(id).one(conn).await?.map(|model| CoverState {
            source_hash: model.source_cover_hash,
            custom_hash: model.custom_cover_hash,
        }))
    }

    /// 封面三个栏位的唯一写入点。`None` 代表不修改该栏位，`Some(None)` 代表清除。
    /// 回传写入后的 cover_version（自定义封面优先）。游戏不存在时回传 RecordNotFound。
    pub async fn set_cover_hashes_in_connection(
        conn: &impl ConnectionTrait,
        id: i32,
        source: Option<Option<String>>,
        custom: Option<Option<String>>,
    ) -> Result<Option<String>, DbErr> {
        let model = games::Entity::find_by_id(id)
            .one(conn)
            .await?
            .ok_or_else(|| DbErr::RecordNotFound(format!("game {id}")))?;
        let next_source = source.unwrap_or(model.source_cover_hash.clone());
        let next_custom = custom.unwrap_or(model.custom_cover_hash.clone());
        let version = next_custom.clone().or_else(|| next_source.clone());
        let mut active: games::ActiveModel = model.into();
        active.source_cover_hash = Set(next_source);
        active.custom_cover_hash = Set(next_custom);
        active.cover_version = Set(version.clone());
        active.update(conn).await?;
        Ok(version)
    }
```

在同檔（`impl` 之外）加入：

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoverState {
    pub source_hash: Option<String>,
    pub custom_hash: Option<String>,
}

impl CoverState {
    pub fn current(&self) -> Option<&str> {
        self.custom_hash.as_deref().or(self.source_hash.as_deref())
    }
}
```

- [ ] **Step 20：確認通過**

Run: `cargo test -p reina-core --test cover_state`
Expected: 3 passed。

- [ ] **Step 21：寫封面 API 的失敗整合測試**

`reina-server/tests/covers.rs`：

```rust
mod support;

use axum::body::Body;
use axum::http::{header, Method, Request, StatusCode};
use support::TestApp;

const PNG: &[u8] = b"\x89PNG\r\n\x1a\ncover-one";
const JPG: &[u8] = b"\xFF\xD8\xFF\xE0cover-two";

async fn put_cover(app: &TestApp, id: i32, bytes: &'static [u8]) -> (StatusCode, serde_json::Value) {
    let request = Request::builder()
        .method(Method::PUT)
        .uri(format!("/game/api/covers/{id}"))
        .header(header::AUTHORIZATION, format!("Bearer {}", app.owner_token()))
        .header(header::CONTENT_TYPE, "application/octet-stream")
        .body(Body::from(bytes))
        .unwrap();
    let response = app.send(request).await;
    let status = response.status;
    let body = response.body.clone();
    (status, serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null))
}

async fn get_cover(app: &TestApp, id: i32, v: &str) -> support::TestResponse {
    app.send(
        Request::builder()
            .uri(format!("/game/api/covers/{id}?v={v}"))
            .header(header::AUTHORIZATION, format!("Bearer {}", app.owner_token()))
            .body(Body::empty())
            .unwrap(),
    )
    .await
}

#[tokio::test]
async fn 未登入被拒() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let response = app.send(Request::builder().uri(format!("/game/api/covers/{id}?v=x")).body(Body::empty()).unwrap()).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn 上傳後以版本網址取得且快取為_immutable() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let before = app.data_version().await;
    let (status, json) = put_cover(&app, id, PNG).await;
    assert_eq!(status, StatusCode::OK);
    let version = json["cover_version"].as_str().unwrap().to_string();
    assert_eq!(app.data_version().await, before + 1);

    let response = get_cover(&app, id, &version).await;
    assert_eq!(response.status, StatusCode::OK);
    assert_eq!(response.headers[header::CACHE_CONTROL], "private, max-age=31536000, immutable");
    assert_eq!(response.headers[header::CONTENT_TYPE], "image/png");
    assert_eq!(response.headers[header::ETAG], format!("\"{version}\""));
    assert_eq!(response.body.clone().as_ref(), PNG);
}

#[tokio::test]
async fn 舊版本回_302_到目前版本且_no_store() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let (_, first) = put_cover(&app, id, PNG).await;
    let (_, second) = put_cover(&app, id, JPG).await;
    let old = first["cover_version"].as_str().unwrap();
    let new = second["cover_version"].as_str().unwrap();
    let response = get_cover(&app, id, old).await;
    assert_eq!(response.status, StatusCode::FOUND);
    assert_eq!(response.headers[header::LOCATION], format!("/game/api/covers/{id}?v={new}"));
    assert_eq!(response.headers[header::CACHE_CONTROL], "no-store");
}

#[tokio::test]
async fn 非圖片_415_超過上限_413_版本都不變() {
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
async fn 刪除自訂封面後回到來源封面() {
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
                .header(header::AUTHORIZATION, format!("Bearer {}", app.owner_token()))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK);
    let json: serde_json::Value = serde_json::from_slice(&response.body.clone()).unwrap();
    assert_eq!(json["cover_version"].as_str().unwrap(), source_version);
}

#[tokio::test]
async fn 寫入_transaction_失敗時新檔被刪除且舊封面仍可取得() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    let (_, first) = put_cover(&app, id, PNG).await;
    let first = first["cover_version"].as_str().unwrap().to_string();
    app.fail_next_write_commit(); // 任務 3 測試工具：讓下一次 tx::finish 在 commit 前 rollback 並回 500
    let (status, _) = put_cover(&app, id, JPG).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    let covers_dir = app.data_dir().join(format!("covers/game_{id}"));
    let files: Vec<_> = std::fs::read_dir(&covers_dir).unwrap().filter_map(|e| e.ok()).collect();
    assert_eq!(files.len(), 1, "只剩原本的封面檔");
    assert_eq!(get_cover(&app, id, &first).await.status, StatusCode::OK);
}

#[tokio::test]
async fn 刪除遊戲在_commit_成功後才清除封面目錄() {
    let app = TestApp::new().await;
    let id = app.insert_game("Foo").await;
    put_cover(&app, id, PNG).await;
    let covers_dir = app.data_dir().join(format!("covers/game_{id}"));
    assert!(covers_dir.exists());

    app.fail_next_write_commit();
    let failed = app.rpc("delete_game", serde_json::json!({ "id": id })).await;
    assert_eq!(failed.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert!(covers_dir.exists(), "commit 失敗時封面必須保留");

    let deleted = app.rpc("delete_game", serde_json::json!({ "id": id })).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert!(!covers_dir.exists());
}

#[tokio::test]
async fn 批次刪除遊戲也會清除每個封面目錄() {
    let app = TestApp::new().await;
    let a = app.insert_game("A").await;
    let b = app.insert_game("B").await;
    put_cover(&app, a, PNG).await;
    put_cover(&app, b, JPG).await;
    let deleted = app.rpc("delete_games_batch", serde_json::json!({ "ids": [a, b] })).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    for id in [a, b] {
        assert!(!app.data_dir().join(format!("covers/game_{id}")).exists());
    }
}

#[tokio::test]
async fn 不存在的遊戲回_404() {
    let app = TestApp::new().await;
    let (status, _) = put_cover(&app, 999, PNG).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(get_cover(&app, 999, "x").await.status, StatusCode::NOT_FOUND);
}

/// 依 302 的 Location 找到目前版本並取得；回傳最終狀態碼
async fn get_current_cover(app: &TestApp, id: i32, any_version: &str) -> StatusCode {
    let first = get_cover(app, id, any_version).await;
    if first.status != StatusCode::FOUND {
        return first.status;
    }
    let location = first.headers[header::LOCATION].to_str().unwrap().to_string();
    let current = location.rsplit_once("v=").map(|(_, v)| v.to_string()).unwrap();
    get_cover(app, id, &current).await.status
}

#[tokio::test]
async fn 同一個遊戲並行更換封面_目前封面的檔案一定存在() {
    // A、B 同時上傳不同圖片：沒有逐遊戲的鎖時，先 commit 的一方清理舊檔會刪掉
    // 另一方剛寫好、尚未 commit 的檔案，之後資料庫會指向不存在的檔案
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
```

`reina-server/Cargo.toml` `[dev-dependencies]` 補 `http-body-util = "0.1"`（若任務 3 已有則略過）。

- [ ] **Step 22：執行確認失敗**

Run: `cargo test -p reina-server --test covers`
Expected: 編譯通過但全部 FAIL（路由不存在，回 404）；若 `TestApp::seed_source_cover` 尚不存在則編譯失敗——此輔助函式在 Step 23 一起加入 `reina-server/tests/support.rs`。

- [ ] **Step 23：實作封面路由**

`reina-server/src/api/covers/handlers.rs`：

```rust
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use reina_core::database::repository::games_repository::GamesRepository;

use crate::api::auth::AuthUser;
use crate::api::covers::sniff::{sniff, ImageKind};
use crate::api::covers::store::{CoverStore, StagedCover};
use crate::app::AppState;
use crate::error::ApiError;
use crate::tx;
use crate::upstream::fetch::{fetch_bytes, UpstreamRequest};
use crate::upstream::policy::{BANGUMI_IMAGE_PROXY_PREFIX, VNDB_IMAGE_PROXY_PREFIX};
use crate::upstream::target::{resolve_target, HostRule};

pub const MAX_COVER_BYTES: usize = 10 * 1024 * 1024;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route(
            "/covers/{game_id}",
            get(get_cover).put(put_custom_cover).delete(delete_custom_cover),
        )
        .route("/covers/{game_id}/source", post(set_source_cover))
        // 多留一點給 HTTP 框架本身，實際上限在 handler 內精確判斷
        .layer(DefaultBodyLimit::max(MAX_COVER_BYTES + 1))
}

pub fn cover_store(state: &AppState) -> CoverStore {
    CoverStore::new(state.config.data_dir.join("covers"))
}

#[derive(Deserialize)]
pub struct VersionQuery {
    v: Option<String>,
}

#[derive(Serialize)]
pub struct CoverVersionResponse {
    cover_version: Option<String>,
}

async fn get_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
    Query(query): Query<VersionQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let cover = GamesRepository::find_cover_state(&state.db, game_id)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "game_not_found", "game not found"))?;
    let Some(current) = cover.current() else {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "cover_not_found", "game has no cover"));
    };
    if query.v.as_deref() != Some(current) {
        let location = format!("/game/api/covers/{game_id}?v={current}");
        return Ok((
            StatusCode::FOUND,
            [(header::LOCATION, location), (header::CACHE_CONTROL, "no-store".to_string())],
        )
            .into_response());
    }
    let etag = format!("\"{current}\"");
    if headers.get(header::IF_NONE_MATCH).and_then(|v| v.to_str().ok()) == Some(etag.as_str()) {
        return Ok((StatusCode::NOT_MODIFIED, [(header::ETAG, etag)]).into_response());
    }
    let (bytes, kind) = cover_store(&state)
        .open(game_id, current)
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "cover_read_failed", error.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "cover_file_missing", "cover file missing"))?;
    let mut response = bytes.into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind.mime()));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=31536000, immutable"));
    headers.insert(header::ETAG, HeaderValue::from_str(&etag).expect("hex etag"));
    Ok(response)
}

/// 把已寫好的檔案切換成遊戲的封面：資料庫更新與版本遞增在同一個 transaction。
/// commit 失敗就刪掉本次新建的檔案；commit 成功才清理已不被引用的舊檔。
async fn commit_cover_change(
    state: &AppState,
    game_id: i32,
    staged: Option<StagedCover>,
    source: Option<Option<String>>,
    custom: Option<Option<String>>,
) -> Result<CoverVersionResponse, ApiError> {
    let store = cover_store(state);
    let result = async {
        let txn = tx::begin(&state.db).await?;
        let changed = GamesRepository::set_cover_hashes_in_connection(&txn, game_id, source, custom)
            .await
            .map_err(|error| match error {
                sea_orm::DbErr::RecordNotFound(_) => ApiError::new(StatusCode::NOT_FOUND, "game_not_found", "game not found"),
                other => ApiError::from(other),
            });
        // 封面有变更就递增 data_version，让其他装置换成新的封面网址
        tx::finish(state, txn, changed, |_| true).await
    }
    .await;
    match result {
        Ok(cover_version) => {
            if let Some(state_after) = GamesRepository::find_cover_state(&state.db, game_id).await? {
                let keep: Vec<&str> = [state_after.source_hash.as_deref(), state_after.custom_hash.as_deref()].into_iter().flatten().collect();
                store.retain_only(game_id, &keep).await;
            }
            Ok(CoverVersionResponse { cover_version })
        }
        Err(error) => {
            if let Some(staged) = staged {
                store.discard(game_id, &staged).await;
            }
            Err(error)
        }
    }
}

async fn stage_image(state: &AppState, game_id: i32, bytes: &[u8]) -> Result<StagedCover, ApiError> {
    if bytes.len() > MAX_COVER_BYTES {
        return Err(ApiError::new(StatusCode::PAYLOAD_TOO_LARGE, "cover_too_large", "cover exceeds 10 MiB"));
    }
    let kind: ImageKind = sniff(bytes).ok_or_else(|| ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "cover_not_image", "unsupported image"))?;
    if GamesRepository::find_cover_state(&state.db, game_id).await?.is_none() {
        return Err(ApiError::new(StatusCode::NOT_FOUND, "game_not_found", "game not found"));
    }
    cover_store(state)
        .put(game_id, bytes, kind)
        .await
        .map_err(|error| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "cover_write_failed", error.to_string()))
}

async fn put_custom_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
    body: Bytes,
) -> Result<Json<CoverVersionResponse>, ApiError> {
    // 写档到清理整段持锁，见 CoverStore::lock_game
    let _guard = cover_store(&state).lock_game(game_id).await;
    let staged = stage_image(&state, game_id, &body).await?;
    let hash = staged.hash.clone();
    Ok(Json(commit_cover_change(&state, game_id, Some(staged), None, Some(Some(hash))).await?))
}

async fn delete_custom_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
) -> Result<Json<CoverVersionResponse>, ApiError> {
    let _guard = cover_store(&state).lock_game(game_id).await;
    Ok(Json(commit_cover_change(&state, game_id, None, None, Some(None)).await?))
}

#[derive(Deserialize)]
pub struct SourceCoverBody {
    url: Option<String>,
}

/// 依桌面版 `build_cover_download_candidates` 的順序：Bangumi 先走代理、VNDB 先走原址。
fn download_candidates(url: &str) -> Vec<String> {
    let host = url::Url::parse(url).ok().and_then(|u| u.host_str().map(str::to_string));
    match host.as_deref() {
        Some("lain.bgm.tv") => vec![format!("{BANGUMI_IMAGE_PROXY_PREFIX}{url}"), url.to_string()],
        Some("t.vndb.org") => vec![url.to_string(), format!("{VNDB_IMAGE_PROXY_PREFIX}{url}")],
        _ => vec![url.to_string()],
    }
}

async fn set_source_cover(
    _user: AuthUser,
    State(state): State<AppState>,
    Path(game_id): Path<i32>,
    Json(body): Json<SourceCoverBody>,
) -> Result<Json<CoverVersionResponse>, ApiError> {
    let Some(url) = body.url.filter(|u| !u.trim().is_empty()) else {
        let _guard = cover_store(&state).lock_game(game_id).await;
        return Ok(Json(commit_cover_change(&state, game_id, None, Some(None), None).await?));
    };
    // 網路下載在寫入 transaction 之外完成，不占用 SQLite 的寫鎖
    let mut last_error = None;
    for candidate in download_candidates(&url) {
        let target = match resolve_target(&candidate, &state.config, HostRule::Image).await {
            Ok(target) => target,
            Err(error) => {
                last_error = Some(error.to_string());
                continue;
            }
        };
        match fetch_bytes(&target, &state.config, UpstreamRequest::get(), MAX_COVER_BYTES).await {
            Ok(response) if (200..300).contains(&response.status) => {
                // 下载在锁外完成（可能很慢），只有写档到清理这一段持锁
                let _guard = cover_store(&state).lock_game(game_id).await;
                let staged = stage_image(&state, game_id, &response.body).await?;
                let hash = staged.hash.clone();
                return Ok(Json(commit_cover_change(&state, game_id, Some(staged), Some(Some(hash)), None).await?));
            }
            Ok(response) => last_error = Some(format!("HTTP {}", response.status)),
            Err(error) => last_error = Some(error.to_string()),
        }
    }
    Err(ApiError::new(
        StatusCode::BAD_GATEWAY,
        "cover_download_failed",
        last_error.unwrap_or_else(|| "no candidate".into()),
    ))
}
```

`reina-server/src/api.rs` 的路由彙總加 `.merge(covers::handlers::routes())`。

刪除遊戲時清理封面目錄：修改任務 3 的 `reina-server/src/api/rpc/handler.rs`，把 `run_write` 換成下面的版本，並在同檔加入 `deleted_game_ids`（桌面版的 `delete_game`／`delete_games_batch` 也會刪封面目錄；網頁版必須等 commit 成功才刪，否則 rollback 後會留下沒有封面的遊戲）：

```rust
async fn run_write(
    state: &AppState,
    command: WriteCommand,
    args: Value,
) -> Result<Value, ApiError> {
    let deleted_ids = deleted_game_ids(&command, &args);
    let txn = tx::begin(&state.db).await?;
    let result = write::dispatch_write(&txn, command, args).await;
    let value = tx::finish(state, txn, result, |_| true).await?;
    // commit 已成功才清理封面档；清理失败只记录警告，不影响已完成的删除
    if !deleted_ids.is_empty() {
        let store = crate::api::covers::handlers::cover_store(state);
        for id in deleted_ids {
            // 与进行中的封面更换串行，避免对方写档后才被整个目录删掉之外的交错
            let _guard = store.lock_game(id).await;
            store.remove_game(id).await;
        }
    }
    Ok(value)
}

/// 从参数取出将被删除的游戏 ID；参数不合法时回传空，交给 dispatch_write 回报 400
fn deleted_game_ids(command: &WriteCommand, args: &Value) -> Vec<i32> {
    let as_id = |value: &Value| value.as_i64().and_then(|id| i32::try_from(id).ok());
    match command {
        WriteCommand::DeleteGame => args.get("id").and_then(as_id).into_iter().collect(),
        WriteCommand::DeleteGamesBatch => args
            .get("ids")
            .and_then(Value::as_array)
            .map(|ids| ids.iter().filter_map(as_id).collect())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}
```

`reina-server/tests/support.rs`（任務 3 建立的整合測試共用模組；`data_dir()` 任務 3 已提供）在檔尾補一個只給封面測試用的輔助函式：

```rust
impl TestApp {
    /// 直接寫入一張來源封面（不經網路），回傳 cover_version。
    pub async fn seed_source_cover(&self, game_id: i32, bytes: &[u8]) -> String {
        let kind = reina_server::api::covers::sniff::sniff(bytes).expect("image");
        let staged = reina_server::api::covers::handlers::cover_store(&self.state)
            .put(game_id, bytes, kind)
            .await
            .unwrap();
        let txn = sea_orm::TransactionTrait::begin(&self.state.db).await.unwrap();
        reina_core::database::repository::games_repository::GamesRepository::set_cover_hashes_in_connection(&txn, game_id, Some(Some(staged.hash.clone())), None)
            .await
            .unwrap();
        txn.commit().await.unwrap();
        staged.hash
    }
}
```

- [ ] **Step 24：確認通過**

Run: `cargo test -p reina-server --test covers`
Expected: 10 passed。

Run: `cargo clippy -p reina-server -- -D warnings`
Expected: 無警告。

#### 7B：前端

- [ ] **Step 25：寫封面 service 的失敗測試**

`src/services/web/covers.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { authenticatedFetch } = vi.hoisted(() => ({
	authenticatedFetch: vi.fn(),
}));
vi.mock("@/services/web/http", () => ({ authenticatedFetch }));

import {
	deleteCustomCover,
	getCoverBlob,
	setSourceCover,
	uploadCustomCover,
} from "./covers";

describe("covers service", () => {
	beforeEach(() => authenticatedFetch.mockReset());

	it("以版本網址取得 Blob", async () => {
		const blob = new Blob(["x"], { type: "image/png" });
		authenticatedFetch.mockResolvedValue(new Response(blob, { status: 200 }));
		const result = await getCoverBlob(7, "abc", undefined);
		expect(authenticatedFetch).toHaveBeenCalledWith(
			"/game/api/covers/7?v=abc",
			{ signal: undefined },
		);
		expect(await result.text()).toBe("x");
	});

	it("非 2xx 丟出錯誤", async () => {
		authenticatedFetch.mockResolvedValue(new Response("", { status: 404 }));
		await expect(getCoverBlob(7, "abc")).rejects.toThrow(/404/);
	});

	it("上傳、刪除、設定來源封面回傳新版本", async () => {
		authenticatedFetch.mockImplementation(
			async () =>
				new Response(JSON.stringify({ cover_version: "v2" }), { status: 200 }),
		);
		const file = new Blob(["img"], { type: "image/png" });
		await expect(uploadCustomCover(7, file)).resolves.toEqual({ cover_version: "v2" });
		expect(authenticatedFetch).toHaveBeenLastCalledWith("/game/api/covers/7", {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: file,
		});
		await deleteCustomCover(7);
		expect(authenticatedFetch).toHaveBeenLastCalledWith("/game/api/covers/7", { method: "DELETE" });
		await setSourceCover(7, "https://t.vndb.org/cv/1.jpg");
		expect(authenticatedFetch).toHaveBeenLastCalledWith("/game/api/covers/7/source", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://t.vndb.org/cv/1.jpg" }),
		});
	});
});
```

測試環境的 `import.meta.env.BASE_URL` 需為 `/game/`：任務 4 的 `vitest.config.ts` 設 `base: "/game/"`（見文末「給執行者的備註」）。

- [ ] **Step 26：執行確認失敗**

Run: `pnpm test:web src/services/web/covers.test.ts`
Expected: FAIL，`Failed to resolve import "./covers"`。

- [ ] **Step 27：實作 `src/services/web/covers.ts`**

```ts
/**
 * @file 網頁版封面 service
 * @description 封面由 reina-server 以內容 hash 版本化提供；<img> 無法帶 Authorization，
 * 所以一律用帶 Bearer 的 fetch 取得 Blob，再由呼叫端轉成 object URL。
 */

import { authenticatedFetch } from "@/services/web/http";
import { AppError } from "@/utils/errors";

export interface CoverVersionResponse {
	cover_version: string | null;
}

const coverUrl = (gameId: number) =>
	`${import.meta.env.BASE_URL}api/covers/${gameId}`;

async function readVersion(response: Response): Promise<CoverVersionResponse> {
	if (!response.ok) {
		throw new AppError({
			code: "cover_request_failed",
			message: `Cover request failed: ${response.status}`,
		});
	}
	return (await response.json()) as CoverVersionResponse;
}

export async function getCoverBlob(
	gameId: number,
	version: string,
	signal?: AbortSignal,
): Promise<Blob> {
	const response = await authenticatedFetch(
		`${coverUrl(gameId)}?v=${encodeURIComponent(version)}`,
		{ signal },
	);
	if (!response.ok) {
		throw new AppError({
			code: "cover_request_failed",
			message: `Cover request failed: ${response.status}`,
		});
	}
	return response.blob();
}

export async function uploadCustomCover(
	gameId: number,
	file: Blob,
): Promise<CoverVersionResponse> {
	return readVersion(
		await authenticatedFetch(coverUrl(gameId), {
			method: "PUT",
			headers: { "Content-Type": "application/octet-stream" },
			body: file,
		}),
	);
}

export async function deleteCustomCover(
	gameId: number,
): Promise<CoverVersionResponse> {
	return readVersion(
		await authenticatedFetch(coverUrl(gameId), { method: "DELETE" }),
	);
}

export async function setSourceCover(
	gameId: number,
	url: string | null,
): Promise<CoverVersionResponse> {
	return readVersion(
		await authenticatedFetch(`${coverUrl(gameId)}/source`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url }),
		}),
	);
}
```

- [ ] **Step 28：確認通過**

Run: `pnpm test:web src/services/web/covers.test.ts`
Expected: 3 passed。

- [ ] **Step 29：寫 `useCoverUrl` 的失敗測試**

`src/hooks/queries/useCoverUrl.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { getCoverBlob } = vi.hoisted(() => ({
	getCoverBlob: vi.fn(),
}));
vi.mock("@/services/web/covers", () => ({ getCoverBlob }));

import { COVER_GC_TIME, coverKeys, useCoverUrl } from "./useCoverUrl";

let counter = 0;
const created: string[] = [];
const revoked: string[] = [];

function wrapperFor(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

describe("useCoverUrl", () => {
	beforeEach(() => {
		counter = 0;
		created.length = 0;
		revoked.length = 0;
		getCoverBlob.mockReset();
		getCoverBlob.mockResolvedValue(new Blob(["img"]));
		vi.stubGlobal("URL", {
			...URL,
			createObjectURL: vi.fn(() => {
				counter += 1;
				const url = `blob:test/${counter}`;
				created.push(url);
				return url;
			}),
			revokeObjectURL: vi.fn((url: string) => revoked.push(url)),
		});
	});
	afterEach(() => vi.unstubAllGlobals());

	it("同一個 Blob 的兩個使用者各自有自己的 URL，卸載一個不影響另一個", async () => {
		const client = new QueryClient();
		const wrapper = wrapperFor(client);
		const a = renderHook(() => useCoverUrl(1, "v1"), { wrapper });
		const b = renderHook(() => useCoverUrl(1, "v1"), { wrapper });
		await waitFor(() => expect(a.result.current).toBeDefined());
		await waitFor(() => expect(b.result.current).toBeDefined());
		expect(getCoverBlob).toHaveBeenCalledTimes(1);
		expect(a.result.current).not.toBe(b.result.current);
		const aUrl = a.result.current;
		a.unmount();
		expect(revoked).toEqual([aUrl]);
		expect(revoked).not.toContain(b.result.current);
	});

	it("重新掛載會用快取的 Blob 建立新的 URL，不重新下載", async () => {
		const client = new QueryClient();
		const wrapper = wrapperFor(client);
		const first = renderHook(() => useCoverUrl(1, "v1"), { wrapper });
		await waitFor(() => expect(first.result.current).toBeDefined());
		const firstUrl = first.result.current;
		first.unmount();
		const second = renderHook(() => useCoverUrl(1, "v1"), { wrapper });
		await waitFor(() => expect(second.result.current).toBeDefined());
		expect(second.result.current).not.toBe(firstUrl);
		expect(getCoverBlob).toHaveBeenCalledTimes(1);
	});

	it("版本為 null 時不下載", () => {
		const client = new QueryClient();
		const { result } = renderHook(() => useCoverUrl(1, null), {
			wrapper: wrapperFor(client),
		});
		expect(result.current).toBeUndefined();
		expect(getCoverBlob).not.toHaveBeenCalled();
	});

	it("快取的是 Blob、gcTime 為 30 分鐘、key 帶 server 前綴", async () => {
		const client = new QueryClient();
		const { result } = renderHook(() => useCoverUrl(1, "v1"), {
			wrapper: wrapperFor(client),
		});
		await waitFor(() => expect(result.current).toBeDefined());
		expect(coverKeys.cover(1, "v1")).toEqual(["server", "cover", 1, "v1"]);
		const query = client.getQueryCache().find({ queryKey: coverKeys.cover(1, "v1") });
		expect(query?.state.data).toBeInstanceOf(Blob);
		expect(query?.options.gcTime).toBe(COVER_GC_TIME);
		expect(COVER_GC_TIME).toBe(30 * 60_000);
	});
});
```

- [ ] **Step 30：執行確認失敗**

Run: `pnpm test:web src/hooks/queries/useCoverUrl.test.tsx`
Expected: FAIL，`Failed to resolve import "./useCoverUrl"`。

- [ ] **Step 31：實作 `src/hooks/queries/useCoverUrl.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getCoverBlob } from "@/services/web/covers";

export const COVER_GC_TIME = 30 * 60_000;

export const coverKeys = {
	cover: (gameId: number, version: string) =>
		["server", "cover", gameId, version] as const,
};

/**
 * 取得封面的 object URL。
 * Query 快取 Blob 本身；object URL 由每個使用者（元件）自己建立與撤銷，
 * 避免一個元件卸載時撤銷了其他元件或快取仍在使用的 URL。
 */
export function useCoverUrl(
	gameId: number,
	version: string | null,
): string | undefined {
	const { data: blob } = useQuery({
		queryKey: coverKeys.cover(gameId, version ?? ""),
		queryFn: ({ signal }) => getCoverBlob(gameId, version as string, signal),
		enabled: version !== null,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: COVER_GC_TIME,
	});
	const [url, setUrl] = useState<string>();

	useEffect(() => {
		if (!blob || version === null) {
			setUrl(undefined);
			return;
		}
		const objectUrl = URL.createObjectURL(blob);
		setUrl(objectUrl);
		return () => URL.revokeObjectURL(objectUrl);
	}, [blob, version]);

	return url;
}
```

- [ ] **Step 32：確認通過**

Run: `pnpm test:web src/hooks/queries/useCoverUrl.test.tsx`
Expected: 4 passed。

- [ ] **Step 33：寫 `useGameCoverSrc` 的失敗測試**

`src/hooks/features/games/useGameCoverSrc.test.tsx`：

```tsx
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GameData } from "@/types";

// vi.mock 會被提升到檔案最上方，工廠用到的變數必須放在 vi.hoisted 裡
const { isWebRuntime, useCoverUrl, publicAssetUrl } = vi.hoisted(() => ({
	isWebRuntime: vi.fn(),
	useCoverUrl: vi.fn(),
	// 固定成網頁版的結果，讓斷言與部署路徑一致
	publicAssetUrl: (path: string) => `/game/${path.replace(/^\/+/, "")}`,
}));
vi.mock("@/services/platform", () => ({ isWebRuntime, publicAssetUrl }));
vi.mock("@/hooks/queries/useCoverUrl", () => ({ useCoverUrl }));
vi.mock("@/utils/game", async (original) => ({
	...(await original<typeof import("@/utils/game")>()),
	getVisibleGameCover: vi.fn(() => "desktop-cover"),
}));

import { useGameCoverSrc } from "./useGameCoverSrc";

const game = { id: 5, sourceIds: {}, cover_version: "h1", tags: [] } as unknown as GameData;
const nsfwGame = { ...game, nsfw: true } as GameData;

describe("useGameCoverSrc", () => {
	beforeEach(() => {
		isWebRuntime.mockReset();
		useCoverUrl.mockReset();
	});

	it("桌面版沿用原本的封面網址", () => {
		isWebRuntime.mockReturnValue(false);
		useCoverUrl.mockReturnValue(undefined);
		const { result } = renderHook(() => useGameCoverSrc(game, false));
		expect(result.current).toBe("desktop-cover");
		expect(useCoverUrl).toHaveBeenCalledWith(5, null);
	});

	it("網頁版有 blob URL 就用它", () => {
		isWebRuntime.mockReturnValue(true);
		useCoverUrl.mockReturnValue("blob:x");
		const { result } = renderHook(() => useGameCoverSrc(game, false));
		expect(result.current).toBe("blob:x");
		expect(useCoverUrl).toHaveBeenCalledWith(5, "h1");
	});

	it("網頁版沒有封面或尚未載入時用子路徑下的預設圖", () => {
		isWebRuntime.mockReturnValue(true);
		useCoverUrl.mockReturnValue(undefined);
		const { result } = renderHook(() =>
			useGameCoverSrc({ ...game, cover_version: null } as GameData, false),
		);
		expect(result.current).toBe("/game/images/default.png");
	});

	it("網頁版替換 NSFW 封面時不下載真實封面", () => {
		isWebRuntime.mockReturnValue(true);
		useCoverUrl.mockReturnValue(undefined);
		const { result } = renderHook(() => useGameCoverSrc(nsfwGame, true));
		expect(result.current).toBe("/game/images/NR18.png");
		expect(useCoverUrl).toHaveBeenCalledWith(5, null);
	});
});
```

- [ ] **Step 34：執行確認失敗**

Run: `pnpm test:web src/hooks/features/games/useGameCoverSrc.test.tsx`
Expected: FAIL，`Failed to resolve import "./useGameCoverSrc"`。

- [ ] **Step 35：實作 hook 與元件**

`src/hooks/features/games/useGameCoverSrc.ts`：

```ts
import { useCoverUrl } from "@/hooks/queries/useCoverUrl";
import { isWebRuntime, publicAssetUrl } from "@/services/platform";
import type { GameData } from "@/types";
import { getGameNsfwStatus, getVisibleGameCover } from "@/utils/game";

/**
 * 回傳可直接放進 <img src> 的封面網址。
 * 桌面版維持 reina-cover 協定；網頁版改用伺服器的版本化封面（blob URL）。
 */
export function useGameCoverSrc(
	game: GameData | undefined,
	replaceNsfwCover = false,
): string {
	const web = isWebRuntime();
	const hideForNsfw = Boolean(game && replaceNsfwCover && getGameNsfwStatus(game));
	const version = web && game && !hideForNsfw ? (game.cover_version ?? null) : null;
	const blobUrl = useCoverUrl(game?.id ?? 0, version);

	if (!game) return "";
	if (!web) return getVisibleGameCover(game, replaceNsfwCover);
	// 预设图与 NSFW 替代图沿用任务 5 的 publicAssetUrl，网页版会带上 /game/ 前缀
	if (hideForNsfw) return publicAssetUrl("images/NR18.png");
	return blobUrl ?? publicAssetUrl("images/default.png");
}
```

`src/components/GameCover/GameCoverImg.tsx`：

```tsx
import type { ImgHTMLAttributes } from "react";
import { useGameCoverSrc } from "@/hooks/features/games/useGameCoverSrc";
import type { GameData } from "@/types";

type GameCoverImgProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	game: GameData;
	replaceNsfwCover?: boolean;
};

/** 在清單或迴圈裡顯示封面用：每個 <img> 自己持有 object URL 的生命週期。 */
export function GameCoverImg({
	game,
	replaceNsfwCover = false,
	...imgProps
}: GameCoverImgProps) {
	const src = useGameCoverSrc(game, replaceNsfwCover);
	return <img {...imgProps} src={src} />;
}
```

`src/components/GameCover/index.ts`：

```ts
export { GameCoverImg } from "./GameCoverImg";
```

- [ ] **Step 36：確認通過**

Run: `pnpm test:web src/hooks/features/games/useGameCoverSrc.test.tsx`
Expected: 4 passed。

- [ ] **Step 37：替換所有封面顯示處**

1. `src/components/Cards/CardItem.tsx`：刪除 `import { getVisibleGameCover } from "@/utils/game";`，加 `import { useGameCoverSrc } from "@/hooks/features/games/useGameCoverSrc";`，第 46 行改為：

```tsx
			const coverImage = useGameCoverSrc(game, nsfwCoverReplace);
```

2. `src/pages/Detail/DetailPage.tsx`：import 改為 `import { getGameDisplayName } from "@/utils/game";` 並加 `import { GameCoverImg } from "@/components/GameCover";`，第 265–271 行：

```tsx
						<GameCoverImg
							game={selectedGame}
							loading="lazy"
							alt={getGameDisplayName(selectedGame)}
							className="max-h-65 max-w-40 lg:max-w-80 rounded-lg shadow-lg select-none"
							onDragStart={(event) => event.preventDefault()}
						/>
```

3. `src/pages/Stats/StatisticsRanking.tsx`：import 改為 `import { getGameDisplayName } from "@/utils/game";`，加 `import { GameCoverImg } from "@/components/GameCover";`，第 58–63 行：

```tsx
			<GameCoverImg
				game={item.game}
				replaceNsfwCover={replaceNsfwCover}
				alt=""
				loading="lazy"
				className="h-14 w-10 shrink-0 rounded object-cover bg-[var(--mui-palette-action-hover)]"
			/>
```

4. `src/pages/Home/homeData.ts`：`ActivityItem` 的 `imageUrl: string;` 改為 `game: GameData;`；兩處 `imageUrl: getVisibleCover(game, replaceNsfwCover),` 改為 `game,`；`buildActivities` 的 `replaceNsfwCover` 參數已不再需要，簽名改為 `buildActivities(games: GameData[], sessions: GameSession[]): ActivityItem[]`，並更新呼叫處（`rg -n "buildActivities\(" src`）。`getVisibleCover` 保留給桌面預載邏輯使用。

5. `src/pages/Home/ActivityPanel.tsx`：加 `import { useGameCoverSrc } from "@/hooks/features/games/useGameCoverSrc";`，把第 161–164 行的 `<Avatar ... src={activity.imageUrl} .../>` 抽成同檔的小元件：

```tsx
function ActivityCover({ activity, replaceNsfwCover }: { activity: ActivityItem; replaceNsfwCover: boolean }) {
	const src = useGameCoverSrc(activity.game, replaceNsfwCover);
	return <Avatar variant="rounded" src={src} className="mr-3 h-12 w-12" />;
}
```

原處改為 `<ActivityCover activity={activity} replaceNsfwCover={replaceNsfwCover} />`；`replaceNsfwCover` 從 `useStore((s) => s.nsfwCoverReplace)` 取得（與 CardItem 相同）。

6. `src/pages/Home/RandomGamePanel.tsx` 第 62–66 行：

```tsx
					<GameCoverImg
						game={game}
						replaceNsfwCover={replaceNsfwCover}
						alt=""
						className="h-21 w-full rounded-2xl object-cover"
					/>
```

（`Box component="img"` 改為原生 `img`，className 相同；import `GameCoverImg`，移除 `getVisibleCover` import。）

7. `src/pages/Home/FocusGamePanel.tsx`：
   - 第 84 行改為 `const coverUrl = useGameCoverSrc(game, replaceNsfwCover);`
   - 第 97–102 行的預載 effect 只在桌面執行（網頁版的 blob URL 不能跨元件共用）：

```tsx
	useEffect(() => {
		if (isWebRuntime()) return;
		for (const recentGame of recentGames) {
			const url = getVisibleCover(recentGame, replaceNsfwCover);
			getCoverIsPortrait(url);
		}
	}, [recentGames, replaceNsfwCover]);
```

   - 第 266 行的最近遊戲縮圖改用 `<GameCoverImg game={recentGame} replaceNsfwCover={replaceNsfwCover} ... />`，其餘屬性照舊。
   - import 補 `useGameCoverSrc`、`GameCoverImg`、`isWebRuntime`。

- [ ] **Step 38：網頁版的自訂封面選擇、預覽與上傳**

1. `src/pages/Detail/game-info/useImagePreview.ts` 增加網頁版的檔案來源（桌面行為不變）：

```ts
import { convertFileSrc } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";

export const useImagePreview = () => {
	const [selectedPath, setSelectedPath] = useState<string | null>(null);
	const [selectedFile, setSelectedFile] = useState<File | null>(null);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);

	// 網頁版預覽使用 object URL，換圖或卸載時必須撤銷
	useEffect(() => {
		if (!selectedFile) return;
		const url = URL.createObjectURL(selectedFile);
		setPreviewUrl(url);
		return () => URL.revokeObjectURL(url);
	}, [selectedFile]);

	const cleanup = useCallback(() => {
		setPreviewUrl(null);
		setSelectedPath(null);
		setSelectedFile(null);
	}, []);

	const selectImage = useCallback((path: string) => {
		setSelectedFile(null);
		setSelectedPath(path);
		setPreviewUrl(convertFileSrc(path));
	}, []);

	const selectFile = useCallback((file: File) => {
		setSelectedPath(null);
		setSelectedFile(file);
	}, []);

	return { selectedPath, selectedFile, previewUrl, selectImage, selectFile, cleanup };
};
```

2. `src/pages/Detail/game-info/gameInfoEditData.ts`：`CoverPreviewParams` 加 `fallbackCoverUrl: string;`，並把函式最後的 `return getGameCover({...})` 與 `shouldDeleteImage` 分支的 `publicAssetUrl("images/default.png")`（任務 5 已從 `"/images/default.png"` 改成這個）改為使用呼叫端傳入的值（網頁版由 `useGameCoverSrc` 算出、桌面版由原本的 `getGameCover` 算出）：

```ts
	if (shouldDeleteImage) {
		return sourceCoverImage ?? fallbackCoverUrl;
	}
	// ...中間分支不變...
	return fallbackCoverUrl;
```

3. `src/pages/Detail/game-info/GameInfoEdit.tsx`：
   - 取得 `selectedFile`、`selectFile`；新增 `const web = isWebRuntime();`、`const webCoverUrl = useGameCoverSrc(selectedGame);`、`const fileInputRef = useRef<HTMLInputElement>(null);`。
   - `getCurrentCoverUrl`（第 425 行）呼叫 `getCoverPreviewUrl` 時傳入 `fallbackCoverUrl: web ? webCoverUrl : getGameCover({ ...selectedGame, image: sourceCoverImage ?? selectedGame.image })`。
   - `handleCustomCoverSelect`（第 364 行）開頭加網頁分支：

```tsx
		if (web) {
			fileInputRef.current?.click();
			return;
		}
```

   - 在元件 JSX 中（封面選單附近）加隱藏的檔案輸入：

```tsx
			{web && (
				<input
					ref={fileInputRef}
					type="file"
					accept="image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif"
					hidden
					onChange={(event) => {
						const file = event.target.files?.[0];
						event.target.value = "";
						if (!file) return;
						if (file.size > 10 * 1024 * 1024) {
							snackbar.error(t("pages.Detail.GameInfoEdit.coverTooLarge", "封面不能超過 10 MB"));
							return;
						}
						setShouldDeleteImage(false);
						selectFile(file);
					}}
				/>
			)}
```

   - 儲存流程（第 560–573 行）改為依執行環境分支；網頁版不把 `newImageExt` 寫進 payload（自訂封面由伺服器的 `custom_cover_hash` 決定）：

```tsx
			let uploadedImageExt: string | null | undefined;

			if (web) {
				if (shouldDeleteImage) {
					await deleteCustomCover(selectedGame.id);
				} else if (selectedFile) {
					await uploadCustomCover(selectedGame.id, selectedFile);
				}
				if (coverSourceChanged && originalSourceCoverImage !== nextSourceCoverImage) {
					await setSourceCover(selectedGame.id, nextSourceCoverImage ?? null);
				}
			} else if (shouldDeleteImage) {
				await deleteGameCustomCovers(selectedGame.id);
				uploadedImageExt = null;
			} else if (selectedImagePath) {
				uploadedImageExt = await uploadSelectedImage(selectedGame.id, selectedImagePath);
			}
```

     第 598–603 行的 `fileService.deleteCloudCoverCache` 包在 `if (!web)` 內；第 614–630 行的樂觀更新同樣包在 `if (!web)` 內（網頁版在 `onSave` 之後由任務 6 的快取更新帶回新的 `cover_version`，`useGameCoverSrc` 自動換成新網址）。
   - 剪貼簿匯入封面的選單項目在網頁版隱藏（`{!web && (...)}`），因為它依賴桌面的暫存檔。
   - import 補 `isWebRuntime`、`useGameCoverSrc`、`deleteCustomCover`、`uploadCustomCover`、`setSourceCover`。

- [ ] **Step 39：全面檢查沒有遺漏的桌面專屬封面來源**

Run: `rg -n "getVisibleGameCover|getGameCover\(|convertFileSrc|reina-cover|getVisibleCover\(" src --glob '!**/*.test.*'`
Expected: 只剩下 `src/utils/game/gameDisplay.ts`（定義處）、`src/hooks/features/games/useGameCoverSrc.ts`（桌面分支）、`src/pages/Home/homeData.ts`（`getVisibleCover` 定義）、`FocusGamePanel.tsx` 的桌面預載、`GameInfoEdit.tsx` 的桌面分支、`useImagePreview.ts` 的 `selectImage`。若出現其他元件，依 Step 37 的方式改成 `useGameCoverSrc` 或 `GameCoverImg`。

- [ ] **Step 40：國際化與整體檢查**

Run: `pnpm i18n:extract`
Run: `pnpm i18n:status`
Expected: 只有新增的 `pages.Detail.GameInfoEdit.coverTooLarge` 缺翻譯；在 `src/locales/{zh-CN,zh-TW,en-US,ja-JP}.json` 補上（zh-CN「封面不能超过 10 MB」、zh-TW「封面不能超過 10 MB」、en-US「Cover must be 10 MB or smaller」、ja-JP「カバー画像は 10 MB 以下にしてください」）。
Run: `pnpm i18n:sync`
Run: `pnpm test:web`
Expected: 全部通過。
Run: `pnpm check`
Expected: 無錯誤。
Run: `pnpm build`
Expected: 桌面版建置成功。

- [ ] **Step 41：Commit**

```bash
git add src-tauri/reina-server/src/upstream.rs src-tauri/reina-server/src/upstream src-tauri/reina-server/src/api/covers.rs src-tauri/reina-server/src/api/covers src-tauri/reina-server/src/api.rs src-tauri/reina-server/src/lib.rs src-tauri/reina-server/src/config.rs src-tauri/reina-server/src/api/rpc/handler.rs src-tauri/reina-server/tests/support.rs src-tauri/reina-server/tests/covers.rs src-tauri/reina-server/Cargo.toml src-tauri/reina-core/src/database/repository/games_repository.rs src-tauri/reina-core/tests/cover_state.rs src-tauri/Cargo.lock
git add src/services/web/covers.ts src/services/web/covers.test.ts src/hooks/queries/useCoverUrl.ts src/hooks/queries/useCoverUrl.test.tsx src/hooks/features/games/useGameCoverSrc.ts src/hooks/features/games/useGameCoverSrc.test.tsx src/components/GameCover src/components/Cards/CardItem.tsx src/pages/Detail/DetailPage.tsx src/pages/Stats/StatisticsRanking.tsx src/pages/Home/homeData.ts src/pages/Home/ActivityPanel.tsx src/pages/Home/RandomGamePanel.tsx src/pages/Home/FocusGamePanel.tsx src/pages/Detail/game-info/useImagePreview.ts src/pages/Detail/game-info/gameInfoEditData.ts src/pages/Detail/game-info/GameInfoEdit.tsx src/locales
git commit -m "feat: serve versioned authenticated covers

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```


---

### 任務 8：中繼資料 HTTP 代理與伺服器限速

目標：網頁版不能用 `tauri-plugin-http` 繞過 CORS，所以所有中繼資料來源請求改由 reina-server 代為發出；每個來源一條全域節流佇列（跨裝置共用），間隔與 429 規則沿用 `rateLimit.ts`；候選預覽圖與來源 icon 也經由伺服器圖片代理，符合 `/game/` 的 CSP（`img-src 'self' data: blob:`）。現有的 source adapters、DOMParser 解析與混合規則全部留在前端不動。

**Files:**
- Create: `reina-server/src/upstream/limiter.rs`（修改 `reina-server/src/upstream.rs` 加 `pub mod limiter;`）
- Create: `reina-server/src/api/metadata.rs`（只有宣告）
- Create: `reina-server/src/api/metadata/handlers.rs`
- Modify: `reina-server/src/api.rs`（`pub mod metadata;` 與 `.merge(metadata::handlers::routes())`）
- Test: `reina-server/tests/metadata.rs`
- Create: `src/metadata/api/serverProxy.ts`、`src/metadata/api/serverProxy.test.ts`
- Modify: `src/metadata/api/http.ts:52-57,104-107`（匯出 `TauriHttpResponse`、網頁分支）
- Modify: `src/metadata/api/rateLimit.ts`（匯出 `getApiRateLimitPolicy`）
- Create: `src/services/web/metadataImage.ts`、`src/hooks/queries/useProxiedImageUrl.ts`、`src/hooks/queries/useProxiedImageUrl.test.tsx`
- Create: `src/components/ProxiedImage/ProxiedImage.tsx`、`src/components/ProxiedImage/index.ts`
- Modify: `src/components/AlertBox.tsx:247,285`、`src/components/AddModal/GameSelectDialog.tsx:94,137`、`src/components/AddModal/MixedSourceConfirmDialog.tsx:175`、`src/pages/Detail/game-info/SourceCoverDialog.tsx:108`、`src/pages/Settings/AccountSettings.tsx:145,173,458,471`、`src/components/Toolbar/Toolbar.tsx:82-100`、`src/components/Windows.tsx:56,95`

**Interfaces:**
- Consumes：任務 7 的 `upstream::{policy, target, fetch}`、`api::covers::sniff::sniff`；任務 3 的 `AppState`、`AuthUser`、`ApiError`、`TestApp`；任務 4 的 `authenticatedFetch`；任務 5 的 `isWebRuntime`。
- Produces：
  - Rust：`SourceLimiter::new(interval: Duration)`、`SourceLimiter::acquire(&self)`、`Limiters::for_source(&self, source: &str) -> &SourceLimiter`。
  - HTTP：`POST /game/api/metadata/request`，body `{ "source": string | null, "method": "GET"|"POST"|"PATCH"|"PUT", "url": string, "headers": Record<string,string>, "body": string | null }` → `{ "status": number, "headers": [string, string][], "body": string }`；屬於 Read（不遞增 `data_version`）。錯誤：白名單外 403 `upstream_forbidden`、上游連不到 502 `upstream_unreachable`、回應超過 8 MiB 502 `upstream_too_large`。
  - HTTP：`GET /game/api/metadata/image?url=<encoded>` → 圖片位元組，`Cache-Control: private, max-age=86400`。
  - TS：`requestViaServerProxy<T>(method, fullUrl, options, data, source): Promise<TauriHttpResponse<T>>`；`getApiRateLimitPolicy(source: ApiRateLimitSource): ApiRateLimitPolicy`。
  - TS：`getMetadataImageBlob(url: string, signal?: AbortSignal): Promise<Blob>`；`metadataImageKeys.image(url)` = `["server", "metadata-image", url]`；`useProxiedImageUrl(url: string | null | undefined): string | undefined`；元件 `<ProxiedImage src={externalUrl} {...imgProps} />`（任務 9 的候選清單使用）。

- [ ] **Step 1：寫全域節流器的失敗測試**

`reina-server/src/upstream/limiter.rs`：

```rust
//! 每個來源一條全域節流佇列。所有裝置共用同一個伺服器，所以限速也跨裝置生效。
//! 間隔數值來自 `upstream::policy::SOURCE_POLICIES`（與前端 rateLimit.ts 一致）。

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use tokio::time::{Duration, Instant};

    #[tokio::test(start_paused = true)]
    async fn 連續請求之間至少間隔設定的毫秒數() {
        let limiter = Arc::new(SourceLimiter::new(Duration::from_millis(250)));
        let start = Instant::now();
        let mut handles = Vec::new();
        for _ in 0..4 {
            let limiter = limiter.clone();
            handles.push(tokio::spawn(async move {
                limiter.acquire().await;
                Instant::now()
            }));
        }
        let mut times: Vec<Instant> = Vec::new();
        for handle in handles {
            times.push(handle.await.unwrap());
        }
        times.sort();
        assert_eq!(times[0] - start, Duration::ZERO);
        for pair in times.windows(2) {
            assert!(pair[1] - pair[0] >= Duration::from_millis(250));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn 閒置超過間隔後不需等待() {
        let limiter = SourceLimiter::new(Duration::from_millis(1600));
        limiter.acquire().await;
        tokio::time::advance(Duration::from_secs(5)).await;
        let before = Instant::now();
        limiter.acquire().await;
        assert_eq!(Instant::now() - before, Duration::ZERO);
    }

    #[tokio::test(start_paused = true)]
    async fn 收到_429_後同一來源的所有請求都要等退避期限() {
        let limiter = SourceLimiter::new(Duration::from_millis(100));
        limiter.acquire().await;
        let delay = limiter.record_429(Some(Duration::from_secs(3)), Duration::from_secs(30), Duration::from_secs(300));
        assert_eq!(delay, Duration::from_secs(3));
        let before = Instant::now();
        limiter.acquire().await;
        assert!(Instant::now() - before >= Duration::from_secs(3), "下一個請求必須等到退避期限");
    }

    #[tokio::test(start_paused = true)]
    async fn 排隊睡眠期間登記的退避也會被遵守() {
        let limiter = std::sync::Arc::new(SourceLimiter::new(Duration::from_secs(1)));
        limiter.acquire().await; // 下一個最早 1 秒後
        let waiter = {
            let limiter = limiter.clone();
            tokio::spawn(async move {
                let before = Instant::now();
                limiter.acquire().await;
                Instant::now() - before
            })
        };
        tokio::task::yield_now().await; // 讓 waiter 先進入排隊並開始睡
        limiter.record_429(Some(Duration::from_secs(5)), Duration::from_secs(30), Duration::from_secs(300));
        let waited = waiter.await.unwrap();
        assert!(waited >= Duration::from_secs(5), "醒來後要重新檢查退避期限，實際等了 {waited:?}");
    }

    #[test]
    fn 沒有_retry_after_時指數退避_成功後重置() {
        let limiter = SourceLimiter::new(Duration::from_millis(100));
        let (default, max) = (Duration::from_secs(30), Duration::from_secs(300));
        assert_eq!(limiter.record_429(None, default, max), Duration::from_secs(30));
        assert_eq!(limiter.record_429(None, default, max), Duration::from_secs(60));
        assert_eq!(limiter.record_429(None, default, max), Duration::from_secs(120));
        assert_eq!(limiter.record_429(None, default, max), Duration::from_secs(240));
        assert_eq!(limiter.record_429(None, default, max), max, "不超過上限");
        limiter.record_success();
        assert_eq!(limiter.record_429(None, default, max), Duration::from_secs(30));
    }

    #[test]
    fn 每個來源的間隔與_policy_一致() {
        let limiters = Limiters::from_policies();
        assert_eq!(limiters.for_source("vndb").interval(), Duration::from_millis(1600));
        assert_eq!(limiters.for_source("bgm").interval(), Duration::from_millis(250));
        assert_eq!(limiters.for_source("dlsite").interval(), Duration::from_millis(2000));
        assert_eq!(limiters.for_source("erogamescape").interval(), Duration::from_millis(3000));
        assert_eq!(limiters.for_source("hikarinagi").interval(), Duration::from_millis(500));
    }
}
```

`reina-server/src/upstream.rs` 加 `pub mod limiter;`。

- [ ] **Step 2：執行確認失敗**

Run: `cargo test -p reina-server --lib upstream::limiter`
Expected: 編譯失敗，`cannot find struct 'SourceLimiter'`。

- [ ] **Step 3：實作節流器**

`limiter.rs` 測試模組上方：

```rust
use std::collections::HashMap;
use std::sync::Mutex as StdMutex;

use tokio::sync::Mutex;
use tokio::time::{sleep_until, Duration, Instant};

use crate::upstream::policy::SOURCE_POLICIES;

#[derive(Debug, Default)]
struct Backoff {
    until: Option<Instant>,
    consecutive_429: u32,
}

#[derive(Debug)]
pub struct SourceLimiter {
    interval: Duration,
    /// 排队用的锁：tokio 的 Mutex 是公平的，等待者依抵达顺序放行
    next_start: Mutex<Option<Instant>>,
    /// 来源共用的 429 退避期限。独立于排队锁：收到 429 的请求不必等排队锁就能登记，
    /// 正在排队睡眠的请求醒来后会重新读取，所以所有分页、装置的请求都会遵守
    backoff: StdMutex<Backoff>,
}

impl SourceLimiter {
    pub fn new(interval: Duration) -> Self {
        Self { interval, next_start: Mutex::new(None), backoff: StdMutex::new(Backoff::default()) }
    }

    pub fn interval(&self) -> Duration {
        self.interval
    }

    fn backoff_until(&self) -> Option<Instant> {
        self.backoff.lock().expect("backoff lock poisoned").until
    }

    /// 等到輪到自己、而且不在退避期間為止
    pub async fn acquire(&self) {
        let mut next = self.next_start.lock().await;
        // 睡醒后重新检查：睡眠期间可能有别的请求收到 429，把退避期限往后延
        loop {
            let wake = [*next, self.backoff_until()].into_iter().flatten().max();
            match wake {
                Some(at) if at > Instant::now() => sleep_until(at).await,
                _ => break,
            }
        }
        *next = Some(Instant::now() + self.interval);
    }

    /// 收到 429：登记来源共用的退避期限（只会延长、不会缩短），回传这次的退避时间。
    /// 没有 Retry-After 时依连续 429 次数指数退避，与桌面版 rateLimit.ts 相同
    pub fn record_429(&self, retry_after: Option<Duration>, default: Duration, max: Duration) -> Duration {
        let mut backoff = self.backoff.lock().expect("backoff lock poisoned");
        backoff.consecutive_429 += 1;
        let exponent = backoff.consecutive_429.saturating_sub(1).min(16);
        let delay = retry_after.unwrap_or_else(|| default.saturating_mul(1 << exponent)).min(max);
        let until = Instant::now() + delay;
        backoff.until = Some(backoff.until.map_or(until, |current| current.max(until)));
        delay
    }

    /// 请求成功：重置连续 429 计数（已登记的退避期限照常到期）
    pub fn record_success(&self) {
        self.backoff.lock().expect("backoff lock poisoned").consecutive_429 = 0;
    }
}

#[derive(Debug)]
pub struct Limiters {
    by_source: HashMap<&'static str, SourceLimiter>,
}

impl Limiters {
    pub fn from_policies() -> Self {
        Self {
            by_source: SOURCE_POLICIES
                .iter()
                .map(|policy| (policy.source, SourceLimiter::new(Duration::from_millis(policy.min_interval_ms))))
                .collect(),
        }
    }

    pub fn for_source(&self, source: &str) -> &SourceLimiter {
        self.by_source.get(source).expect("every policy has a limiter")
    }
}
```

- [ ] **Step 4：確認通過**

Run: `cargo test -p reina-server --lib upstream::limiter`
Expected: 6 passed。

- [ ] **Step 5：寫代理端點的失敗整合測試**

`reina-server/tests/metadata.rs`：

```rust
mod support;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};
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
                .header(header::AUTHORIZATION, format!("Bearer {}", app.owner_token()))
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await;
    let status = response.status;
    let bytes = response.body.clone();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

#[tokio::test]
async fn 轉送請求且不外洩_teledrive_token_也不改變版本() {
    let seen: Arc<Mutex<Vec<HeaderMap>>> = Arc::default();
    let seen2 = seen.clone();
    let addr = spawn(Router::new().route("/kana/vn", post(move |headers: HeaderMap, body: String| {
        seen2.lock().unwrap().push(headers);
        async move { ([(header::CONTENT_TYPE, "application/json")], format!("{{\"echo\":{body}}}")) }
    })))
    .await;
    let app = TestApp::with_config(|config| {
        config.upstream_overrides.insert("api.vndb.org".into(), addr);
    })
    .await;
    let before = app.data_version().await;
    let (status, json) = proxy(&app, json!({
        "source": "vndb", "method": "POST", "url": "https://api.vndb.org/kana/vn",
        "headers": {"Content-Type": "application/json", "Accept": "application/json"},
        "body": "{\"filters\":[]}"
    }))
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], 200);
    assert_eq!(json["body"], "{\"echo\":{\"filters\":[]}}");
    let headers = seen.lock().unwrap()[0].clone();
    let token = app.owner_token();
    assert!(headers.values().all(|value| !value.to_str().unwrap_or("").contains(&token)));
    assert!(headers.get(header::AUTHORIZATION).is_none());
    assert_eq!(app.data_version().await, before, "代理請求屬於 Read");
}

#[tokio::test]
async fn 拒絕白名單外_host_與來源不符() {
    let app = TestApp::new().await;
    let (status, json) = proxy(&app, json!({"source": null, "method": "GET", "url": "https://example.com/", "headers": {}, "body": null})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(json["code"], "upstream_forbidden");
    let (status, _) = proxy(&app, json!({"source": "bgm", "method": "GET", "url": "https://api.vndb.org/kana/vn", "headers": {}, "body": null})).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = proxy(&app, json!({"source": null, "method": "DELETE", "url": "https://api.bgm.tv/v0/me", "headers": {}, "body": null})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn 同一來源的請求在伺服器端被節流() {
    let addr = spawn(Router::new().route("/v0/subjects/1", get(|| async { "{}" }))).await;
    let app = TestApp::with_config(|config| {
        config.upstream_overrides.insert("api.bgm.tv".into(), addr);
    })
    .await;
    let body = json!({"source": "bgm", "method": "GET", "url": "https://api.bgm.tv/v0/subjects/1", "headers": {}, "body": null});
    let start = Instant::now();
    let (a, b) = tokio::join!(proxy(&app, body.clone()), proxy(&app, body.clone()));
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    assert!(start.elapsed() >= Duration::from_millis(250), "bgm 間隔 250ms");
}

#[tokio::test]
async fn vndb_429_依_retry_after_重試最多兩次_其他來源直接回傳_429() {
    let hits = Arc::new(Mutex::new(0u32));
    let hits2 = hits.clone();
    let vndb = spawn(Router::new().route("/kana/vn", post(move || {
        let hits = hits2.clone();
        async move {
            let mut count = hits.lock().unwrap();
            *count += 1;
            // 兩個分支型別相同，axum 可直接轉成 Response
            if *count <= 2 {
                (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "1")], "slow down")
            } else {
                (StatusCode::OK, [(header::RETRY_AFTER, "0")], "{}")
            }
        }
    })))
    .await;
    let bgm = spawn(Router::new().route("/v0/subjects/2", get(|| async {
        (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "3600")], "limited")
    })))
    .await;
    let app = TestApp::with_config(|config| {
        config.upstream_overrides.insert("api.vndb.org".into(), vndb);
        config.upstream_overrides.insert("api.bgm.tv".into(), bgm);
    })
    .await;
    let (status, json) = proxy(&app, json!({"source": "vndb", "method": "POST", "url": "https://api.vndb.org/kana/vn", "headers": {}, "body": "{}"})).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["status"], 200);
    assert_eq!(*hits.lock().unwrap(), 3);

    let (status, json) = proxy(&app, json!({"source": "bgm", "method": "GET", "url": "https://api.bgm.tv/v0/subjects/2", "headers": {}, "body": null})).await;
    assert_eq!(status, StatusCode::OK, "代理本身成功，上游狀態放在 body.status");
    assert_eq!(json["status"], 429);
    let retry_after = json["headers"].as_array().unwrap().iter().find(|pair| pair[0] == "retry-after").unwrap();
    assert_eq!(retry_after[1], "3600");
}

#[tokio::test]
async fn vndb_退避期間其他請求也不會打到上游() {
    // 第一次回 429（Retry-After 3 秒），之後都回 200；記錄每次打到上游的時間
    let hits: Arc<Mutex<Vec<std::time::Instant>>> = Arc::default();
    let hits2 = hits.clone();
    let vndb = spawn(Router::new().route("/kana/vn", post(move || {
        let hits = hits2.clone();
        async move {
            let mut hits = hits.lock().unwrap();
            hits.push(std::time::Instant::now());
            if hits.len() == 1 {
                (StatusCode::TOO_MANY_REQUESTS, [(header::RETRY_AFTER, "3")], "slow down")
            } else {
                (StatusCode::OK, [(header::RETRY_AFTER, "0")], "{}")
            }
        }
    })))
    .await;
    let app = TestApp::with_config(|config| {
        config.upstream_overrides.insert("api.vndb.org".into(), vndb);
    })
    .await;
    let body = json!({"source": "vndb", "method": "POST", "url": "https://api.vndb.org/kana/vn", "headers": {}, "body": "{}"});
    // 兩個分頁同時送出：一個會先吃到 429，另一個必須跟著等退避期限，而不是 1.6 秒後就送
    let (a, b) = tokio::join!(proxy(&app, body.clone()), proxy(&app, body.clone()));
    assert_eq!(a.1["status"], 200);
    assert_eq!(b.1["status"], 200);
    let hits = hits.lock().unwrap();
    assert_eq!(hits.len(), 3, "一次 429 + 兩次成功");
    let limited_at = hits[0];
    for later in &hits[1..] {
        assert!(
            *later - limited_at >= std::time::Duration::from_secs(3),
            "429 之後的請求要等到退避期限：只隔了 {:?}",
            *later - limited_at
        );
    }
}

#[tokio::test]
async fn 圖片代理只接受圖床_host_且內容必須是圖片() {
    let addr = spawn(Router::new()
        .route("/cv/1.jpg", get(|| async { ([(header::CONTENT_TYPE, "image/jpeg")], b"\xFF\xD8\xFF\xE0jpeg".to_vec()) }))
        .route("/cv/html", get(|| async { "<html></html>" })))
        .await;
    let app = TestApp::with_config(|config| {
        config.upstream_overrides.insert("t.vndb.org".into(), addr);
    })
    .await;
    let get_image = |url: &'static str| {
        Request::builder()
            .uri(format!("/game/api/metadata/image?url={}", urlencoding::encode(url)))
            .header(header::AUTHORIZATION, format!("Bearer {}", app.owner_token()))
            .body(Body::empty())
            .unwrap()
    };
    let ok = app.send(get_image("https://t.vndb.org/cv/1.jpg")).await;
    assert_eq!(ok.status, StatusCode::OK);
    assert_eq!(ok.headers[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(ok.headers[header::CACHE_CONTROL], "private, max-age=86400");
    assert_eq!(app.send(get_image("https://t.vndb.org/cv/html")).await.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(app.send(get_image("https://example.com/a.jpg")).await.status, StatusCode::FORBIDDEN);
}
```

`reina-server/Cargo.toml` `[dev-dependencies]` 補 `urlencoding = "2"`。

- [ ] **Step 6：執行確認失敗**

Run: `cargo test -p reina-server --test metadata`
Expected: 全部 FAIL（路由不存在，回 404 而非預期狀態）。

- [ ] **Step 7：實作代理端點**

`reina-server/src/api/metadata.rs`：

```rust
pub mod handlers;
```

`reina-server/src/api/metadata/handlers.rs`：

```rust
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Query, State};
use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};

use crate::api::auth::AuthUser;
use crate::api::covers::sniff::sniff;
use crate::app::AppState;
use crate::error::ApiError;
use crate::upstream::fetch::{fetch_bytes, UpstreamRequest, UpstreamResponse};
use crate::upstream::limiter::Limiters;
use crate::upstream::target::{resolve_target, HostRule, UpstreamError};

const MAX_METADATA_BYTES: usize = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 10 * 1024 * 1024;

/// 節流器跟著 router 建立：每個 AppState（正式環境只有一個，測試每個 TestApp 一個）各自一份。
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/metadata/request", post(proxy_request))
        .route("/metadata/image", get(proxy_image))
        .layer(Extension(Arc::new(Limiters::from_policies())))
}

#[derive(Deserialize)]
pub struct ProxyRequest {
    source: Option<String>,
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    body: Option<String>,
}

#[derive(Serialize)]
pub struct ProxyResponse {
    status: u16,
    headers: Vec<(String, String)>,
    body: String,
}

fn upstream_error(error: UpstreamError) -> ApiError {
    match error {
        UpstreamError::Forbidden(reason) => ApiError::new(StatusCode::FORBIDDEN, "upstream_forbidden", reason),
        UpstreamError::Unreachable(reason) => ApiError::new(StatusCode::BAD_GATEWAY, "upstream_unreachable", reason),
        UpstreamError::TooLarge => ApiError::new(StatusCode::BAD_GATEWAY, "upstream_too_large", "upstream response too large"),
    }
}

/// Retry-After 可以是秒數或 HTTP 日期；沒有或解析失敗回傳 None，由 limiter 決定預設退避。
fn parse_retry_after(response: &UpstreamResponse) -> Option<Duration> {
    let raw = response.headers.iter().find(|(name, _)| name == "retry-after").map(|(_, value)| value.as_str())?;
    raw.trim().parse::<u64>().ok().map(Duration::from_secs).or_else(|| {
        httpdate::parse_http_date(raw)
            .ok()
            .and_then(|at| at.duration_since(std::time::SystemTime::now()).ok())
    })
}

async fn proxy_request(
    _user: AuthUser,
    State(state): State<AppState>,
    Extension(limiters): Extension<Arc<Limiters>>,
    Json(request): Json<ProxyRequest>,
) -> Result<Json<ProxyResponse>, ApiError> {
    let method = match request.method.as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "PUT" => reqwest::Method::PUT,
        _ => return Err(ApiError::new(StatusCode::BAD_REQUEST, "method_not_allowed", "unsupported method")),
    };
    let target = resolve_target(&request.url, &state.config, HostRule::MetadataApi).await.map_err(upstream_error)?;
    let policy = target.policy.expect("MetadataApi targets always have a policy");
    if let Some(source) = &request.source
        && source != policy.source
    {
        return Err(ApiError::new(StatusCode::FORBIDDEN, "upstream_forbidden", "source does not match host"));
    }
    let upstream_request = UpstreamRequest {
        method,
        headers: request.headers.into_iter().collect(),
        body: request.body,
    };
    let limiter = limiters.for_source(policy.source);
    let mut attempt = 0;
    loop {
        limiter.acquire().await;
        let response = fetch_bytes(&target, &state.config, upstream_request.clone(), MAX_METADATA_BYTES)
            .await
            .map_err(upstream_error)?;
        // 只有会退避的来源（桌面版 stopOn429 = false，目前是 VNDB）才登记退避；
        // 其他来源收到 429 直接回给前端，由前端停止当前任务（与桌面版相同）
        if response.status == 429 && policy.default_backoff_ms > 0 {
            // 退避期限记在来源共用的 limiter：其他分页、装置的请求也会一起等，下一轮 acquire 会等到期限
            limiter.record_429(
                parse_retry_after(&response),
                Duration::from_millis(policy.default_backoff_ms),
                Duration::from_millis(policy.max_backoff_ms),
            );
            if attempt < policy.max_429_retries {
                attempt += 1;
                continue;
            }
        } else if (200..300).contains(&response.status) {
            limiter.record_success();
        }
        return Ok(Json(ProxyResponse {
            status: response.status,
            headers: response.headers,
            body: String::from_utf8_lossy(&response.body).into_owned(),
        }));
    }
}

#[derive(Deserialize)]
pub struct ImageQuery {
    url: String,
}

async fn proxy_image(
    _user: AuthUser,
    State(state): State<AppState>,
    Query(query): Query<ImageQuery>,
) -> Result<Response, ApiError> {
    let target = resolve_target(&query.url, &state.config, HostRule::Image).await.map_err(upstream_error)?;
    let response = fetch_bytes(&target, &state.config, UpstreamRequest::get(), MAX_IMAGE_BYTES)
        .await
        .map_err(upstream_error)?;
    if !(200..300).contains(&response.status) {
        return Err(ApiError::new(StatusCode::BAD_GATEWAY, "upstream_status", format!("HTTP {}", response.status)));
    }
    let kind = sniff(&response.body)
        .ok_or_else(|| ApiError::new(StatusCode::UNSUPPORTED_MEDIA_TYPE, "not_image", "upstream did not return an image"))?;
    let mut http_response = response.body.into_response();
    let headers = http_response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(kind.mime()));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=86400"));
    Ok(http_response)
}
```

`reina-server/Cargo.toml` `[dependencies]` 補 `httpdate = "1"`。`reina-server/src/api.rs` 加 `pub mod metadata;` 並在路由彙總加 `.merge(metadata::handlers::routes())`。這兩個端點是一般 GET/POST handler，不經過 `tx::begin`／`tx::finish`，所以不會遞增版本。

- [ ] **Step 8：確認通過**

Run: `cargo test -p reina-server --test metadata`
Expected: 6 passed（VNDB 重試與退避兩個測試各約需 2–5 秒）。

- [ ] **Step 9：寫前端代理分支的失敗測試**

`src/metadata/api/serverProxy.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRateLimitError, HttpResponseError } from "@/utils/errors";

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { authenticatedFetch } = vi.hoisted(() => ({
	authenticatedFetch: vi.fn(),
}));
vi.mock("@/services/web/http", () => ({ authenticatedFetch }));

import { requestViaServerProxy } from "./serverProxy";

function proxyReply(status: number, body: string, headers: [string, string][] = []) {
	return new Response(JSON.stringify({ status, headers, body }), { status: 200 });
}

describe("requestViaServerProxy", () => {
	beforeEach(() => authenticatedFetch.mockReset());

	it("把請求原樣交給伺服器並解析 JSON", async () => {
		authenticatedFetch.mockResolvedValue(proxyReply(200, '{"results":[1]}'));
		const result = await requestViaServerProxy<{ results: number[] }>(
			"POST",
			"https://api.vndb.org/kana/vn",
			{ headers: { Accept: "application/json" } },
			{ filters: [] },
			"vndb",
		);
		expect(result.data).toEqual({ results: [1] });
		const [url, init] = authenticatedFetch.mock.calls[0];
		expect(url).toBe("/game/api/metadata/request");
		expect(JSON.parse(init.body)).toEqual({
			source: "vndb",
			method: "POST",
			url: "https://api.vndb.org/kana/vn",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: '{"filters":[]}',
		});
	});

	it("responseType text 回傳原文", async () => {
		authenticatedFetch.mockResolvedValue(proxyReply(200, "<html>x</html>"));
		const result = await requestViaServerProxy<string>(
			"GET",
			"https://www.dlsite.com/maniax/work/=/product_id/RJ1.html",
			{ responseType: "text" },
			undefined,
			"dlsite",
		);
		expect(result.data).toBe("<html>x</html>");
	});

	it("上游 429 轉成 ApiRateLimitError，bgm 為 fatal，vndb 不是", async () => {
		authenticatedFetch.mockResolvedValue(proxyReply(429, "", [["retry-after", "10"]]));
		const bgm = requestViaServerProxy("GET", "https://api.bgm.tv/v0/x", {}, undefined, "bgm");
		await expect(bgm).rejects.toBeInstanceOf(ApiRateLimitError);
		await expect(bgm).rejects.toMatchObject({ fatal: true, retryAfterMs: 10_000 });
		authenticatedFetch.mockResolvedValue(proxyReply(429, ""));
		await expect(
			requestViaServerProxy("POST", "https://api.vndb.org/kana/vn", {}, {}, "vndb"),
		).rejects.toMatchObject({ fatal: false });
	});

	it("上游其他錯誤轉成 HttpResponseError；代理本身失敗也丟錯", async () => {
		authenticatedFetch.mockResolvedValue(proxyReply(404, "nope"));
		await expect(
			requestViaServerProxy("GET", "https://api.bgm.tv/v0/x", {}, undefined, "bgm"),
		).rejects.toBeInstanceOf(HttpResponseError);
		authenticatedFetch.mockResolvedValue(new Response('{"code":"upstream_forbidden"}', { status: 403 }));
		await expect(
			requestViaServerProxy("GET", "https://api.bgm.tv/v0/x", {}, undefined, "bgm"),
		).rejects.toThrow(/403/);
	});
});
```

- [ ] **Step 10：執行確認失敗**

Run: `pnpm test:web src/metadata/api/serverProxy.test.ts`
Expected: FAIL，`Failed to resolve import "./serverProxy"`。

- [ ] **Step 11：實作 serverProxy 並接進 http.ts**

`src/metadata/api/rateLimit.ts` 在 `API_RATE_LIMIT_POLICIES` 定義之後加：

```ts
export function getApiRateLimitPolicy(
	source: ApiRateLimitSource,
): ApiRateLimitPolicy {
	return API_RATE_LIMIT_POLICIES[source];
}
```

（若 `ApiRateLimitPolicy` 尚未 export，一併改成 `export interface`。）

`src/metadata/api/http.ts`：第 52 行 `interface TauriHttpResponse` 改為 `export interface TauriHttpResponse`；`getApiRateLimitErrorMessage` 改為 `export function`；在 `requestTauriHttp` 內 `const rateLimitSource = ...` 之後加：

```ts
	// 網頁版沒有 tauri-plugin-http，請求交給 reina-server 代發；
	// 節流與 VNDB 的 429 重試由伺服器負責，避免兩層重試疊加。
	if (isWebRuntime()) {
		return requestViaServerProxy<T>(method, fullUrl, options, data, rateLimitSource);
	}
```

檔案頂端 import：`import { isWebRuntime } from "@/services/platform";`、`import { requestViaServerProxy } from "./serverProxy";`。

`src/metadata/api/serverProxy.ts`：

```ts
/**
 * @file 網頁版的中繼資料請求
 * @description 透過 reina-server 的 /api/metadata/request 代為連線外部來源。
 * 注意：TeleDrive 的 JWT 只放在送往本站的 Authorization，不會出現在轉送給上游的 headers 裡。
 */

import { authenticatedFetch } from "@/services/web/http";
import {
	ApiRateLimitError,
	AppError,
	HttpResponseError,
	toError,
} from "@/utils/errors";
import {
	getApiRateLimitErrorMessage,
	type TauriHttpOptions,
	type TauriHttpResponse,
} from "./http";
import { type ApiRateLimitSource, getApiRateLimitPolicy } from "./rateLimit";

interface ProxyReply {
	status: number;
	headers: [string, string][];
	body: string;
}

function parseRetryAfterMs(headers: [string, string][]): number | undefined {
	const raw = headers.find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	if (!raw) return undefined;
	const seconds = Number(raw);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const at = Date.parse(raw);
	return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function requestViaServerProxy<T>(
	method: "GET" | "POST" | "PATCH" | "PUT",
	fullUrl: string,
	options: TauriHttpOptions | undefined,
	data: unknown,
	source: ApiRateLimitSource | undefined,
): Promise<TauriHttpResponse<T>> {
	const response = await authenticatedFetch(
		`${import.meta.env.BASE_URL}api/metadata/request`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			signal: options?.signal,
			body: JSON.stringify({
				source: source ?? null,
				method,
				url: fullUrl,
				headers: {
					...(method === "GET" ? {} : { "Content-Type": "application/json" }),
					...options?.headers,
				},
				body: method === "GET" || data === undefined ? null : JSON.stringify(data),
			}),
		},
	);
	if (!response.ok) {
		throw new AppError({
			code: "metadata_proxy_failed",
			message: `Metadata proxy failed: ${response.status} ${method} ${fullUrl}`,
		});
	}
	const reply = (await response.json()) as ProxyReply;

	if (reply.status === 429 && source) {
		const retryAfterMs = parseRetryAfterMs(reply.headers);
		throw new ApiRateLimitError({
			source,
			message: getApiRateLimitErrorMessage(source),
			retryAfterMs,
			backoffUntil: Date.now() + (retryAfterMs ?? 0),
			fatal: getApiRateLimitPolicy(source).stopOn429,
		});
	}
	if (reply.status < 200 || reply.status >= 300) {
		throw new HttpResponseError({
			method,
			url: fullUrl,
			status: reply.status,
			statusText: "",
		});
	}

	let parsed: T;
	if (options?.responseType === "text") {
		parsed = reply.body as T;
	} else if (!reply.body) {
		parsed = null as T;
	} else {
		try {
			parsed = JSON.parse(reply.body) as T;
		} catch (error) {
			throw new AppError({
				code: "http_response_parse_failed",
				message: `Failed to parse HTTP response: ${method} ${fullUrl}`,
				cause: toError(error, "Failed to parse HTTP response"),
			});
		}
	}
	return { data: parsed, status: reply.status, statusText: "", headers: reply.headers };
}
```

- [ ] **Step 12：確認通過**

Run: `pnpm test:web src/metadata/api/serverProxy.test.ts`
Expected: 4 passed。

- [ ] **Step 13：寫圖片代理 hook 的失敗測試**

`src/hooks/queries/useProxiedImageUrl.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { isWebRuntime, getMetadataImageBlob } = vi.hoisted(() => ({
	isWebRuntime: vi.fn(),
	getMetadataImageBlob: vi.fn(),
}));
const desktopResolver = vi.fn((url?: string | null) => url ?? undefined);
vi.mock("@/services/platform", () => ({ isWebRuntime }));
vi.mock("@/services/web/metadataImage", () => ({ getMetadataImageBlob }));
vi.mock("@/hooks/common/useProxyImageUrlResolver", () => ({
	useProxyImageUrlResolver: () => desktopResolver,
}));

import { metadataImageKeys, useProxiedImageUrl } from "./useProxiedImageUrl";

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe("useProxiedImageUrl", () => {
	beforeEach(() => {
		isWebRuntime.mockReset();
		getMetadataImageBlob.mockReset();
		vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:img"), revokeObjectURL: vi.fn() });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("桌面版沿用既有的 reina-image 解析", () => {
		isWebRuntime.mockReturnValue(false);
		const { result } = renderHook(() => useProxiedImageUrl("https://t.vndb.org/a.jpg"), { wrapper });
		expect(result.current).toBe("https://t.vndb.org/a.jpg");
		expect(getMetadataImageBlob).not.toHaveBeenCalled();
	});

	it("網頁版經伺服器代理取得 Blob", async () => {
		isWebRuntime.mockReturnValue(true);
		getMetadataImageBlob.mockResolvedValue(new Blob(["x"]));
		const { result } = renderHook(() => useProxiedImageUrl("https://t.vndb.org/a.jpg"), { wrapper });
		await waitFor(() => expect(result.current).toBe("blob:img"));
		expect(metadataImageKeys.image("u")).toEqual(["server", "metadata-image", "u"]);
	});

	it("網頁版的 data: 網址直接使用，空值回傳 undefined", () => {
		isWebRuntime.mockReturnValue(true);
		expect(renderHook(() => useProxiedImageUrl("data:image/png;base64,AA"), { wrapper }).result.current).toBe("data:image/png;base64,AA");
		expect(renderHook(() => useProxiedImageUrl(null), { wrapper }).result.current).toBeUndefined();
	});
});
```

- [ ] **Step 14：執行確認失敗**

Run: `pnpm test:web src/hooks/queries/useProxiedImageUrl.test.tsx`
Expected: FAIL，`Failed to resolve import "./useProxiedImageUrl"`。

- [ ] **Step 15：實作圖片代理 service、hook 與元件**

`src/services/web/metadataImage.ts`：

```ts
import { authenticatedFetch } from "@/services/web/http";
import { AppError } from "@/utils/errors";

export async function getMetadataImageBlob(
	url: string,
	signal?: AbortSignal,
): Promise<Blob> {
	const response = await authenticatedFetch(
		`${import.meta.env.BASE_URL}api/metadata/image?url=${encodeURIComponent(url)}`,
		{ signal },
	);
	if (!response.ok) {
		throw new AppError({
			code: "metadata_image_failed",
			message: `Metadata image failed: ${response.status}`,
		});
	}
	return response.blob();
}
```

`src/hooks/queries/useProxiedImageUrl.ts`：

```ts
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useProxyImageUrlResolver } from "@/hooks/common/useProxyImageUrlResolver";
import { isWebRuntime } from "@/services/platform";
import { getMetadataImageBlob } from "@/services/web/metadataImage";

export const METADATA_IMAGE_GC_TIME = 5 * 60_000;

export const metadataImageKeys = {
	image: (url: string) => ["server", "metadata-image", url] as const,
};

function needsServerProxy(url: string): boolean {
	return /^https?:\/\//i.test(url);
}

/** 外部來源的圖片（候選封面、頭像、來源 icon）。網頁版一律經伺服器代理，符合 CSP。 */
export function useProxiedImageUrl(url: string | null | undefined): string | undefined {
	const web = isWebRuntime();
	const resolveDesktop = useProxyImageUrlResolver();
	const proxied = web && Boolean(url) && needsServerProxy(url as string);
	const { data: blob } = useQuery({
		queryKey: metadataImageKeys.image(url ?? ""),
		queryFn: ({ signal }) => getMetadataImageBlob(url as string, signal),
		enabled: proxied,
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: METADATA_IMAGE_GC_TIME,
		retry: false,
	});
	const [objectUrl, setObjectUrl] = useState<string>();

	useEffect(() => {
		if (!proxied || !blob) {
			setObjectUrl(undefined);
			return;
		}
		const next = URL.createObjectURL(blob);
		setObjectUrl(next);
		return () => URL.revokeObjectURL(next);
	}, [blob, proxied]);

	if (!url) return undefined;
	if (!web) return resolveDesktop(url);
	return proxied ? objectUrl : url;
}
```

`src/components/ProxiedImage/ProxiedImage.tsx`：

```tsx
import type { ImgHTMLAttributes } from "react";
import { useProxiedImageUrl } from "@/hooks/queries/useProxiedImageUrl";

type ProxiedImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src"> & {
	src: string | null | undefined;
};

export function ProxiedImage({ src, ...imgProps }: ProxiedImageProps) {
	const resolved = useProxiedImageUrl(src);
	return <img {...imgProps} src={resolved} />;
}
```

`src/components/ProxiedImage/index.ts`：`export { ProxiedImage } from "./ProxiedImage";`

- [ ] **Step 16：確認通過**

Run: `pnpm test:web src/hooks/queries/useProxiedImageUrl.test.tsx`
Expected: 3 passed。

- [ ] **Step 17：替換所有外部圖片的使用處**

每一處都把「`const resolveImageUrl = useProxyImageUrlResolver();` + `src={resolveImageUrl(x)}`」改成 `<ProxiedImage src={x} .../>`，或在非 `<img>` 的 MUI 元件用 `useProxiedImageUrl(x)`：

1. `src/components/AlertBox.tsx`：第 285 行所在的 `<img>`/`Box component="img"` 改成 `<ProxiedImage src={source.image} ... />`（保留原本的 className/alt）；移除第 247 行的 resolver。
2. `src/components/AddModal/GameSelectDialog.tsx` 第 137 行、`src/components/AddModal/MixedSourceConfirmDialog.tsx` 第 175 行、`src/pages/Detail/game-info/SourceCoverDialog.tsx` 第 108 行：同上，改 `<ProxiedImage src={displayInfo.image} .../>` / `<ProxiedImage src={option.image} .../>`。
3. `src/pages/Settings/AccountSettings.tsx` 第 173、471 行：頭像若是 MUI `Avatar`，在所屬元件頂端改用 `const avatarSrc = useProxiedImageUrl(getBgmAvatarUrl(username));`，`src={avatarSrc}`；第 471 行同理用 `profile?.avatar?.src`。
4. `src/components/Toolbar/Toolbar.tsx` 第 84–86 行：`const imageUrl = useProxiedImageUrl(adapter.iconUrl);`，其餘 `failedUrl` 邏輯不變（`imageUrl` 可能是 `undefined`，`failedUrl === imageUrl` 比較仍成立）。
5. `src/components/Windows.tsx` 第 95 行：html-react-parser 的 `replace` 回傳 `<ProxiedImage src={domNode.attribs.src} alt={domNode.attribs.alt ?? ""} />`，移除第 56 行的 resolver。

Run: `rg -n "useProxyImageUrlResolver" src --glob '!**/*.test.*'`
Expected: 只剩 `src/hooks/common/useProxyImageUrlResolver.ts`（定義）與 `src/hooks/queries/useProxiedImageUrl.ts`（桌面分支）。

- [ ] **Step 18：整體檢查**

Run: `pnpm test:web`
Expected: 全部通過。
Run: `pnpm check`
Expected: 無錯誤。
Run: `cargo clippy -p reina-server -- -D warnings`
Expected: 無警告。

- [ ] **Step 19：Commit**

```bash
git add src-tauri/reina-server/src/upstream.rs src-tauri/reina-server/src/upstream/limiter.rs src-tauri/reina-server/src/api/metadata.rs src-tauri/reina-server/src/api/metadata src-tauri/reina-server/src/api.rs src-tauri/reina-server/tests/metadata.rs src-tauri/reina-server/Cargo.toml src-tauri/Cargo.lock
git add src/metadata/api/serverProxy.ts src/metadata/api/serverProxy.test.ts src/metadata/api/http.ts src/metadata/api/rateLimit.ts src/services/web/metadataImage.ts src/hooks/queries/useProxiedImageUrl.ts src/hooks/queries/useProxiedImageUrl.test.tsx src/components/ProxiedImage src/components/AlertBox.tsx src/components/AddModal/GameSelectDialog.tsx src/components/AddModal/MixedSourceConfirmDialog.tsx src/pages/Detail/game-info/SourceCoverDialog.tsx src/pages/Settings/AccountSettings.tsx src/components/Toolbar/Toolbar.tsx src/components/Windows.tsx
git commit -m "feat: proxy metadata requests with shared rate limits

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### 任務 9：雲端掃描、嚴格比對與待確認流程

目標：reina-server 用使用者的 TeleDrive JWT 列出 `game` 資料夾，名稱規則與 bridge 的 `H:\game\` 一致，未出現過的遊戲建立為 `pending` 條目；前端以嚴格規則比對中繼資料候選，只有「完全相同或別名完全相同」才自動套用，其餘列入待確認；RJ 號碼反查要驗證 DLsite 作品類型，Steam App ID 經 VNDB 外部連結反查。之前封面腳本的四個誤配案例全部寫成回歸測試。

**Files:**
- Create: `reina-server/src/api/scan.rs`（只有宣告）
- Create: `reina-server/src/api/scan/naming.rs`（與 bridge 一致的名稱規則）
- Create: `reina-server/src/api/scan/teledrive.rs`（TeleDrive 列表 client）
- Create: `reina-server/src/api/scan/handlers.rs`
- Modify: `reina-server/src/api.rs`（`pub mod scan;` 與 `.merge(scan::handlers::routes())`）
- Modify: `reina-server/src/config.rs`（加 `game_folder`，Step 15）
- Modify: `reina-core/src/database/dto.rs`（`InsertGameData::cloud_placeholder`）
- Modify: `reina-core/src/database/repository/games_repository.rs`（`find_ids_by_teledrive_paths`、`find_scan_pending`）
- Test: `reina-server/tests/scan.rs`
- Create: `src/metadata/strictMatch.ts`、`src/metadata/strictMatch.test.ts`
- Create: `src/metadata/cloudScanResolve.ts`、`src/metadata/cloudScanResolve.test.ts`
- Modify: `src/metadata/api/dlsite.ts:24-37,396-420`（`work_type`）、`src/metadata/api/dlsite.ts`（新增 `fetchDlsiteWorkType`，接在 `fetchDlsiteById` 之後）、`src/types/types.ts:158-166`（`DlsiteData.work_type`）
- Create: `src/metadata/api/dlsite.test.ts`、`src/metadata/cloudScanDlsite.test.ts`（HTTP 層模擬，測真實的 DLsite 作品類型查詢）
- Modify: `src/metadata/api/vndb.ts`（`fetchVndbIdBySteamAppId`）
- Create: `src/services/web/scan.ts`
- Create: `src/hooks/features/games/useCloudScan.ts`、`src/hooks/features/games/useCloudScan.test.tsx`
- Create: `src/components/AddModal/CloudScanTab.tsx`
- Create: `src/components/AddModal/addModalTabs.ts`、`src/components/AddModal/addModalTabs.test.ts`（網頁版與桌面版的新增分頁規則）
- Modify: `src/components/AddModal/AddModal.tsx:74,452-470`（新增「雲端掃描」分頁，僅網頁版顯示）
- Modify: `src/locales/*/`

**Interfaces:**
- Consumes：任務 2 的 `InsertGameData` 新欄位 `teledrive_path: Option<String>`、`exe_relpath: Option<String>`、`scan_status: Option<String>`、`scan_candidates: Option<serde_json::Value>`，`UpdateGameData` 對應的 `Option<Option<…>>` 欄位，以及 `teledrive_path` 非空唯一索引；`GamesRepository::insert_in_connection(conn: &impl ConnectionTrait, game: InsertGameData) -> Result<FullGameData, DbErr>`；TS `UpdateGameParams.scan_status?: ScanStatus | null`、`scan_candidates?: ScanCandidate[] | null`。任務 3 的 `tx::begin`／`tx::finish(state, txn, result, bump)`、`AuthUser`（`token` 欄位）、`Config.teledrive_api: String`（本任務以 `url::Url::parse` 轉成 `Url`）、`Config::for_tests()`、`tests/support.rs` 的 `TestApp::with_config`、`OWNER_ID`、`SECRET`。本任務新增 `Config.game_folder: String`（env `REINA_GAME_FOLDER`，預設 `"game"`，Step 15）。任務 6 的 `checkServerVersion()` 與 `gameKeys`（已加 `"server"` 前綴）。任務 7 的 `setSourceCover`、`GameCoverImg`。任務 8 的 `ProxiedImage`（網頁版中繼資料請求已自動走代理）。
- Produces：
  - HTTP：`POST /game/api/scan` → `{ "added_ids": number[], "pending_ids": number[] }`（Write）；錯誤：TeleDrive 401 → 401 `teledrive_unauthorized`（前端依任務 4 刷新 token 後重試一次）、找不到 `game` 資料夾 → 404 `game_folder_missing`、TeleDrive 其他錯誤 → 502 `teledrive_unavailable`。
  - HTTP：`GET /game/api/scan/pending` → `ScanPendingItem[]`，`ScanPendingItem = { id: number, name: string, teledrive_path: string, scan_status: "pending" | "needs_confirmation", scan_candidates: ScanCandidate[] }`（Read）。
  - Rust：`naming::derive_game_names(rows: &[ListingRow]) -> Vec<String>`；`ListingRow { file_id, filename, is_dir, created_at }`。
  - TS：`normalizeTitle(value: string): string`；`classifyTitleMatch(query: string, titles: readonly (string | undefined)[]): TitleMatch`，`TitleMatch = { level: "exact" | "candidate" | "none"; matched?: string }`；`isDlsiteGameWorkType(workType: string | undefined): boolean`；`resolveCloudScanName(name, deps, sources): Promise<CloudScanOutcome>`；`useCloudScan()`。

#### 9A：伺服器端

- [ ] **Step 1：寫名稱規則的失敗測試**

`reina-server/src/api/scan.rs`：

```rust
pub mod handlers;
pub mod naming;
pub mod teledrive;
```

`reina-server/src/api/scan/naming.rs`（先放測試）：

```rust
//! 由 TeleDrive 的 game 資料夾列表推導遊戲名稱，規則必須與 bridge 一致：
//! - `tdapi.children_by_name`：同名（完全相同的 filename）保留 created_at 較新的一筆
//! - `GameCollection.get_member_names`：`.zip`（不分大小寫）去掉副檔名後當成資料夾
//! - `_resolve_game`：先找完全相同的 `<名稱>.zip`，找不到才不分大小寫找，多筆取最新
//! 其他一般檔案不算遊戲。名稱在 Windows 上不分大小寫，所以大小寫不同的名稱視為同一款。

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, is_dir: bool, created_at: &str) -> ListingRow {
        ListingRow { file_id: format!("id-{name}-{created_at}"), filename: name.into(), is_dir, created_at: created_at.into() }
    }

    #[test]
    fn 資料夾與_zip_都算遊戲_一般檔案不算() {
        let rows = vec![
            row("Foo", true, "2026-01-01T00:00:00"),
            row("Bar.zip", false, "2026-01-01T00:00:00"),
            row("readme.txt", false, "2026-01-01T00:00:00"),
            row("Baz.ZIP", false, "2026-01-01T00:00:00"),
        ];
        assert_eq!(derive_game_names(&rows), vec!["Bar", "Baz", "Foo"]);
    }

    #[test]
    fn 同名資料夾與_zip_只算一款() {
        let rows = vec![row("Foo", true, "2026-01-01T00:00:00"), row("Foo.zip", false, "2026-01-02T00:00:00")];
        assert_eq!(derive_game_names(&rows), vec!["Foo"]);
    }

    #[test]
    fn 大小寫不同只算一款_名稱取完全相同_zip_優先() {
        let rows = vec![
            row("Foo.ZIP", false, "2026-03-01T00:00:00"),
            row("foo.zip", false, "2026-01-01T00:00:00"),
        ];
        // 完全相同副檔名 `.zip` 的那筆優先，即使它比較舊
        assert_eq!(derive_game_names(&rows), vec!["foo"]);
    }

    #[test]
    fn 沒有完全相同_zip_時取最新的候選() {
        let rows = vec![
            row("Foo.ZIP", false, "2026-01-01T00:00:00"),
            row("foo.Zip", false, "2026-03-01T00:00:00"),
        ];
        assert_eq!(derive_game_names(&rows), vec!["foo"]);
    }

    #[test]
    fn 完全相同的檔名重複時保留較新的列() {
        let rows = vec![row("Foo.zip", false, "2026-01-01T00:00:00"), row("Foo.zip", false, "2026-02-01T00:00:00")];
        assert_eq!(derive_game_names(&rows), vec!["Foo"]);
    }

    #[test]
    fn 非_ascii_與逗號名稱原樣保留() {
        let rows = vec![row("廃村少女, 体験版.zip", false, "2026-01-01T00:00:00"), row("サブ救って!", true, "2026-01-01T00:00:00")];
        assert_eq!(derive_game_names(&rows), vec!["サブ救って!", "廃村少女, 体験版"]);
    }
}
```

- [ ] **Step 2：執行確認失敗**

Run: `cargo test -p reina-server --lib api::scan::naming`
Expected: 編譯失敗，`cannot find struct 'ListingRow'`（同時需先建立空的 `handlers.rs`、`teledrive.rs`，各一行 `//! 見任務 9`）。

- [ ] **Step 3：實作名稱規則**

`naming.rs` 測試模組上方：

```rust
use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ListingRow {
    pub file_id: String,
    pub filename: String,
    #[serde(rename = "isDir", default)]
    pub is_dir: bool,
    /// TeleDrive 存的是無時區的 UTC ISO 字串（datetime.utcnow），同格式可直接字串比較
    #[serde(default)]
    pub created_at: String,
}

fn is_zip_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".zip")
}

fn strip_zip_suffix(name: &str) -> &str {
    if is_zip_name(name) { &name[..name.len() - 4] } else { name }
}

/// 優先順序：完全相同 `.zip`（新者優先）> 其他大小寫的 zip（新者優先）> 資料夾（新者優先）
fn rank(row: &ListingRow) -> (u8, &str) {
    let tier = if !row.is_dir && row.filename.ends_with(".zip") {
        2
    } else if !row.is_dir {
        1
    } else {
        0
    };
    (tier, row.created_at.as_str())
}

pub fn derive_game_names(rows: &[ListingRow]) -> Vec<String> {
    // 1. children_by_name：完全相同的檔名只留最新
    let mut newest: BTreeMap<&str, &ListingRow> = BTreeMap::new();
    for row in rows {
        match newest.get(row.filename.as_str()) {
            Some(prev) if prev.created_at >= row.created_at => {}
            _ => {
                newest.insert(row.filename.as_str(), row);
            }
        }
    }
    // 2. 依不分大小寫的遊戲名稱分組，每組挑出 bridge 會解析到的那一筆
    let mut groups: BTreeMap<String, &ListingRow> = BTreeMap::new();
    for row in newest.values() {
        if !row.is_dir && !is_zip_name(&row.filename) {
            continue;
        }
        let key = strip_zip_suffix(&row.filename).to_lowercase();
        match groups.get(&key) {
            Some(prev) if rank(prev) >= rank(row) => {}
            _ => {
                groups.insert(key, row);
            }
        }
    }
    let mut names: Vec<String> = groups.values().map(|row| strip_zip_suffix(&row.filename).to_string()).collect();
    names.sort();
    names
}
```

- [ ] **Step 4：確認通過**

Run: `cargo test -p reina-server --lib api::scan::naming`
Expected: 6 passed。

- [ ] **Step 5：寫 TeleDrive 列表 client 的失敗測試**

`reina-server/src/api/scan/teledrive.rs`（先放測試）：

```rust
//! 以使用者自己的 TeleDrive JWT 讀取列表，行為對齊 bridge 的 `tdapi._list_paginated`：
//! `/folders` 不分頁一次回傳；`/files` 以 page_size=10000 分頁直到讀完。

#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::get;
    use axum::{Json, Router};
    use serde_json::json;
    use std::collections::HashMap;

    async fn spawn(router: Router) -> url::Url {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        url::Url::parse(&format!("http://{addr}")).unwrap()
    }

    fn auth_ok(headers: &HeaderMap) -> bool {
        headers.get("authorization").and_then(|v| v.to_str().ok()) == Some("Bearer tok")
    }

    #[tokio::test]
    async fn 讀完所有分頁並帶上使用者的_token() {
        let base = spawn(Router::new()
            .route("/api/v1/folders", get(|headers: HeaderMap, Query(q): Query<HashMap<String, String>>| async move {
                if !auth_ok(&headers) { return Err(StatusCode::UNAUTHORIZED); }
                let files = if q.get("parent_id").is_none() {
                    json!([{"file_id": "g", "filename": "game", "isDir": true, "created_at": "2026-01-01T00:00:00"}])
                } else {
                    json!([{"file_id": "d1", "filename": "Foo", "isDir": true, "created_at": "2026-01-01T00:00:00"}])
                };
                Ok(Json(json!({"files": files, "total": 1, "page": 1, "page_size": 1})))
            }))
            .route("/api/v1/files", get(|headers: HeaderMap, Query(q): Query<HashMap<String, String>>| async move {
                if !auth_ok(&headers) { return Err(StatusCode::UNAUTHORIZED); }
                assert_eq!(q["parent_id"], "g");
                assert_eq!(q["page_size"], "10000");
                let page: u32 = q["page"].parse().unwrap();
                let batch: Vec<_> = if page == 1 {
                    (0..10000).map(|i| json!({"file_id": format!("f{i}"), "filename": format!("g{i}.zip"), "isDir": false, "created_at": "2026-01-01T00:00:00"})).collect()
                } else {
                    vec![json!({"file_id": "last", "filename": "Last.zip", "isDir": false, "created_at": "2026-01-01T00:00:00"})]
                };
                Ok(Json(json!({"files": batch, "total": 10001, "page": page, "page_size": 10000})))
            })))
            .await;
        let client = TeleDriveClient::new(reqwest::Client::new(), base, "tok".into());
        let game = client.find_game_folder("game").await.unwrap().unwrap();
        assert_eq!(game, "g");
        let rows = client.list_children(&game).await.unwrap();
        assert_eq!(rows.len(), 1 + 10001);
        assert!(rows.iter().any(|r| r.filename == "Last.zip"));
    }

    #[tokio::test]
    async fn token_失效回傳_unauthorized_找不到資料夾回傳_none() {
        let base = spawn(Router::new().route("/api/v1/folders", get(|headers: HeaderMap| async move {
            if !auth_ok(&headers) { return Err(StatusCode::UNAUTHORIZED); }
            Ok(Json(json!({"files": [], "total": 0, "page": 1, "page_size": 0})))
        })))
        .await;
        let bad = TeleDriveClient::new(reqwest::Client::new(), base.clone(), "wrong".into());
        assert!(matches!(bad.find_game_folder("game").await, Err(TeleDriveError::Unauthorized)));
        let good = TeleDriveClient::new(reqwest::Client::new(), base, "tok".into());
        assert!(good.find_game_folder("game").await.unwrap().is_none());
    }
}
```

- [ ] **Step 6：執行確認失敗**

Run: `cargo test -p reina-server --lib api::scan::teledrive`
Expected: 編譯失敗，`cannot find struct 'TeleDriveClient'`。

- [ ] **Step 7：實作 TeleDrive client**

`teledrive.rs` 測試模組上方：

```rust
use serde::Deserialize;

use crate::api::scan::naming::ListingRow;

/// 與 bridge `tdapi.PAGE_SIZE` 相同
pub const PAGE_SIZE: usize = 10_000;

#[derive(Debug, thiserror::Error)]
pub enum TeleDriveError {
    #[error("teledrive rejected the token")]
    Unauthorized,
    #[error("teledrive unavailable: {0}")]
    Unavailable(String),
}

#[derive(Deserialize)]
struct ListResponse {
    #[serde(default)]
    files: Vec<ListingRow>,
    #[serde(default)]
    total: usize,
}

pub struct TeleDriveClient {
    http: reqwest::Client,
    base: url::Url,
    token: String,
}

impl TeleDriveClient {
    pub fn new(http: reqwest::Client, base: url::Url, token: String) -> Self {
        Self { http, base, token }
    }

    async fn get(&self, path: &str, query: &[(&str, String)]) -> Result<ListResponse, TeleDriveError> {
        let url = self.base.join(path).map_err(|e| TeleDriveError::Unavailable(e.to_string()))?;
        let response = self
            .http
            .get(url)
            .bearer_auth(&self.token)
            .query(query)
            .send()
            .await
            .map_err(|e| TeleDriveError::Unavailable(e.to_string()))?;
        if response.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Err(TeleDriveError::Unauthorized);
        }
        if !response.status().is_success() {
            return Err(TeleDriveError::Unavailable(format!("HTTP {}", response.status())));
        }
        response.json().await.map_err(|e| TeleDriveError::Unavailable(e.to_string()))
    }

    /// 根目錄下名稱完全相同的資料夾；重複時取最新（對齊 `children_by_name`）。
    pub async fn find_game_folder(&self, name: &str) -> Result<Option<String>, TeleDriveError> {
        let root = self.get("/api/v1/folders", &[]).await?;
        Ok(root
            .files
            .into_iter()
            .filter(|row| row.is_dir && row.filename == name)
            .max_by(|a, b| a.created_at.cmp(&b.created_at))
            .map(|row| row.file_id))
    }

    pub async fn list_children(&self, parent_id: &str) -> Result<Vec<ListingRow>, TeleDriveError> {
        // TeleDrive 的 GET /folders 不分页，一次回传该层全部资料夹（routes.py list_folders 固定 page=1）；
        // /files 才有分页，所以只有下面的 /files 需要逐页读取
        let mut rows = self.get("/api/v1/folders", &[("parent_id", parent_id.to_string())]).await?.files;
        let mut page = 1usize;
        let mut files: Vec<ListingRow> = Vec::new();
        loop {
            let batch = self
                .get(
                    "/api/v1/files",
                    &[("parent_id", parent_id.to_string()), ("page", page.to_string()), ("page_size", PAGE_SIZE.to_string())],
                )
                .await?;
            let count = batch.files.len();
            files.extend(batch.files);
            if count < PAGE_SIZE || files.len() >= batch.total {
                break;
            }
            page += 1;
        }
        rows.extend(files);
        Ok(rows)
    }
}
```

- [ ] **Step 8：確認通過**

Run: `cargo test -p reina-server --lib api::scan::teledrive`
Expected: 2 passed。

- [ ] **Step 9：寫掃描端點的失敗整合測試**

`reina-server/tests/scan.rs`：

```rust
mod support;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::Query;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::routing::get;
use axum::{Json, Router};
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode};
use serde_json::{json, Value};
use support::{OWNER_ID, SECRET, TestApp};

type Listing = Arc<Mutex<Vec<Value>>>;

/// 假 TeleDrive 驗證轉送過來的 token：必須是同一把金鑰簽給擁有者的 JWT。
/// support::owner_token() 每次的 exp 不同，所以不能比對字串，要解碼驗證。
fn forwarded_owner_token(headers: &HeaderMap) -> bool {
    let Some(token) = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
    else {
        return false;
    };
    decode::<Value>(token, &DecodingKey::from_secret(SECRET.as_bytes()), &Validation::new(Algorithm::HS256))
        .map(|data| data.claims["user_id"] == json!(OWNER_ID))
        .unwrap_or(false)
}

/// `accept_owner = false` 模擬 TeleDrive 拒絕所有 token
async fn fake_teledrive(listing: Listing, accept_owner: bool) -> String {
    let router = Router::new()
        .route("/api/v1/folders", get({
            let listing = listing.clone();
            move |headers: HeaderMap, Query(q): Query<HashMap<String, String>>| {
                let listing = listing.clone();
                async move {
                    if !accept_owner || !forwarded_owner_token(&headers) {
                        return Err(StatusCode::UNAUTHORIZED);
                    }
                    let files: Vec<Value> = if q.get("parent_id").is_none() {
                        vec![json!({"file_id": "g", "filename": "game", "isDir": true, "created_at": "2026-01-01T00:00:00"})]
                    } else {
                        listing.lock().unwrap().iter().filter(|v| v["isDir"] == true).cloned().collect()
                    };
                    Ok(Json(json!({"total": files.len(), "files": files, "page": 1, "page_size": 0})))
                }
            }
        }))
        .route("/api/v1/files", get({
            let listing = listing.clone();
            move || {
                let listing = listing.clone();
                async move {
                    let files: Vec<Value> = listing.lock().unwrap().iter().filter(|v| v["isDir"] == false).cloned().collect();
                    Json(json!({"total": files.len(), "files": files, "page": 1, "page_size": 10000}))
                }
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

fn item(name: &str, is_dir: bool) -> Value {
    json!({"file_id": format!("id-{name}"), "filename": name, "isDir": is_dir, "created_at": "2026-01-01T00:00:00"})
}

async fn call(app: &TestApp, method: Method, uri: &str) -> (StatusCode, Value) {
    let response = app
        .send(
            Request::builder()
                .method(method)
                .uri(uri)
                .header(header::AUTHORIZATION, format!("Bearer {}", app.owner_token()))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    let status = response.status;
    let bytes = response.body.clone();
    (status, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn app_with(listing: Listing) -> TestApp {
    let base = fake_teledrive(listing, true).await;
    TestApp::with_config(move |config| config.teledrive_api = base).await
}

#[tokio::test]
async fn 掃描建立_pending_條目_重掃不重複() {
    let listing: Listing = Arc::new(Mutex::new(vec![item("Foo", true), item("Bar.zip", false), item("Baz.ZIP", false), item("notes.txt", false)]));
    let app = app_with(listing.clone()).await;
    let before = app.data_version().await;
    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(json["added_ids"].as_array().unwrap().len(), 3);
    assert_eq!(json["pending_ids"].as_array().unwrap().len(), 3);
    assert_eq!(app.data_version().await, before + 1);

    let (_, pending) = call(&app, Method::GET, "/game/api/scan/pending").await;
    let mut paths: Vec<String> = pending.as_array().unwrap().iter().map(|p| p["teledrive_path"].as_str().unwrap().to_string()).collect();
    paths.sort();
    assert_eq!(paths, vec!["game/Bar", "game/Baz", "game/Foo"]);
    assert!(pending.as_array().unwrap().iter().all(|p| p["scan_status"] == "pending"));

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
    let (a, b) = tokio::join!(call(&app, Method::POST, "/game/api/scan"), call(&app, Method::POST, "/game/api/scan"));
    assert_eq!(a.0, StatusCode::OK);
    assert_eq!(b.0, StatusCode::OK);
    let total = a.1["added_ids"].as_array().unwrap().len() + b.1["added_ids"].as_array().unwrap().len();
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

/// 啟動一個只有固定路由的假 TeleDrive，用來模擬「沒有 game 資料夾」與「列表中途失敗」
async fn fake_teledrive_with(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{addr}")
}

#[tokio::test]
async fn 第一次使用沒有_game_資料夾時回_404_且版本不變() {
    // 根目錄只有別的資料夾，沒有 game
    let router = Router::new()
        .route("/api/v1/folders", get(|| async {
            Json(json!({"total": 1, "files": [{"file_id": "x", "filename": "photos", "isDir": true, "created_at": "2026-01-01T00:00:00"}], "page": 1, "page_size": 0}))
        }))
        .route("/api/v1/files", get(|| async { Json(json!({"total": 0, "files": [], "page": 1, "page_size": 10000})) }));
    let base = fake_teledrive_with(router).await;
    let app = TestApp::with_config(move |config| config.teledrive_api = base).await;
    let before = app.data_version().await;
    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(json["code"], "game_folder_missing");
    assert_eq!(app.data_version().await, before);
}

#[tokio::test]
async fn teledrive_列表中途失敗時回_502_不留下任何條目() {
    // 根目錄找得到 game，資料夾列表也正常，但 /files 回 500：不能只新增資料夾那一半
    let router = Router::new()
        .route("/api/v1/folders", get(|Query(q): Query<HashMap<String, String>>| async move {
            if q.get("parent_id").is_none() {
                Json(json!({"total": 1, "files": [{"file_id": "g", "filename": "game", "isDir": true, "created_at": "2026-01-01T00:00:00"}], "page": 1, "page_size": 0}))
            } else {
                Json(json!({"total": 1, "files": [{"file_id": "id-Foo", "filename": "Foo", "isDir": true, "created_at": "2026-01-01T00:00:00"}], "page": 1, "page_size": 0}))
            }
        }))
        .route("/api/v1/files", get(|| async { StatusCode::INTERNAL_SERVER_ERROR }));
    let base = fake_teledrive_with(router).await;
    let app = TestApp::with_config(move |config| config.teledrive_api = base).await;
    let before = app.data_version().await;
    let (status, json) = call(&app, Method::POST, "/game/api/scan").await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(json["code"], "teledrive_unavailable");
    assert_eq!(app.data_version().await, before);
    let (_, pending) = call(&app, Method::GET, "/game/api/scan/pending").await;
    assert!(pending.as_array().unwrap().is_empty(), "列表失敗時不能寫入任何遊戲");
}
```

（假 TeleDrive 以 `support::SECRET` 解碼驗證轉送來的 token，並確認 `user_id` 是 `OWNER_ID`，藉此證明伺服器轉送的是使用者自己的 JWT。）

- [ ] **Step 10：執行確認失敗**

Run: `cargo test -p reina-server --test scan`
Expected: 全部 FAIL（`/game/api/scan` 回 404）。

- [ ] **Step 11：寫 core 查詢的失敗測試**

`reina-core/tests/scan_queries.rs`：

```rust
use reina_core::database::connection::connect_database;
use reina_core::database::dto::InsertGameData;
use reina_core::database::repository::games_repository::GamesRepository;

#[tokio::test]
async fn 依_teledrive_path_查出既有_id_與_pending_清單() {
    let dir = tempfile::tempdir().unwrap();
    let db = connect_database(&dir.path().join("t.db")).await.unwrap();
    let foo = GamesRepository::insert(&db, InsertGameData::cloud_placeholder("Foo", Some("game/Foo".into()))).await.unwrap();
    GamesRepository::insert(&db, InsertGameData::cloud_placeholder("Manual", None)).await.unwrap();

    let found = GamesRepository::find_ids_by_teledrive_paths(&db, &["game/Foo".into(), "game/Missing".into()]).await.unwrap();
    assert_eq!(found.get("game/Foo"), Some(&foo.id));
    assert!(!found.contains_key("game/Missing"));

    let pending = GamesRepository::find_scan_pending(&db).await.unwrap();
    assert_eq!(pending.len(), 1, "手動新增的條目沒有 teledrive_path，不算掃描待處理");
    assert_eq!(pending[0].name, "Foo");
    assert_eq!(pending[0].scan_status, "pending");
    assert!(pending[0].scan_candidates.is_empty());
}
```

- [ ] **Step 12：執行確認失敗**

Run: `cargo test -p reina-core --test scan_queries`
Expected: 編譯失敗，`no function or associated item named 'cloud_placeholder'`。

- [ ] **Step 13：實作 core 建構函式與查詢**

`reina-core/src/database/dto.rs` 在 `InsertGameData` 定義之後加（欄位清單須與任務 2 完成後的 `InsertGameData` 完全一致；此處列出的是目前的欄位加上任務 2 新增的四個）：

```rust
impl InsertGameData {
    /// 雲端掃描建立的佔位條目：還沒有任何來源資料，只有名稱與 TeleDrive 路徑。
    /// `teledrive_path` 為 None 時代表手動新增的一般條目（測試用）。
    pub fn cloud_placeholder(name: &str, teledrive_path: Option<String>) -> Self {
        let scan_status = teledrive_path.as_ref().map(|_| "pending".to_string());
        Self {
            id_type: "custom".to_string(),
            date: None,
            localpath: None,
            executable: None,
            launch_type: default_launch_type(),
            steam_launch_id: None,
            savepath: None,
            autosave: None,
            maxbackups: None,
            clear: None,
            le_launch: None,
            magpie: None,
            custom_data: Some(CustomData { name: Some(name.to_string()), ..Default::default() }),
            sources: Vec::new(),
            teledrive_path,
            exe_relpath: None,
            scan_status,
            scan_candidates: None,
        }
    }
}
```

`games_repository.rs` 的 `impl GamesRepository` 內加入（頂端補 `use std::collections::HashMap;`、`use sea_orm::{ColumnTrait, QueryFilter, QuerySelect};` 中尚未匯入者）：

```rust
    pub async fn find_ids_by_teledrive_paths(
        conn: &impl ConnectionTrait,
        paths: &[String],
    ) -> Result<HashMap<String, i32>, DbErr> {
        if paths.is_empty() {
            return Ok(HashMap::new());
        }
        let rows: Vec<(i32, Option<String>)> = games::Entity::find()
            .select_only()
            .column(games::Column::Id)
            .column(games::Column::TeledrivePath)
            .filter(games::Column::TeledrivePath.is_in(paths.iter().cloned()))
            .into_tuple()
            .all(conn)
            .await?;
        Ok(rows.into_iter().filter_map(|(id, path)| path.map(|p| (p, id))).collect())
    }

    pub async fn find_scan_pending(conn: &impl ConnectionTrait) -> Result<Vec<ScanPendingRow>, DbErr> {
        let models = games::Entity::find()
            .filter(games::Column::TeledrivePath.is_not_null())
            .filter(games::Column::ScanStatus.is_in(["pending", "needs_confirmation"]))
            .all(conn)
            .await?;
        Ok(models
            .into_iter()
            .map(|model| ScanPendingRow {
                id: model.id,
                name: model
                    .custom_data
                    .as_ref()
                    .and_then(|data| data.name.clone())
                    .unwrap_or_default(),
                teledrive_path: model.teledrive_path.unwrap_or_default(),
                scan_status: model.scan_status.unwrap_or_else(|| "pending".into()),
                scan_candidates: model
                    .scan_candidates
                    .and_then(|value| value.as_array().cloned())
                    .unwrap_or_default(),
            })
            .collect())
    }
```

同檔 `impl` 之外：

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct ScanPendingRow {
    pub id: i32,
    pub name: String,
    pub teledrive_path: String,
    pub scan_status: String,
    pub scan_candidates: Vec<serde_json::Value>,
}
```

（`model.custom_data` 的型別以任務 2 之後 entity 的實際型別為準；若是 `Option<CustomData>` 如上，若是非 Option 則去掉 `.as_ref()`。）

- [ ] **Step 14：確認 core 查詢通過**

Run: `cargo test -p reina-core --test scan_queries`
Expected: 1 passed。

- [ ] **Step 15：Config 加 `game_folder`**

掃描要知道 TeleDrive 根目錄下哪個資料夾是遊戲庫（bridge 的 `game_folder` 設定，預設 `game`）。在 `reina-server/src/config.rs`（任務 3 建立）先加測試，再加欄位。

同檔測試模組的 `必填欄位齊全時套用預設值` 最後加一行：

```rust
        assert_eq!(config.game_folder, "game");
```

`可覆寫選填欄位並去掉網址結尾斜線` 的 `lookup(&[…])` 加入 `("REINA_GAME_FOLDER", " games ")`，並在最後加一行：

```rust
        assert_eq!(config.game_folder, "games");
```

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib config`
Expected: 編譯失敗，`no field 'game_folder' on type 'Config'`。

接著改 `config.rs` 四處：

1. `pub struct Config` 在 `pub static_dir: PathBuf,` 之後加入：

```rust
    /// TeleDrive 根目录下存放游戏的资料夹名称，与 bridge 的 game_folder 设定一致
    pub game_folder: String,
```

2. `Config::from_lookup` 的 `Ok(Self { … })` 在 `static_dir: …,` 之後加入：

```rust
            game_folder: optional("REINA_GAME_FOLDER").unwrap_or_else(|| "game".to_string()),
```

3. `Config::for_tests()` 的 `Self { … }` 在 `static_dir: …,` 之後加入 `game_folder: "game".to_string(),`。

4. `impl fmt::Debug for Config` 在 `.field("static_dir", &self.static_dir)` 之後加入 `.field("game_folder", &self.game_folder)`。

Run: `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --lib config`
Expected: `5 passed`。

- [ ] **Step 16：實作掃描端點**

`reina-server/src/api/scan/handlers.rs`：

```rust
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::{get, post};
use axum::{Json, Router};
use sea_orm::{DatabaseTransaction, SqlErr, TransactionTrait};
use serde::Serialize;

use reina_core::database::dto::InsertGameData;
use reina_core::database::repository::games_repository::{GamesRepository, ScanPendingRow};

use crate::api::auth::AuthUser;
use crate::api::scan::naming::derive_game_names;
use crate::api::scan::teledrive::{TeleDriveClient, TeleDriveError};
use crate::app::AppState;
use crate::error::ApiError;
use crate::tx;

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/scan", post(scan))
        .route("/scan/pending", get(pending))
}

#[derive(Serialize)]
pub struct ScanResponse {
    added_ids: Vec<i32>,
    pending_ids: Vec<i32>,
}

fn teledrive_error(error: TeleDriveError) -> ApiError {
    match error {
        TeleDriveError::Unauthorized => ApiError::new(StatusCode::UNAUTHORIZED, "teledrive_unauthorized", "TeleDrive rejected the token"),
        TeleDriveError::Unavailable(reason) => ApiError::new(StatusCode::BAD_GATEWAY, "teledrive_unavailable", reason),
    }
}

async fn scan(user: AuthUser, State(state): State<AppState>) -> Result<Json<ScanResponse>, ApiError> {
    // 列表在写入 transaction 之外读完，不占用 SQLite 的写锁
    let base = url::Url::parse(&state.config.teledrive_api)
        .map_err(|error| ApiError::internal(format!("TELEDRIVE_API 不是合法网址: {error}")))?;
    let client = TeleDriveClient::new(state.http.clone(), base, user.token.clone());
    let game_folder = client
        .find_game_folder(&state.config.game_folder)
        .await
        .map_err(teledrive_error)?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "game_folder_missing", "TeleDrive has no game folder"))?;
    let rows = client.list_children(&game_folder).await.map_err(teledrive_error)?;
    let names = derive_game_names(&rows);
    let paths: Vec<String> = names
        .iter()
        .map(|name| format!("{}/{name}", state.config.game_folder))
        .collect();

    let txn = tx::begin(&state.db).await?;
    let result = insert_missing(&txn, &names, &paths).await;
    // 没有新增任何游戏时只 commit、不递增 data_version，避免每次扫描都让所有页面重新载入
    let response = tx::finish(&state, txn, result, |response: &ScanResponse| !response.added_ids.is_empty()).await?;
    Ok(Json(response))
}

async fn insert_missing(
    txn: &DatabaseTransaction,
    names: &[String],
    paths: &[String],
) -> Result<ScanResponse, ApiError> {
    let existing = GamesRepository::find_ids_by_teledrive_paths(txn, paths).await?;
    let mut added_ids = Vec::new();
    for (name, path) in names.iter().zip(paths.iter()) {
        if existing.contains_key(path) {
            continue;
        }
        // 每笔一个 savepoint：并行扫描撞到唯一索引时只略过这一笔，不让整个 transaction 失败
        let savepoint = txn.begin().await?;
        match GamesRepository::insert_in_connection(&savepoint, InsertGameData::cloud_placeholder(name, Some(path.clone()))).await {
            Ok(game) => {
                savepoint.commit().await?;
                added_ids.push(game.id);
            }
            Err(error) if matches!(error.sql_err(), Some(SqlErr::UniqueConstraintViolation(_))) => {
                savepoint.rollback().await?;
            }
            Err(error) => return Err(ApiError::from(error)),
        }
    }
    let pending_ids = GamesRepository::find_scan_pending(txn).await?.into_iter().map(|row| row.id).collect();
    Ok(ScanResponse { added_ids, pending_ids })
}

async fn pending(_user: AuthUser, State(state): State<AppState>) -> Result<Json<Vec<ScanPendingRow>>, ApiError> {
    Ok(Json(GamesRepository::find_scan_pending(&state.db).await?))
}
```

`reina-server/src/api.rs` 加 `pub mod scan;` 並在路由彙總加 `.merge(scan::handlers::routes())`。

- [ ] **Step 17：確認通過**

Run: `cargo test -p reina-server --test scan`
Expected: 7 passed。

Run: `cargo clippy -p reina-server -p reina-core -- -D warnings`
Expected: 無警告。

#### 9B：前端比對與流程

- [ ] **Step 18：寫嚴格比對的失敗測試（含四個誤配回歸案例）**

`src/metadata/strictMatch.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import {
	classifyTitleMatch,
	isDlsiteGameWorkType,
	normalizeTitle,
} from "./strictMatch";

describe("normalizeTitle", () => {
	it("NFKC、忽略大小寫、壓縮空白", () => {
		expect(normalizeTitle("  ＶｅｎｕｓＢｌｏｏｄ　-GAIA- ")).toBe("venusblood -gaia-");
	});
});

describe("classifyTitleMatch：之前封面腳本的誤配必須不再自動套用", () => {
	it("h 不會配到 H+", () => {
		expect(classifyTitleMatch("h", ["H+"]).level).toBe("none");
	});
	it("RANZE 不會配到 RAYZE", () => {
		expect(classifyTitleMatch("RANZE", ["RAYZE"]).level).toBe("none");
	});
	it("Hypnosis App 2 不會配到 Hypnosis", () => {
		expect(classifyTitleMatch("Hypnosis App 2", ["Hypnosis"]).level).toBe("none");
	});
});

describe("classifyTitleMatch：可以自動套用的情況", () => {
	it("主標題完全相同（忽略大小寫）", () => {
		expect(classifyTitleMatch("To Be or Not to Be", ["To Be or Not To Be"])).toEqual({
			level: "exact",
			matched: "To Be or Not To Be",
		});
	});
	it("別名完全相同", () => {
		expect(
			classifyTitleMatch("Koikata", ["Koi Suru Kimochi no Kasanekata", undefined, "Koikata"]).level,
		).toBe("exact");
	});
	it("全形與半形視為相同", () => {
		expect(classifyTitleMatch("ＶｅｎｕｓＢｌｏｏｄ", ["VenusBlood"]).level).toBe("exact");
	});
});

describe("classifyTitleMatch：只能列為待確認", () => {
	it("包含關係且長度比 ≥ 0.8", () => {
		expect(
			classifyTitleMatch("Amaoto ni Michiru Yoru", ["Amaoto ni Michiru Yoru EX"]).level,
		).toBe("candidate");
	});
	it("包含關係但較短名稱少於 4 字", () => {
		expect(classifyTitleMatch("Rei", ["Rei!"]).level).toBe("none");
	});
	it("完全不相干", () => {
		expect(classifyTitleMatch("黄昏少女", ["昨日の魔女は今日の夢"]).level).toBe("none");
	});
});

describe("isDlsiteGameWorkType", () => {
	it("RJ01000250 的 SOU（音聲）不是遊戲", () => {
		expect(isDlsiteGameWorkType("SOU")).toBe(false);
	});
	it("RJ01276936 的 SLN（模擬）是遊戲", () => {
		expect(isDlsiteGameWorkType("SLN")).toBe(true);
	});
	it("漫畫與未知類型不是遊戲", () => {
		expect(isDlsiteGameWorkType("MNG")).toBe(false);
		expect(isDlsiteGameWorkType(undefined)).toBe(false);
	});
});
```

- [ ] **Step 19：執行確認失敗**

Run: `pnpm test:web src/metadata/strictMatch.test.ts`
Expected: FAIL，`Failed to resolve import "./strictMatch"`。

- [ ] **Step 20：實作 `src/metadata/strictMatch.ts`**

```ts
/**
 * @file 雲端掃描用的嚴格標題比對
 * @description 之前以相似度自動套用造成大量誤配（h→H+、RANZE→RAYZE、Hypnosis App 2→Hypnosis），
 * 所以掃描只在「完全相同或別名完全相同」時自動套用；包含關係只列為待確認。
 */

export type TitleMatchLevel = "exact" | "candidate" | "none";

export interface TitleMatch {
	level: TitleMatchLevel;
	matched?: string;
}

const MIN_CANDIDATE_LENGTH = 4;
const MIN_CANDIDATE_RATIO = 0.8;

/** DLsite 的遊戲類 work_type。SOU（音聲）、MNG（漫畫）、ICG（CG 集）等都不是遊戲。 */
const DLSITE_GAME_WORK_TYPES = new Set([
	"ACN",
	"QIZ",
	"ADV",
	"RPG",
	"TBL",
	"DNV",
	"SLN",
	"TYP",
	"STG",
	"PZL",
	"ETC",
]);

export function normalizeTitle(value: string): string {
	return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function length(value: string): number {
	return [...value].length;
}

export function classifyTitleMatch(
	query: string,
	titles: readonly (string | undefined | null)[],
): TitleMatch {
	const q = normalizeTitle(query);
	if (!q) return { level: "none" };
	let candidate: string | undefined;
	for (const title of titles) {
		if (!title) continue;
		const t = normalizeTitle(title);
		if (!t) continue;
		if (t === q) return { level: "exact", matched: title };
		const [short, long] = length(t) < length(q) ? [t, q] : [q, t];
		if (
			!candidate &&
			long.includes(short) &&
			length(short) >= MIN_CANDIDATE_LENGTH &&
			length(short) / length(long) >= MIN_CANDIDATE_RATIO
		) {
			candidate = title;
		}
	}
	return candidate ? { level: "candidate", matched: candidate } : { level: "none" };
}

export function isDlsiteGameWorkType(workType: string | undefined): boolean {
	return workType ? DLSITE_GAME_WORK_TYPES.has(workType.toUpperCase()) : false;
}
```

- [ ] **Step 21：確認通過**

Run: `pnpm test:web src/metadata/strictMatch.test.ts`
Expected: 12 passed。

- [ ] **Step 22：讓 DLsite 資料帶出 `work_type`**

`src/types/types.ts` 的 `DlsiteData` 加 `work_type?: string;`。

`src/metadata/api/dlsite.ts`：`RawDlsiteProductInfo` 加 `work_type?: string;`；`transformDetailDocument` 的 `const data: DlsiteData = { ... }` 內加一個欄位：

```ts
		work_type: normalizeText(info?.work_type) || undefined,
```

（`normalizeText` 已是該檔既有的輔助函式。）

Run: `pnpm typecheck`
Expected: 無錯誤。

- [ ] **Step 22a：寫掃描專用作品類型查詢的失敗測試（HTTP 層模擬）**

掃描**不能**用 `fetchDlsiteById` 判斷作品類型：它在資訊 API 失敗、作品頁成功時會吞掉資訊 API 的錯誤（`dlsite.ts:463-474`），回傳沒有 `work_type` 的資料，掃描就會把「查詢失敗」誤判成「非遊戲」並存成 `needs_confirmation`、不再重試。所以另寫一個只查資訊 API 的函式。測試保留真實的 `dlsite.ts`，只模擬它底下的 `./http`，才能涵蓋這段邏輯。

新檔 `src/metadata/api/dlsite.test.ts`：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRateLimitError, HttpResponseError } from "@/utils/errors";

// 只模拟 dlsite.ts 底下的 HTTP 层，dlsite.ts 本身用真实实作
const { get, getText } = vi.hoisted(() => ({ get: vi.fn(), getText: vi.fn() }));
vi.mock("./http", () => ({ default: { get, getText } }));
vi.mock("@/providers/i18n", () => ({ default: { language: "ja-JP" } }));

import { fetchDlsiteWorkType } from "./dlsite";

const WORK_PAGE_OK = "<html><body><h1 id='work_name'>作品</h1></body></html>";

describe("fetchDlsiteWorkType", () => {
	beforeEach(() => {
		get.mockReset();
		getText.mockReset();
		// 作品页永远可以成功：确认结果只取决于资讯 API，不会用作品页掩盖失败
		getText.mockResolvedValue({ data: WORK_PAGE_OK });
	});

	it("資訊 API 有作品時回傳 work_type，而且不讀作品頁", async () => {
		get.mockResolvedValue({ data: { RJ01000250: { work_type: "SOU" } } });
		await expect(fetchDlsiteWorkType("RJ01000250")).resolves.toBe("SOU");
		expect(get).toHaveBeenCalledWith(
			"https://www.dlsite.com/maniax/product/info/ajax",
			expect.objectContaining({ params: expect.objectContaining({ product_id: "RJ01000250" }) }),
		);
		expect(getText).not.toHaveBeenCalled();
	});

	it("作品存在但沒有 work_type 時保守回 UNKNOWN", async () => {
		get.mockResolvedValue({ data: { RJ01276936: {} } });
		await expect(fetchDlsiteWorkType("RJ01276936")).resolves.toBe("UNKNOWN");
	});

	it("資訊 API 回空（查無此作品）時回 undefined", async () => {
		// 2026-09-26 以不存在的 RJ99999999 实测：资讯 API 回 []
		get.mockResolvedValue({ data: [] });
		await expect(fetchDlsiteWorkType("RJ99999999")).resolves.toBeUndefined();
	});

	it("資訊 API 網路失敗、作品頁成功：往外拋，不能當成非遊戲", async () => {
		const network = new TypeError("Failed to fetch");
		get.mockRejectedValue(network);
		await expect(fetchDlsiteWorkType("RJ01000250")).rejects.toBe(network);
	});

	it("資訊 API 被限流、作品頁成功：往外拋限流錯誤", async () => {
		const limited = new ApiRateLimitError({ source: "dlsite", message: "429" });
		get.mockRejectedValue(limited);
		await expect(fetchDlsiteWorkType("RJ01000250")).rejects.toBe(limited);
	});

	it("資訊 API 回 5xx：往外拋", async () => {
		const http503 = new HttpResponseError({
			method: "GET",
			status: 503,
			statusText: "Service Unavailable",
			url: "https://www.dlsite.com/maniax/product/info/ajax",
		});
		get.mockRejectedValue(http503);
		await expect(fetchDlsiteWorkType("RJ01000250")).rejects.toBe(http503);
	});

	it("不合法的 ID 丟 invalid_game_id", async () => {
		await expect(fetchDlsiteWorkType("not-an-id")).rejects.toMatchObject({ code: "invalid_game_id" });
		expect(get).not.toHaveBeenCalled();
	});
});
```

新檔 `src/metadata/cloudScanDlsite.test.ts`（掃描解析 + 真實 `fetchDlsiteWorkType`，同樣只模擬 HTTP 層）：
```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRateLimitError } from "@/utils/errors";

const { get, getText } = vi.hoisted(() => ({ get: vi.fn(), getText: vi.fn() }));
vi.mock("./api/http", () => ({ default: { get, getText } }));
vi.mock("@/providers/i18n", () => ({ default: { language: "ja-JP" } }));

import { fetchDlsiteWorkType } from "./api/dlsite";
import { type CloudScanDeps, resolveCloudScanName } from "./cloudScanResolve";

function deps(): CloudScanDeps {
	return {
		searchByName: vi.fn(async () => []),
		getGameById: vi.fn(async (id: string, source: string) => ({ id_type: source, sources: [{ source, external_id: id, data: {} }] }) as never),
		getDlsiteWorkType: (rjId) => fetchDlsiteWorkType(rjId),
		findVndbIdBySteamAppId: vi.fn(async () => null),
	};
}

describe("雲端掃描 × 真實 DLsite 作品類型查詢", () => {
	beforeEach(() => {
		get.mockReset();
		getText.mockReset();
		getText.mockResolvedValue({ data: "<html></html>" });
	});

	it("資訊 API 網路失敗、作品頁成功：解析結果是 failed，不做名稱搜尋", async () => {
		get.mockRejectedValue(new TypeError("Failed to fetch"));
		const d = deps();
		const outcome = await resolveCloudScanName("01000250", d, ["vndb", "bgm", "ymgal"]);
		expect(outcome.kind).toBe("failed");
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("資訊 API 被限流、作品頁成功：解析往外拋，停止整次掃描", async () => {
		const limited = new ApiRateLimitError({ source: "dlsite", message: "429" });
		get.mockRejectedValue(limited);
		const d = deps();
		await expect(resolveCloudScanName("01000250", d, ["vndb"])).rejects.toBe(limited);
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("資訊 API 回音聲作品：dlsite_not_game", async () => {
		get.mockResolvedValue({ data: { RJ01000250: { work_type: "SOU" } } });
		const outcome = await resolveCloudScanName("01000250", deps(), ["vndb"]);
		expect(outcome).toEqual({ kind: "not_found", reason: "dlsite_not_game" });
	});

	it("確定查無此作品時，才繼續走 Steam 反查", async () => {
		get.mockResolvedValue({ data: [] });
		const d = deps();
		const outcome = await resolveCloudScanName("331694", d, ["vndb"]);
		expect(d.findVndbIdBySteamAppId).toHaveBeenCalledWith(331694);
		expect(outcome).toEqual({ kind: "not_found", reason: "no_match" });
	});
});
```

Run: `pnpm test:web src/metadata/api/dlsite.test.ts src/metadata/cloudScanDlsite.test.ts`
Expected: FAIL，`dlsite.ts` 沒有 `fetchDlsiteWorkType` 這個匯出（`cloudScanDlsite.test.ts` 在 Step 26 建立 `cloudScanResolve.ts` 之前也會因 `Failed to resolve import "./cloudScanResolve"` 失敗，屬預期）。

- [ ] **Step 22b：實作 `fetchDlsiteWorkType`**

`src/metadata/api/dlsite.ts` 在 `fetchDlsiteById` 之後加入（`fetchProductInfo`、`normalizeDlsiteId`、`normalizeText` 都是該檔既有函式）：
```ts
/**
 * 云端扫描专用：只查资讯 API，取得作品类型。
 * 不能用 fetchDlsiteById：它在资讯 API 失败、作品页成功时会吞掉资讯 API 的错误，
 * 回传没有 work_type 的资料，扫描会把「查询失败」误判成「非游戏」。
 * - 作品存在：回传 work_type（缺少时保守回 "UNKNOWN"，视为非游戏）
 * - 资讯 API 回空：查无此作品，回 undefined
 * - 其他错误（网路、限流、5xx）：往外抛，由扫描转成 failed 或停止扫描
 */
export async function fetchDlsiteWorkType(
	id: string,
	context: NetworkRequestContext = {},
): Promise<string | undefined> {
	const normalizedId = normalizeDlsiteId(id);
	if (!normalizedId) {
		throw new AppError({
			code: "invalid_game_id",
			message: `Invalid DLsite id: ${id}`,
		});
	}
	const info = await fetchProductInfo(normalizedId, context);
	if (!info) return undefined;
	return normalizeText(info.work_type) || "UNKNOWN";
}
```

Run: `pnpm test:web src/metadata/api/dlsite.test.ts`
Expected: 7 passed。（`cloudScanDlsite.test.ts` 在 Step 27 與 `cloudScanResolve.test.ts` 一起確認。）

- [ ] **Step 23：新增 Steam App ID 經 VNDB 反查**

`src/metadata/api/vndb.ts` 在 `fetchVndbById` 之後加：

```ts
/**
 * 以 Steam App ID 反查 VNDB 作品 ID。VNDB 的外部連結記在 release 上，
 * 所以查 release 再取第一個關聯的 VN。找不到回傳 null。
 */
export async function fetchVndbIdBySteamAppId(
	appId: number,
	context: NetworkRequestContext = {},
): Promise<string | null> {
	const response = await http.post<VndbQueryResponse<{ vns: { id: string }[] }>>(
		`${VNDB_API_BASE}/release`,
		{
			filters: ["extlink", "=", ["steam", appId]],
			fields: "vns.id",
			results: 5,
		},
		buildVndbRateLimitedOptions(context),
	);
	for (const release of response.data.results ?? []) {
		const vn = release.vns?.[0];
		if (vn?.id) return vn.id;
	}
	return null;
}
```

- [ ] **Step 24：寫掃描解析流程的失敗測試**

`src/metadata/cloudScanResolve.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";
import { ApiRateLimitError } from "@/utils/errors";
import type { SourceCandidate } from "./sourceCandidate";
import { type CloudScanDeps, resolveCloudScanName } from "./cloudScanResolve";

function candidate(source: "vndb" | "bgm", externalId: string, name: string, extra: Partial<SourceCandidate["display"]> = {}): SourceCandidate {
	return { source, externalId, data: {}, display: { name, ...extra } };
}

function deps(overrides: Partial<CloudScanDeps> = {}): CloudScanDeps {
	return {
		searchByName: vi.fn(async () => []),
		getGameById: vi.fn(async (id: string, source: string) => ({ id_type: source, sources: [{ source, external_id: id, data: {} }] }) as never),
		getDlsiteWorkType: vi.fn(async () => undefined),
		findVndbIdBySteamAppId: vi.fn(async () => null),
		...overrides,
	};
}

describe("resolveCloudScanName", () => {
	it("完全相同才自動套用，並抓完整資料", async () => {
		const d = deps({
			searchByName: vi.fn(async ({ source }) =>
				source === "vndb" ? [candidate("vndb", "v1", "To Be or Not To Be")] : [],
			),
		});
		const outcome = await resolveCloudScanName("To Be or Not to Be", d, ["vndb", "bgm"]);
		expect(outcome.kind).toBe("accepted");
		expect(d.getGameById).toHaveBeenCalledWith("v1", "vndb");
	});

	it("回歸：h / RANZE / Hypnosis App 2 都不會自動套用", async () => {
		for (const [query, title] of [["h", "H+"], ["RANZE", "RAYZE"], ["Hypnosis App 2", "Hypnosis"]] as const) {
			const d = deps({ searchByName: vi.fn(async () => [candidate("vndb", "vX", title)]) });
			const outcome = await resolveCloudScanName(query, d, ["vndb"]);
			expect(outcome.kind, query).toBe("not_found");
			expect(d.getGameById).not.toHaveBeenCalled();
		}
	});

	it("包含關係只列為待確認，不抓完整資料", async () => {
		const d = deps({
			searchByName: vi.fn(async () => [candidate("bgm", "b9", "Amaoto ni Michiru Yoru EX", { image: "https://lain.bgm.tv/x.jpg" })]),
		});
		const outcome = await resolveCloudScanName("Amaoto ni Michiru Yoru", d, ["bgm"]);
		expect(outcome).toEqual({
			kind: "needs_confirmation",
			candidates: [{ source: "bgm", externalId: "b9", name: "Amaoto ni Michiru Yoru EX", image: "https://lain.bgm.tv/x.jpg" }],
		});
		expect(d.getGameById).not.toHaveBeenCalled();
	});

	it("回歸：RJ01000250 是音聲作品，拒絕採用這個 ID", async () => {
		const d = deps({ getDlsiteWorkType: vi.fn(async () => "SOU") });
		const outcome = await resolveCloudScanName("01000250", d, ["vndb"]);
		expect(outcome).toEqual({ kind: "not_found", reason: "dlsite_not_game" });
		expect(d.getGameById).not.toHaveBeenCalled();
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("RJ 號碼是遊戲類作品時直接採用 DLsite", async () => {
		const d = deps({ getDlsiteWorkType: vi.fn(async () => "SLN") });
		const outcome = await resolveCloudScanName("RJ01276936", d, ["vndb"]);
		expect(outcome.kind).toBe("accepted");
		expect(d.getDlsiteWorkType).toHaveBeenCalledWith("RJ01276936");
		expect(d.getGameById).toHaveBeenCalledWith("RJ01276936", "dlsite");
	});

	it("7 位數字視為 Steam App ID，經 VNDB 反查", async () => {
		const d = deps({ findVndbIdBySteamAppId: vi.fn(async () => "v42") });
		const outcome = await resolveCloudScanName("1742470", d, ["vndb"]);
		expect(outcome.kind).toBe("accepted");
		expect(d.findVndbIdBySteamAppId).toHaveBeenCalledWith(1742470);
		expect(d.getGameById).toHaveBeenCalledWith("v42", "vndb");
	});

	it("6 位數字先試 DLsite，查無資料再試 Steam", async () => {
		const d = deps({
			getDlsiteWorkType: vi.fn(async () => undefined),
			findVndbIdBySteamAppId: vi.fn(async () => null),
		});
		const outcome = await resolveCloudScanName("331694", d, ["vndb"]);
		expect(d.getDlsiteWorkType).toHaveBeenCalledWith("RJ331694");
		expect(d.findVndbIdBySteamAppId).toHaveBeenCalledWith(331694);
		expect(outcome).toEqual({ kind: "not_found", reason: "no_match" });
	});

	it("單一來源失敗不影響其他來源", async () => {
		const d = deps({
			searchByName: vi.fn(async ({ source }) => {
				if (source === "vndb") throw new Error("down");
				return [candidate("bgm", "b1", "昨日の魔女は今日の夢")];
			}),
		});
		const outcome = await resolveCloudScanName("昨日の魔女は今日の夢", d, ["vndb", "bgm"]);
		expect(outcome.kind).toBe("accepted");
	});

	it("所有來源都失敗時回 failed，不能當成「沒有匹配」", async () => {
		const d = deps({
			searchByName: vi.fn(async () => {
				throw new Error("network down");
			}),
		});
		const outcome = await resolveCloudScanName("昨日の魔女は今日の夢", d, ["vndb", "bgm"]);
		expect(outcome.kind).toBe("failed");
	});

	it("部分來源失敗但另一來源有候選：仍回待確認", async () => {
		const d = deps({
			searchByName: vi.fn(async ({ source }) => {
				if (source === "vndb") throw new Error("down");
				return [candidate("bgm", "b1", "昨日の魔女は今日の夢 EX")];
			}),
		});
		const outcome = await resolveCloudScanName("昨日の魔女は今日の夢", d, ["vndb", "bgm"]);
		expect(outcome.kind).toBe("needs_confirmation");
	});

	it("DLsite 查詢失敗時回 failed，不改用名稱搜尋亂猜", async () => {
		const d = deps({
			getDlsiteWorkType: vi.fn(async () => {
				throw new Error("timeout");
			}),
		});
		const outcome = await resolveCloudScanName("01000250", d, ["vndb"]);
		expect(outcome.kind).toBe("failed");
		expect(d.searchByName).not.toHaveBeenCalled();
	});

	it("Steam 反查失敗時回 failed", async () => {
		const d = deps({
			findVndbIdBySteamAppId: vi.fn(async () => {
				throw new Error("502");
			}),
		});
		const outcome = await resolveCloudScanName("1742470", d, ["vndb"]);
		expect(outcome.kind).toBe("failed");
	});

	it("自動套用時抓完整資料失敗回 failed", async () => {
		const d = deps({
			searchByName: vi.fn(async () => [candidate("vndb", "v1", "To Be or Not To Be")]),
			getGameById: vi.fn(async () => {
				throw new Error("500");
			}),
		});
		const outcome = await resolveCloudScanName("To Be or Not to Be", d, ["vndb"]);
		expect(outcome.kind).toBe("failed");
	});

	it("限流錯誤往外拋，讓整個掃描停下來", async () => {
		const limited = new ApiRateLimitError({ source: "vndb", message: "429" });
		const d = deps({
			searchByName: vi.fn(async () => {
				throw limited;
			}),
		});
		await expect(resolveCloudScanName("昨日の魔女は今日の夢", d, ["vndb", "bgm"])).rejects.toBe(limited);
	});
});
```

- [ ] **Step 25：執行確認失敗**

Run: `pnpm test:web src/metadata/cloudScanResolve.test.ts`
Expected: FAIL，`Failed to resolve import "./cloudScanResolve"`。

- [ ] **Step 26：實作 `src/metadata/cloudScanResolve.ts`**

```ts
/**
 * @file 雲端掃描的單一名稱解析
 * @description 依序處理：RJ 號碼（驗證作品類型）→ Steam App ID（VNDB 反查）→ 名稱嚴格比對。
 * 只有 ID 反查成功或標題完全相同才自動套用；包含關係只回傳候選讓使用者確認。
 */

import type { GameMetadataDraft, SourceType } from "@/types";
import { isApiRateLimitError } from "@/utils/errors";
import type { SourceCandidate } from "./sourceCandidate";
import { classifyTitleMatch, isDlsiteGameWorkType } from "./strictMatch";

export interface ScanCandidate {
	source: SourceType;
	externalId: string;
	name: string;
	image?: string;
}

export type CloudScanOutcome =
	| { kind: "accepted"; draft: GameMetadataDraft }
	| { kind: "needs_confirmation"; candidates: ScanCandidate[] }
	// 查询成功但确定没有可用结果
	| { kind: "not_found"; reason: "no_match" | "dlsite_not_game" }
	// 查询本身失败（网路、上游错误），结果未知：条目要维持 pending，下次扫描重试
	| { kind: "failed"; error: unknown };

export interface CloudScanDeps {
	searchByName(params: { query: string; source: SourceType; limit?: number }): Promise<SourceCandidate[]>;
	getGameById(id: string, source: SourceType): Promise<GameMetadataDraft>;
	/** 回傳 DLsite 的 work_type；查無此作品回傳 undefined。 */
	getDlsiteWorkType(rjId: string): Promise<string | undefined>;
	findVndbIdBySteamAppId(appId: number): Promise<string | null>;
}

const RJ_NAME = /^(?:RJ)?(\d{6}|\d{8})$/i;
const STEAM_NAME = /^\d{3,7}$/;
const SEARCH_LIMIT = 5;

function candidateTitles(candidate: SourceCandidate): (string | undefined)[] {
	const d = candidate.display;
	return [d.name, d.name_cn, ...(d.all_titles ?? []), ...(d.aliases ?? [])];
}

/** 限流错误往外抛，让整个扫描停下来；其他错误交给呼叫端转成 failed */
function rethrowRateLimit(error: unknown): void {
	if (isApiRateLimitError(error)) throw error;
}

export async function resolveCloudScanName(
	name: string,
	deps: CloudScanDeps,
	sources: readonly SourceType[],
): Promise<CloudScanOutcome> {
	try {
		return await resolveOrThrow(name, deps, sources);
	} catch (error) {
		rethrowRateLimit(error);
		return { kind: "failed", error };
	}
}

async function resolveOrThrow(
	name: string,
	deps: CloudScanDeps,
	sources: readonly SourceType[],
): Promise<CloudScanOutcome> {
	const trimmed = name.trim();

	const rj = RJ_NAME.exec(trimmed);
	if (rj) {
		const rjId = `RJ${rj[1]}`;
		// 请求失败直接往外抛（→ failed），不能当成「查无此作品」继续往下猜
		const workType = await deps.getDlsiteWorkType(rjId);
		if (workType !== undefined) {
			if (!isDlsiteGameWorkType(workType)) {
				return { kind: "not_found", reason: "dlsite_not_game" };
			}
			return { kind: "accepted", draft: await deps.getGameById(rjId, "dlsite") };
		}
	}

	if (STEAM_NAME.test(trimmed)) {
		const vnId = await deps.findVndbIdBySteamAppId(Number(trimmed));
		if (vnId) {
			return { kind: "accepted", draft: await deps.getGameById(vnId, "vndb") };
		}
		// 純數字名稱拿去做名稱搜尋只會製造誤配
		return { kind: "not_found", reason: "no_match" };
	}

	const candidates: ScanCandidate[] = [];
	let searchError: unknown = null;
	for (const source of sources) {
		let results: SourceCandidate[];
		try {
			results = await deps.searchByName({ query: trimmed, source, limit: SEARCH_LIMIT });
		} catch (error) {
			rethrowRateLimit(error);
			// 单一来源失败不影响其他来源；但全部来源都没结果时，不能断定「没有匹配」
			searchError ??= error;
			continue;
		}
		for (const result of results) {
			if (!result.externalId) continue;
			const match = classifyTitleMatch(trimmed, candidateTitles(result));
			if (match.level === "exact") {
				return { kind: "accepted", draft: await deps.getGameById(result.externalId, source) };
			}
			if (match.level === "candidate") {
				candidates.push({
					source,
					externalId: result.externalId,
					name: result.display.name ?? match.matched ?? trimmed,
					...(result.display.image ? { image: result.display.image } : {}),
				});
			}
		}
	}
	if (candidates.length > 0) return { kind: "needs_confirmation", candidates };
	if (searchError !== null) return { kind: "failed", error: searchError };
	return { kind: "not_found", reason: "no_match" };
}
```

- [ ] **Step 27：確認通過**

Run: `pnpm test:web src/metadata/cloudScanResolve.test.ts`
Expected: 14 passed。

Run: `pnpm test:web src/metadata/cloudScanDlsite.test.ts`
Expected: 4 passed。

- [ ] **Step 28：寫 `useCloudScan` 的失敗測試**

`src/services/web/scan.ts` 先建立（下一步測試會 mock 它）：

```ts
import { authenticatedFetch } from "@/services/web/http";
import type { ScanCandidate } from "@/metadata/cloudScanResolve";
import { AppError } from "@/utils/errors";

export interface ScanResult {
	added_ids: number[];
	pending_ids: number[];
}

export interface ScanPendingItem {
	id: number;
	name: string;
	teledrive_path: string;
	scan_status: "pending" | "needs_confirmation";
	scan_candidates: ScanCandidate[];
}

async function readJson<T>(response: Response, action: string): Promise<T> {
	if (!response.ok) {
		const body = (await response.json().catch(() => ({}))) as { code?: string };
		throw new AppError({
			code: body.code ?? "scan_request_failed",
			message: `${action} failed: ${response.status}`,
		});
	}
	return (await response.json()) as T;
}

export async function startCloudScan(): Promise<ScanResult> {
	return readJson(
		await authenticatedFetch(`${import.meta.env.BASE_URL}api/scan`, { method: "POST" }),
		"Cloud scan",
	);
}

export async function getScanPending(): Promise<ScanPendingItem[]> {
	return readJson(
		await authenticatedFetch(`${import.meta.env.BASE_URL}api/scan/pending`),
		"Scan pending",
	);
}
```

`src/hooks/features/games/useCloudScan.test.tsx`：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRateLimitError } from "@/utils/errors";

// vi.mock 會被提升到檔案最上方，工廠用到的 mock 必須用 vi.hoisted 建立
const { startCloudScan, getScanPending, updateGame, setSourceCover, checkServerVersion, resolveCloudScanName } = vi.hoisted(() => ({
	startCloudScan: vi.fn(),
	getScanPending: vi.fn(),
	updateGame: vi.fn(),
	setSourceCover: vi.fn(),
	checkServerVersion: vi.fn(),
	resolveCloudScanName: vi.fn(),
}));

vi.mock("@/services/web/scan", () => ({ startCloudScan, getScanPending }));
vi.mock("@/services/invoke", () => ({ gameService: { updateGame } }));
vi.mock("@/services/web/covers", () => ({ setSourceCover }));
vi.mock("@/hooks/queries/useServerVersion", () => ({ checkServerVersion }));
vi.mock("@/metadata/cloudScanResolve", () => ({ resolveCloudScanName }));
vi.mock("@/services/requestContext", () => ({
	createMetadataSession: () => ({ searchByName: vi.fn(), getGameById: vi.fn() }),
}));

import { useCloudScan } from "./useCloudScan";

const wrapper = ({ children }: { children: ReactNode }) => (
	<QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

const draft = {
	id_type: "vndb",
	sources: [{ source: "vndb", external_id: "v1", data: { image: "https://t.vndb.org/cv/1.jpg" } }],
};

describe("useCloudScan", () => {
	beforeEach(() => {
		for (const fn of [startCloudScan, getScanPending, updateGame, setSourceCover, checkServerVersion, resolveCloudScanName]) fn.mockReset();
		updateGame.mockResolvedValue({});
		setSourceCover.mockResolvedValue({ cover_version: "h" });
	});

	it("自動套用的寫入來源資料與封面，待確認的寫入候選", async () => {
		startCloudScan.mockResolvedValue({ added_ids: [1, 2], pending_ids: [1, 2] });
		getScanPending
			.mockResolvedValueOnce([
				{ id: 1, name: "A", teledrive_path: "game/A", scan_status: "pending", scan_candidates: [] },
				{ id: 2, name: "B", teledrive_path: "game/B", scan_status: "pending", scan_candidates: [] },
			])
			.mockResolvedValueOnce([
				{ id: 2, name: "B", teledrive_path: "game/B", scan_status: "needs_confirmation", scan_candidates: [{ source: "bgm", externalId: "b", name: "B EX" }] },
			]);
		resolveCloudScanName
			.mockResolvedValueOnce({ kind: "accepted", draft })
			.mockResolvedValueOnce({ kind: "needs_confirmation", candidates: [{ source: "bgm", externalId: "b", name: "B EX" }] });

		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});

		expect(updateGame).toHaveBeenCalledWith(1, expect.objectContaining({ id_type: "vndb", scan_status: "complete", scan_candidates: null }));
		expect(setSourceCover).toHaveBeenCalledWith(1, "https://t.vndb.org/cv/1.jpg");
		expect(updateGame).toHaveBeenCalledWith(2, { scan_status: "needs_confirmation", scan_candidates: [{ source: "bgm", externalId: "b", name: "B EX" }] });
		await waitFor(() => expect(result.current.pending).toHaveLength(1));
		expect(checkServerVersion).toHaveBeenCalled();
	});

	it("已經是待確認的條目不會重新自動解析", async () => {
		startCloudScan.mockResolvedValue({ added_ids: [], pending_ids: [3] });
		getScanPending.mockResolvedValue([
			{ id: 3, name: "C", teledrive_path: "game/C", scan_status: "needs_confirmation", scan_candidates: [] },
		]);
		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});
		expect(resolveCloudScanName).not.toHaveBeenCalled();
	});

	it("使用者確認候選後抓完整資料並完成", async () => {
		getScanPending.mockResolvedValue([]);
		const { result } = renderHook(() => useCloudScan({ getGameById: vi.fn(async () => draft) }), { wrapper });
		await act(async () => {
			await result.current.confirm(
				{ id: 2, name: "B", teledrive_path: "game/B", scan_status: "needs_confirmation", scan_candidates: [] },
				{ source: "vndb", externalId: "v1", name: "B" },
			);
		});
		expect(updateGame).toHaveBeenCalledWith(2, expect.objectContaining({ scan_status: "complete" }));
		expect(setSourceCover).toHaveBeenCalledWith(2, "https://t.vndb.org/cv/1.jpg");
	});

	it("查詢失敗的條目不寫入、維持 pending，並計入 failedCount", async () => {
		startCloudScan.mockResolvedValue({ added_ids: [4], pending_ids: [4] });
		getScanPending.mockResolvedValue([
			{ id: 4, name: "D", teledrive_path: "game/D", scan_status: "pending", scan_candidates: [] },
		]);
		resolveCloudScanName.mockResolvedValueOnce({ kind: "failed", error: new Error("network down") });
		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});
		expect(updateGame).not.toHaveBeenCalled();
		expect(result.current.failedCount).toBe(1);
		expect(result.current.error).toBeNull();
	});

	it("限流時停止掃描、顯示錯誤，其餘條目維持 pending", async () => {
		startCloudScan.mockResolvedValue({ added_ids: [5, 6], pending_ids: [5, 6] });
		getScanPending.mockResolvedValue([
			{ id: 5, name: "E", teledrive_path: "game/E", scan_status: "pending", scan_candidates: [] },
			{ id: 6, name: "F", teledrive_path: "game/F", scan_status: "pending", scan_candidates: [] },
		]);
		const limited = new ApiRateLimitError({ source: "vndb", message: "429" });
		resolveCloudScanName.mockRejectedValueOnce(limited);
		const { result } = renderHook(() => useCloudScan(), { wrapper });
		await act(async () => {
			await result.current.scan();
		});
		expect(resolveCloudScanName).toHaveBeenCalledTimes(1);
		expect(updateGame).not.toHaveBeenCalled();
		expect(result.current.error).toBe(limited);
	});
});
```

- [ ] **Step 29：執行確認失敗**

Run: `pnpm test:web src/hooks/features/games/useCloudScan.test.tsx`
Expected: FAIL，`Failed to resolve import "./useCloudScan"`。

- [ ] **Step 30：實作 `src/hooks/features/games/useCloudScan.ts`**

```ts
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { gameKeys } from "@/hooks/queries/useGames";
import { checkServerVersion } from "@/hooks/queries/useServerVersion";
import { fetchDlsiteWorkType } from "@/metadata/api/dlsite";
import { fetchVndbIdBySteamAppId } from "@/metadata/api/vndb";
import {
	type CloudScanDeps,
	resolveCloudScanName,
	type ScanCandidate,
} from "@/metadata/cloudScanResolve";
import { buildMetadataUpdatePayload } from "@/metadata/data/metadata";
import { gameService } from "@/services/invoke";
import { createMetadataSession, getNetworkRequestContext } from "@/services/requestContext";
import { setSourceCover } from "@/services/web/covers";
import { getScanPending, type ScanPendingItem, startCloudScan } from "@/services/web/scan";
import type { GameMetadataDraft, SourceType } from "@/types";

/** 掃描時依序嘗試的來源（與 spec 3.5「依序從 VNDB、Bangumi 等來源」一致） */
export const CLOUD_SCAN_SOURCES: readonly SourceType[] = ["vndb", "bgm", "ymgal"];

function draftCoverImage(draft: GameMetadataDraft): string | null {
	const ordered = [
		...draft.sources.filter((record) => record.source === draft.id_type),
		...draft.sources.filter((record) => record.source !== draft.id_type),
	];
	for (const record of ordered) {
		const image = (record.data as { image?: string } | undefined)?.image;
		if (image) return image;
	}
	return null;
}

function defaultDeps(): CloudScanDeps {
	const session = createMetadataSession();
	return {
		searchByName: (params) => session.searchByName(params),
		getGameById: (id, source) => session.getGameById(id, source),
		// 只查资讯 API：查无此作品回 undefined，其他错误往外抛（见 fetchDlsiteWorkType）
		getDlsiteWorkType: (rjId) => fetchDlsiteWorkType(rjId, getNetworkRequestContext()),
		findVndbIdBySteamAppId: (appId) => fetchVndbIdBySteamAppId(appId, getNetworkRequestContext()),
	};
}

export function useCloudScan(overrides: Partial<CloudScanDeps> = {}) {
	const queryClient = useQueryClient();
	const [running, setRunning] = useState(false);
	const [progress, setProgress] = useState({ done: 0, total: 0 });
	const [pending, setPending] = useState<ScanPendingItem[]>([]);
	const [error, setError] = useState<unknown>(null);
	// 本次扫描中查询失败、维持 pending 等待下次重试的条目数
	const [failedCount, setFailedCount] = useState(0);
	const cancelledRef = useRef(false);
	const overridesRef = useRef(overrides);
	overridesRef.current = overrides;

	const deps = useCallback(
		(): CloudScanDeps => ({ ...defaultDeps(), ...overridesRef.current }),
		[],
	);

	const saveAccepted = useCallback(async (gameId: number, draft: GameMetadataDraft) => {
		await gameService.updateGame(gameId, {
			...buildMetadataUpdatePayload(draft),
			scan_status: "complete",
			scan_candidates: null,
		});
		const image = draftCoverImage(draft);
		if (image) {
			// 封面下載失敗不影響條目本身；使用者之後可以在詳情頁重新選封面
			await setSourceCover(gameId, image).catch(() => undefined);
		}
	}, []);

	const refresh = useCallback(async () => {
		setPending(await getScanPending());
		await queryClient.invalidateQueries({ queryKey: gameKeys.all });
		await checkServerVersion();
	}, [queryClient]);

	const scan = useCallback(async () => {
		cancelledRef.current = false;
		setRunning(true);
		setError(null);
		try {
			await startCloudScan();
			const items = (await getScanPending()).filter((item) => item.scan_status === "pending");
			setProgress({ done: 0, total: items.length });
			const resolver = deps();
			let failed = 0;
			setFailedCount(0);
			for (const [index, item] of items.entries()) {
				if (cancelledRef.current) break;
				// 限流错误由 resolveCloudScanName 往外抛：停止整个扫描（进入 catch 显示错误），剩下的维持 pending
				const outcome = await resolveCloudScanName(item.name, resolver, CLOUD_SCAN_SOURCES);
				if (outcome.kind === "accepted") {
					await saveAccepted(item.id, outcome.draft);
				} else if (outcome.kind === "failed") {
					// 查询失败 ≠ 没有匹配：不写入，维持 pending，下次扫描会重试
					failed += 1;
					setFailedCount(failed);
				} else {
					await gameService.updateGame(item.id, {
						scan_status: "needs_confirmation",
						scan_candidates: outcome.kind === "needs_confirmation" ? outcome.candidates : [],
					});
				}
				setProgress({ done: index + 1, total: items.length });
			}
		} catch (scanError) {
			setError(scanError);
		} finally {
			setRunning(false);
			await refresh().catch(() => undefined);
		}
	}, [deps, refresh, saveAccepted]);

	const confirm = useCallback(
		async (item: ScanPendingItem, candidate: ScanCandidate) => {
			const draft = await deps().getGameById(candidate.externalId, candidate.source);
			await saveAccepted(item.id, draft);
			await refresh();
		},
		[deps, refresh, saveAccepted],
	);

	const dismiss = useCallback(
		async (item: ScanPendingItem) => {
			await gameService.updateGame(item.id, { scan_status: "complete", scan_candidates: null });
			await refresh();
		},
		[refresh],
	);

	const cancel = useCallback(() => {
		cancelledRef.current = true;
	}, []);

	const loadPending = useCallback(async () => {
		setPending(await getScanPending());
	}, []);

	return { scan, confirm, dismiss, cancel, loadPending, running, progress, pending, error, failedCount };
}
```

- [ ] **Step 31：確認通過**

Run: `pnpm test:web src/hooks/features/games/useCloudScan.test.tsx`
Expected: 5 passed。

- [ ] **Step 32：掃描分頁 UI**

`src/components/AddModal/CloudScanTab.tsx`：

```tsx
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import List from "@mui/material/List";
import ListItem from "@mui/material/ListItem";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ProxiedImage } from "@/components/ProxiedImage";
import { useCloudScan } from "@/hooks/features/games/useCloudScan";
import { getUserErrorMessage } from "@/utils/errors";

export default function CloudScanTab() {
	const { t } = useTranslation();
	const { scan, confirm, dismiss, cancel, loadPending, running, progress, pending, error, failedCount } = useCloudScan();

	useEffect(() => {
		void loadPending();
	}, [loadPending]);

	return (
		<Stack spacing={2} className="pt-2">
			<Typography variant="body2" color="text.secondary">
				{t("components.AddModal.cloudScan.description", "掃描 TeleDrive 的 game 資料夾，新增尚未建立的遊戲。只有名稱完全相同的結果會自動套用，其他的需要你確認。")}
			</Typography>
			<Stack direction="row" spacing={1}>
				<Button variant="contained" disabled={running} onClick={() => void scan()}>
					{t("components.AddModal.cloudScan.start", "開始掃描")}
				</Button>
				{running && (
					<Button onClick={cancel}>{t("components.AddModal.cloudScan.cancel", "停止")}</Button>
				)}
			</Stack>
			{running && (
				<LinearProgress
					variant={progress.total ? "determinate" : "indeterminate"}
					value={progress.total ? (progress.done / progress.total) * 100 : 0}
				/>
			)}
			{error ? (
				<Typography color="error">{getUserErrorMessage(error, t)}</Typography>
			) : null}
			{!running && failedCount > 0 ? (
				<Typography color="warning.main">
					{t("components.AddModal.cloudScan.retryLater", "有 {{count}} 款暫時查不到資料，下次掃描會自動重試。", { count: failedCount })}
				</Typography>
			) : null}
			<Typography variant="subtitle2">
				{t("components.AddModal.cloudScan.pendingTitle", "待確認（{{count}}）", { count: pending.length })}
			</Typography>
			<List dense>
				{pending.map((item) => (
					<ListItem key={item.id} className="flex-col items-start gap-1">
						<Typography fontWeight={700}>{item.name}</Typography>
						{item.scan_candidates.length === 0 ? (
							<Typography variant="body2" color="text.secondary">
								{t("components.AddModal.cloudScan.noCandidate", "找不到可信的候選，請到遊戲詳情頁手動搜尋。")}
							</Typography>
						) : (
							item.scan_candidates.map((candidate) => (
								<Stack key={`${candidate.source}:${candidate.externalId}`} direction="row" spacing={1} className="items-center">
									{candidate.image && <ProxiedImage src={candidate.image} alt="" className="h-12 w-9 rounded object-cover" />}
									<Typography variant="body2" className="flex-1">
										{candidate.name}（{candidate.source}）
									</Typography>
									<Button size="small" onClick={() => void confirm(item, candidate)}>
										{t("components.AddModal.cloudScan.confirm", "套用")}
									</Button>
								</Stack>
							))
						)}
						<Button size="small" color="inherit" onClick={() => void dismiss(item)}>
							{t("components.AddModal.cloudScan.dismiss", "略過")}
						</Button>
					</ListItem>
				))}
			</List>
		</Stack>
	);
}
```

`src/components/AddModal/AddModal.tsx`：
- 第 74 行：`type AddModalTab = "single" | "bulk" | "cloud";`
- import `CloudScanTab from "./CloudScanTab";` 與 `isWebRuntime`。
- 第 461–465 行的 `bulk` Tab 之後加：

```tsx
					{isWebRuntime() && (
						<Tab
							value="cloud"
							label={t("components.AddModal.cloudTab", "雲端掃描")}
						/>
					)}
```

- 在 single / bulk 內容區塊之後加：

```tsx
				{isWebRuntime() && (
					<Box sx={{ display: activeTab === "cloud" ? undefined : "none" }}>
						<CloudScanTab />
					</Box>
				)}
```

- 第 429 行的 `maxWidth` 判斷改為 `activeTab === "single" ? "sm" : "lg"`。

- [ ] **Step 32a：網頁版隱藏本機路徑的新增方式（先寫測試）**

「批量」分頁完全依賴本機功能（`fileService.scanDirectoryForGames`、`resolveBulkImportPaths`、`scanSteamLaunchTargets`），「單個」分頁的「選擇啟動檔」按鈕與路徑欄位也依賴本機檔案對話框；網頁版按下去會失敗。網頁版改成：預設開啟「雲端掃描」、不顯示「批量」分頁；「單個」分頁保留名稱／ID 搜尋中繼資料的手動新增（新增的遊戲 `teledrive_path` 為 `null`），但隱藏本機路徑按鈕與欄位。拖放由 `useTauriDragDrop` 內的 `isTauri()` 保護，不必處理。

新檔 `src/components/AddModal/addModalTabs.ts`：
```ts
export type AddModalTab = "single" | "bulk" | "cloud";

/** 依执行环境决定新增对话框可用的分页；网页版没有本机路径，只能手动搜寻或云端扫描 */
export function availableAddModalTabs(isWeb: boolean): AddModalTab[] {
	return isWeb ? ["cloud", "single"] : ["single", "bulk"];
}

/** 对话框开启时的预设分页 */
export function defaultAddModalTab(isWeb: boolean): AddModalTab {
	return availableAddModalTabs(isWeb)[0];
}
```

新檔 `src/components/AddModal/addModalTabs.test.ts`：
```ts
import { describe, expect, it } from "vitest";
import { availableAddModalTabs, defaultAddModalTab } from "./addModalTabs";

describe("addModalTabs", () => {
	it("桌面版維持單個與批量，預設單個", () => {
		expect(availableAddModalTabs(false)).toEqual(["single", "bulk"]);
		expect(defaultAddModalTab(false)).toBe("single");
	});

	it("網頁版沒有批量分頁，預設雲端掃描", () => {
		expect(availableAddModalTabs(true)).toEqual(["cloud", "single"]);
		expect(availableAddModalTabs(true)).not.toContain("bulk");
		expect(defaultAddModalTab(true)).toBe("cloud");
	});
});
```

Run: `pnpm test:web src/components/AddModal/addModalTabs.test.ts`
Expected: FAIL，`Failed to resolve import "./addModalTabs"`（先只建立測試檔時）；建立 `addModalTabs.ts` 後 PASS（2 passed）。

- [ ] **Step 32b：`AddModal.tsx` 套用分頁規則**

`src/components/AddModal/AddModal.tsx`（覆蓋 Step 32 的寫法，以本步為準）：
- 刪除第 74 行的 `type AddModalTab = …`，改為 `import { type AddModalTab, availableAddModalTabs, defaultAddModalTab } from "./addModalTabs";`。
- 在元件開頭加入 `const isWeb = isWebRuntime();`、`const tabs = availableAddModalTabs(isWeb);`。
- 第 158 行：`useState<AddModalTab>(defaultAddModalTab(isWeb))`。
- 第 219、324 行把 `setActiveTab("single")`（重設分頁）改為 `setActiveTab(defaultAddModalTab(isWeb))`。第 246 行的 `setActiveTab("bulk")` 只在拖放時觸發，網頁版不會發生，維持不變。
- 第 452–465 行的 `<Tabs>` 內容改為依 `tabs` 產生：

```tsx
					{tabs.map((tab) => (
						<Tab
							key={tab}
							value={tab}
							label={
								tab === "single"
									? t("components.AddModal.singleTab", "单个添加")
									: tab === "bulk"
										? t("components.AddModal.bulkTab", "批量导入")
										: t("components.AddModal.cloudTab", "雲端掃描")
							}
						/>
					))}
```

- 「單個」分頁內第 473–497 行的「選擇啟動檔」`<Button>` 與唯讀路徑 `<TextField>` 包在 `{!isWeb && (<>…</>)}` 內。
- `BulkImportTab` 的渲染區塊包在 `{!isWeb && (…)}` 內，網頁版不掛載它（避免它在掛載時呼叫本機 service）。
- Step 32 加的 `{isWebRuntime() && (<Box …><CloudScanTab /></Box>)}` 保留，條件改用 `isWeb`。

Run: `pnpm test:web src/components/AddModal`
Expected: PASS。
Run: `pnpm typecheck`
Expected: 無錯誤。

- [ ] **Step 33：國際化**

Run: `pnpm i18n:extract`
Run: `pnpm i18n:status`
Expected: 缺的只有 `components.AddModal.cloudTab` 與 `components.AddModal.cloudScan.*` 共 9 個鍵。在 `src/locales/{zh-CN,zh-TW,en-US,ja-JP}.json` 補齊：

| 鍵 | zh-TW | zh-CN | en-US | ja-JP |
|---|---|---|---|---|
| `cloudTab` | 雲端掃描 | 云端扫描 | Cloud scan | クラウドスキャン |
| `cloudScan.description` | 掃描 TeleDrive 的 game 資料夾，新增尚未建立的遊戲。只有名稱完全相同的結果會自動套用，其他的需要你確認。 | 扫描 TeleDrive 的 game 文件夹，添加尚未建立的游戏。只有名称完全相同的结果会自动应用，其余需要你确认。 | Scan the TeleDrive game folder and add games that are not in the library yet. Only exact title matches are applied automatically; everything else needs your confirmation. | TeleDrive の game フォルダをスキャンし、未登録のゲームを追加します。タイトルが完全一致した結果のみ自動で適用され、それ以外は確認が必要です。 |
| `cloudScan.start` | 開始掃描 | 开始扫描 | Start scan | スキャン開始 |
| `cloudScan.cancel` | 停止 | 停止 | Stop | 停止 |
| `cloudScan.pendingTitle` | 待確認（{{count}}） | 待确认（{{count}}） | Needs review ({{count}}) | 要確認（{{count}}） |
| `cloudScan.noCandidate` | 找不到可信的候選，請到遊戲詳情頁手動搜尋。 | 找不到可信的候选，请到游戏详情页手动搜索。 | No reliable match found. Search manually from the game detail page. | 信頼できる候補が見つかりません。ゲーム詳細ページから手動で検索してください。 |
| `cloudScan.confirm` | 套用 | 应用 | Apply | 適用 |
| `cloudScan.dismiss` | 略過 | 跳过 | Skip | スキップ |
| `cloudScan.retryLater` | 有 {{count}} 款暫時查不到資料，下次掃描會自動重試。 | 有 {{count}} 款暂时查不到资料，下次扫描会自动重试。 | {{count}} game(s) could not be looked up right now and will be retried on the next scan. | {{count}} 件のゲームを一時的に取得できませんでした。次回のスキャンで自動的に再試行します。 |

Run: `pnpm i18n:sync`
Run: `rg "__MISSING__" src/locales`
Expected: 無輸出。

- [ ] **Step 34：整體檢查**

Run: `pnpm test:web`
Expected: 全部通過。
Run: `pnpm check`
Expected: 無錯誤。
Run: `cargo test -p reina-server -p reina-core`
Expected: 全部通過。

- [ ] **Step 35：Commit**

```bash
git add src-tauri/reina-server/src/api/scan.rs src-tauri/reina-server/src/api/scan src-tauri/reina-server/src/api.rs src-tauri/reina-server/tests/scan.rs src-tauri/reina-core/src/database/dto.rs src-tauri/reina-core/src/database/repository/games_repository.rs src-tauri/reina-core/tests/scan_queries.rs
git add src/metadata/strictMatch.ts src/metadata/strictMatch.test.ts src/metadata/cloudScanResolve.ts src/metadata/cloudScanResolve.test.ts src/metadata/cloudScanDlsite.test.ts src/metadata/api/dlsite.ts src/metadata/api/dlsite.test.ts src/metadata/api/vndb.ts src/types/types.ts src/services/web/scan.ts src/hooks/features/games/useCloudScan.ts src/hooks/features/games/useCloudScan.test.tsx src/components/AddModal/CloudScanTab.tsx src/components/AddModal/addModalTabs.ts src/components/AddModal/addModalTabs.test.ts src/components/AddModal/AddModal.tsx src/locales
git commit -m "feat: scan TeleDrive games with explicit metadata confirmation

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

## 給執行者的備註

實作前先讀這一節。這些是撰寫計畫時從原始碼查到、會影響多個任務的事實。

**Rust 與資料庫**
- 桌面版 package 名稱是 `ReinaManager`（lib 名 `reina_manager_lib`）；workspace 原本只有 `reina-path`、`migration`，任務 1 加入 `reina-core`，任務 3 加入 `reina-server`。測試指令用 `cargo test -p <package>`。
- repository 的實際名稱是 `GamesRepository`、`CollectionsRepository`、`GameStatsRepository`、`SettingsRepository`。桌面版 `src/database/service.rs` 的 `#[tauri::command]` 留在桌面 crate；reina-server 自己寫 HTTP 包裝去呼叫 repository。
- 可組合 transaction 的規則：原本內部會 `begin/commit` 的寫入函式，另外提供 `*_in_connection` 版本；原本就不開 transaction 的（`GamesRepository::{delete, delete_many}`、`CollectionsRepository::{create, update, delete, remove_games_from_collection}`、`SettingsRepository::update_settings`）保留原名、改成泛型 `<C: ConnectionTrait>`。`insert_batch_in_connection` 另外需要 `C: TransactionTrait`（每筆 savepoint）。
- SQLite 只有 1 條連線：Write 持有 transaction 時，同一個請求內任何改用 `&DatabaseConnection` 的呼叫都會卡死。`*_in_connection` 內部絕不能再用連線池。
- `get_all_settings` 在空資料庫第一次呼叫時會建立 `user` 預設列。它仍歸類為 Read、不遞增版本，這是刻意的：那一列只是預設值。
- migration 的既有 bug 已在任務 1 修正：m000004、m000007 對新資料庫也會備份，原本會用 `reina_path::get_db_path()` 碰到桌面版的資料庫；改成從目前連線取得路徑。伺服器第一次啟動會在 `/data/backups/` 產生兩個小備份檔，屬正常現象，volume 必須可寫。
- `normalize_install_root_path` 在 Linux 只接受 `/` 開頭的路徑，網頁版的「安裝目錄」設定不可用（任務 5 的能力邊界已處理）。
- `exe_relpath` 儲存時 `\` 會轉成 `/`，並拒絕 `..`、絕對路徑和含 `:` 的片段。計畫 B 的 bridge 解析時以 `/` 分隔。
- 封面三個欄位（`cover_version`、`source_cover_hash`、`custom_cover_hash`）在任務 2 建立，唯一寫入點是任務 7 的 `GamesRepository::set_cover_hashes_in_connection`，不在 Insert／Update DTO 裡。

**reina-server**
- Write 的共用入口是 `tx::begin(&state.db)` 與 `tx::finish(&state, txn, result, bump)`；`bump` 回傳 `false` 時只 commit 不遞增版本（掃描沒新增遊戲時使用；計畫 B 的遊玩紀錄重送也會用）。
- 測試工具在 `reina-server/tests/support.rs`（`mod support;`）：`TestApp::{new, with_config}`、`owner_token()`、`insert_game`、`fail_next_write_commit()`（經由 `AppState.fault: Arc<tx::CommitFault>` 讓下一次 `tx::finish` rollback 並回 500）、`send`、`rpc`、`data_version`。
- 錯誤 body 是 `{ code, message }`；`code` 固定為 `unauthorized`／`forbidden`／`not_found`／`invalid_arguments`／`command_failed`，加上各子模組自己的代碼（例如 `game_folder_missing`、`teledrive_unavailable`、`upstream_status`）。`message` 沿用桌面版的簡體中文前綴。前端只在 401 時刷新 token。
- 成功的 RPC 一律回 JSON body，沒有回傳值的 command 回 `null`。
- axum 0.8 的路徑參數語法是 `{command}`／`{*path}`。深層路由判定「最後一段含 `.` 就視為檔案」，找不到回 404；目前的路由參數都是數字 ID，不受影響。
- `jsonwebtoken 9` 依賴 `ring`，Docker 的 Rust 建置階段需要 C 編譯器（官方 `rust:*` 映像已內建）。
- JWT 規則和 TeleDrive 的 `decode_jwt` 一致：只接受 HS256、leeway 0、`user_id` 可以是整數或數字字串；`acting_account_id` 不參與授權。

- 封面寫入的並行規則：同一個遊戲的「寫檔 → commit → 清理」全程持有 `CoverStore::lock_game(game_id)`；刪除遊戲後清理封面目錄也要先取得這把鎖。來源封面的網路下載在鎖外完成。不持鎖時，一方 commit 後的 `retain_only` 會刪掉另一方剛寫好、尚未 commit 的檔案。
- VNDB 的 429 退避期限記在來源共用的 `SourceLimiter`（`record_429`／`record_success`），`acquire` 睡醒後會重新檢查，所以其他分頁、其他裝置的請求都會一起等。只有 `default_backoff_ms > 0` 的來源（桌面版 `stopOn429 = false`，目前只有 VNDB）會登記退避；其他來源收到 429 直接回給前端。

**前端**
- `isWebRuntime()` 以 `import.meta.env.MODE === "web"` 判斷；`vitest.config.ts` 設 `base: "/game/"`，讓測試中的 `import.meta.env.BASE_URL` 是 `/game/`。
- 測試依賴選 `jsdom@29.1.1`：`jsdom@30` 需要 Node `^24.15`，本機是 v24.11。`vi.mock` 工廠內引用的 mock 一律用 `vi.hoisted`，避免提升造成的 TDZ 錯誤。
- 任務 5 找到並處理的網頁版阻塞點：`GameInfoEdit.tsx:106` 在模組層級呼叫 `sep()`；多處 `"/images/…"` 絕對路徑（改用 `publicAssetUrl()`）；`useCardsController.tsx:89` 用 `window.location.pathname` 當捲動位置的鍵。
- 網頁版沒有 Vite dev proxy：`localhost:5173` 讀不到 TeleDrive 網域的 IndexedDB，網頁版行為以 Vitest 和部署後驗收（計畫 C）為準。
- 桌面版的 `zustand/persist` 在網頁版也會寫 `localStorage` 的 `reina-manager-store`；鍵名和 TeleDrive 不衝突，本計畫不另外隔離。
- 版本同步器分成 `primeServerVersion()`（啟動時、首屏資料讀取前呼叫，只記錄版本）和 `checkServerVersion()`。啟動採樣失敗時頁面照常掛載；之後第一次成功的 `check()` 會先重新讀取已載入的資料，再記錄版本，不能直接把當時的版本當成已同步。
- 本機啟動、開啟資料夾等入口在任務 5 只是先隱藏；網頁版的下載／執行按鈕由計畫 B 加回，並呼叫任務 6 的 `checkServerVersion()`。

**中繼資料與掃描**
- 掃描解析要區分「查詢成功但沒有匹配」（`not_found`，寫入 `needs_confirmation`）和「查詢失敗」（`failed`，**不寫入**，維持 `pending`，下次掃描自動重試）。限流錯誤（`ApiRateLimitError`）會往外拋並停止整次掃描，剩下的條目同樣維持 `pending`。
- 真實依賴**不能吞錯**：掃描的 DLsite 作品類型改用只查資訊 API 的 `fetchDlsiteWorkType`（查無此作品回 `undefined`，其他錯誤往外拋），**不用** `fetchDlsiteById`，因為後者在資訊 API 失敗、作品頁成功時會吞掉錯誤、回傳沒有 `work_type` 的資料。只 mock `CloudScanDeps` 的解析器測試抓不到這類問題，所以 `dlsite.test.ts`、`cloudScanDlsite.test.ts` 保留真實的 `dlsite.ts`，只模擬 `./http`；之後新增的依賴也要在 HTTP 層測試。
- 網頁版所有外部圖片（候選封面、頭像、來源圖示、描述內嵌圖）都走 `/game/api/metadata/image`。Kungal、Hikarinagi 的 API 需要登入，查不到實際圖床子網域，暫時以網域後綴 `kungal.com`、`hikarinagi.org` 放行；之後若發現其他圖床，只要在 `IMAGE_HOST_SUFFIXES` 補上。ErogameScape 的封面常掛在外站，外站圖目前會被拒而顯示空白，屬已知限制。
- DLsite `work_type` 已實測（2026-09-26，`/maniax/product/info/ajax`）：RJ01000250 是 `SOU`（音聲），RJ01276936 是 `SLN`（遊戲）。
- TeleDrive 的 `GET /folders` 不分頁，一次回傳該層全部資料夾；只有 `/files` 需要逐頁讀取。
