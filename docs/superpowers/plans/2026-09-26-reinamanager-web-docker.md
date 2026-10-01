# ReinaManager 網頁版與 Docker：實作總覽

> **For agentic workers:** 這是總覽，不直接照著實作。實際執行的是下面三份子計畫；每份都要用 superpowers:subagent-driven-development（建議）或 superpowers:executing-plans 逐任務執行，步驟用 `- [ ]` 追蹤。

**Goal:** 透過 TeleDrive 的 `/game/` 提供共用登入、遊戲庫管理、掃描、封面與跨裝置同步，並透過每台 Windows 的 bridge 下載、啟動遊戲和彙總遊玩時間。

**Architecture:** 保留 `src-tauri` 作為 Cargo workspace，新增不依賴 Tauri 的 `reina-core` 和 axum 服務 `reina-server`。同一套 React 依執行環境選擇 Tauri IPC 或 HTTP，沿用現有的中繼資料 adapter，由伺服器代理外部請求。Windows 本機操作全部交給 bridge；TeleDrive 只改部署設定。

**Tech Stack:** 現有 React、TypeScript、TanStack Query、UnoCSS、SeaORM/SQLite；新增 axum、jsonwebtoken；bridge 沿用 Python、cheroot、pytest，新增 psutil。前端測試用 Vitest、Testing Library、fake-indexeddb，瀏覽器驗收用 Playwright。

**Spec:** [2026-09-26-reinamanager-web-docker-design.md](../specs/2026-09-26-reinamanager-web-docker-design.md)

## 子計畫

| 計畫 | 範圍 | 狀態 | 檔案 |
| --- | --- | --- | --- |
| A：伺服器與網頁 | 任務 1–9：共用 crate、schema 與 transaction、reina-server、瀏覽器登入、`/game` 子路徑、跨裝置版本、封面、中繼資料代理、雲端掃描 | 已實作並驗證 | [2026-09-26-plan-a-server-web.md](2026-09-26-plan-a-server-web.md) |
| B：bridge 與計時 | 任務 10–15：bridge 驗證、ZIP 解析與背景下載、網頁下載／執行按鈕、啟動與程序樹、計時佇列與恢復、遊玩紀錄入庫 | 已細化（含測試碼、實作邊界與介面） | [2026-09-26-plan-b-bridge-playtime.md](2026-09-26-plan-b-bridge-playtime.md) |
| C：部署與驗收 | 任務 16–17：Docker、WSL TeleDrive 設定、整合驗收、i18n、文件 | 已細化（含部署步驟與驗收矩陣） | [2026-09-26-plan-c-deployment-validation.md](2026-09-26-plan-c-deployment-validation.md) |

A 已完成後，B、C 已依目前實際介面重新查證並細化：伺服器端直接使用現有 `tx::begin/finish`、`TestApp`、`Config`、`authenticatedFetch` 與 `checkServerVersion`；bridge 計畫也依目前 `_bridge_legacy.py`、`LocalFetcher`、`tdapi.py` 的真實結構編寫，不再以未實作介面猜測。

## 全域約束

