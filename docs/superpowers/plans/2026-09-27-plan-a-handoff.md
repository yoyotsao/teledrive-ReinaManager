# 計畫 A 進度交接：任務 7 封面服務

交接日期：2026-09-27（Asia/Taipei）。本次依使用者要求保存中斷進度，沒有繼續實作任務 7 的剩餘功能。

## 狀態與入口

- 工作目錄：`D:/game/ReinaManager`。
- 分支：`feat/web-server-plan-a`。
- 本次進度提交的父提交：`de8df97`，任務 6 的版本同步競態修正。
- 規格：[Web／Docker 設計](../specs/2026-09-26-reinamanager-web-docker-design.md)。
- 實施計畫：[計畫 A](2026-09-26-plan-a-server-web.md)，任務 7 自第 7269 行開始。
- 本機執行紀錄：`.superpowers/sdd/2026-09-26-plan-a-server-web/` 的 `progress.md`、`implementer-common.md`、`task-7-brief.md` 與任務 1–6 報告。此目錄被忽略，不會隨 Git 提交；重要裁決整理於本文件。
- 使用者的 fork：`https://github.com/yoyotsao/teledrive-ReinaManager`，遠端名稱 `mine`；`origin` 保留為上游。先前裁決要求每個任務完成後推送 `mine`。

任務 7 **尚未完成、尚未寫完成報告、尚未送審**。本次 commit 是進度保存，不能當成任務 7 驗收通過。任務 8、9 尚未開始。

## 任務 1–6 已有進度

下表的完成／審查狀態來自既有 `progress.md`，本次未重新進行各任務的完整審查。

| 任務 | 內容 | 提交 | 既有紀錄 |
| --- | --- | --- | --- |
| 1 | 抽出共用 `reina-core` | `5c5de9a` | 完成、審查通過 |
| 2 | Web 欄位、資料版本與可組合 transaction | `893801f` | 完成、審查通過 |
| 3 | `reina-server`、JWT、RPC、版本 API、靜態檔 | `c3f2c72` | 完成、審查通過；保留既有 Clippy 警告等 minor 項目 |
| 4 | TeleDrive 瀏覽器登入與 HTTP 傳輸 | `bb8b3a3` | 完成、審查通過 |
| 5 | `/game` 路徑與平台能力邊界 | `d948ee1` | 完成、審查通過 |
| 6 | 跨裝置 query／版本同步 | `f0e516b`、`de8df97` | 修正 `check()` 在 `prime()` 進行中被略過的競態後審查通過 |

## 任務 7 中斷位置與現有實作

使用者提供的原始狀態：實作者因週用量上限與 API 429 中斷；原代理曾嘗試恢復，識別為 `aeeb898`。停下時剛執行 `cargo fmt`，下一步是重跑測試。本次已重新執行下節列出的驗證。

### 後端已落地

- `src-tauri/reina-server/src/api/covers/{sniff,store,handlers}.rs`：圖片檔頭判斷、SHA-256 檔名、暫存檔寫入後 rename、10 MiB 上限、自訂／來源封面的優先順序。
- 封面 API 已接入 `api/router.rs`：`GET/PUT/DELETE /game/api/covers/{game_id}`、`POST /game/api/covers/{game_id}/source`。需要 `AuthUser`；讀取封面帶版本參數，舊版本導向目前版本，提供 ETag 與私有 immutable 快取。
- `CoverStore::lock_game(game_id)`：同一遊戲的「寫檔 → transaction commit → 清理」全程串行；來源圖片下載在鎖外完成。
- `src-tauri/reina-server/src/upstream/{policy,target,fetch}.rs`：host 白名單、URL／位址驗證、DNS 固定位址、同 host 轉址、下載大小限制与標頭轉送限制。這些基礎能力也會供任務 8 使用；任務 8 的 HTTP 路由與限速尚未實作。
- `GamesRepository::{find_cover_state,set_cover_hashes_in_connection}` 與 `CoverState`：封面三個欄位的專用讀寫入口；`None` 不修改、`Some(None)` 清除，自訂封面優先。
- 封面欄位與 `data_version` 在同一 transaction 更新；失敗清理本次新建圖片，成功後清理失去引用的圖片。
- 刪除／批次刪除遊戲的 RPC 在 commit 成功後取得封面鎖並清理目錄。
- `Config.upstream_overrides` 與測試用 seed helper 已補上；`Cargo.toml`／`Cargo.lock` 有相應依賴與 `reqwest` stream feature 變更。
- 測試已存在：`reina-core/tests/cover_state.rs`、`reina-server/tests/covers.rs`，以及 covers／upstream 模組內的單元測試，含並行更換封面與 rollback 情境。

### 前端已落地但尚未接完

- `src/services/web/covers.ts` 與相鄰測試：透過 `authenticatedFetch` 取得 Blob、上傳自訂封面、刪除自訂封面、設定來源封面。
- `GameData.cover_version` 與 `getDisplayGameData()` 的欄位傳遞已補上。
- `gameInfoEditData.ts` 已改為由呼叫端傳入 `fallbackCoverUrl`，但 `GameInfoEdit.tsx` 呼叫端仍是舊參數，因此目前型別檢查失敗。
- 計畫要求的 `useCoverUrl`、`useGameCoverSrc`、`GameCoverImg` 與相鄰測試均尚未建立；封面顯示與編輯／預覽流程尚未串接 Web service。
- 尚未修改任何翻譯字串；完成任務 7 時仍需依 i18n Skill 補齊並檢查四種語系。

## 本次實際驗證

Rust 指令在 `src-tauri` 執行，前端指令在專案根目錄執行。

