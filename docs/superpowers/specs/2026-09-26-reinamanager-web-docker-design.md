# ReinaManager 網頁版（Docker + TeleDrive）設計

- 日期：2026-09-26
- 狀態：設計已確認，待撰寫實作計畫
- 涉及的 repo：
  - `D:\game\ReinaManager`：reina-server、前端
  - WSL `Ubuntu-24.04:~/teledrive`：compose 與 nginx。**以這份為準**，`D:\python\teledrive` 只是參考用的副本。
  - `D:\python\teledrive-webdav`：bridge 端新增的功能

## 1. 目標與範圍

### 1.1 目標
- 在 `https://teledrive.yoyotsaoteledrive.dpdns.org/game` 用瀏覽器使用 ReinaManager，取代原本的桌面版。
- 共用 TeleDrive 的登入，不另外提供登入畫面。
- 在任何裝置上都能瀏覽和管理遊戲庫。
- 在裝有 teledrive-webdav 的 Windows 電腦上，同一個按鈕依狀態顯示「下載」或「執行」。
- 遊玩時間在所有電腦之間共用，統計的是合計時間。

### 1.2 已確認的決定
| 項目 | 決定 |
|---|---|
| 和桌面版的關係 | 網頁版取代桌面版。資料放在 Docker 容器裡，作為唯一的資料來源。 |
| 既有資料 | **不遷移**。從空的資料庫開始，遊戲庫用「掃描」建立。 |
| 本機動作 | 取回遊戲、啟動遊戲、遊玩計時、掃描新遊戲。 |
| 本機代理程式 | **不做獨立的 agent**。改為在每台電腦的 teledrive-webdav bridge 新增功能，由瀏覽器直接呼叫本機 bridge。 |
| 多台電腦 | 每台電腦各自安裝 teledrive-webdav，就能各自下載和執行。遊玩時間統一累計。 |
| 登入 | 沿用 TeleDrive 的 JWT。它存在同源的 IndexedDB：`teledrive-credentials` → `credentials` → `active.jwt`，規則見 3.1。**TeleDrive 不改程式。** |
| 路由 | 在 TeleDrive frontend 的 nginx 新增 `location /game/`。**Cloudflare 後台不用改。** |

### 1.3 第一版不做的事
- 桌面版專屬的功能：系統匣、自動啟動、updater、視窗狀態、deep link 安裝協定（`reinamanager://install`）。
- Magpie、以系統管理員身分執行。
- 舊資料庫的遷移。

**保留 Locale Emulator 啟動**，因為很多日文遊戲需要它。

## 2. 架構

```
瀏覽器（任何裝置）
 │ https://teledrive…/game/*
 ▼
Cloudflare Tunnel（teledrive-cloudflared-1，TUNNEL_TOKEN，共用 teledrive-frontend-1 的網路）
 ▼
teledrive-frontend nginx :3000
 ├─ /api/v1  ─▶ teledrive-backend:8000
 └─ /game/   ─▶ reinamanager:8787（Docker，加入 ~/teledrive compose，不對主機開 port）
                 ├─ SQLite（volume reina-data:/data，唯一資料來源）
                 ├─ 中繼資料代理（Bangumi / VNDB / Ymgal / Kungal / Hikarinagi）
                 └─ TeleDrive API（http://backend:8000，列出 game 資料夾）

瀏覽器（只有裝了 teledrive-webdav 的 Windows 才有）
 │ http://127.0.0.1:8081/rpc/game/*（CORS + TeleDrive JWT）
 ▼
teledrive-webdav bridge（每台電腦各一個）
 ├─ gamestate：本機是否已預載、下載背景工作與進度
 ├─ gamelaunch：啟動遊戲、監控程序樹
 └─ playtime：遊玩紀錄的本機佇列，以及回報給 reina-server
```

### 2.1 元件

**reina-server**（放在 ReinaManager repo，Rust + axum）
- 提供 `/game/` 的前端靜態檔案，以及 `/game/api/*` API。子路徑部署需要三件事一起做：
  - vite 的 `base` 設為 `/game/`。
  - `src/providers/router.tsx` 的 `createBrowserRouter(routeConfig, { basename: "/game" })`。
  - 深層路由回退：reina-server 對 `/game/` 底下、不屬於 `/game/api/` 也不是靜態檔的路徑，一律回傳 `index.html`。
- 封面改由 reina-server 管理，見 3.6。
- `/game/api/rpc/<command>` 對應原本的 Tauri command。
- 把 `src-tauri` 中不依賴 Tauri 的部分抽成共用 crate：database、entity、migration，以及遊戲和中繼資料的邏輯。過渡期間桌面版仍要能建置。
- **中繼資料代理**：原本前端透過 `tauri-plugin-http` 避開瀏覽器的跨網域限制，網頁版改由伺服器發出請求，並沿用各來源的限速規則。
- **掃描**：直接呼叫 TeleDrive API 列出 `game` 資料夾，不經過 `H:`。