- ReinaManager 根目錄為 `D:/game/ReinaManager`；bridge 根目錄為 `D:/python/teledrive-webdav`；TeleDrive 只操作 WSL `Ubuntu-24.04:~/teledrive`，不用 Windows 參考副本部署。
- 資料庫從空庫開始；`reina-data:/data` 是伺服器持久化入口，容器不對主機開放 port，內部 port `8787`。
- JWT 從 `teledrive-credentials / credentials / active.jwt` 取得；保留同記錄中的 `accounts`，不解讀、不記錄、不向伺服器傳送 Telegram session。
- 伺服器端固定 HS256，必須驗證 `exp`、`user_id` 和 `REINA_OWNER_ID`；bridge 驗證瀏覽器 token，不持有 `JWT_SECRET`。
- 伺服器只儲存 `teledrive_path` 與 `exe_relpath` 作為遊戲位置，不接受用戶端 Windows 絕對路徑。
- 版本輪詢前景每 `60` 秒，聚焦、恢復可見和重新聯網立即檢查；下載狀態每 `2` 秒，執行狀態每 `10` 秒；bridge 程序樹每 `2` 秒檢查，心跳每 `60` 秒寫入磁碟。
- 桌面版過渡期繼續能建置；Web 不啟用系統匣、自啟動、updater、視窗狀態、安裝 deep link、Magpie、管理員啟動。保留 Locale Emulator。
- Rust 使用同級 `<模組>.rs` 宣告及 `<模組>/` 子檔案，不建立 `mod.rs`；遷移追加，不改寫歷史 schema 語義。
- 前端元件不直接呼叫 invoke、useQuery 或 useQueryClient；傳輸在 service，查詢在 query hook，流程在 feature hook；複用現有 GameIndex 和快取 patch。
- 本計畫僅新增文件，不修改現有使用者工作。實作前記錄三個倉庫的狀態；本次可見的 `src-tauri/Cargo.toml` 修改和 `test/` 圖片資料不視為本計畫產物。
- 提交按任務邊界進行，只暫存該任務的檔案，禁止 `git add .`。依賴版本以專案鎖檔案及相容性檢查為準，不順便升級既有工具鏈。

## 重點驗證場景

1. 手機先改 A、電腦再改 B：電腦必須得到兩者的修改，寫入響應不能推進已同步版本。歸任務 6。
2. SQL 寫入失敗或封面 commit 失敗：實體、版本及當前可見封面保持一致。歸任務 2、3、7。
3. launcher 快速退出、PID 重用、傳送成功但本地清理前崩潰：恢復歸屬正確，會話僅計一次。歸任務 13、14、15。
4. ZIP 大小寫、Unicode/逗號名稱、取消後重試：同一遊戲落到同一個目錄，不重複下載已完成檔案。歸任務 9、11、12。
5. 真實 HTTPS 頁面訪問 loopback：CSP、預檢、身份驗證、瀏覽器本機訪問許可權分別驗證；手機無 bridge 仍能管理遊戲庫。歸任務 10、12、16、17。

## 實作拆分與檔案邊界

為減少計畫之間的介面漂移，先用這一份主計畫，按三個可單獨驗收的部分執行：任務 1–9 為伺服器與網頁，10–15 為 bridge 與計時，16–17 為部署及驗收。bridge 的單元實作可以使用假的 reina-server；最終聯調仍按依賴順序。

| 範圍 | 檔案與職責 |
| --- | --- |
| 共用 Rust | 新增 `src-tauri/reina-core/`；把現有 `entity.rs + entity/`、`database/dto.rs`、repository 實作搬入此處，舊路徑重匯出；保留 migration crate，避免兩套實體或遷移 |
| HTTP 服務 | 新增 `src-tauri/reina-server/`：`app.rs` 組合路由與狀態，`config.rs` 配置，`api.rs + api/` 放 auth、rpc、version、covers、metadata、scan、sessions；`main.rs` 啟動，`lib.rs` 匯出測試入口 |
| 傳輸與登入 | 修改 `src/services/invoke/base.ts`；新增 `src/services/web/auth.ts`、`http.ts`、`version.ts`；增加相鄰測試 |
| Web 查詢與介面 | 擴充套件現有 query key、`gameCachePatch.ts`、Cards、Detail、AddModal、LaunchModal；新增 `useServerVersion.ts`、`useCoverUrl.ts`、`useBridgeGames.ts` 與必要的 feature hook |
| 中繼資料 | 保留 `src/metadata/adapters/`、`sourceRegistry.ts`、`data/`；修改 `api/http.ts` 和 `sourceAutoResolve.ts`；增加伺服器代理，不另寫一整套 Rust 源解析器 |
| bridge | 擴充 `fetchlocal.py`、`config.py` 與目前實際承載 `RpcApp`/resolver/main 的 `_bridge_legacy.py`；新增 `gamestate.py`、`gamelaunch.py`、`playtime.py`，各自管理任務、程序、日誌佇列 |
| 部署 | ReinaManager 新增 `Dockerfile`、`.dockerignore`；WSL 修改 compose、`frontend/nginx.conf`、`frontend/Dockerfile`，增加 `frontend/reina-security-headers.conf` |

