# 計畫 B：bridge 與計時（任務 10–15）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (<code>- [ ]</code>) syntax for tracking.

**Goal:** 讓 ReinaManager 網頁版安全地連到每台 Windows 的 TeleDrive bridge，完成雲端遊戲的背景下載、續傳、exe 選擇、Locale Emulator 啟動、程序樹監控、崩潰恢復與跨電腦遊玩時間彙總。

**Architecture:** 本機能力全部留在 <code>teledrive-webdav</code>。瀏覽器只呼叫 loopback <code>http://127.0.0.1:8081/rpc/game/*</code>；bridge 不持有 <code>JWT_SECRET</code>，而是拿瀏覽器送來的 TeleDrive JWT 去 TeleDrive 已驗證端點驗證。下載共用現有 <code>LocalFetcher</code> 與 <code>Resolver</code>，不另寫第二套 ZIP/路徑規則。啟動與計時分成 <code>gamelaunch.py</code>、<code>playtime.py</code>，執行中的 session 與待送紀錄先落本機磁碟，再由 bridge 自己的 TeleDrive JWT 回報 reina-server。伺服器端以外部 UUID 冪等寫入既有會話與統計模型，所有實際新增和 <code>data_version</code> 在同一 transaction。

**Tech Stack:** Python 3、cheroot/WsgiDAV、requests、Telethon、psutil、pytest；React + TypeScript、TanStack Query、Vitest；Rust、axum、SeaORM/SQLite。

**Spec:** [2026-09-26-reinamanager-web-docker-design.md](../specs/2026-09-26-reinamanager-web-docker-design.md)  
**總覽:** [2026-09-26-reinamanager-web-docker.md](2026-09-26-reinamanager-web-docker.md)  
**前置:** [計畫 A](2026-09-26-plan-a-server-web.md) 已產生 <code>authenticatedFetch</code>、<code>checkServerVersion</code>、<code>tx::begin/finish</code>、<code>TestApp</code>、<code>reina-core</code> 與 <code>reina-server</code>。

## Global Constraints

- **三個工作目錄：**
  - ReinaManager：<code>D:/game/ReinaManager</code>。
  - bridge：<code>D:/python/teledrive-webdav</code>。
  - TeleDrive：本計畫 B 不修改；部署留到計畫 C。