**ReinaManager 前端**（同一套 React 程式）
- AGENTS.md 規定 `invoke` 只能在 service 層呼叫，所以只要替換傳輸層：`invoke(cmd, args)` 改成 `POST /game/api/rpc/<cmd>`。
- 移除或停用網頁上沒有意義的 Tauri API：tray、menu、window、autostart、updater、window-state、dialog。檔案選擇改成網頁上傳，或讓使用者從 bridge 回報的清單中選擇。
- 除了 `invoke`，還有以下依賴 Tauri 的地方要一併替換：
  - **封面**：`src/utils/game/gameDisplay.ts` 的 `convertFileSrc` 和 `reina-cover` 協定，改用 3.6 的 HTTP 介面。
  - **統計刷新**：`src/services/game/gameStats.ts` 原本靠 Tauri 的 `game-session-ended` 事件讓統計失效，改用 3.7 的機制。
- 新增「本機 bridge client」，負責下載／執行按鈕的狀態與進度。

**teledrive-webdav 新模組**（Python）
- 新增 `/rpc/game/*` 路由。原本的 `/rpc/*` 和 WebDAV 行為**完全不變**。
- 邏輯放在獨立檔案：`gamelaunch.py`（啟動與程序監控）和 `playtime.py`（佇列與回報）。`bridge.py` 的 `RpcApp` 只負責把請求分派給它們。
- 本文件的 `<cache_dir>` 一律指 bridge 程式裡的 `cfg.cache_dir`。它本身已經是 `<config.ini 的 paths.cache_dir>/meta`，所以後面的檔案都直接放在它底下，不要再加一層 `meta`。
- `config.ini` 新增 `[reina]` 段：`allowed_origin`（CORS 允許的網域）、`server_url`（reina-server 的網址）、`locale_emulator`（`LEProc.exe` 的路徑；留空則停用 Locale Emulator 啟動選項）。

## 3. 資料流

### 3.1 身分驗證
- **取得 token**：TeleDrive 前端已經把憑證從 `localStorage['tg_jwt']` 搬到 IndexedDB，初始化時還會刪掉舊的 localStorage 鍵，所以 `/game` 改讀同源的 IndexedDB：
  - 位置：資料庫 `teledrive-credentials`（版本 1）→ object store `credentials` → 鍵 `active`。
  - 格式：`{ accounts: StoredAccount[], jwt: string | null }`。
  - **只讀寫 `jwt` 欄位。** `accounts` 裡是 Telegram session，屬於明文的 bearer 憑證。`/game` 不讀取、不傳送、不記錄它。
  - 找不到紀錄或 `jwt` 是 null：`/game` 顯示「請先登入 TeleDrive」，並附上前往 `/` 的連結。TeleDrive 登入後不會自動跳回，由使用者自己回到 `/game`；這樣 TeleDrive 不用改程式。
- **刷新 token**：比照 TeleDrive `frontend/src/api/client.ts` 的做法。
  - 收到 401 時，用目前的 jwt 呼叫 `POST /api/v1/auth/refresh`，同一時間只送一個刷新請求，其他請求等它的結果。
  - 刷新成功後**寫回 IndexedDB**：在同一個 `readwrite` transaction 裡先 `get('active')` 再 `put`，只換掉 `jwt`，保留當下的 `accounts`，避免覆蓋 TeleDrive 分頁同時做的修改。
  - 刷新失敗（超過 refresh 寬限期）就視為未登入。
  - 舊的 jwt 在 `exp` 之前仍然有效，所以已開著的 TeleDrive 分頁繼續用舊 token 不會出錯，它之後遇到 401 會自己刷新。
- **前端 → reina-server**
  - 每次請求都帶 `Authorization: Bearer <jwt>`。
  - reina-server 從 compose 讀取和 teledrive-backend **同一個** `JWT_SECRET`，用 HS256 在本地驗證。規則和 TeleDrive 的 `decode_jwt` 一致：必須有 `exp` 和 `user_id`，且未過期。
  - 驗證通過後，`user_id` 必須等於 `REINA_OWNER_ID`，否則回 403。
- **前端 → bridge**
  - bridge **不持有** `JWT_SECRET`。它拿瀏覽器送來的 token 呼叫 TeleDrive 現有的已驗證端點（`GET /api/v1/folders`），回應 200 才算有效。
  - token 中的 `user_id` 必須等於 bridge 的 `primary_user_id`。驗證結果依 token 快取 5 分鐘。
- **401 處理**：先照上面的方式刷新一次，還是 401 才視為未登入。reina-server 和 bridge 回的 401 都這樣處理。

### 3.2 遊戲怎麼對應到檔案
- 資料庫**不存 Windows 路徑**，只存兩個欄位：
  - `teledrive_path`：`game/<資料夾名>`。
  - `exe_relpath`：遊戲目錄內的 exe 相對路徑，例如 `01000250/haison.exe`。