新檔案只用於獨立職責。後文相鄰 `*.test.ts(x)` 為新增測試，不復用或清空使用者的 `test/` 圖片目錄。

路徑約定：未標註倉庫的路徑均相對 ReinaManager 根目錄；`reina-core/...`、`reina-server/...` 分別是 `src-tauri/reina-core/...`、`src-tauri/reina-server/...` 的簡稱。同一檔案清單裡緊隨完整路徑的檔名沿用該目錄；標註 bridge 的路徑相對 bridge 倉庫，WSL 路徑始終顯式標註。

## 約定的介面

- RPC：`POST /game/api/rpc/:command`，請求 JSON 保持現有 invoke 引數名稱；成功返回原 command 的 JSON 值，錯誤返回 `{code, message}`。讀取與寫入用 Rust 註冊型別區分，與 HTTP 動詞無關。
- 版本：`GET /game/api/version → {data_version: number}`，響應 `Cache-Control: no-store`。輪詢 query 使用 `['server-version']`，不屬於批次失效的 `['server', ...]`。
- 遊戲 DTO 在現有欄位上追加 `teledrive_path: string | null`、`exe_relpath: string | null`、`cover_version: string | null`、`scan_status: 'pending' | 'needs_confirmation' | 'complete' | null`。舊桌面欄位繼續保留，但 Web 寫入拒絕本機絕對路徑。
- 封面 query 完整 key 為 `['server', 'cover', game_id, cover_version]`，這是 spec 中封面 key 加上伺服器名稱空間。快取 Blob；元件擁有各自的 object URL。
- bridge 狀態：`{games: [{path, status, completed_bytes, total_bytes, elapsed_seconds, error}]}`；`status` 為 `running/downloading/ready/incomplete/absent`。無 bridge/許可權拒絕是用戶端連線狀態，不偽裝為某款遊戲的狀態。
- 會話：`POST /game/api/sessions` 接受 spec 的 `{id, game_id, device, start, end, seconds}`，時間為 Unix 秒，UUID 字串用於冪等；響應 `{accepted: boolean}`，重複返回 `false` 且版本不變。
- 所有非 RPC 寫入口同樣透過統一寫事務邊界；僅會話去重命中允許成功但不增加版本。

## 任務 1–9（計畫 A）

細節見 [計畫 A](2026-09-26-plan-a-server-web.md)。總覽只保留各任務的交付物：

| 任務 | 交付物 |
| --- | --- |
| 1 | `reina-core` crate：entity、DTO、repository、路徑驗證搬出；`open_database` / `connect_database`；修正 migration 備份會碰到桌面版資料庫的 bug |
| 2 | migration `m20260926_000020_web_library`（雲端欄位、封面 hash、`server_state` 版本表）；`VersionRepository`；repository 可接受外部 transaction |
| 3 | `reina-server`：Config、JWT 驗證、34 個 RPC（Read 18／Write 16）、`tx::begin/finish`、`/game/api/version`、靜態檔與深層路由回退 |
| 4 | 瀏覽器登入（IndexedDB jwt、single-flight 刷新與寫回）、`authenticatedFetch`、`serverRpc`、Vitest 環境 |
| 5 | `pnpm build:web`（`/game/`、`dist-web/`）、router basename、平台能力邊界、Tauri 依賴盤點 |
| 6 | query key `["server", …]`、`useServerVersionSync`、`checkServerVersion` |
| 7 | 封面 API（版本化 URL、immutable 快取、302）、`useCoverUrl`（快取 Blob、各元件自管 object URL）、刪除遊戲後清理封面 |
| 8 | `/game/api/metadata/request` 與 `/image` 代理、各來源節流、前端 adapter 改走代理 |
| 9 | `/game/api/scan`、嚴格比對與待確認、DLsite `work_type` 與 Steam 反查、網頁掃描 UI |