- **先記錄狀態：**每個任務開始前分別記錄相關 repo 的 branch、HEAD、未提交變更；不要覆蓋使用者工作。
- **bridge 實際程式結構：**<code>RpcApp</code>、<code>Dispatcher</code>、<code>build_app</code>、<code>main</code> 與 <code>Resolver._resolve_game</code> 都直接定義在 <code>D:/python/teledrive-webdav/bridge.py</code>，沒有 legacy 模組匯入。任務 10–14 的路由、resolver 與生命週期接線直接修改 <code>bridge.py</code> 的既有定義；實作前再核對入口，不建立另一份同名類別。
- **原有 bridge 行為不回歸：**<code>/rpc/health</code>、<code>/rpc/status</code>、<code>/rpc/fetch-local</code>、<code>/rpc/thumb</code>、<code>/rpc/props</code> 以及 WebDAV mount 行為保持相容。
- **loopback 邊界：**bridge 繼續只綁 <code>127.0.0.1</code>。新增 CORS 只讓指定 ReinaManager Origin 從瀏覽器存取 <code>/rpc/game/*</code>，不把既有匿名 WebDAV/RPC 暴露到網路。
- **JWT 邊界：**bridge 不知道 <code>JWT_SECRET</code>，不驗簽 JWT。必須先用原 token 呼叫 TeleDrive 已驗證 API 成功，之後才可把 JWT payload 當作已被上游認證的 claims 讀取；JWT、Authorization、Telegram session 不得進 log。
- **路徑邊界：**reina-server 只存 <code>teledrive_path</code> 和 <code>exe_relpath</code>。Windows 絕對路徑只存在 bridge 本機，不可回寫伺服器。
- **本機資料位置：**本計畫所有 bridge 狀態檔都直接放 <code>cfg.cache_dir</code>；該值目前已是設定 <code>paths.cache_dir/meta</code>，不得再加一層 <code>meta</code>。
- **輪詢頻率：**downloading 最快每 2 秒；running 每 10 秒；沒有活躍工作時不固定輪詢。bridge 程序樹每 2 秒檢查；<code>last_seen</code> 每 60 秒持久化。
- **前端分層：**元件不直接使用 <code>useQuery</code>/<code>useQueryClient</code>；HTTP 在 service，Query key/cache 在 query hook，流程編排在 feature hook。
- **桌面相容：**桌面版現有遊戲啟動、Tauri event 與統計仍要可建置；Web 分支不得觸發桌面檔案對話框、Magpie 或管理員啟動。
- **i18n：**任務 12 若新增 UI 字串，同步 <code>zh-CN</code>、<code>zh-TW</code>、<code>en-US</code>、<code>ja-JP</code>；完整 i18n 驗收集中在計畫 C。
- **Commit：**每個任務一個可驗收 commit；只暫存該任務檔案，禁止 <code>git add .</code>。

## Locked Interfaces

### bridge browser RPC

所有新增端點都在：

- <code>OPTIONS /rpc/game/*</code>
- <code>GET /rpc/game/state?paths=game%2FA&paths=game%2FB</code>
- <code>POST /rpc/game/fetch</code>，JSON <code>{"path":"game/A"}</code>
- <code>DELETE /rpc/game/fetch?path=game%2FA</code>
- <code>GET /rpc/game/exes?path=game%2FA</code>
- <code>POST /rpc/game/launch</code>，JSON <code>{"path":"game/A","exe_relpath":"bin/game.exe","game_id":1,"locale_emulator":false}</code>

正式請求帶：

- <code>Origin: https://...</code>
- <code>Authorization: Bearer &lt;TeleDrive JWT&gt;</code>

狀態格式：

~~~json
{
  "games": [
    {
      "path": "game/A",
      "status": "downloading",
      "completed_bytes": 1048576,
      "total_bytes": 8388608,
      "elapsed_seconds": 12,
      "error": null
    }
  ]
}
~~~

<code>status</code> 只能是 <code>running</code>、<code>downloading</code>、<code>ready</code>、<code>incomplete</code>、<code>absent</code>。沒有 bridge、CORS 被瀏覽器拒絕、網路錯誤屬於**連線狀態**，不能偽裝成 <code>absent</code>。

### Playtime record

bridge → reina-server：

~~~json
{
  "id": "8b5d2a2d-...",
  "game_id": 12,
  "device": "DESKTOP-ABC",
  "start": 1790551200,
  "end": 1790554812,
  "seconds": 3612
}
~~~

成功：

~~~json
{"accepted": true}
~~~

同 UUID 重送：

~~~json
{"accepted": false}
~~~

重送命中不能再次增加統計或 <code>data_version</code>。

## Review Focus

1. **瀏覽器 token 被 bridge 自己的 JWT 取代：**驗證瀏覽器 token 的 HTTP 呼叫不能走會自動帶 <code>TeleDriveClient._token</code> 的 <code>_call</code>。
2. **JWT payload 未驗簽：**bridge 可以在上游驗證 200 之後讀 payload 的 <code>user_id/exp</code>；在上游成功之前不得信任 claims。
3. **逗號與 Unicode 遊戲名：**<code>paths</code> 必須用重複 query parameter，不用逗號分隔。
4. **大寫 ZIP：**<code>Foo.zip</code> 精確候選永遠優先；只有沒有精確候選時，才在 <code>Foo.ZIP</code>/<code>foo.Zip</code> 等候選中取較新的。
5. **取消/崩潰續傳：**正式檔只在完整讀完後 <code>os.replace</code>；<code>.part</code> 不可被視為完成；已有同大小正式檔才可跳過。
6. **launcher 瞬間退出：**監控不能只追 <code>children()</code>；程序樹還未持久化前崩潰時，要能用 root 路徑掃描接回真正遊戲程序。
7. **PID 重用：**PID 與 <code>create_time</code> 必須一起比對。
8. **送出成功、ack 前崩潰：**重啟後會重送同 UUID，伺服器只算一次。
9. **零秒恢復紀錄：**bridge 已建立 running record 後，即使只能確認 0 秒，也要留下一筆會話；不能套桌面版「少於 60 秒不記錄」規則。
10. **統計分鐘相容：**保留精確 <code>duration_seconds</code>，既有分鐘欄位使用桌面版同一個四捨五入規則：<code>seconds / 60 + (seconds % 60 &gt;= 30)</code>。
11. **canonical path 不可經 drive letter round-trip：**browser 傳 <code>game/A</code>；只有舊 Explorer wrapper 處理 <code>H:\...</code>。兩者都要落到同一個 <code>fetch_segments()</code>。
12. **running store lost update：**atomic replace 只能避免半檔，不能避免兩個 monitor thread 的 snapshot 覆寫；running map mutation 必須有單一 mutex。

---

### 任務 10：bridge 路由、CORS 預檢與瀏覽器身份驗證

把 <code>/rpc/game/*</code> 做成與舊 RPC 分離的 browser control plane。這一步只建立安全邊界與路由骨架，不實作下載/啟動。

**Files（teledrive-webdav）:**
- Modify: <code>config.py</code>
- Modify: <code>config.example.ini</code>
- Modify: <code>bridge.py</code>
- Create: <code>gamestate.py</code>
- Create: <code>tests/test_game_rpc.py</code>
- Modify: <code>tests/test_bridge_e2e.py</code>（只擴充 FakeBackend/rig 所需的 auth seam）

**Interfaces:**

Consumes:
- <code>Config.api_base</code>
- <code>Resolver.pool.primary.worker.user_id</code>
- <code>TeleDriveClient._http_session()</code> 作為現有 requests session
- 現有 <code>RpcApp</code>、<code>Dispatcher</code>

Produces:
- Config 欄位：
  - <code>reina_allowed_origin: str</code>
  - <code>reina_server_url: str</code>
  - <code>reina_locale_emulator: str</code>
- <code>GameRpc.handle(environ, start_response)</code>
- <code>GameRpc.verify_browser_token(token: str, origin: str) -&gt; int</code>，成功回傳 owner Telegram user id
- 共用 JSON/CORS response helper

- [x] **Step 1: 先固定 config 與 CORS contract 的失敗測試**

<code>config.example.ini</code> 新增：

~~~ini
[reina]
allowed_origin = https://teledrive.yoyotsaoteledrive.dpdns.org
server_url = https://teledrive.yoyotsaoteledrive.dpdns.org
locale_emulator =
~~~

Config 欄位放 dataclass 最後並給預設值，讓既有測試手工建立 <code>Config</code> 不必全改。

<code>tests/test_game_rpc.py</code> 至少包含：

~~~python
def test_preflight_requires_exact_allowed_origin(game_rpc_client):
    response = game_rpc_client.options(
        "/rpc/game/state",
        origin="https://evil.example",
        request_method="GET",
        request_headers="authorization,content-type",
    )
    assert response.status_code == 403
    assert "Access-Control-Allow-Origin" not in response.headers

def test_preflight_does_not_require_bearer(game_rpc_client):
    response = game_rpc_client.options(
        "/rpc/game/state",
        origin=ALLOWED_ORIGIN,
        request_method="GET",
        request_headers="authorization",
    )
    assert response.status_code == 204
    assert response.headers["Access-Control-Allow-Origin"] == ALLOWED_ORIGIN
~~~

也固定：
- scheme 不同拒絕。
- port 不同拒絕。
- <code>DELETE</code> 在 allow methods。
- <code>Authorization, Content-Type</code> 在 allow headers。
- 瀏覽器若送出 Local/Private Network preflight（例如 <code>Access-Control-Request-Private-Network: true</code>），只對允許 Origin 回對應 allow header；瀏覽器本身的本機網路權限仍在計畫 C 用真實 HTTPS 驗證。
- 允許 Origin 下，即使正式請求回 401/503，也要帶 CORS header。

Run:

~~~powershell
.venv\Scripts\python.exe -m pytest tests/test_game_rpc.py -q
~~~

Expected: config 欄位、GameRpc 都尚不存在而失敗。

- [x] **Step 2: 實作 config，不動既有 endpoint config**

<code>load_config()</code> 從 <code>[reina]</code> 讀取三個欄位；<code>allowed_origin</code> 用 <code>rstrip("/")</code> 正規化，但不要接受 wildcard。

加入測試：
- 未設定時 <code>allowed_origin</code>、<code>server_url</code> 為空，代表 browser game RPC disabled。
- 設定值帶尾斜線時 only origin 比對仍一致。
- Locale Emulator 空字串表示功能停用。

- [x] **Step 3: 寫 browser token 驗證，明確繞開 <code>_call</code>**

流程：

1. 從 Bearer header 取原 token。
2. 先以**該 token 原文**直接呼叫 <code>GET {cfg.api_base}/folders</code>；不得呼叫 <code>api._call()</code>。
3. 200 才表示 TeleDrive 已替 bridge 驗過簽章、exp 與使用者。
4. 200 之後才能 base64url decode JWT payload，取 <code>user_id</code> 和 <code>exp</code>。
5. <code>user_id != resolver.pool.primary.worker.user_id</code> → 403。
6. 驗證結果依 token hash 快取，TTL <code>min(300, exp-now)</code>；不要把 token 當 dict key 留在可 dump 的狀態。
7. TeleDrive 401/403 → bridge 401；TeleDrive 連不上/5xx → bridge 503，不要誤報登出。

代表性 seam：

~~~python
def _validate_with_teledrive(self, token):
    response = self.api._http_session().request(
        "GET",
        f"{self.cfg.api_base}/folders",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    return response
~~~

測試 FakeBackend 必須能看到傳入 Authorization，並明確斷言它是 browser token，不是 bridge own token。

- [x] **Step 4: 新增 <code>GameRpc</code>，舊 <code>RpcApp</code> 只做精確分派**

在 <code>gamestate.py</code> 先建立 GameRpc 骨架，下載/launch handler 可暫回 501。

在 <code>bridge.py</code>：
- <code>RpcApp.__init__</code> 建立/接收 <code>game_rpc</code>。
- <code>RpcApp.__call__</code> 只有 route 等於 <code>/game</code> 或以 <code>/game/</code> 開頭時委派。
- <code>/fetch-local</code> 等舊 route 走原邏輯。
- OPTIONS 只對 <code>/rpc/game/*</code> 開 browser CORS。

不要修改 <code>Dispatcher</code> 對 <code>/rpc</code> 的既有入口。

- [x] **Step 5: 做 auth/security regression**

新增測試：
- missing bearer → 401。
- malformed token → 401 且 log 無 token。
- valid upstream token + wrong user id → 403。
- token 快取在 5 分鐘內不重打 TeleDrive。
- exp 剩 3 秒時快取不超過 3 秒。
- upstream timeout → 503，CORS 仍存在。
- disallowed Origin 在 auth 前就 403，且不呼叫上游。
- Private/Local Network preflight 只在 allowed Origin 下成功，不把 allow-private-network header 洩給其他 Origin。
- 非 <code>/rpc/game/*</code> 不要求 Origin/Bearer。

Run:

~~~powershell
.venv\Scripts\python.exe -m pytest tests/test_game_rpc.py tests/test_bridge_e2e.py -q
~~~

- [x] **Step 6: Commit**

Commit（bridge repo）：

~~~text
feat: authenticate browser game RPC on bridge
~~~

---

### 任務 11：共用 ZIP 解析、背景下載與續傳狀態機

讓瀏覽器下載不再綁著 HTTP stream；同時修掉 <code>.ZIP</code> 大小寫 bug，確保 Explorer、舊 fetch-local、Web game RPC 使用同一套 resolver/fetcher。

**Files（teledrive-webdav）:**
- Modify: <code>bridge.py</code>（<code>Resolver._resolve_game</code>）
- Modify: <code>fetchlocal.py</code>
- Modify: <code>gamestate.py</code>
- Create: <code>tests/test_game_fetch.py</code>
- Modify: <code>tests/test_bridge_e2e.py</code>

**Interfaces:**

Produces:
- <code>LocalFetcher.destination_for(segments: list[str]) -&gt; Path</code>
- <code>LocalFetcher.fetch_segments(segments: list[str], *, skip_existing: bool = False, cancel: threading.Event | None = None) -&gt; Iterator[str]</code>：共用的 resolve/plan/copy 核心
- <code>LocalFetcher.fetch(windows_path: str, *, skip_existing: bool = False, cancel: threading.Event | None = None) -&gt; Iterator[str]</code>：舊 Explorer wrapper，只負責 Windows path → segments 後委派 <code>fetch_segments</code>
- <code>GameState.states(paths)</code>
- <code>GameState.fetch(path)</code>
- <code>GameState.cancel(path)</code>
- <code>cfg.cache_dir / "reina-games.json"</code>
- <code>&lt;game root&gt;/.reina-complete</code>

- [x] **Step 1: 用測試鎖住現有 destination semantics**

針對：
- TeleDrive 普通 folder。
- virtual ZIP root。
- ZIP subdirectory/file。
- staging tree。
- Unicode 名稱。
- 名稱含逗號。

對每一種都同時 assert：

~~~python
items, root = fetcher._plan(loc, segments)
assert fetcher.destination_for(segments) == root
~~~

<code>destination_for</code> 必須透過現有 resolver + <code>_plan</code> 得到 root，不能自己重寫 <code>local_dir/game/name</code> 規則。

舊 <code>/rpc/fetch-local</code> 測試保留原輸出：
- target line。
- 檔案數/大小 line。
- progress line。
- <code>OK &lt;root&gt;</code>。

同一組測試另外固定兩條輸入 contract：
- <code>fetch(windows_path)</code> 仍先用 <code>resolver.dav_path_from_windows()</code>，然後只呼叫 <code>fetch_segments(segments, ...)</code>；舊 Explorer 行為不變。
- Web RPC 的 canonical <code>teledrive_path</code>（例如 <code>game/A</code>）**不轉成 <code>H:\game\A</code>**。GameState 先驗證/切成 DAV segments，再直接呼叫 <code>destination_for(segments)</code> / <code>fetch_segments(segments, ...)</code>。

- [x] **Step 2: 先寫 ZIP 大小寫回歸測試**

規則固定：

1. 有精確 <code>Foo.zip</code> 時永遠使用它，即使 <code>Foo.ZIP</code> 較新。
2. 無精確候選時，把所有「副檔名為 zip（不分大小寫）且 strip 後名稱等於 top」的非目錄列出。
3. 多筆 fallback 取 <code>mtime</code> 最新；同時間用穩定 tie-break（filename + file_id）避免結果漂移，並 warning。
4. resolver priority 仍是 staging → ZIP → normal entry。

Run:

~~~powershell
.venv\Scripts\python.exe -m pytest tests/test_game_fetch.py -q
~~~

Expected: 現有 <code>children.get(top + ".zip")</code> 讓大寫案例失敗。

- [x] **Step 3: 先抽出 segment-level 共用核心，再加取消/續傳**

把現行 <code>fetch(windows_path)</code> 中「resolve → _plan → copy → progress」搬到 <code>fetch_segments(segments, ...)</code>。<code>fetch(windows_path)</code> 只保留：
1. 輸出原本的 <code>target:</code> line。
2. <code>dav_path_from_windows()</code> 驗證/轉換。
3. 委派 <code>fetch_segments()</code>。

因此 Web 與 Explorer 共用**完全相同**的 resolver、plan、copy code；GameState 禁止拼 <code>cfg.mount_drive</code> 或任何假的 Windows path。

<code>skip_existing=False</code> 時維持舊行為。

<code>skip_existing=True</code>：
- 每個 Item 開始前先刪該 item 的殘留 <code>.part</code>。
- 正式檔存在且大小等於 plan size → 當作已完成並納入 progress completed bytes。
- 大小不符 → 重新抓。
- 寫完時追蹤本 item 實際 byte count；不等於 <code>Item.size</code> 就刪 <code>.part</code> 並 ERROR。
- 每一個 copy chunk 後檢查 <code>cancel.is_set()</code>；取消不 rename 未完成 <code>.part</code>。
- 下一個 item 開始前再檢查一次 cancel。

測試用 fake reader 強迫 short read、mid-file cancel、第二次 resume。

- [x] **Step 4: 寫 GameState 背景工作與持久化 path map**

資料結構建議：

~~~python
@dataclass
class DownloadJob:
    path: str
    started_at: float
    completed_bytes: int = 0
    total_bytes: int = 0
    error: str | None = None
    cancel: threading.Event = field(default_factory=threading.Event)
~~~

同一 normalized <code>teledrive_path</code> 同時只有一個 DownloadJob；重複 POST 返回目前工作，不開第二條 thread。

GameState 先用單一 helper 將 canonical path 轉成 segments，例如：
- 拒絕絕對路徑、反斜線、空 segment、<code>.</code>、<code>..</code>。
- 第一段必須精確等於 <code>cfg.game_folder</code>。
- 至少要有遊戲名稱，不能把整個 <code>game/</code> 根當下載目標。
- 保留 Unicode、空白與逗號原字串；不要做 CSV split 或 drive-letter synthesis。

下載 thread：
1. <code>segments = canonical_game_segments(path)</code>。
2. <code>root = fetcher.destination_for(segments)</code>，取得與實際 plan 相同的 root。
3. root 存在時刪舊 <code>.reina-complete</code>。
4. 呼叫 <code>fetcher.fetch_segments(segments, skip_existing=True, cancel=event)</code>。
5. 解析 progress 更新 job。
6. 只有收到成功 <code>OK root</code> 且沒有 cancel/error 時：
   - 原子更新 <code>reina-games.json</code> 的 <code>{teledrive_path: root}</code>。
   - 原子寫 <code>.reina-complete</code>。
7. error/cancel 保留已完成正式檔，狀態轉 <code>incomplete</code>。

<code>reina-games.json</code> 用 tmp → flush/fsync → <code>os.replace</code>；不要只靠 process-memory mapping。

- [x] **Step 5: 狀態判定必須有固定優先序**

對每個 path：

1. GameLauncher（任務 13）回報 running → <code>running</code>。
2. DownloadJob active → <code>downloading</code>。
3. root 有 <code>.reina-complete</code> → <code>ready</code>。
4. root 存在 → <code>incomplete</code>。
5. 否則 <code>absent</code>。

任務 11 先注入假的 running provider，避免提前耦合任務 13。

重啟 GameState 時：
- 不自動重啟未完成 thread。
- mapping 有 root 時優先使用實際記錄。
- 沒 mapping 時，仍用同一個 <code>canonical_game_segments(path)</code> + <code>destination_for(segments)</code> 推導；root 存在、無 marker → <code>incomplete</code>。
- state/fetch/exes/launch 對 canonical path 的解析必須共用同一 helper，避免同一路徑在不同 RPC 得到不同本機 root。

- [x] **Step 6: 接上 RPC，paths 用重複 query parameter**

<code>GameRpc</code>：
- GET state：<code>parse_qs(...).get("paths", [])</code>。
- POST fetch：JSON body path。
- DELETE fetch：query path。

禁止用 <code>path1,path2</code>，否則遊戲名本身含逗號會壞。

- [x] **Step 7: 回歸與 commit**

Run:

~~~powershell
.venv\Scripts\python.exe -m pytest tests/test_game_fetch.py tests/test_game_rpc.py tests/test_bridge_e2e.py -q
~~~

Commit（bridge repo）：

~~~text
feat: add resumable background game downloads
~~~

---

### 任務 12：ReinaManager Web 的 bridge 狀態、下載、exe 選擇與啟動入口

把 bridge 能力接到現有 Web UI，同時維持 desktop launch flow 不變。

**Files（ReinaManager）:**
- Create: <code>src/services/web/bridge.ts</code>
- Create: <code>src/services/web/bridge.test.ts</code>
- Create: <code>src/hooks/queries/useBridgeGames.ts</code>
- Create: <code>src/hooks/queries/useBridgeGames.test.tsx</code>
- Modify: <code>src/hooks/features/games/useGameLaunchFlow.ts</code>
- Modify: <code>src/components/LaunchModal.tsx</code>
- Modify: <code>src/components/Cards/CardItem.tsx</code>
- Modify: <code>src/pages/Detail/DetailPage.tsx</code>
- Modify: <code>src/types/types.ts</code>
- Modify: <code>src/metadata/data/dataTransform.ts</code>
- Modify: locale files as required

**Interfaces:**

Produces:

~~~ts
export interface BridgeGameState {
  path: string;
  status: "running" | "downloading" | "ready" | "incomplete" | "absent";
  completed_bytes: number;
  total_bytes: number;
  elapsed_seconds: number;
  error: string | null;
}

bridgeService.getStates(paths)
bridgeService.fetch(path)
bridgeService.cancel(path)
bridgeService.getExes(path)
bridgeService.launch({ path, exe_relpath, game_id, locale_emulator })
~~~

- [x] **Step 1: 先補正 display DTO 邊界**

目前 <code>FullGameData</code> 已有 <code>teledrive_path/exe_relpath</code>，但 <code>GameData</code> 沒有。先寫 transform 測試，再讓 <code>getDisplayGameData</code> 展平：

~~~ts
teledrive_path?: string;
exe_relpath?: string;
~~~

Web feature hook 只能用 GameData 裡的相對 path；不要從 raw cache 偷 Windows path。

- [x] **Step 2: service 只複用既有 authenticatedFetch**

<code>src/services/web/http.ts</code> 已經白名單允許：
- origin <code>http://127.0.0.1:8081</code>
- path prefix <code>/rpc/game/</code>

bridge service 不再自己讀 IndexedDB、不再自己刷新 JWT。

測試：
- 第一次 401 → <code>authenticatedFetch</code> 既有 single-flight refresh → retry。
- 403 原樣轉成 bridge permission error。
- fetch reject/瀏覽器 Private Network Access/CORS error → local bridge unavailable。
- 409 launch → <code>bridge_game_not_ready</code> 或 <code>bridge_exe_invalid</code>，讓 feature hook能要求重選。

- [x] **Step 3: query hook 使用 bridge namespace，不放 server namespace**

Query key 例如：

~~~ts
const bridgeKeys = {
  all: ["bridge", "games"] as const,
  states: (paths: string[]) => ["bridge", "games", "states", [...paths].sort()] as const,
};
~~~

此 hook 必須顯式覆蓋 <code>src/providers/queryClient.ts</code> 的全域預設（<code>staleTime: Infinity</code>、focus/reconnect false）：

~~~ts
staleTime: 0,
refetchOnMount: true,
refetchOnWindowFocus: true,
refetchOnReconnect: true,
refetchIntervalInBackground: false,
~~~

<code>refetchInterval</code>：
- 任一 downloading → 2000 ms。
- 否則任一 running → 10000 ms。
- 否則 false。
- background tab 不固定輪詢；回到前景、網路重連或重新掛載時重查 stale bridge state，即使上次是 absent/ready。server version sync 仍只失效 server namespace。

POST fetch / DELETE cancel / POST launch 成功後立即 invalidate/refetch bridge state；元件不碰 QueryClient。

- [x] **Step 4: feature hook 按 runtime 分流**

桌面：保留現有 <code>handleExeFile</code> + <code>useGamePlayStore</code>。

Web：
1. 沒 <code>teledrive_path</code> → disabled，不觸發任何 Tauri dialog。
2. <code>absent</code> → fetch。
3. <code>incomplete</code> → fetch（續傳）。
4. <code>downloading</code> → cancel。
5. <code>ready</code> 且無 <code>exe_relpath</code> → GET exes → UI 選擇 → <code>useUpdateGame()</code> 把**相對路徑**寫 server。
6. <code>ready</code> 且已有 exe → launch。
7. launch 409 → 清楚提示檔案已變動，重新列 exe；不要自行把 Windows 絕對路徑存回 server。
8. <code>running</code> → 顯示 elapsed，不提供桌面 <code>stopGame</code>，除非 spec 另定義 stop endpoint。

Locale Emulator checkbox 只有 bridge config 支援時顯示；若 task 10/13 回傳 capability，可由 state/exes response 附 capability；若沒有 capability endpoint，launch 409/validation error 必須有可理解文案。

- [x] **Step 5: running → 非 running 時同步 server version**

query hook/feature hook 保留前一次 state。偵測某 path 從 running 轉到其他狀態時：

~~~ts
void checkServerVersion();
~~~

不要直接 invalidate stats，因為 bridge queue 可能尚未 POST 成功；真正資料變更仍由 server <code>data_version</code> 決定。

- [x] **Step 6: UI / i18n 測試**

至少測：
- absent：下載。
- incomplete：繼續下載 + last error。
- downloading：progress + 取消。
- ready：執行。
- ready/no exe：選 exe。
- running：elapsed。
- bridge unavailable：disabled + 原因，但遊戲 CRUD/scan/cover 不受影響。
- 手機或無 bridge：不誤顯示 absent。
- Web 不 import/呼叫桌面 file dialog。
- 使用與 production 相同的 QueryClient defaults，先快取 absent/ready 並確認空閒時不固定輪詢；另一頁啟動下載/遊戲後，原頁 focus 必須重新請求並恢復 2 秒/10 秒輪詢。
- 分別驗證 reconnect 與卸載後重新掛載也會更新 absent/ready 快取；背景不固定輪詢，回到空閒後停止 interval。不要用測試專用的寬鬆 defaults 掩蓋 hook 漏設選項。

Run:

~~~text
pnpm exec vitest run src/services/web/bridge.test.ts src/hooks/queries/useBridgeGames.test.tsx
pnpm test:web
pnpm check
pnpm build
pnpm build:web
~~~

- [x] **Step 7: Commit**

Commit（ReinaManager）：

~~~text
feat(web): connect game library actions to local bridge
~~~

---

### 任務 13：Windows 遊戲啟動、exe 枚舉與程序樹監控

新增純 Python Windows launcher。這一任務先用 store protocol + fake store 測；任務 14 再接真實 durable store。

**Files（teledrive-webdav）:**
- Create: <code>gamelaunch.py</code>
- Create: <code>tests/test_game_launch.py</code>
- Modify: <code>gamestate.py</code>
- Modify: <code>bridge.py</code>
- Modify: <code>requirements.txt</code>

**Interfaces:**

~~~python
@dataclass
class ProcessRef:
    pid: int
    create_time: float

@dataclass
class RunningSession:
    session_id: str
    game_id: int
    device: str
    start: int
    root: str
    pids: list[ProcessRef]
    last_seen: int

class GameLauncher:
    def list_exes(self, path: str) -> list[str]: ...
    def launch(
        self,
        path: str,
        exe_relpath: str,
        game_id: int,
        locale_emulator: bool = False,
    ) -> RunningSession: ...
~~~

- [ ] **Step 1: 建立 ProcessAdapter 與 fake clock 測試 seam**

不要把 psutil 呼叫散在 business logic。定義 adapter 至少能：
- snapshot all processes。
- 依 PID + create_time 查存活。
- 取 exe path。
- 取 parent pid。
- spawn command。

測試不啟動真遊戲即可涵蓋程序樹切換。

- [ ] **Step 2: path safety 與 exe enumeration 先寫失敗測試**

<code>list_exes(path)</code>：
- path 必須 resolve 到 ready game root。
- 遞迴列 <code>*.exe</code>，回傳相對 root 的路徑，排序穩定。
- 不回傳絕對路徑。

launch 拒絕：
- <code>..\outside.exe</code>。
- 絕對 path。
- symlink/junction resolve 後跑到 root 外。
- root 沒 <code>.reina-complete</code>。
- 相同 game 已 running。
- Locale Emulator requested 但 config 空或檔案不存在。

用 <code>Path.resolve()</code> 後再以 <code>os.path.commonpath</code> 檢查 containment；Windows 比較須大小寫不敏感。

- [ ] **Step 3: 啟動不使用 shell，也不做 runas**

Normal：

~~~python
subprocess.Popen(
    [str(exe_path)],
    cwd=str(exe_path.parent),
    shell=False,
)
~~~

Locale Emulator 對齊 ReinaManager desktop 現行行為：<code>LEProc.exe</code> 作為 executable，遊戲 exe path 作第一個獨立 argument；不要組成一條 shell command。

Web 版明確不實作桌面 <code>ShellExecuteExW("runas")</code> fallback，也不啟用 Magpie。

在 <code>requirements.txt</code> 增加 psutil，版本依當前 Python 相容測試鎖定，不順便升級其他套件。

- [ ] **Step 4: 程序追蹤不能依賴父程序一直活著**

每 2 秒拿一次 process snapshot，集合來源：
1. 目前 session 已知 PID 且 create_time 相同。
2. 這些程序的 descendants。
3. exe path 位於 root 下，create_time 不早於 session start 的程序。

launcher 可能在下一次 poll 前退出，因此第 3 項不是只用於 restart，也要在正常 monitor 每輪做 fallback。

任何 membership 變化立刻：
- 更新 <code>session.pids</code>。
- 呼叫 store.save(session)。

沒有 membership 變化時，只在距離上次 durable heartbeat ≥60 秒更新 <code>last_seen</code> 並 save。

同一 ProcessRef 不可同時被兩個 RunningSession claim；以 session start/root 與既有 claim map 做 deterministic ownership。

- [ ] **Step 5: launch 成功邊界在 durable initial save 之後**

順序：
1. resolve root/exe。
2. spawn。
3. 產 UUID session_id。
4. 建 RunningSession，至少包含 initial pid/create_time。
5. <code>store.save(session)</code> 成功。
6. 才讓 RPC 回 launch success。
7. 開 monitor thread。

若第 5 步失敗：
- 不回「成功」。
- 取消這次 monitor registration。
- 不要為了清理而強殺使用者已啟動的遊戲；回明確 500/diagnostic，讓使用者知道「已啟動但計時未建立」的風險，並 log PID（可 log PID，不可 log token）。

這個例外比偷偷回成功更安全；後續可由 root recovery 掃描診斷，但不能假裝 durable guarantee 已成立。

- [ ] **Step 6: 接 exes/launch RPC 與 state running provider**

GameRpc：
- GET exes。
- POST launch。

GameState 的 running 判斷向 GameLauncher 查 root/session，不複製 process logic。

Run:

~~~powershell
.venv\Scripts\python.exe -m pytest tests/test_game_launch.py tests/test_game_fetch.py tests/test_game_rpc.py -q
~~~

- [ ] **Step 7: Commit**

Commit（bridge repo）：

~~~text
feat: launch games and track Windows process trees
~~~

---

### 任務 14：durable playtime、崩潰恢復與補送

把任務 13 的 in-memory store 換成 durable store，並保證 crash 邊界「不重複、只要 running 已成功落盤就不整段遺失」。

**Files（teledrive-webdav）:**
- Create: <code>playtime.py</code>
- Create: <code>tests/test_playtime.py</code>
- Modify: <code>gamelaunch.py</code>
- Modify: <code>bridge.py</code>

**Interfaces:**

~~~python
class RunningSessionStore:
    def save(self, session: RunningSession) -> None: ...
    def remove(self, session_id: str) -> None: ...
    def all(self) -> list[RunningSession]: ...

class PlaytimeQueue:
    def append(self, record: dict) -> None: ...
    def pending(self) -> list[dict]: ...
    def contains(self, external_id: str) -> bool: ...
    def ack(self, external_id: str) -> None: ...
~~~

Files:
- <code>cfg.cache_dir / "playtime-running.json"</code>
- <code>cfg.cache_dir / "playtime-queue.jsonl"</code>

- [ ] **Step 1: 用故障注入測試鎖住 write ordering**

Running store：
- 啟動時一次讀取 <code>playtime-running.json</code> 成為單一 in-memory <code>dict[session_id, RunningSession]</code>。
- store instance 自己持有一把 mutex；<code>save()</code>、<code>remove()</code>、<code>all()</code> 都先取得同一把鎖。
- <code>save/remove</code> 在鎖內更新 in-memory map，並在**同一鎖內**把完整 snapshot tmp write → flush → fsync file → os.replace；不能每個 monitor thread 各自 read-modify-replace 檔案。
- <code>all()</code> 在鎖內複製 snapshot 後回傳，caller 不可取得可直接修改 store map 的 reference。
- 最好 fsync parent dir（Windows 可做 best-effort）。

Queue append：
- 初始化與每次 append 都先在同一把 queue mutex 下檢查並修復截斷尾行（規則見 Step 2）；append/ack/pending/contains 共用此鎖。
- 持鎖 append one full JSON line（含換行），flush + fsync 後才回傳成功。
- 修復或 append 失敗時不得 remove running，也不能把尚未 fsync 的 UUID 放進可供 <code>contains()</code> 判定成功的索引。

結束 session 必須：

~~~text
queue.append(record) + fsync
→ running_store.remove(session_id)
~~~

不能反過來。

測試在每一邊界 throw，重建 service 後結果只允許：
- session 仍 running；或
- queue 已有 exactly one record。
不得兩邊都沒有。

另外加 concurrency regression：
- 兩個不同 game/session 同時 heartbeat/save，最後 running file 必須同時保留兩筆。
- session A <code>remove()</code> 與 session B <code>save()</code> 交錯時，A 消失、B 保留，不能由最後一個 snapshot writer 把另一個 mutation 蓋掉。
- 高次數 parallel save/remove 後，磁碟 JSON 與 store in-memory snapshot 一致。

- [ ] **Step 2: ack rewrite 與 concurrent append 使用同一把鎖**

<code>ack(id)</code>：
1. lock。
2. 讀完整 queue snapshot。
3. 過濾 target id。
4. tmp write + fsync。
5. replace。
6. unlock。

sender 不能先讀、放鎖、再 rewrite，否則會抹掉期間新 append。

JSONL 修復必須在 <code>recover_sessions()</code>、sender、HTTP 啟動前完成，且每次 append 前都再次持鎖檢查，避免同一程序的失敗寫入留下壞尾：
- 按 bytes 記錄最後一個完整換行的 offset，保留 earlier complete lines。
- 只有最後一段**沒有換行且無法解析為合法 record**時，才可 truncate 回該 offset；warning 不包含憑證。truncate → flush → fsync 完成後，才能 append 新 record。
- 若沒有換行的尾段已是合法 record，保留它，補換行並 flush + fsync 後納入 UUID 索引，避免丟掉已寫完 JSON 的紀錄。
- 有換行的壞 line（含檔案中間壞行）視為資料損壞；停止自動 append/ack/rewrite，保留 queue 與 running 原檔並給明確 diagnostic，不能跳過後繼續寫。
- <code>pending/contains</code> 只使用已完成修復並持久化的 snapshot；repair 失敗必須向上回報，不能誤判 queue 沒有 session。

故障回歸必須覆蓋：
- 先寫一筆完整 queue record + 無換行的半條 JSON，另有一筆 durable running record；重啟後在 sender 尚未啟動時 recovery append，再結束第二筆 session append。所有完整紀錄仍可逐行解析且 UUID 各一筆，沒有壞行被推到中間；running 只在對應完整 record fsync 後刪除。
- 在 truncate/fsync、append/fsync、running remove 邊界逐一注入失敗再重啟，完整前綴不丟失，每筆 session 至少仍在 running 或可解析的 queue 中。
- 合法 JSON 但缺換行的尾段必須保留並補換行；同 session recovery 不重複 append。
- 中間壞行時 recovery 不刪 running，append/ack 都拒絕改檔；repair 與 concurrent append/ack 不互相覆寫。

- [ ] **Step 3: recover_sessions 的三段策略**

先確認 queue 初始化修復成功，再處理每筆 running；修復失敗不得繼續恢復刪除流程：

1. recorded ProcessRef 中任一 PID 還活且 create_time match → attach，保留 session_id/start。
2. 否則掃描所有 process，找 exe 在 <code>root</code> 下且 create_time ≥ start → attach，立即 save 新 pids。
3. 都沒有：
   - queue 已有同 session_id → 只 remove running。
   - queue 沒有 → <code>end = last_seen</code>，<code>seconds = max(0, end-start)</code>，append queue 後 remove running。

PID 相同但 create_time 不同視為 dead，不能 attach。

測試 launcher 子程序情境：parent 在首次 2 秒 poll 前就退出、bridge crash；restart 後用 root fallback 接回 child。

時長測試：
- bridge 12:00 last_seen、遊戲 13:00 結束、bridge 14:00 才回來 → end=12:00。
- bridge 12:00 crash、遊戲 14:00 restart 時仍活 → 沿用原 start，最後結束時計入停機期間。

- [ ] **Step 4: sender 使用 bridge own JWT，不使用 browser token**

目標：

~~~text
POST {reina_server_url}/game/api/sessions
Authorization: Bearer <bridge TeleDrive JWT>
~~~

取得 token 用現有 <code>TeleDriveClient.login()</code>。401：
- 強制 refresh/login 一次。
- 重送一次。
- 還 401 留 queue。

status：
- 200 accepted true/false 都可 ack（server idempotent）。
- 401：refresh one time。
- 403：保留 record、長退避與 diagnostic。
- 404 game deleted：保留 record，不快速重試；例如每 15 分鐘再試。
- 5xx/network：指數退避，5→10→30→60→300 秒上限。
- 禁止 log Authorization/JWT。

sender thread 關閉時不需等 queue 清空；durable queue 就是設計的 recovery。

- [ ] **Step 5: bridge startup/shutdown 接入順序**

main：
1. api/pool 啟動。
2. 建 RunningSessionStore、PlaytimeQueue；持 queue lock 完成尾行檢查、修復與 fsync。失敗則保留檔案並中止後續啟動，不能先 recover 或接新 launch。
3. 建 GameLauncher/GameState/GameRpc。
4. <code>recover_sessions()</code>。
5. 啟動 sender。
6. 啟動 HTTP server。

shutdown：
- 停接新 HTTP。
- 停 background download/monitor/sender loop。
- monitor 最後 save 當前 session。
- 不把未送 queue 當 error 刪除。
- 再 stop pool。

- [ ] **Step 6: 全 bridge regression**

Run:

~~~powershell
.venv\Scripts\python.exe -m pytest tests/test_playtime.py tests/test_game_launch.py tests/test_game_fetch.py tests/test_game_rpc.py -q
.venv\Scripts\python.exe -m pytest tests -q
~~~

- [ ] **Step 7: Commit**

Commit（bridge repo）：

~~~text
feat: persist and recover bridge playtime sessions
~~~

---

### 任務 15：reina-server 冪等會話入庫、精確秒數與 Web 統計刷新

接受 bridge durable queue，保留精確秒數，同時讓既有以「分鐘」為單位的 UI/統計不必整體重寫。

**Files（ReinaManager）:**
- Create: <code>src-tauri/migration/src/m20260926_000021_bridge_sessions.rs</code>
- Modify: <code>src-tauri/migration/src/lib.rs</code>
- Modify: <code>src-tauri/reina-core/src/entity/game_sessions.rs</code>
- Modify: <code>src-tauri/reina-core/src/database/dto.rs</code>
- Modify: <code>src-tauri/reina-core/src/database/repository/game_stats_repository.rs</code>
- Modify: adjacent core tests
- Create: <code>src-tauri/reina-server/src/api/sessions.rs</code>
- Modify: <code>src-tauri/reina-server/src/api.rs</code>
- Modify: <code>src-tauri/reina-server/src/api/router.rs</code>
- Create: <code>src-tauri/reina-server/tests/sessions.rs</code>
- Modify: <code>src/types/types.ts</code>
- Modify: <code>src/services/game/gameStats.ts</code>
- Modify: <code>src/hooks/queries/useStats.ts</code> only if Web-specific invalidation/presentation needs change
- Modify: <code>src-tauri/src/game/monitor/session.rs</code> to reuse the shared seconds→minutes helper instead of duplicating rounding logic

**Schema:**

Append to <code>game_sessions</code>:
- <code>external_id TEXT NULL</code>
- <code>device TEXT NULL</code>
- <code>duration_seconds INTEGER NULL</code>
- unique index on non-null <code>external_id</code>

Keep:
- integer <code>session_id</code> primary key for old UI/API。
- <code>duration</code> minutes as compatibility/statistics projection。

**Interfaces:**

~~~rust
pub struct BridgeSessionInput {
    pub id: String,
    pub game_id: i32,
    pub device: String,
    pub start: i32,
    pub end: i32,
    pub seconds: i32,
}

pub enum BridgeSessionError {
    InvalidInput(String),
    GameNotFound,
    Database(DbErr),
}

pub async fn insert_bridge_session_in_connection<C>(
    db: &C,
    record: BridgeSessionInput,
) -> Result<bool, BridgeSessionError>
where
    C: ConnectionTrait;
~~~

<code>true</code> = inserted；<code>false</code> = external UUID 已存在。

- [ ] **Step 1: migration/entity 測試先失敗**

測試新空庫：
- 欄位存在。
- 多筆 desktop session（external_id NULL）可存在。
- 相同 non-null external_id 第二筆被 unique index 阻止。
- migration 不改歷史 desktop rows。

加入 migration registry 後 run：

~~~text
cargo test --manifest-path src-tauri/Cargo.toml -p reina-core
~~~

- [ ] **Step 2: 抽出共用秒→分鐘 helper，對齊 desktop 規則**

目前 desktop <code>monitor/session.rs</code> 已使用：

~~~text
seconds / 60 + (seconds % 60 >= 30 ? 1 : 0)
~~~

把此規則移到可被 desktop/reina-server 共用的 core helper，例如：

~~~rust
pub fn round_seconds_to_minutes(seconds: u64) -> Result<i32, DbErr>
~~~

desktop monitor 改用它，刪除本地 duplicate helper。

邊界測試：
- 0 → 0
- 1 → 0
- 29 → 0
- 30 → 1
- 59 → 1
- 60 → 1
- 89 → 1
- 90 → 2

bridge session **不套** desktop <code>MIN_SESSION_SECONDS=60</code>，所以 1 秒、30 秒、59 秒都會存 exact seconds；只有 compatibility minutes 依上述規則。

- [ ] **Step 3: 讓統計投影能處理合法 0-minute session**

現有 <code>session_statistics_contribution</code> 對 <code>duration &lt;= 0</code> 與 <code>end &lt;= start</code> 會拒絕。為 bridge crash recovery：
- 改成拒絕 <code>duration &lt; 0</code>。
- 改成拒絕 <code>end &lt; start</code>。
- 0 minute / start==end 仍：
  - session_count +1。
  - last_played 更新。
  - total_time +0。
  - daily_stats 不必新增 0 項。

手動 session API 仍維持「duration 必須 >0」；desktop monitor 仍維持 <60 秒不建立 session。只有 bridge ingestion 放寬。

- [ ] **Step 4: repository 做 UUID idempotency，不能 check-then-insert 無 unique 保護**

流程：
1. 驗證 UUID 格式、game_id 合法、device 非空、seconds ≥0、end ≥ start，以及時間戳/分鐘投影可表示；失敗回 <code>BridgeSessionError::InvalidInput</code>。
2. 在同一 transaction 驗證 game id 存在；不存在回 <code>BridgeSessionError::GameNotFound</code>。
3. 把 exact seconds 轉 compatibility minutes。
4. insert session（external_id/device/duration_seconds 一起）。
5. 若 unique external_id conflict → 回 <code>Ok(false)</code>，不更新 statistics。
6. 真 insert → 用同 transaction 增量更新 statistics，回 <code>Ok(true)</code>。

輸入導致的 helper 校驗錯誤歸入 <code>InvalidInput</code>；實際資料庫讀寫錯誤才包成 <code>Database(DbErr)</code>。不要依錯誤訊息字串比對 400/404，也不要把其他 constraint 錯誤一律當 UUID 重送成功。

同 UUID 併發測試要兩個 request 同時發出，最終：
- session row 1。
- session_count 1。
- total minutes 只加一次。

- [ ] **Step 5: <code>POST /game/api/sessions</code> 使用既有 auth + tx boundary**

API：
- auth 與其他 <code>/game/api</code> 一致。
- JSON parse/validation error 400。
- game missing 404。
- DB error 500。
- 成功 body <code>{"accepted": bool}</code>。

Transaction：

~~~rust
let txn = tx::begin(&state.db).await?;
let result = insert_bridge_session_in_connection(&txn, input)
    .await
    .map_err(|error| match error {
        BridgeSessionError::InvalidInput(message) => ApiError::bad_request(message),
        BridgeSessionError::GameNotFound => ApiError::not_found("遊戲不存在"),
        BridgeSessionError::Database(error) => ApiError::from(error),
    });
let accepted = tx::finish(&state, txn, result, |accepted| *accepted).await?;
~~~

repository boundary 使用明確的 <code>BridgeSessionError</code>，HTTP handler 在交給 <code>tx::finish</code> 前逐一映射（並 import 對應型別及 <code>crate::error::ApiError</code>）。現有 <code>ApiError::from(DbErr)</code> 一律回 500，只用於真正 DB error。JSON extractor 的 rejection 也須在此 endpoint 顯式映射為 <code>ApiError::bad_request</code>，避免 malformed JSON / 欄位型別錯誤沿用框架的 422 等預設。

因此：
- accepted=true → business + statistics + version 同一 commit，version +1。
- accepted=false → commit/rollback policy 不改資料，version +0。

測試另外注入 <code>state.fault.fail_next()</code>，確認 session/statistics/version 全部 rollback。

HTTP 整合測試必須斷言 status 與 error code：malformed JSON、錯誤欄位型別、非法 UUID、空 device、負 seconds、end < start → 400 / <code>invalid_arguments</code>；格式合法但 game 已刪除 → 404 / <code>not_found</code>；真正 DB error 與 commit fault → 500 / <code>command_failed</code>。所有失敗均不新增 session、不改 statistics/version；同 UUID 重送仍為 200 accepted=false。bridge sender 測試以 404 / <code>not_found</code> 驗證 deleted-game 長退避且保留 queue，不把任意 route 404 誤認為遊戲被刪除。

- [ ] **Step 6: Web 統計不再依賴 Tauri event 才刷新**

目前 <code>src/services/game/gameStats.ts</code> 會註冊 <code>game-session-ended</code> Tauri event。保持 desktop 行為，但 Web：
- 不要求本機 Tauri event。
- server 接受 session 後 data_version 增加。
- <code>useServerVersionSync</code> 失效 <code>["server", ...]</code>，包含 <code>statsKeys.all</code>。
- running→ended 時任務 12 只觸發一次 <code>checkServerVersion()</code>；若 queue 尚未送出，下一次 60 秒 poll 補上。

若 <code>gameStats.ts</code> 在 Web bundle 有 top-level Tauri event import，調整成 platform-safe lazy import/desktop-only module，並擴充既有 web import smoke test。

TS <code>GameSession</code> 可追加：
- <code>external_id?: string | null</code>
- <code>device?: string | null</code>
- <code>duration_seconds?: number | null</code>

- [ ] **Step 7: 完整 server/core regression**

Run:

~~~text
cargo test --manifest-path src-tauri/Cargo.toml -p reina-server --test sessions
cargo test --manifest-path src-tauri/Cargo.toml -p reina-core -p reina-server
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml -p reina-core -p reina-server --no-deps -- -D warnings
pnpm test:web
pnpm check
pnpm build
pnpm build:web
~~~

- [ ] **Step 8: Commit**

Commit（ReinaManager）：

~~~text
feat(server): ingest idempotent bridge playtime sessions
~~~

---

## Plan B Completion Gate

Plan B 只有在以下條件全部成立才算完成：

- bridge 新增 browser RPC 不改變舊 RPC/WebDAV。
- browser token 實際由 TeleDrive 驗證，其他 user/token/origin 被拒絕。
- folder 與 ZIP 遊戲的 <code>destination_for()</code> 和實際 fetch destination 完全一致，browser canonical path 不經 drive-letter synthesis，直接走 <code>fetch_segments()</code>。
- <code>.zip</code>/<code>.ZIP</code> 規則通過，精確候選優先。
- 下載可取消、bridge restart 後呈 incomplete、resume 只補未完成正式檔。
- Web 無 bridge 時仍能管理遊戲庫，不把 unavailable 當 absent。
- bridge hook 覆蓋全域 stale/focus/reconnect defaults；快取 absent/ready 後仍能在 focus/reconnect/remount 發現新工作並恢復輪詢。
- ready → exe 選擇 → launch 不向 server 傳 Windows absolute path。
- launcher 快速退出/子程序接手、PID reuse、junction escape 都有自動測試。
- running durable record 已寫入後，不會整段失去 session；多遊戲 concurrent heartbeat/save/remove 不會互相覆寫。
- queue 重送/崩潰後同 UUID server 只計一次。
- queue 壞尾在 recovery 與每次 append 前持鎖修復並 fsync；截斷尾行 → recovery append → 再 append 的故障序列不丟 session，也不製造中間壞行。
- session API 校驗/遊戲不存在/DB 故障分別回 400/404/500，失敗不改統計或版本；sender 對 deleted-game 使用長退避。
- exact <code>duration_seconds</code> 保存，既有 minute projection 和 desktop rounding 一致。
- ReinaManager desktop/web build 都通過。
- bridge <code>pytest tests -q</code> 通過。
- reina-core/reina-server tests、fmt、clippy 通過。

完成後再進入 [計畫 C](2026-09-26-plan-c-deployment-validation.md)；Plan B 本身不替換 WSL 正式入口，也不宣稱真實 HTTPS 流程已驗收。