- 每台電腦的 bridge 自行換算本機位置，**以 fetcher 實際的下載目的地為準，不另外寫死路徑規則**：
  - 現有的 `fetchlocal.py` `_plan()` 會把遊戲放在 `<local_dir>/<名稱>`，而不是 `<local_dir>/game/<名稱>`。ZIP 遊戲的名稱是 zip 根目錄名或 view 名稱，一般資料夾則是 `entry.name`。
  - 把目的地的計算抽成公開方法 `Fetcher.destination_for(segments)`，由 `_plan()` 和 gamestate 共用，確保下載位置和狀態查詢、啟動用的路徑一定一致。
  - 下載完成時，把 `{teledrive_path: 本機根目錄}` 記到 `<cache_dir>/reina-games.json`（原子寫入）。gamestate 和 gamelaunch 都以這份紀錄為準；沒有紀錄的遊戲，才用 `destination_for()` 推算。
  - 實際執行的 exe 是 `<本機根目錄>/<exe_relpath>`。
  - 原本的 `/rpc/fetch-local` 輸出格式和下載位置不變，Explorer 右鍵選單照常使用。唯一的行為變動是修正大寫 `.ZIP` 無法解析的問題（見 3.3），這對 Explorer 也是修正。

### 3.3 下載／執行按鈕
頁面載入時，前端呼叫 `GET http://127.0.0.1:8081/rpc/game/state?paths=game%2FA&paths=game%2FB`，以重複 `paths` 參數查詢多個遊戲，保留名稱中的逗號與 Unicode。

每個 `games[]` 狀態項目可附帶 `capabilities`，例如 `{"locale_emulator": true}`；它描述該遊戲所在 bridge 可用的選項，不是整個回應的全域欄位。

| 狀態 | 判定條件 | 按鈕 |
|---|---|---|
狀態依下表**由上往下**判定，先符合的優先。每個遊戲一定落在其中一種：

| 狀態 | 判定條件 | 按鈕 |
|---|---|---|
| `running` | gamelaunch 正在追蹤這個遊戲 | 「遊玩中」和已玩時間 |
| `downloading` | 有進行中的背景工作（附已完成位元組數、總位元組數、最後一次錯誤） | 進度條，可取消 |
| `ready` | 本機根目錄有 `.reina-complete` 標記 | 執行 |
| `incomplete` | 本機根目錄存在，但沒有 `.reina-complete`，也沒有背景工作。會出現在取消下載、下載失敗、bridge 在下載途中重啟之後 | 繼續下載（附上次的錯誤訊息，如果有的話） |
| `absent` | 本機根目錄不存在 | 下載 |
| 呼叫失敗 | 沒有 bridge，或區域網路權限被拒 | 停用，並顯示原因 |

- **下載與繼續下載**：`POST /rpc/game/fetch {path}` 會在 bridge 裡開一個背景工作。`absent` 和 `incomplete` 都用同一個入口。
  - 背景工作沿用 `fetcher.fetch()` 的規劃與複製邏輯，關掉網頁也不會中斷；目前 `/rpc/fetch-local` 的串流在分頁關閉時會中斷，這就是要改成背景工作的原因。
  - 背景工作以 `skip_existing=True` 呼叫 fetcher。fetcher 本來就是先寫 `.part`、完成後才 `os.replace` 成正式檔名，所以正式檔案一定是完整的。遇到大小和計畫相同的正式檔案就跳過，不再下載；殘留的 `.part` 一律捨棄重抓。這樣「繼續下載」只補沒完成的檔案。舊的 `/rpc/fetch-local` 不傳這個參數，行為不變。
  - 同一個 `path` 同時只能有一個背景工作；重複送出會回傳進行中的那一個。
  - 前端在 `downloading` 期間每 2 秒輪詢一次 `state`。
  - 完成時（fetcher 輸出 `OK <root>`）寫入 `.reina-complete`，並更新 `reina-games.json`。失敗時（輸出 `ERROR …`）結束背景工作，錯誤訊息保留在記憶體裡，讓下一次 `state` 回傳；狀態會變成 `incomplete`。
  - `DELETE /rpc/game/fetch?path=` 會取消下載：在目前檔案寫完當下這個區塊後停止，狀態變成 `incomplete`。