> 以下任務 10–17 只保留交付物摘要。直接實作請使用 [計畫 B](2026-09-26-plan-b-bridge-playtime.md) 與 [計畫 C](2026-09-26-plan-c-deployment-validation.md)，其中已補齊真實檔案路徑、Consumes/Produces、測試碼、實作邊界與驗收命令。

## 任務 10：bridge 路由、預檢與身份驗證

**檔案（bridge 倉庫）：**修改 `_bridge_legacy.py`、`config.py`、`config.example.ini`；新增 `gamestate.py`、`tests/test_game_rpc.py`，擴充套件現有 `tests/test_bridge_e2e.py` 的 FakeBackend/rig。

**介面：**`GameRpc.handle(environ, start_response)` 由 RpcApp 僅在 `/rpc/game/*` 分派；`verify_browser_token(token: str, origin: str) -> int`；配置增加 spec 的 `[reina]` 三項。

- [ ] 寫真實 WSGI 測試：Origin 必須完整匹配含 scheme/port 的配置；OPTIONS 不要求 Bearer，但校驗 Origin、methods 和 headers；正式請求缺 token、其他使用者、過期 token 均拒絕，舊 RPC 不改變。
- [ ] 執行 `.venv\Scripts\python.exe -m pytest tests/test_game_rpc.py -q`，觀察失敗。
- [ ] 用單獨驗證請求將瀏覽器 token 送 TeleDrive `/api/v1/folders`，不能透過自動替換成 bridge 自有 token 的 `_call` 誤判；成功後讀取 user_id 與 primary_user_id 比較。
- [ ] 快取 TTL 為 `min(300秒, exp剩餘秒數)`；網路錯誤返回不可用而非“使用者未登入”；CORS 在允許 Origin 的錯誤響應也返回，非允許 Origin 回 403 且無允許頭。
- [ ] JWT 只使用於驗證/對應伺服器請求，不把原文寫日誌；繫結繼續為 loopback。為 DELETE、Authorization、Content-Type 提供正確預檢響應。
- [ ] 執行該測試及舊 `test_bridge_e2e.py` 的 RPC 用例，提交 `feat: authenticate browser game RPC on bridge`。

## 任務 11：共用 ZIP 解析與背景下載狀態機

**檔案（bridge）：**修改 `_bridge_legacy.py` 的 `_resolve_game`、`fetchlocal.py` 的 `LocalFetcher`、`gamestate.py`；新增 `tests/test_game_fetch.py`，擴充套件 `tests/test_bridge_e2e.py`。

**介面：**實際類名沿用 `LocalFetcher`，新增 `destination_for(segments: list[str]) -> Path`；`fetch(windows_path: str, *, skip_existing: bool = False, cancel: threading.Event | None = None) -> Iterator[str]`；`GameState.fetch(path: str)`、`cancel(path: str)`、`states(paths: list[str])`。

- [ ] 引數化測試普通目錄、虛擬 ZIP、非 ASCII/逗號名稱；完全相同 `.zip` 優先，不存在時按 spec 後備候選 mtime；舊 `fetch-local` 的位置和輸出不變。
- [ ] 用假的可分塊讀流測試取消、讀失敗、重啟、重複 fetch、已有完整檔案跳過、`.part` 重抓；錯誤時不寫完成標記。`destination_for` 與 `_plan` 的 root 必須相同。
- [ ] 執行 `.venv\Scripts\python.exe -m pytest tests/test_game_fetch.py tests/test_bridge_e2e.py -q` 先失敗，再提取目的地計算，修正共用 resolver。
- [ ] GameState 用規範化 path 加鎖管理每款遊戲的唯一工作；在規劃成功後建立根目錄，儲存路徑對映；流讀完也核對實際位元組數與計畫，不把短讀當完整檔案。取消檢查在每個複製區塊後執行。
- [ ] 背景任務與 HTTP 響應生命週期解耦；狀態順序按 spec。成功後原子寫 `.reina-complete` 與路徑對映，失敗保留正式檔案；重新下載開始前清理舊完成標記。服務重啟不自動重開下載，已有根目錄無標記即 incomplete。
- [ ] 使用 `reina-games.json` 記錄實際 root，路徑來自 fetcher 而非拼接 `local/game`；`cfg.cache_dir` 本身已經是 meta 目錄，統一用 `cfg.cache_dir / 'reina-games.json'`，避免再巢狀 meta。
- [ ] 請求 `paths` 用重複引數 `?paths=...&paths=...` 編碼為列表，避免逗號名稱歧義；用戶端與測試一起固定該編碼。
- [ ] 測試透過後提交 `feat: add resumable background game downloads`。