| 指令 | 結果 |
| --- | --- |
| `cargo test -p reina-core -p reina-server --locked --offline` | 通過，113 個測試：core 52、server 61；含 core 封面狀態 4 個、server 封面整合 10 個 |
| `cargo fmt --all --check` | 通過，沒有再次改寫檔案 |
| `cargo clippy -p reina-core -p reina-server --all-targets --locked --offline` | exit 0；只有既有 `settings_repository.rs:13` 的 `async_fn_in_trait` 警告 |
| `.\node_modules\.bin\vitest.CMD run` | 通過，12 個測試檔、54 個測試；其中 covers service 3 個 |
| `.\node_modules\.bin\tsc.CMD -b --noEmit` | 失敗，`GameInfoEdit.tsx:435` TS2741：缺少必要參數 `fallbackCoverUrl` |
| `.\node_modules\.bin\biome.CMD check src/services/web/covers.ts src/services/web/covers.test.ts src/types/types.ts src/metadata/data/dataTransform.ts src/pages/Detail/game-info/gameInfoEditData.ts` | 失敗，2 項格式問題：`dataTransform.ts` 的 CRLF 與 `covers.test.ts` 的斷行；沒有套用修正 |

本環境的 `pnpm` 先被 PowerShell 的 `.ps1` 執行政策擋下；改用 `pnpm.cmd` 後長時間無輸出，已終止該嘗試。上表前端檢查改用專案已安裝的 `.CMD` 工具，分別等同 package scripts 的 `vitest run` 與 `tsc -b --noEmit`，沒有修改執行政策或重裝依賴。

本次沒有驗證 `cargo check -p ReinaManager`、桌面／Web 正式建置、Blob 生命週期或部署後瀏覽器行為。既有測試通過不代表尚未實作的前端功能可用，也沒有可補記的原實作者 RED 階段證據。

## 下一位實作者的接續順序

1. 先閱讀 `docs/README.md`、本交接、規格與計畫任務 7；本機紀錄仍在時再讀共用規則與 brief。不需要重做已存在的後端。
2. 前端 service 已對應 Step 25–28，且本次測試通過。從 **Step 29：`useCoverUrl` 的失敗測試** 接續，完成 Blob query 快取與共用 object URL 建立／撤銷邏輯；元件切换、版本改變、卸載時都要正確撤銷。
3. 完成 Step 33–36 的 `useGameCoverSrc`、`GameCoverImg` 與測試，保留 NSFW 替換及桌面封面分支。
4. 依 Step 37 替換卡片、詳情、統計排名與首頁各面板的封面顯示，核對 focus 面板預載等非直接 `<img>` 路徑。
5. 依 Step 38 完成 Web 自訂封面選擇／預覽／上傳／刪除、來源封面更新；同步 `GameInfoEdit.tsx` 對 `fallbackCoverUrl` 的呼叫，消除已知 TS2741。此 helper 已有半成品，延續現有改動即可。
6. 完成 Step 39 的遺漏檢查、Step 40 的 i18n 與驗證；只格式化任務檔案。補做 `cargo check -p ReinaManager`、`pnpm build:web`、`pnpm build` 與新增 Hook／元件測試。
7. 寫 `.superpowers/sdd/2026-09-26-plan-a-server-web/task-7-report.md`：實作範圍、實際驗證、可確認的 TDD 證據、偏離與疑慮。任務真正完成後再建立完成提交、交由控制者送審；審查通過後更新進度。
8. 後續任務 8 是中繼資料代理與限速，任務 9 是雲端掃描。既有裁決另安排任務 10 統一同步 `docs/architecture/backend.md`、`frontend.md`，不要把舊架構文件視為已反映本分支。

## 必須保留的裁決與工作樹限制

- **不要 add、不要還原那約 190 個只有換行差異的無關檔案**，由使用者決定如何處理。此指示覆蓋早期 ledger 中曾允許 `git checkout` 還原的舊裁決。
- `core.autocrlf=true`；部分原始位元組的 LF／CRLF 差異會被 Git 正規化，未必出現在 `git status`。本次忽略行尾後的實質修改共 12 個既有檔案，均屬任務 7；不要以狀態較少推論換行差異已被還原。
- 只用明確檔案清單暫存任務改動與交接文件，禁止 `git add .`／`git add -A`。`test/` 是使用者的封面圖片資料，維持未追蹤且不要修改。
- 不跑全庫 `pnpm check`／`pnpm format`，避免再次改寫無關檔案。用 `pnpm exec biome check --write <任務檔案>` 與獨立型別檢查；本環境必要時使用相同工具的本機 `.CMD` 入口。
- 封面 query key 依控制者 P8 裁決使用 `["cover", gameId, cover_version, …]`，不放在 `["server", …]` 前綴下，避免每次資料版本更新重抓所有 Blob。此裁決覆蓋任務 7 計畫／brief 中仍留著的 `["server", "cover", …]` 範例，測試也要跟著裁決。
- object URL effect 必須抽成共用 Hook／函式，不在多處複製；React Query 快取 Blob，不快取 object URL。
- 路由彙總在 `reina-server/src/api/router.rs`；同級 Rust 模組宣告檔只放宣告。`invoke` 僅能在 service，元件不得直接用 `useQuery`／`useQueryClient`。
- 不自行修 `settings_repository.rs:13` 的既有警告；控制者決定最終統一處理，期間以 Clippy 無新增警告為準。
- 保持中文交流、中文程式註解，沿用專案現有組織與工具。新增翻譯時依 [i18n Skill](../../../.agents/skills/i18n/SKILL.md) 完成完整性檢查。

本次交接提交可用 `git log -1` 查得；完整進度差異可用 `git diff de8df97..HEAD` 檢視。這個範圍包含已寫入但尚未串接完成的程式碼，恢復時應先處理上述已知缺口。