- **ZIP 名稱的大小寫**：列表（`get_member_names` 和掃描）以不分大小寫的方式去掉 `.zip`，但 `bridge._resolve_game` 目前只找 `top + ".zip"`。所以 `Foo.ZIP` 在 `H:\game\` 顯示成 `Foo`，卻開不了，也下載不了。這是**現有的 bug**，Explorer 也會遇到。
  - 修正方式是直接改 `_resolve_game`，不另外為 `/rpc/game/*` 寫一套解析，讓 `H:`、`fetch-local` 和 `/rpc/game/*` 共用同一個規則。
  - 規則：先找完全相同的 `top + ".zip"`；找不到時，在 `game_children()` 裡找「去掉 `.zip`（不分大小寫）後等於 `top`」的非目錄項目。有多筆符合時，取 `mtime` 最新的一筆，並記錄警告。
  - 解析的優先順序不變：暫存區 → ZIP → 其他項目。
- **執行**：`POST /rpc/game/launch {path, exe_relpath, game_id, locale_emulator?}`。
  - bridge 先解析出實際路徑，確認它**位於該遊戲的本機目錄內**（防止 `..` 和絕對路徑），而且狀態是 `ready`，才啟動。
  - 條件不符就回 409。
- **選擇 exe**：遊戲第一次變成 `ready` 時，前端呼叫 `GET /rpc/game/exes?path=`，列出候選 exe，讓使用者選一次，結果存進 reina-server。

### 3.4 遊玩計時
- **開始**：gamelaunch 啟動遊戲後，監控**整個程序樹**，包含 launcher 另外開的子程序。
- **結束**：最後一個程序結束時，這段遊玩就結束。
- **遊玩紀錄**的格式：`{id: uuid, game_id, device, start, end, seconds}`。
  - `device` 是電腦名稱。
  - 紀錄先附加到 `<cache_dir>/playtime-queue.jsonl`，再用 bridge 自己的 TeleDrive JWT 送到 `POST /game/api/sessions`，送成功後才從佇列移除。
  - reina-server 依 `id` 去重，重送也不會重複計算。
- **執行中紀錄**：`<cache_dir>/playtime-running.json` 存成一個以 `session_id` 為鍵的物件。每筆記錄**完整的遊玩身分**：
  - `{session_id, game_id, device, start, pids: [{pid, create_time}], last_seen}`。
  - `create_time` 是程序的建立時間，用來避免 PID 被系統回收重用後誤判成同一個程序。
  - 每次寫入都用「暫存檔 → `os.replace`」原子寫入。
- 執行中紀錄裡再加一個欄位 `root`：遊戲的本機根目錄，恢復時用來找程序（見下方）。
- **寫入時機**：程序樹變動和時間心跳**分開寫入**。
  1. **啟動**：產生 `session_id`，**先寫入**執行中紀錄，才回應 `launch` 成功。
  2. **程序樹變動**：monitor 每 2 秒檢查一次程序樹。只要有子程序加入或結束，就**立刻**改寫該筆的 `pids`，不等心跳。典型的 launcher 開完遊戲就結束，這種情況也會在 2 秒內寫到磁碟。
  3. **時間心跳**：每 60 秒更新一次 `last_seen`，只用來推算當機時的結束時間。
  4. **結束**：先把遊玩紀錄（沿用同一個 `session_id` 當作 `id`）附加到 `playtime-queue.jsonl` 並 `fsync`，**然後**才刪除執行中紀錄。
  5. **回報**：佇列裡的紀錄送出成功後才移除。
- **bridge 重啟時的恢復**：逐筆檢查 `playtime-running.json`。
  1. 如果紀錄裡有任何 `pid` 還活著，而且 `create_time` 相符，就接回監控，沿用原本的 `session_id` 和 `start`。
  2. 如果紀錄裡的程序都不在了，就**掃描系統上所有程序**，找執行檔路徑位於 `root` 底下、而且建立時間晚於 `start` 的程序。有找到就接回監控，並立刻改寫 `pids`。這一步處理的是「launcher 剛開了子程序，bridge 在 2 秒內就當掉」這種最壞情況。
  3. 兩者都找不到，就以 `last_seen` 當作 `end`，照第 4 步的順序結算。結算前先檢查佇列裡是否已經有同一個 `session_id`（表示寫完佇列後、刪除紀錄前當掉），有的話只刪除執行中紀錄，不再附加一次。
  - 就算重複送出，reina-server 也會依 `id` 去重。
- **保證範圍**（不承諾「完全不會遺失」）：
  - **不會重複計算**：每段遊玩只會產生一筆紀錄，由 `session_id` 去重。
  - **不會整段遺失**：只要執行中紀錄已經寫入，就一定會產生一筆遊玩紀錄。
  - **時長規則**：只計算能確認的時間。最後一次心跳（`last_seen`）之後、bridge 無法確認遊戲還在執行的時間，一律不計入。
    - 遊戲在 bridge 停機期間仍在執行，重啟後被接回：停機期間的時間**會計入**。這時 `start` 不變，結束時間是實際偵測到的時間，所以沒有誤差。
    - 遊戲在 bridge 停機期間就結束了：結算到 `last_seen` 為止。少算的時間是「最後一次心跳到遊戲實際結束」這一段，**最多可能等於整段停機時間**。例如 12:00 最後一次心跳，bridge 接著當掉，遊戲玩到 13:00，bridge 14:00 才重啟，就會少算 1 小時。
    - 60 秒只是**bridge 正常運作時**，最後一次心跳沒涵蓋到的時間上限（例如 bridge 程序本身當掉的那一刻）；它不限制停機期間的遊玩時間。
  - **無法接回的情況**：遊戲程序的執行檔不在 `root` 底下（例如 launcher 另外啟動系統上已安裝的程式），而且 bridge 在程序樹寫入前的 2 秒內當掉。這時同樣以 `last_seen` 結算。
- **統計**：所有電腦的遊玩紀錄都存進同一個資料庫，統計頁面顯示的是合計。

### 3.5 掃描新遊戲
- 網頁上按「掃描」後，reina-server 用使用者的 JWT 列出 `game` 資料夾的內容，**語意必須和 bridge 的 `/game` 目錄一致**：
  - 同時分頁讀取 `GET /folders` 和 `GET /files`（依照 `tdapi._list_both` 和 `_list_paginated`），兩者合併。
  - 名稱相同時保留較新的一筆（依照 `tdapi.children_by_name`）。
  - 副檔名是 `.zip` 的檔案（不分大小寫）視為遊戲，名稱去掉 `.zip`（依照 `zipfs.is_zip_name` 和 `strip_zip_suffix`）。bridge 打包上傳的遊戲都是這種形式。
  - 分割檔（`is_split_file`）以列表回傳的那一列為準，不另外展開各個分割部分。
  - 其他一般檔案不算遊戲。
  - bridge 本機還在暫存、尚未上傳的遊戲不在掃描範圍內，上傳完成後再掃描一次就會出現。
- `teledrive_path` 使用去掉 `.zip` 後的名稱，也就是 `H:\game\` 底下看到的名稱，和 bridge 解析路徑的方式一致。
- 資料庫裡還沒有的資料夾會自動新增條目，並依序從各來源抓封面和中繼資料。比對規則如下：
  - 資料夾名稱符合 RJ 號碼或 Steam App ID 時，先反查平台。但作品類型不是遊戲時（例如 DLsite 的 `work_type` 是 `SOU` 音聲），**不採用這個 ID**。
  - 名稱比對採用嚴格規則：完全相同或和別名相同才算高信心；包含關係要看長度比例，太短的名稱不採用。
  - 低信心的結果標為「待確認」，不會自動套用。
- exe 相對路徑在掃描階段還不知道，要等第一次下載完成時才決定（見 3.3）。

### 3.6 封面
- **儲存**：所有封面都存在 reina-server 的 `/data/covers/game_<id>/`，位於 volume `reina-data` 內。
  - 從中繼資料來源取得的圖片網址，在新增或掃描時由伺服器下載，存成本地檔案。
  - 使用者上傳的自訂封面也存在這裡。
  - 瀏覽器不直接載入外部圖床，所以 CSP 的 `img-src` 維持 `'self' data: blob:` 就夠了。
- **介面**
  - `GET /game/api/covers/<game_id>?v=<cover_version>`：回傳圖片。
    - `cover_version` 是封面內容的 hash，跟著遊戲資料一起回傳。封面一有變動（新增、上傳、刪除、重新抓取）它就會變，所以**版本直接寫在 URL 裡**。
    - 快取設定是 `Cache-Control: private, max-age=31536000, immutable`：同一個 URL 的內容永遠不變，換了封面就換成新的 URL，瀏覽器不會拿舊圖。
    - `v` 和目前版本不同時，回 `302` 導向目前版本的 URL，避免舊頁面拿到錯的圖卻被長期快取。
  - `PUT /game/api/covers/<game_id>`：上傳自訂封面，大小上限 10 MB。
  - `DELETE /game/api/covers/<game_id>`：移除自訂封面，恢復成來源封面。
- **驗證**：`<img src>` 無法帶 `Authorization` 標頭，所以前端改用 `fetch`（帶 Bearer）取得圖片，再轉成 `blob:` URL 顯示。
  - React Query 快取的是 **`Blob` 物件本身**，key 是 `["cover", game_id, cover_version]`，而不是 blob URL。
  - **每個元件自己管理 object URL**：hook（`useCoverUrl`）在 `useEffect` 裡對快取的 Blob 呼叫 `URL.createObjectURL`，cleanup 時（元件卸載或 Blob 換掉）呼叫 `URL.revokeObjectURL`。
  - 這樣一個元件撤銷自己的 URL，不會影響其他元件；離開頁面再回來時，會用快取的 Blob 建立新的 URL。
  - 封面 query 的 `gcTime` 設為 30 分鐘，避免 Blob 一直占用記憶體；快取被清掉後，重新 fetch 同一個 URL 會直接命中瀏覽器的 HTTP 快取。
- **前端改動**：`gameDisplay.ts` 的 `getGameCover` 改為回傳封面版本，由上述 hook 產生 URL。`convertFileSrc` 和 `reina-cover` 協定在網頁版一律不用。

### 3.7 資料刷新（跨裝置）
- 原本的 `queryClient` 預設資料永不過期、視窗聚焦和重新連線時也不刷新，統計則只靠 Tauri 的 `game-session-ended` 事件更新。網頁版有多台裝置：別台電腦回報的遊玩紀錄、bridge 補送的紀錄，以及用手機新增、刪除遊戲或調整合集，已開著的頁面都不會知道。
- **採用一個全域資料版本加輪詢，不做伺服器推播**（單人使用，輪詢的成本可以忽略，也不用處理 nginx 和 Cloudflare 對長連線的緩衝與逾時）：
  - reina-server 在資料庫裡維護一個 `data_version`，提供 `GET /game/api/version`，回傳 `{data_version}`。
  - **任何會改變伺服器資料的操作成功後**，都在同一個 transaction 裡遞增 `data_version`。包括遊戲、合集、設定、封面的新增修改刪除、掃描、中繼資料更新，以及接受一筆**新的**遊玩紀錄（依 `id` 去重後；重送的舊紀錄不遞增）。
  - **不能用 HTTP 方法判斷。** 所有 RPC 都是 `POST /game/api/rpc/<command>`，其中也包含 `find_all_games`、`find_game_by_id` 這類讀取命令。如果非 GET 就遞增，每次讀取都會改變版本，輪詢就會不停觸發全面重新載入。
  - **依 command 的讀寫性質分類**：在 reina-server 註冊 command 時，一定要宣告它是 `Read` 還是 `Write`，沒宣告就無法編譯。
    - `Read`：不開 transaction，不遞增版本。
    - `Write`：路由層開一個 transaction 交給 command 使用。共用 crate 的資料庫函式都接受 `&impl ConnectionTrait`，所以可以直接傳 transaction 進去。command 成功後，**在同一個 transaction 裡**把 `data_version` 加 1，再 commit；command 失敗就 rollback，版本不變。
  - **封面檔案**：檔案寫在 volume 裡，不在資料庫中。做法是先寫入新檔，再在 Write transaction 裡更新 `cover_version` 並遞增版本；如果 commit 失敗，就刪掉剛寫入的新檔。
  - **`POST /game/api/sessions`**：同樣在 transaction 裡處理，但只有真的新增了紀錄（依 `id` 去重後）才遞增。重送的舊紀錄不遞增，避免 bridge 補送時讓所有頁面白白重新載入。
- **前端**
  - 頁面在前景（`document.visibilityState === "visible"`）時，每 60 秒查一次版本；視窗重新聚焦或網路重新連線時也立刻查一次。
  - 版本和上次不同時，讓**所有來自伺服器的 query 失效**（統一的 key 前綴 `["server", …]`）。bridge 的狀態 query 不受影響。
  - 自己剛送出的修改，照原本的做法直接更新或失效對應的 query，不必等輪詢。
  - **前端記錄的「已同步版本」只能從 `GET /game/api/version` 的輪詢結果更新，不能用修改請求回傳的版本。** 修改請求回傳的版本可能已經包含其他裝置同時做的修改，直接記下來會把那些修改當成已同步，之後就再也看不到。代價是每次自己修改後，下一次輪詢會多做一次全面重新載入；單人使用可以接受。
  - 本機的 bridge client 發現某個遊戲從 `running` 變成其他狀態時，立刻查一次版本。這取代原本 `game-session-ended` 的即時效果。
  - `running` 狀態期間，bridge client 每 10 秒查一次 `state`，用來顯示已玩時間和偵測遊戲結束。

## 4. 錯誤處理

| 情況 | 處理方式 |
|---|---|
| 找不到本機 bridge | 按鈕停用並顯示原因，其他功能照常可用。 |
| 區域網路權限被拒 | 顯示如何在網站設定裡重新允許。 |
| 下載失敗、取消，或 bridge 在下載途中重啟 | 狀態變成 `incomplete`，按鈕是「繼續下載」，並顯示 fetcher 的 `ERROR …` 訊息（如果有的話）。fetcher 失敗時會刪掉當下的 `.part` 檔；已經完成的正式檔案保留，繼續下載時跳過。沒有 `.reina-complete` 就不會判定為 `ready`。 |
| exe 不存在，或不在遊戲目錄內 | 回 409，前端提示「重新選擇執行檔」。 |
| 中繼資料來源逾時或被限速 | 伺服器端依來源限速，前端顯示部分結果。 |
| reina-server 或 TeleDrive 無法連線 | 前端顯示離線狀態。遊玩紀錄留在 bridge 的佇列裡，恢復後補送。 |
| JWT 過期或簽章無效 | reina-server 與 bridge 回 401，前端導回 TeleDrive 登入。 |
| JWT 有效但帳號不是設定的擁有者 | reina-server 與 bridge 回 403。 |
| CORS 的 Origin 不符 | bridge 不回傳 CORS 標頭，`/rpc/game/*` 回 403。 |

## 5. 部署

- **ReinaManager repo**
  - 新增 `Dockerfile`，分兩個階段建置：Node 階段執行 `pnpm build`，Rust 階段執行 `cargo build --release -p reina-server`，最後得到精簡的 runtime 映像檔。
- **`~/teledrive/docker-compose.yml`**
  - 新增 `reinamanager` 服務：
    - 使用 `image: reinamanager:local`。映像檔在 ReinaManager repo 用 `docker build -t reinamanager:local .` 建好；兩邊共用同一個 Docker Desktop，所以 compose 不必跨 `/mnt/d` 建置。
    - volume：`reina-data:/data`。
    - 環境變數：`JWT_SECRET`（和 backend 同一個來源）、`REINA_OWNER_ID`、`TELEDRIVE_API=http://backend:8000`、`REINA_PORT=8787`。
    - 不設定 `ports`。
- **`~/teledrive/frontend/nginx.conf`**
  - 新增 `location /game/`，`proxy_pass http://reinamanager:8787`。
  - `/game/` 的 `client_max_body_size 10m`，用來上傳封面；其他路徑維持原本的 `1m`。
  - **`/game/` 使用自己的安全標頭檔 `reina-security-headers.conf`。** 現有的 `security-headers.conf` 把 `connect-src` 限定在同源和 Telegram，會擋掉 `fetch('http://127.0.0.1:8081/…')`；這時 bridge 就算放行 CORS 也沒用。
    - 依 nginx 規則，只要 location 裡有任何 `add_header`，就不會繼承上層的 `add_header`。所以新檔要**完整列出**所有安全標頭：
      - `X-Content-Type-Options`、`X-Frame-Options`、`Referrer-Policy`、`Permissions-Policy`、`Cross-Origin-Resource-Policy` 維持原值。
      - CSP 只調整 `connect-src`：`'self' http://127.0.0.1:8081`。
      - 不加入 Telegram 的網址，因為 `/game` 不需要。
      - 其他 CSP 指令和 TeleDrive 相同（`script-src 'self'`、`img-src 'self' data: blob:` 等）。
    - TeleDrive 其他路徑的 CSP **完全不變**。
  - `/game` 和 TeleDrive 同源，可以讀到 IndexedDB 裡的 Telegram session（見 3.1），所以 CSP 就是防止 session 被竊取的邊界：
    - `connect-src` 只開放 bridge 這一個固定位址。
    - 不使用任何第三方 script 或 CDN。
    - 不使用 `unsafe-eval`。
  - frontend 映像檔要重新建置，或重新載入 nginx 設定。
- **teledrive-webdav**
  - `config.ini` 新增 `[reina]` 段，改完用 `restart.bat` 生效。不需要重啟 rclone。
- **Cloudflare**
  - 不需要任何修改。Tunnel 原本就把流量導向 frontend nginx。

## 6. 測試

- **reina-server**
  - JWT 驗證的單元測試：有效、過期、簽章錯誤、不是本人的 `user_id`。
  - 每個 `/game/api` 端點用暫存 SQLite 做整合測試。
  - 掃描的列表合併：`/folders` 和 `/files` 都要分頁讀完、同名時保留較新的一筆、`.zip`／`.ZIP` 去掉副檔名、一般檔案不算遊戲。
  - `/game/` 深層路由回退到 `index.html`，`/game/api/*` 則不受影響。
  - 遊玩紀錄的 `id` 去重：重送不會讓 `data_version` 遞增，新紀錄會。
  - 每個 `Read` command（例如 `find_all_games`、`find_game_by_id`）呼叫後，`data_version` 都不變。
  - 每個 `Write` command 成功後，`data_version` 恰好加 1，而且和業務資料在同一次 commit；command 失敗或 rollback 時，資料和版本都不變。
  - 封面上傳時如果 commit 失敗，新寫入的封面檔會被刪掉，`cover_version` 和 `data_version` 都不變。
  - 封面：`v` 不是目前版本時回 302；回應的快取標頭是 `immutable`。
  - 掃描比對的回歸測試，資料採用之前封面腳本的誤配案例：`h → H+`、`RANZE → RAYZE`、`Hypnosis App 2 → Hypnosis`，以及 RJ01000250（音聲作品誤當成遊戲 ID）。
- **bridge**（沿用現有 pytest，TeleDrive 和 MTProto 都用假的）
  - CORS 只放行 `allowed_origin`。
  - token 驗證。
  - `state` 判定：六種狀態都要能判定到，而且依表格順序優先；沒有完成標記就不算 `ready`；取消下載、下載失敗、下載途中重啟 bridge 之後都是 `incomplete`。
  - 繼續下載：已完成的正式檔案會跳過，殘留的 `.part` 會重抓；同一個 path 重複送出不會開第二個背景工作。
  - 大寫 ZIP：`Foo.ZIP` 在 `H:\game\Foo` 能解析；`/rpc/game/fetch`、舊的 `/rpc/fetch-local` 都能下載；下載到 `destination_for()` 算出的位置；狀態最後會變成 `ready`。`Foo.zip` 和 `Foo.ZIP` 同時存在時，不論哪個比較新，都一定用完全相同的 `Foo.zip`。只有 `Foo.ZIP` 和 `foo.Zip` 這類都不是完全相同的候選時，才取 `mtime` 最新的一筆。
  - `launch` 拒絕遊戲目錄以外的路徑。
  - 計時佇列在重啟和補送時不會重複計算。
  - 資料夾形式和 ZIP 形式的遊戲，`destination_for()` 的結果都和 `_plan()` 實際的下載目的地相同；舊的 `/rpc/fetch-local` 輸出沒有改變。
  - 計時恢復：模擬在寫入順序的每一步之間當掉，重啟後每種情況都恰好產生一筆遊玩紀錄，而且 `session_id` 和原本相同；PID 被重用（`create_time` 不同）時不會被接回。
  - launcher 情境：launcher 開了子程序後立刻結束。在程序樹寫入之前讓 bridge 當掉，重啟後要能透過「執行檔在 `root` 底下」接回子程序，不能提前結算。
  - 時長規則：
    - bridge 停機期間遊戲結束時，時長結算到 `last_seen`，不會把停機期間算進去。
    - bridge 停機期間遊戲仍在執行，之後被接回時，時長包含停機期間，`start` 維持原本的值。
- **前端**：`pnpm check` 要通過。
- **實機驗證**（依照 teledrive-webdav 的 CLAUDE.md，測試通過不算完成）
  - 用這台電腦的瀏覽器開 `https://teledrive…/game`，走完「掃描 → 下載 → 執行 → 關閉遊戲 → 確認遊玩時間有累計」。
  - 用手機開同一個網址，確認可以瀏覽，按鈕是停用的。
  - 直接開啟 `/game/libraries/<id>`，並在該頁按重新整理，頁面要正常顯示，不能出現 404。
  - 在已登入 TeleDrive 的瀏覽器開 `/game`，不用重新登入就能使用。把 jwt 改成過期的，會自動刷新，而且刷新後 TeleDrive 分頁仍然正常（`accounts` 沒有被覆蓋）。
  - 用瀏覽器 DevTools 確認 `/game` 回應的 CSP 包含 `http://127.0.0.1:8081`，而 `/` 回應的 CSP 和原本相同。
  - 新增遊戲和掃描後，封面都能顯示，重新整理後仍然在。
  - 開著統計頁，從另一台電腦（或用 curl 模擬 bridge）回報一筆遊玩紀錄，60 秒內頁面數字要更新。
  - 分別用資料夾形式和 ZIP 形式的遊戲，走完「掃描 → 下載 → 執行」。
  - 電腦開著遊戲庫頁面時，用手機新增一個遊戲、改一個封面，60 秒內電腦頁面要出現新遊戲和新封面（不是舊圖）。
  - 先用手機修改遊戲 A，緊接著在電腦上修改遊戲 B，電腦頁面的 A 和 B 都要更新成新的內容。
  - 頁面開著、沒有人修改任何東西時，觀察 5 分鐘，網路面板裡只能看到 `/game/api/version` 的輪詢請求，不能出現全面重新載入。
  - 下載到一半按取消，按鈕變成「繼續下載」；按下後只補沒完成的檔案，最後變成「執行」。
  - 下載途中重啟 bridge（`restart.bat`），按鈕同樣變成「繼續下載」。

## 7. 實作順序

每個階段都能單獨驗證：

1. **reina-server 基礎**：抽出共用 crate，建好 axum 骨架、JWT 驗證、Dockerfile、compose，以及 nginx 路由和 `/game/` 的 CSP。驗收標準：已登入 TeleDrive 的瀏覽器可以直接打開 `/game`（讀 IndexedDB 的 jwt），深層路由重新整理不會 404。
2. **前端上線**：傳輸層改成 HTTP、token 刷新和寫回、router 的 basename、封面的 HTTP 介面，停用桌面版專屬功能，中繼資料改由伺服器代理。驗收標準：可以手動新增和編輯遊戲、抓取中繼資料，封面能顯示。
3. **掃描**：透過 TeleDrive API 列出 `game` 資料夾，自動新增條目並抓封面，含待確認機制。
4. **bridge 端**：新增 `/rpc/game/state`、`fetch`、`launch`、`exes`，以及 CORS 和 token 驗證。驗收標準：下載和執行按鈕可以使用。
5. **遊玩計時**：監控程序樹、執行中紀錄與恢復、本機佇列、`/game/api/sessions`，並接上統計頁面。

`data_version` 和 `/game/api/version` 的輪詢放在第 2 階段，因為那時網頁上就能修改遊戲庫，需要跨裝置同步。