## 任務 12：網頁下載、狀態與 exe 選擇

**檔案：**新增 `src/services/web/bridge.ts`、`src/hooks/queries/useBridgeGames.ts` 及測試；擴充套件 `src/hooks/features/games/useGameLaunchFlow.ts`、`src/components/LaunchModal.tsx`、`src/components/Cards/CardItem.tsx`、`src/pages/Detail/DetailPage.tsx`。

**介面：**`bridgeService.getStates(paths: string[]): Promise<BridgeGameState[]>`、`fetch(path)`、`cancel(path)`、`getExes(path): Promise<string[]>`、`launch({path, exe_relpath, game_id, locale_emulator})`。所有呼叫複用任務 4 token 取得及單次刷新。

- [ ] 寫 hook 測試狀態按鈕、下載 2 秒/執行 10 秒輪詢、背景不必要輪詢暫停；連線拒絕與使用者許可權拒絕不誤報為遊戲不存在。測試 POST/DELETE 後立即查詢狀態。
- [ ] 首次 ready 且 exe_relpath 未設定時呼叫 exes；選擇結果透過伺服器 Write RPC 儲存；已有設定時直接啟動，409 提示重新選擇。測試 Windows 絕對路徑從不發往伺服器。
- [ ] 執行 `pnpm test:web src/hooks/queries/useBridgeGames.test.tsx`，先失敗，再將現有 launch feature 按平台分派，避免 Web 觸發桌面路徑選擇器。
- [ ] running 轉為其他狀態立刻 `checkServerVersion()`；佇列上報尚未完成時允許下一次全域輪詢補上，不假裝本地結束等於伺服器已入庫。
- [ ] 所有新增按鈕/錯誤文案走 i18n；無 bridge 的手機可以繼續遊戲庫 CRUD、掃描、封面管理。
- [ ] 測試透過後提交 `feat: connect game library actions to local bridge`。

## 任務 13：Windows 啟動、程序樹監控與即時持久化

**檔案（bridge）：**新增 `gamelaunch.py`、`tests/test_game_launch.py`；修改 `requirements.txt`、`gamestate.py`、`_bridge_legacy.py`。

**介面：**`GameLauncher.launch(path: str, exe_relpath: str, game_id: int, locale_emulator: bool = False) -> RunningSession`；`RunningSession` 欄位按 spec 加 root；`list_exes(path) -> list[str]`。

- [ ] 用程序adapter/假時鐘測試 `.exe` 枚舉、ready 前置條件、重複啟動、相對路徑穿越、絕對路徑、junction 指向根外；LE 配置為空時拒絕對應啟動選項。
- [ ] 測試 launcher 啟動後迅速退出，子程序繼續；不能僅在父 PID 仍存活時呼叫 children。利用全系統程序快照與 parent PID/create_time 跟蹤，再以遊戲 root 補充查詢，成員變化立即寫入磁碟。
- [ ] 執行 `.venv\Scripts\python.exe -m pytest tests/test_game_launch.py -q` 先失敗，再加 psutil 與無 shell 的 subprocess 引數列表；cwd 為 exe 所在目錄，LEProc 使用獨立引數，禁止管理員啟動。
- [ ] 加入任務 14 的 RunningSessionStore：啟動確認與首次 PID 持久化完成才返回成功，儲存失敗必須明確失敗並清理本次啟動的監控狀態，不留下“成功但未跟蹤”的會話。
- [ ] 2 秒監控、60 秒 last_seen；PID 身份使用建立時間；同一程序不歸入兩個恢復會話。root 補查同時用於快速 launcher 退出和恢復，避免僅靠重啟才能找回子程序。
- [ ] 測試透過後提交 `feat: launch games and track Windows process trees`。任務 13/14 相互呼叫的型別先按本介面定義，任務 13 可用記憶體假的 store 單獨驗收，真實寫入磁碟在任務 14 接入。

## 任務 14：計時日誌、崩潰恢復與補送

**檔案（bridge）：**新增 `playtime.py`、`tests/test_playtime.py`；修改 `gamelaunch.py`、`_bridge_legacy.py` 初始化/關閉流程；複用 `tdapi.py` 的登入能力。

**介面：**`RunningSessionStore.save(session)`、`remove(session_id)`、`all()`；`PlaytimeQueue.append(record)`、`ack(id)`、`pending()`；`recover_sessions()`；傳送端使用 bridge 自己取得的 JWT。

- [ ] 故障注入測試每個寫入磁碟/入隊/刪除/傳送邊界；同一 UUID 重啟後不改變，傳送成功但 ack 前崩潰可重送；損壞的 JSONL 尾部不能導致前面完整記錄丟失。
- [ ] 測試 root 補查、PID 重用、已結束會話結算 last_seen、仍存活會話沿用 start；12:00 心跳/13:00 結束/14:00 重啟應以 12:00 結算，不能假定只少 60 秒。
- [ ] 執行 `.venv\Scripts\python.exe -m pytest tests/test_playtime.py -q` 先失敗，再實作鎖保護的單寫者日誌；running 用暫存檔案 flush/fsync 後 os.replace，queue append 後 fsync，再刪 running。
- [ ] ack 重寫佇列採用同一鎖和臨時檔案原子替換，不能覆蓋傳送期間新追加的會話；結算恢復優先檢查佇列中已有 ID，避免已經結束的會話被重新附著到新啟動程序。
- [ ] 網路失敗留佇列，用有上限的退避重試；401 刷新 bridge 自有 token 後重試；不把 4xx 靜默當成功刪除。404 遊戲已刪除時保留記錄並顯示診斷，不無限快速重試。
- [ ] 檔案位置基於實際 `cfg.cache_dir`：`playtime-running.json` 與 `playtime-queue.jsonl` 放現有 meta 目錄；日誌脫敏，禁止列印 JWT。
- [ ] 測試透過後提交 `feat: persist and recover bridge playtime sessions`。

## 任務 15：伺服器會話冪等入庫與統計對接

**檔案：**新增 `src-tauri/migration/src/m20260926_000021_bridge_sessions.rs`；修改 core `entity/game_sessions.rs`、`database/repository/game_stats_repository.rs`、DTO 與相鄰測試；新增 `reina-server/src/api/sessions.rs`、`tests/sessions.rs`；調整 `src/services/game/gameStats.ts` 和統計 hooks 的 Web 分支。

**介面：**外部 UUID 存 `external_id` 唯一列，保留原整數 session_id 供舊 UI 使用；追加 device、duration_seconds，原 duration 分鐘欄位繼續作為相容投影。`insert_bridge_session(tx, record) -> Result<bool, DbErr>` 返回是否真正新增。

- [ ] 測試同一 UUID 順序/併發傳送多次僅寫一筆、統計僅增加一次、版本僅加一次；不同裝置不同 UUID 的同時間段按 spec 合計，不去重重疊時間。
- [ ] 測試不存在 game、負時長、end < start 拒絕；合法短會話仍儲存，不能沿用桌面 monitor 的“小於 60 秒丟棄”規則。精確秒數保留，顯示分鐘轉換沿用現有統計單位並覆蓋邊界測試。
- [ ] 執行 `cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test sessions` 先失敗，再複用 core 統計重建/會話落庫內部方法；新紀錄、聚合與版本必須同一事務。
- [ ] 允許崩潰恢復得到零秒會話，不能因 desktop 最小時長過濾導致 bridge 保證的記錄消失。Web 使用經過確認的 elapsed seconds，不偽裝成前臺視窗活躍時長。
- [ ] API 重送成功返回 accepted:false；Web 無 Tauri event 也能透過全域版本刷新首頁、詳情、統計和最近遊玩記錄。
- [ ] 執行 core/statistics 既有測試及新測試，提交 `feat: ingest idempotent bridge sessions into shared statistics`。

## 任務 16：Docker 與實際 WSL TeleDrive 配置

**檔案：**新增 ReinaManager `Dockerfile`、`.dockerignore`；修改 WSL `~/teledrive/docker-compose.yml`、`frontend/nginx.conf`、`frontend/Dockerfile`；新增 `frontend/reina-security-headers.conf`。

**介面：**映象 `reinamanager:local`；環境按 spec 四項，另以容器預設常量確定靜態資源和 `/data` 位置；服務名 `reinamanager`。

- [ ] Docker 使用 Node 建置前端、Rust 建置服務、精簡 runtime 三個實際階段；前端 `pnpm build:web`（輸出 `dist-web/`），Rust `cargo build --manifest-path src-tauri/Cargo.toml --release -p reina-server --locked`。`.dockerignore` 排除 `.env`、使用者 `test/`、target、node_modules、資料庫與本機憑證。
- [ ] Compose 使用 image、volume、env，不配置 ports；JWT_SECRET 引用 backend 的同一變數來源，REINA_OWNER_ID 只填使用者配置，不提交真實值。服務在 schema 初始化後才報告健康。
- [ ] nginx 增加 `/game/` 代理和 `/game` 到 `/game/` 的規範跳轉；深層回退由 reina-server 負責，API 404 保持 JSON。
- [ ] 獨立安全標頭檔案放 `/etc/nginx/snippets/reina-security-headers.conf`，Dockerfile 明確 COPY 到此路徑；不能放進 `conf.d/*.conf` 自動載入而讓 Web 的 CSP 意外成為全域配置。location 中 include 完整頭集合，connect-src 僅 self 和固定 loopback，上傳上限 10m。
- [ ] 保持 TeleDrive backend 中繼資料職責，遊戲檔案位元組只經本機 Telegram 下載。靜態 JS 不能包含 JWT_SECRET 或 Telegram session。
- [ ] 分別執行 `docker build -t reinamanager:local .`、WSL compose `config --quiet`、建置 frontend、容器 `nginx -t`；驗證響應中沒有兩條互相限制的 CSP，`/` 的 CSP 不變。
- [ ] 當前任務提交三個倉庫中各自的配置變更；實際重建/重啟在任務 17 執行，避免功能未完整時替換正在使用的入口。

## 任務 17：整合驗收、國際化與交付

**檔案：**新增 `playwright.config.ts`、`e2e/web-game.spec.ts`，修改 package test 指令碼；更新 `docs/README.md`、`docs/architecture/{README,frontend,backend,game-library,metadata}.md`，bridge `CLAUDE.md` 的新 RPC/狀態說明；新增 UI 文案更新 `src/locales/` 現有各語言檔案。

**介面：**`pnpm test:e2e` 啟動/連線配置的測試服務，使用測試 owner JWT 與隔離資料庫；真實登入驗收使用既有已登入瀏覽器，不輸出憑證。

- [ ] 配置 `pnpm test:e2e` 為 `playwright test`，安裝 `@playwright/test` 及 Chromium 測試瀏覽器；`playwright.config.ts` 使用隔離測試資料，不對正式遊戲庫執行破壞性故障注入。
- [ ] 在三個倉庫分別執行所需檢查，不用跨 shell 的複合命令：
  - ReinaManager：`pnpm test:web`；按 i18n Skill 執行 `pnpm i18n:status`、補全所有語言、`pnpm i18n:sync`、`pnpm i18n:extract`、`pnpm format`、`rg "__MISSING__" src/locales`（應無匹配）；最後 `pnpm check`、兩個建置模式。
  - Rust：在 `src-tauri` 執行 `cargo fmt --all -- --check`、`cargo test -p reina-core -p reina-server`、`cargo clippy -p reina-core -p reina-server`、`cargo check -p ReinaManager`。
  - bridge：`.venv\Scripts\python.exe -m pytest tests -q`。
- [ ] Playwright 建立隔離的兩個同 owner 瀏覽器上下文：登入提示、IndexedDB 登入、過期刷新不改 accounts、深層路徑刷新、同時使用同封面、來源封面/自定義封面切換、兩個裝置修改傳播、無修改五分鐘無全量刷新。
- [ ] 注入 fake bridge 驗證全部狀態、取消重試、409 重新選 exe、手機上下文無 bridge；真實 bridge 驗證 `.zip/.ZIP`、普通目錄、Locale Emulator、launcher、關閉後伺服器統計和離線補送。
- [ ] 部署時先檢查 bridge `/rpc/status` 的工作，使用 `restart.bat` 只重啟 bridge，不殺 rclone；背景啟動工具使用隱藏視窗。用 WSL 實際 compose 啟動 reina 服務並重建 frontend，驗證 `/` 與 `/api/v1` 的既有行為。
- [ ] 真實 HTTPS 頁面完成掃描→下載→執行→結束→統計；手機實體瀏覽器及無 bridge 瀏覽器各驗證一次。僅移動裝置模擬不能證明實體裝置網路許可權；無法自動控制實體手機時明確標記該一項待實機驗證，不宣稱已透過。
- [ ] 更新架構文件邊界和部署說明，記錄每個驗證命令、結果、實際 URL 與未完成項；截圖和網路日誌脫敏。失敗則修復所屬任務並重跑相關檢查，避免只交一份需使用者執行的命令清單。
- [ ] 提交已驗證的測試與文件：`docs: document web deployment and verified game workflow`。此時才報告實作完成。

## 設計到任務的覆蓋檢查

| spec 範圍 | 實作任務 |
| --- | --- |
| 空庫、共用 crate、桌面可建置 | 1、2、3、17 |
| 登入、刷新、owner、CSP | 3、4、10、16、17 |
| 子路徑、原生隔離 | 5、16、17 |
| 封面、代理、各源限速 | 7、8 |
| 目錄/ZIP 掃描、嚴格匹配、待確認 | 9、11 |
| 路徑、下載狀態、繼續下載、exe | 10、11、12、13 |
| 程序樹、心跳、恢復、計時佇列、統計 | 13、14、15 |
| Read/Write 事務與跨裝置資料版本 | 2、3、6、7、9、15 |
| 部署、國際化與實機完成標準 | 16、17 |

## 複查紀錄

- 2026-09-26：本文件原為單一計畫，經對照 spec 與原始碼後確認內容正確，但不符合 writing-plans 的格式（缺測試碼與實作碼、缺 Consumes/Produces）。依使用者決定拆成 A、B、C 三份，本文件改為總覽。
- 查證時發現並已修正 spec：bridge 的 `cfg.cache_dir` 已經是 `…/meta`，檔案直接放在它底下。
- 細化計畫 A 時新增的事實（計畫 A 已處理）：migration 備份會碰到桌面版資料庫、`GameInfoEdit.tsx` 在模組層級呼叫 `sep()`、`/images/…` 絕對路徑、捲動位置鍵含 `/game`、`jsdom@30` 需要較新的 Node。
- 不變的決定：單人使用、共用 TeleDrive 登入、不遷移資料、不做獨立 agent。第三方 OAuth、遠端存檔操作等 spec 沒定義的網頁功能不在範圍內。

**狀態：** 計畫 A 已實作並驗證；計畫 B、C 已細化。B、C 尚未實作，正式 Docker/WSL 部署與實機驗收尚未進行。