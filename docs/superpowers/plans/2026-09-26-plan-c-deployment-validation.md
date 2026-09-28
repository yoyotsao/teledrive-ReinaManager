# 計畫 C：Docker、部署與端到端驗收（任務 16–17）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (<code>- [ ]</code>) syntax for tracking.

**Goal:** 把已完成的 ReinaManager Web + bridge 能力安全部署到 TeleDrive 的正式 <code>/game/</code> 子路徑，建立可重複的容器建置、nginx/CSP 邊界、自動化 E2E 與真實 Windows/手機驗收，最後留下可維護的部署與診斷文件。

**Architecture:** ReinaManager 產生單一 <code>reinamanager:local</code> image：Node stage 建 <code>dist-web/</code>、Rust stage 建 <code>reina-server</code>、runtime 只帶 binary + static files + SQLite/CA runtime。WSL TeleDrive compose 只引用 image、共享既有 <code>JWT_SECRET</code>，並掛 <code>reina-data:/data</code>；不公開 8787 port。TeleDrive nginx 將 <code>/game*</code> 代理到 <code>reinamanager:8787</code>，並在該 location 使用獨立 CSP，允許 browser 存取固定 loopback bridge；TeleDrive 根站 CSP 不變。自動 E2E 使用隔離 reina DB + test JWT + fake bridge；正式完成標準再用真實 HTTPS、真 bridge、實體手機走一次。

**Tech Stack:** Docker multi-stage build、Docker Compose、nginx、axum；Playwright + Chromium；現有 Vitest/Rust/pytest/i18n toolchain。

**Spec:** [2026-09-26-reinamanager-web-docker-design.md](../specs/2026-09-26-reinamanager-web-docker-design.md)  
**總覽:** [2026-09-26-reinamanager-web-docker.md](2026-09-26-reinamanager-web-docker.md)  
**前置:** [計畫 A](2026-09-26-plan-a-server-web.md) 與 [計畫 B](2026-09-26-plan-b-bridge-playtime.md) 全部 completion gate 通過。

## Global Constraints

- **ReinaManager repo:** <code>D:/game/ReinaManager</code>。
- **bridge repo:** <code>D:/python/teledrive-webdav</code>。
- **正式 TeleDrive repo:** WSL <code>Ubuntu-24.04:~/teledrive</code>。只修改/部署這份，不用 Windows 上的參考副本。
- **正式入口:** <code>https://teledrive.yoyotsaoteledrive.dpdns.org/game/</code>。
- **不改 Cloudflare ingress:** 現有 cloudflared 仍透過 <code>network_mode: "service:frontend"</code> 到 nginx 的 3000；<code>/game</code> 在 nginx 內反代，不新增 tunnel hostname。
- **不公開 reina-server:** compose service 不加 <code>ports</code>；只能被 compose network 的 frontend/backend 存取。
- **Secrets:** <code>JWT_SECRET</code> 只在 backend/reinamanager container env；不能被前端 build arg、static JS、Playwright trace、log 或文件帶出。<code>REINA_OWNER_ID</code> 的真值只放部署 <code>.env</code>，不 commit。
- **Persistent data:** <code>reina-data:/data</code> 唯一正式 DB/cover persistence；不 bind-mount source tree 到 runtime。
- **統計時區：**本次單 owner 部署統一使用 <code>Asia/Taipei</code>（UTC+8），在首次 session 寫入前設定 server <code>TZ</code> 並安裝 runtime 時區資料；桌面/手機驗收與 Playwright browser 使用相同時區。現有 <code>game_stats_repository.rs</code> 使用 <code>chrono::Local</code> 持久化 daily_stats、查日期範圍與小時分布，<code>useStats.ts</code> 使用 browser 本地日期，因此只設 server TZ 不代表已支援任意跨時區客戶端。若要支援不同時區瀏覽器，須另行統一前後端日期計算，不能宣稱本計畫已涵蓋。
- **CSP:** TeleDrive <code>/</code> 現行 CSP 不得增加 loopback；只有 <code>/game/</code> 回應允許 <code>http://127.0.0.1:8081</code>。
- **nginx add_header inheritance:** <code>/game/</code> location 必須 include 一份**完整** Reina header set。因為 location 有自己的 <code>add_header</code>，它會取代 server-level 的 inherited headers；不要只覆寫 CSP 而漏掉 nosniff/frame/referrer/permissions/CORP。
- **proxy path:** reina-server 自己路由含 <code>/game</code>，所以 nginx <code>proxy_pass http://reinamanager:8787;</code> **不要加尾斜線**，避免把 <code>/game</code> prefix strip 掉。
- **變更分 repo commit:**任務 16/17 若同時改 ReinaManager、TeleDrive、bridge，各 repo 分開 commit；不要用跨 repo 的單一「完成」commit 掩蓋實際部署邊界。
- **不先重啟 production:**任務 16 只建 image、改 compose/nginx 並離線驗證；真正替換正式 frontend/reinamanager 在任務 17 所有自動測試通過之後。
- **i18n:**遵守 ReinaManager <code>.agents/skills/i18n/SKILL.md</code> 的完整 status/sync/extract/format/missing 流程。
- **實機完成標準:** Playwright device emulation 不能取代實體手機；fake bridge 不能取代至少一次真 bridge。

## Review Focus

1. **CSP 被全域套用：**Reina CSP 不可放 <code>/etc/nginx/conf.d/*.conf</code> 被 nginx 自動 include；否則 TeleDrive 根站可能多一條更嚴格 CSP。
2. **兩條 CSP 同時生效：**瀏覽器會取交集；如果 <code>/game</code> 同時收到 TeleDrive CSP（不允許 loopback）和 Reina CSP，bridge 仍會被擋。驗收必須檢查實際 response header 數量。
3. **proxy_pass 尾斜線：**錯誤 strip <code>/game</code> 後，reina-server 深層路由與 API 都會 404。
4. **compose image 不在同 Docker engine：**WSL 啟動前先 <code>docker image inspect reinamanager:local</code>；若 Windows/WSL 用不同 engine，必須在 WSL 同一 context 從 <code>/mnt/d/game/ReinaManager</code> 重建。
5. **healthz 太早：**reina-server 必須完成 schema migration/DB open 後才啟動 listener；health success 才讓 frontend 依賴視為 ready。
6. **前端 bundle 洩密：**<code>JWT_SECRET</code>、Telegram session 不能是 Docker build ARG，也不能出現在 <code>dist-web</code>。
7. **E2E 污染正式 DB：**故障注入、test owner JWT、fake sessions 都只能指向隔離 data dir。
8. **手機無 bridge：**頁面必須仍可 CRUD/scan/cover；只有下載/執行控制 disabled。
9. **版本輪詢無變更：**5 分鐘觀察中只能固定看到 version polling；不能每 60 秒 refetch 整個 games/stats/covers。
10. **部署成功但 bridge 正在工作：**重啟 bridge 前看 <code>/rpc/status</code>；只用既有 <code>restart.bat</code>，不能殺 rclone/下載程序。
11. **離線驗證啟動 production dependency：**任何 <code>docker compose run</code> validation 都必須 <code>--no-deps</code>；要測 upstream/DNS 時另建隔離 network/container，不能讓 candidate server 提前掛正式 <code>reina-data</code>。
12. **E2E 測到 stale dist-web：**官方 <code>pnpm test:e2e</code> 必須自己先 <code>pnpm build:web</code>；不能依賴工作目錄殘留 artifact。
13. **rollback tag 指到 candidate：**rollback 一律從目前 running container 的 immutable <code>.Image</code> ID 建 tag，不能從已被 Task 16 build 移動過的 <code>reinamanager:local</code> / frontend tag 複製。
14. **UTC 容器污染統計日期：**runtime 必須包含 <code>tzdata</code> 並在首次寫入前以 <code>TZ=Asia/Taipei</code> 啟動；跨午夜 fixture 要同時驗證持久化日期、今日時長、日期範圍與小時分布。
15. **憑證競爭測試未共用資料庫：**refresh/accounts race 使用同一 BrowserContext 下的兩個同源 page；獨立 context 只用於跨裝置版本同步，不能拿來模擬 IndexedDB 競爭。

---

### 任務 16：ReinaManager Docker image 與 WSL TeleDrive nginx/compose

先建立可重複 image 和 proxy 設定，但不替換正式服務。

## 16A — ReinaManager image

**Files（ReinaManager）:**
- Create: <code>Dockerfile</code>
- Create: <code>.dockerignore</code>
- Optional Modify: deployment section in local docs only if build command needs說明

**Produces:**
- image <code>reinamanager:local</code>
- runtime binary <code>/app/reina-server</code>
- static root <code>/app/static</code>

- [ ] **Step 1: 先用失敗 build 驗證 Docker context 邊界**

<code>.dockerignore</code> 至少排除：

~~~text
.git
.env
.env.*
node_modules
dist
dist-web
src-tauri/target
target
test
*.db
*.db-shm
*.db-wal
*.session
**/__pycache__
~~~

注意：repo 根 <code>test/</code> 是使用者封面圖片，不是測試程式；Docker context 也不要把它送進 daemon。

- [ ] **Step 2: 寫三階段 Dockerfile**

方向：

~~~dockerfile
FROM node:24-bookworm-slim AS web
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build:web

FROM rust:bookworm AS server
WORKDIR /src
COPY src-tauri ./src-tauri
RUN cargo build --manifest-path src-tauri/Cargo.toml --release -p reina-server --locked

FROM debian:bookworm-slim AS runtime
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl libsqlite3-0 tzdata \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=server /src/src-tauri/target/release/reina-server /app/reina-server
COPY --from=web /src/dist-web /app/static
ENV REINA_PORT=8787
ENV REINA_DATA_DIR=/data
ENV REINA_STATIC_DIR=/app/static
ENV TZ=Asia/Taipei
EXPOSE 8787
ENTRYPOINT ["/app/reina-server"]
~~~

實作時如果 Cargo workspace build 需要 root 的其他檔案，就調整 COPY，但**不要**把 secrets 變 build args。

Node 版本使用專案實際支援版本；pnpm 版本由 <code>packageManager</code> + corepack 鎖定，不手寫另一個版本。

Rust runtime 用 <code>ldd</code> 檢查 binary 依賴；若 <code>libsqlite3-0</code> 非必要可移除，但先以可啟動為準。

<code>tzdata</code> 是統計日期的 runtime 依賴，不可在清理 image 時移除。所有候選 server/隔離測試也必須在程序啟動前設定 TZ，不能啟動後才變更環境變數。

- [ ] **Step 3: image smoke test**

Run（ReinaManager repo）：

~~~text
docker build -t reinamanager:local .
docker run --rm --entrypoint /app/reina-server reinamanager:local --help
~~~

若 binary 沒 <code>--help</code>，改用缺少必填 env 時預期快速失敗，確認不是 shared library error。

檢查 bundle：

~~~text
docker run --rm --entrypoint sh reinamanager:local -c "find /app/static -maxdepth 2 -type f | head"
~~~

再以字串掃描確認：
- 沒有部署 <code>JWT_SECRET</code> 真值。
- 沒有 Telegram session。
- 沒有 <code>.env</code>。

另外驗證 image 內存在 <code>/usr/share/zoneinfo/Asia/Taipei</code>，並執行：

~~~text
docker run --rm --entrypoint date -e TZ=Asia/Taipei reinamanager:local -d @1790526600 +%Y-%m-%dT%H:%M:%S%z
~~~

Expected: <code>2026-09-28T00:30:00+0800</code>。這只驗 runtime 時區資料；統計正確性仍須通過任務 17 的 API/瀏覽器跨午夜測試。

## 16B — TeleDrive compose service

**Files（WSL <code>~/teledrive</code>）:**
- Modify: <code>docker-compose.yml</code>
- Modify: <code>.env.example</code>

**Consumes:**
- 現有 <code>JWT_SECRET</code>
- backend service <code>http://backend:8000</code>
- local image <code>reinamanager:local</code>

**Produces:**
- service name <code>reinamanager</code>
- volume <code>reina-data</code>

- [ ] **Step 4: 加 service，不開 host port**

Compose 形狀：

~~~yaml
reinamanager:
  image: reinamanager:local
  environment:
    JWT_SECRET: ${JWT_SECRET}
    REINA_OWNER_ID: ${REINA_OWNER_ID:?set REINA_OWNER_ID in .env}
    TELEDRIVE_API: http://backend:8000
    REINA_GAME_FOLDER: game
    TZ: Asia/Taipei
  volumes:
    - reina-data:/data
  depends_on:
    - backend
  healthcheck:
    test: ["CMD", "curl", "-fsS", "http://127.0.0.1:8787/game/healthz"]
    interval: 10s
    timeout: 3s
    retries: 12
  restart: unless-stopped
~~~

不要 <code>ports:</code>。

正式首次啟動前核對 compose 的 <code>TZ</code> 與 image 一致。若正式 volume 已在 UTC 或其他時區寫入 session/daily_stats，先備份並另行安排依 session 重建統計的遷移與驗證；只改 TZ 不會修復既有 daily_stats，也不能讓新舊投影混用後直接通過驗收。

同一個 compose 裡現有 <code>frontend.depends_on</code> 也要從單純 backend list 改成能等待 Reina health 的 mapping，避免 nginx 啟動時 upstream 尚未可解析/可連：

~~~yaml
frontend:
  depends_on:
    backend:
      condition: service_started
    reinamanager:
      condition: service_healthy
~~~

Volumes：

~~~yaml
volumes:
  teledrive-data:
  reina-data:
~~~

<code>.env.example</code> 只加：

~~~text
# Telegram user id allowed to use ReinaManager /game.
REINA_OWNER_ID=
~~~

不 commit 真 user id。

- [ ] **Step 5: 確認 image context 是同一個 Docker engine**

在 WSL：

~~~bash
docker image inspect reinamanager:local
~~~

若找不到，從同一 WSL Docker context：

~~~bash
docker build -t reinamanager:local /mnt/d/game/ReinaManager
~~~

不要改 compose 成 Windows 路徑 build context。

## 16C — nginx route 與 Reina-only CSP

**Files（WSL <code>~/teledrive</code>）:**
- Modify: <code>frontend/nginx.conf</code>
- Modify: <code>frontend/Dockerfile</code>
- Create: <code>frontend/reina-security-headers.conf</code>

現有 <code>frontend/security-headers.conf</code> 是 TeleDrive 根站完整 header set；不要修改其 CSP 來放 loopback。

- [ ] **Step 6: 建 Reina header snippet**

<code>frontend/reina-security-headers.conf</code>：

~~~nginx
add_header Content-Security-Policy "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; connect-src 'self' http://127.0.0.1:8081" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "no-referrer" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
~~~

只有固定 <code>127.0.0.1:8081</code>；不使用 <code>http://127.0.0.1:*</code>、<code>http:</code> 或 wildcard。

Dockerfile：

~~~dockerfile
COPY reina-security-headers.conf /etc/nginx/snippets/reina-security-headers.conf
~~~

**不要** copy 到 <code>/etc/nginx/conf.d</code>。

- [ ] **Step 7: nginx location 保留 /game prefix**

在 SPA fallback 前加入：

~~~nginx
location = /game {
    return 308 /game/;
}

location /game/ {
    include /etc/nginx/snippets/reina-security-headers.conf;
    client_max_body_size 10m;

    proxy_pass http://reinamanager:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 60s;
    proxy_send_timeout 60s;
}
~~~

<code>proxy_pass</code> 後**沒有 slash**。

API/static/deep route 全由 reina-server 分流：
- <code>/game/api/*</code> API。
- <code>/game/assets/*</code> static。
- <code>/game/libraries/12</code> fallback index。
- 不存在的 <code>/game/api/*</code> 仍是 JSON/HTTP API error，不可以被 SPA fallback 成 index。

- [ ] **Step 8: 離線驗證，不 restart production**

WSL：

~~~bash
docker compose config --quiet
docker compose build frontend
docker compose run --rm --no-deps frontend nginx -t
~~~

<code>--no-deps</code> 是硬性要求：這一步不得因 <code>frontend.depends_on</code> 去啟動 candidate <code>reinamanager</code> / backend，也不得碰正式 <code>reina-data</code>。

若 <code>nginx -t</code> 因 <code>reinamanager</code> hostname 尚未存在而失敗，不可拿掉 <code>--no-deps</code>。改用**隔離 validation network**：
1. 建 temporary Docker network。
2. 在該 network 啟一個帶 <code>--network-alias reinamanager</code> 的 validation-only upstream；純語法檢查可用 dummy container，只需要 DNS 可解析。
3. 若要實際測 proxy/header，才啟 candidate reina-server，但掛**新的 temporary volume / temporary data dir**與 test-only env，絕不掛 compose 的正式 <code>reina-data</code>。
4. 用剛建好的 frontend image 加入同 network 執行 <code>nginx -t</code> 與 HTTP smoke。
5. 驗證完刪 validation containers/network/temporary volume。

若 compose service 依賴 local image，先：

~~~bash
docker image inspect reinamanager:local
~~~

這一整段仍屬離線 candidate 驗證；Task 16 結束前 production <code>reinamanager</code> service 必須保持未啟動。

Header regression 必須比較：
- <code>/</code>：仍是原 TeleDrive CSP，connect-src 含 Telegram，不含 loopback。
- <code>/game/</code>：**只有一個有效 CSP header set**，connect-src 有 <code>127.0.0.1:8081</code>。
- 兩邊都有 nosniff/frame/referrer/permissions/CORP。

- [ ] **Step 9: Task 16 commits**

ReinaManager repo：

~~~text
build(web): add reina-server production image
~~~

TeleDrive repo：

~~~text
feat(game): proxy ReinaManager under /game
~~~

到此**不啟動正式 reinamanager、不重建正式 frontend**。

---

### 任務 17：自動化 E2E、完整回歸、正式部署與實機驗收

先讓所有可自動驗證的行為在隔離環境綠，再切正式 WSL 服務，最後走真實 browser/bridge/phone。

## 17A — Playwright isolation harness

**Files（ReinaManager）:**
- Modify: <code>package.json</code>
- Modify: <code>pnpm-lock.yaml</code>
- Create: <code>playwright.config.ts</code>
- Create: <code>e2e/web-game.spec.ts</code>
- Create: <code>e2e/support/fake-bridge.mjs</code>
- Create: <code>e2e/support/test-env.mjs</code>（若需要負責 temp data/server lifecycle）
- Optional Create: <code>e2e/support/jwt.mjs</code>

**Produces:**
- <code>pnpm test:e2e</code>
- 隔離 <code>REINA_DATA_DIR</code>
- test-only JWT secret/owner
- fake loopback bridge at <code>127.0.0.1:8081</code>

- [ ] **Step 1: 安裝 Playwright，不混進 production dependency**

Run：

~~~text
pnpm add -D @playwright/test
pnpm exec playwright install chromium
~~~

Package script：

~~~json
{
  "test:e2e": "pnpm build:web && playwright test"
}
~~~

<code>test:e2e</code> 的第一步必須重新產生 <code>dist-web/</code>；clean checkout 沒有 artifact 時會正常 build，開發機有舊 <code>dist-web</code> 時也不會拿它直接測。build 失敗就不能啟動 Playwright。

不把 Chromium 放進 production Docker image。

- [ ] **Step 2: test reina-server 使用真正 auth/static/router，只有資料是隔離的**

test env：
- <code>JWT_SECRET=reina-e2e-secret</code>（只在 test process）。
- <code>REINA_OWNER_ID=42</code>。
- <code>REINA_DATA_DIR=&lt;temporary directory&gt;</code>。
- <code>REINA_STATIC_DIR=&lt;repo&gt;/dist-web</code>。
- <code>REINA_PORT</code> 用固定 test port 或啟動器分配空 port。
- server 子程序啟動環境設 <code>TZ=Asia/Taipei</code>；Playwright config 設 <code>use.timezoneId = "Asia/Taipei"</code>。時區驗收使用帶 tzdata 的 Linux candidate container 與 temporary volume，避免 Windows 宿主時區掩蓋容器配置錯誤。

<code>dist-web</code> 只允許來自同一次 <code>pnpm test:e2e</code> 開頭的 fresh <code>pnpm build:web</code>；test-env 不得在找不到 artifact 時退回舊 dev server，也不得默默沿用前一輪 build。

每次 suite 前清空 temp dir；不得指向 <code>/data</code> 或 production DB。

Playwright 用 Node crypto 簽 test HS256 JWT，不新增產品端 auth bypass。JWT payload至少：
- user_id 42。
- exp future/past 兩種。

- [ ] **Step 3: fake bridge 要測真的 CORS/前端狀態，不改產品 service**

fake bridge 只存在 e2e/support：
- OPTIONS 回 task 10 同樣的 CORS headers。
- 驗 Authorization。
- 可由測試預設狀態表驅動 state/fetch/cancel/exes/launch。
- 可模擬 401 first request、403、409、network close。
- 不需要模擬 WebDAV/Telegram。

「無 bridge」案例用 Playwright route abort <code>http://127.0.0.1:8081/**</code>，而不是產品碼加 test flag。

## 17B — Automated browser scenarios

- [ ] **Step 4: IndexedDB auth 與 deep route**

Playwright helper 在 browser context 建：
- DB <code>teledrive-credentials</code> v1。
- store <code>credentials</code>。
- key <code>active</code>。
- record <code>{accounts:[sentinel], jwt:testToken}</code>。

測：
1. 無 jwt → login gate + link <code>/</code>。
2. valid jwt → <code>/game/</code> 正常。
3. 直接開 <code>/game/libraries/&lt;id&gt;</code> + reload 不 404。
4. expired jwt + test refresh stub → fresh jwt 被寫回，但 accounts sentinel 完整不變。
5. refresh 期間同一 BrowserContext 的另一同源 page 修改 accounts → 最後仍保留**最新** accounts。

第 5 項必須控制實際交錯順序：
1. 用 <code>context.newPage()</code> 建 page A/B，兩頁載入同一 origin，共用上面的 IndexedDB；只初始化一次 active record，不用每次導航都覆寫的 init script。
2. A 帶 expired jwt 發起 authenticated request；測試攔住 <code>/api/v1/auth/refresh</code> 回應，用明確 barrier 等待 refresh request 已到達。
3. 在回應仍暫停時，B 以 readwrite transaction 更新 active record 的 accounts sentinel；等待 <code>transaction.oncomplete</code>，不是只等 put request success。
4. 釋放 A 的 refresh response，回 test-only fresh jwt，等待 A retry 成功。
5. A/B 都重新讀 IndexedDB，斷言 fresh jwt 與 B 最新的完整 accounts 同時存在。不得使用固定 sleep 猜時序；fixture、trace 與 assertion 只含假憑證。

不同 BrowserContext 不共享 IndexedDB，不能用來實作此 race；下一步的跨裝置案例才使用獨立 context。

- [ ] **Step 5: cover/cache/version 多 context**

兩個同 owner context：
- context A 新增遊戲/改來源封面。
- context B 保持頁面打開，透過 version polling/focus 看到更新。
- B 再改另一遊戲，A 的先前修改不能因本地 write response/version tracking 被覆蓋。
- custom cover upload/remove reload 後狀態一致。
- same cover URL version immutable；cover version 改變後 URL/query key 改變。

長時間 no-change test：
- <code>test.setTimeout</code> 至少 330 秒。
- 記錄 <code>/game/api/*</code> network。
- 5 分鐘無 write 時允許固定 <code>/game/api/version</code>。
- 不應每分鐘出現 <code>find_all_games</code>、stats 全量、covers refetch。
- focus 測試另獨立做，避免干擾這個計數。

- [ ] **Step 6: fake bridge UI state machine**

逐一測：
- absent → download。
- downloading → progress + cancel。
- cancel 後 incomplete。
- resume → ready。
- ready/no exe_relpath → exes dialog。
- save exe_relpath 後 launch。
- launch 409 → 提示重新選 exe。
- running → elapsed。
- running 結束 →觸發 server version check，不自行捏造 stats。
- bridge 403 與 network unavailable 顯示不同原因。
- no bridge context 仍可 edit metadata/cover/scan page。
- page A 已快取 absent/ready 且停止 interval；同一 context 的 page B 啟動下載/遊戲，A 回到前景後重新請求 bridge state 並恢復相應輪詢。另測 reconnect/remount；不要靠 server version invalidation 讓此案例過關。

- [ ] **Step 6a: 統計時區與跨午夜回歸**

使用隔離 Linux candidate server（<code>TZ=Asia/Taipei</code>、tzdata、temporary volume）、兩個獨立測試遊戲及同時區 browser；固定瀏覽器目前時間為 <code>2026-09-28T02:00:00+08:00</code>。透過真實 session API 寫入 test-only record，timestamp 仍是 UTC epoch seconds，不先加減 8 小時：
- 遊戲 A：本地 <code>2026-09-28 00:30–01:00</code>，1800 秒。daily_stats 歸 <code>2026-09-28</code> 30 分鐘，不能落到 UTC 的前一天；UI 今日時長 30 分鐘，當日日期查詢包含該 session，小時分布按既有「開始小時歸類」落在 0 點。
- 遊戲 B：本地 <code>2026-09-27 23:50–2026-09-28 00:10</code>，1200 秒。daily_stats 兩天各 10 分鐘，UI 今日時長 10 分鐘；小時分布沿用現有語義，完整 20 分鐘歸開始小時 23 點，按開始日期查詢前一天包含、當天不包含。
- 全庫今日時長合計 40 分鐘；檢查 API 結果與落盤 daily_stats 一致，重啟同一隔離 server/volume 後結果不變，同 UUID 重送不增加統計。

core 純函式測試沿用既有 <code>TimeZone</code> 注入與 UTC+8 fixture；需要測 <code>chrono::Local</code> 的整合測試在獨立 Linux process/container 啟動前設 TZ，不在平行測試中修改程序全域 TZ，也不接觸正式 DB。此步只驗證日期/時段正確性，沿用既有分布語義。

## 17C — 三 repo 全量自動檢查

- [ ] **Step 7: ReinaManager frontend/i18n**

先照 i18n skill，指令分開跑：

~~~text
pnpm i18n:status
pnpm i18n:status en-US --hide-translated
pnpm i18n:status ja-JP --hide-translated
pnpm i18n:status zh-TW --hide-translated
pnpm i18n:sync
pnpm i18n:extract
pnpm format
rg "__MISSING__" src/locales
~~~

<code>rg</code> 無匹配才成功；若 runner 沒安裝 <code>rg</code>，不能把 command-not-found 當「無缺失」，改用可用工具明確掃描。

接著：

~~~text
pnpm test:web
pnpm check
pnpm build
pnpm test:e2e
~~~

最後一條 <code>pnpm test:e2e</code> 會先執行 <code>pnpm build:web</code>，所以 Playwright 測到的 <code>dist-web</code> 就是這次 validation 要交付的 Web artifact。不要在 E2E 通過後再另外 build 一份未測試的 <code>dist-web</code>。

- [ ] **Step 8: ReinaManager Rust**

在 <code>src-tauri</code>：

~~~text
cargo fmt --all -- --check
cargo test --locked -p reina-core -p reina-server
cargo clippy --locked -p reina-server --no-deps -- -D warnings
cargo check --locked -p ReinaManager
~~~

若 core 有獨立 clippy warning，再加：

~~~text
cargo clippy --locked -p reina-core --no-deps -- -D warnings
~~~

- [ ] **Step 9: bridge**

在 <code>D:/python/teledrive-webdav</code>：

~~~powershell
.venv\Scripts\python.exe -m pytest tests -q
~~~

再啟動測試 bridge，確認：

~~~text
GET /rpc/health
GET /rpc/status
~~~

輸出沒有 token/session。

## 17D — 正式 WSL deploy

- [ ] **Step 10: 部署前紀錄可回退狀態**

三 repo：
- branch。
- HEAD。
- dirty files。
- TeleDrive compose config。
- 目前 running containers/images。

先從**目前正在跑的 container**擷取 immutable image ID，再建立 rollback tag；不能從 <code>reinamanager:local</code> 或 frontend 的可移動 tag 複製，因為 Task 16 的 candidate build 可能已經把那些 tag 指到新 image。

例如：

~~~bash
FRONTEND_CID="$(docker compose ps -q frontend)"
OLD_FRONTEND_IMAGE_ID="$(docker inspect -f '{{.Image}}' "$FRONTEND_CID")"
docker image tag "$OLD_FRONTEND_IMAGE_ID" teledrive-frontend:pre-game-rollout

REINA_CID="$(docker compose ps -q reinamanager)"
if [ -n "$REINA_CID" ]; then
  OLD_REINA_IMAGE_ID="$(docker inspect -f '{{.Image}}' "$REINA_CID")"
  docker image tag "$OLD_REINA_IMAGE_ID" reinamanager:pre-game-rollout
fi
~~~

把兩個 immutable ID 寫進部署記錄。第一次部署沒有既有 reinamanager container 時，明確記為「no previous reina image」；frontend 仍一定保存目前 running image ID。Rollback 操作也優先用這些保存的 ID/tag，不重新解析 candidate tag。

- [ ] **Step 11: bridge restart 前先看工作狀態**

Windows：

~~~text
http://127.0.0.1:8081/rpc/status
~~~

確認沒有不應中斷的 upload/staging/fetch 工作。

只使用 bridge repo 現有 <code>restart.bat</code> 或既定啟動流程重啟 bridge；**不要 kill rclone**。若 restart script 有 hidden-window variant，使用該方式，避免新增第二個 bridge。

重啟後：
- health。
- status。
- game CORS OPTIONS。
- 舊 H: mount still works。
- 舊 fetch-local still works。

- [ ] **Step 12: 在同 Docker engine 重建/載入 image**

若 WSL 看得到 Windows build：

~~~bash
docker image inspect reinamanager:local
~~~

否則：

~~~bash
docker build -t reinamanager:local /mnt/d/game/ReinaManager
~~~

確認 image digest/id 記錄到部署筆記。

- [ ] **Step 13: 先啟 reinamanager，再換 frontend**

WSL：

~~~bash
cd ~/teledrive
docker compose up -d reinamanager
docker compose ps reinamanager
docker compose logs --tail=100 reinamanager
~~~

等 healthy。

接收第一筆 session 前，確認 container <code>TZ=Asia/Taipei</code>、zoneinfo 可讀，並用任務 16 的固定 timestamp smoke 檢查輸出為 <code>+0800</code>；若 volume 已有其他時區資料，先完成前述遷移，不能只依 health green 放行。

內網 smoke：

~~~bash
docker compose exec frontend wget -qO- http://reinamanager:8787/game/healthz
~~~

若舊 frontend 沒 wget，使用同 network 的臨時 curl container。

接著：

~~~bash
docker compose build frontend
docker compose up -d frontend
docker compose ps
~~~

cloudflared 因 <code>network_mode: service:frontend</code> 要確認仍 attached/running；必要時依 compose 行為 recreate cloudflared，但不改 tunnel dashboard。

- [ ] **Step 14: 根站 regression 先驗**

正式 HTTPS：
- <code>/</code> TeleDrive 正常。
- <code>/api/v1</code> auth/metadata 正常。
- <code>/sw.js</code> cache header 不變。
- root CSP 不含 loopback。
- cloudflared 無 reconnect loop。

任何根站回歸先 rollback frontend，不繼續 game acceptance。

## 17E — 真實 HTTPS + 真 bridge + 實體手機 acceptance

- [ ] **Step 15: auth/router/CSP**

桌面瀏覽器：
- 已登入 TeleDrive 後開 <code>/game/</code>，不用重新登入。
- deep route <code>/game/libraries/&lt;id&gt;</code> 直接打開/reload。
- DevTools Network 檢查 <code>/game/</code> CSP：
  - 一個有效 CSP set。
  - connect-src 有 <code>http://127.0.0.1:8081</code>。
- <code>/</code> CSP 維持 TeleDrive 原值。

Token refresh/accounts preservation：
- 優先在自動 test env 驗完整 expired-token race。
- 正式站只用既有使用者帳號做非破壞驗證；不得把 production JWT 貼到 terminal/log/screenshot。

- [ ] **Step 16: scan/cover/cross-device**

真 TeleDrive：
1. <code>/game</code> 掃描。
2. 新增/確認遊戲。
3. 來源封面顯示。
4. reload 封面仍存在。
5. 上傳 custom cover → reload →可移除。
6. 手機改遊戲 A；桌面 60 秒內看到。
7. 桌面接著改遊戲 B；A/B 都保持最新。
8. idle 5 分鐘 Network 只有 version polling，不全量 reload。

- [ ] **Step 17: folder 與 ZIP 各走完整下載/啟動**

至少：
- 一個 TeleDrive folder game。
- 一個 <code>.zip</code>。
- 一個大寫/混合大小寫 <code>.ZIP</code>（若正式資料沒有，使用可安全建立的測試遊戲；驗完清理）。

每個：
1. scan。
2. absent → download。
3. ready。
4. 首次選 exe。
5. launch。
6. launcher/child 正常追蹤。
7. 關閉最後 game process。
8. bridge queue POST server。
9. stats/recent sessions 更新。

Locale Emulator 至少一次真 launch；Web 不測 runas/Magpie，因這兩項本來就不在 Web scope。

- [ ] **Step 18: cancel/restart/offline recovery**

下載大檔：
- 中途 cancel → incomplete。
- resume →只補未完成檔。
- 再做一輪下載到一半，使用 <code>restart.bat</code> 重啟 bridge → incomplete → resume。

Playtime：
- 遊戲執行中 restart bridge，確認 recovery 接回原 session_id/start。
- 暫時讓 reina-server/session endpoint 不可達或以 test-safe network fault 模擬，結束遊戲後 queue 留存；恢復網路後補送且統計只加一次。
- 不在 production DB 做故意 commit fault injection。

- [ ] **Step 19: 實體手機**

真手機（不是 DevTools 模擬）：
- 開同一 <code>https://.../game/</code>。
- 瀏覽/編輯/掃描/封面可用。
- 因手機沒有 Windows loopback bridge，下載/執行 disabled，原因可理解。
- 頁面不因 <code>127.0.0.1:8081</code> 失敗而不斷 snackbar/重試。

如果當下沒有實體手機可用，交付報告只能寫「實體手機待驗證」，不能寫 Plan C 全部完成。

## 17F — 文件與交付記錄

**Files（ReinaManager）:**
- Modify: <code>docs/README.md</code>
- Modify: <code>docs/architecture/README.md</code>
- Modify: <code>docs/architecture/frontend.md</code>
- Modify: <code>docs/architecture/backend.md</code>
- Modify: <code>docs/architecture/game-library.md</code>
- Modify: <code>docs/architecture/metadata.md</code>
- Create/Modify: deployment/operations doc as appropriate

**Files（bridge）:**
- Modify: <code>CLAUDE.md</code> 或目前實際的操作文件，記錄 browser RPC/state/cache/playtime queue。

**Files（TeleDrive）:**
- Update deployment comments/docs only where needed，避免複製整份 Reina architecture。

- [ ] **Step 20: 文件只記穩定 boundary 與真實驗收結果**

Reina docs 至少補：
- <code>/game</code> deployment path。
- server/bridge responsibility。
- bridge query keys vs server query keys。
- <code>data_version</code> 與 playtime queue 的 eventual consistency。
- Docker build/redeploy/rollback。
- reina-data backup location。
- 統計時區 <code>Asia/Taipei</code>、browser 同時區前提；已有資料時變更 TZ 需要重建投影的遷移，不可直接切換。
- 常見問題：no bridge、CORS/PNA、401、incomplete download、playtime queue pending。

Bridge docs 至少補：
- <code>[reina]</code> config。
- <code>/rpc/game/*</code>。
- <code>reina-games.json</code>。
- <code>playtime-running.json</code>。
- <code>playtime-queue.jsonl</code>。
- restart 前看 status。
- JWT/session redaction。

- [ ] **Step 21: 保存驗收矩陣，不保存 secrets**

交付記錄包含：
- 三 repo HEAD。
- image ID。
- compose service status。
- 每個 test command + pass count。
- 正式 URL。
- folder/ZIP/LE/phone/idle-5min 結果。
- server/browser 時區、跨午夜統計驗收，以及同 context 雙頁 refresh/accounts race 結果。
- pending/manual items。

不要貼：
- Authorization header。
- IndexedDB accounts。
- JWT。
- Telegram session。
- <code>.env</code>。

- [ ] **Step 22: Final commits**

ReinaManager repo：

~~~text
test(web): add isolated browser game workflow coverage
~~~

若文件同一任務最後另 commit：

~~~text
docs: document web deployment and verified game workflow
~~~

bridge repo：

~~~text
docs: document browser game RPC and playtime recovery
~~~

TeleDrive repo：

~~~text
docs(game): document ReinaManager deployment checks
~~~

保持 commit 數量最少；純格式/臨時 validation workflow 不留在歷史。

---

## Plan C Completion Gate

只有下列全部滿足才能報告「Web/Docker 完成」：

- <code>reinamanager:local</code> 可重建，runtime 不含 source secrets。
- compose <code>reinamanager</code> 無 host port，<code>reina-data</code> persistent，health green；Task 16 的離線驗證沒有提前啟動/掛載 production service/data。
- TeleDrive <code>/</code>、<code>/api/v1</code> 無回歸。
- <code>/game/</code>、deep route、API/static routing 正常。
- <code>/game</code> response CSP 可連 <code>127.0.0.1:8081</code>；TeleDrive root CSP 不含 loopback；沒有雙 CSP 交集問題。
- ReinaManager <code>pnpm test:web</code>、<code>pnpm test:e2e</code>、i18n、check、desktop/web build 全綠；<code>test:e2e</code> 自己 fresh-build <code>dist-web</code>，沒有測 stale artifact。
- reina-core/reina-server fmt/tests/clippy 與 desktop cargo check 全綠。
- bridge 完整 pytest 全綠。
- 真實 folder + ZIP + mixed-case ZIP 的 scan/download/launch 至少驗過。
- 真實 Locale Emulator 至少驗過。
- cancel/resume、bridge restart/resume 驗過。
- running session restart recovery 與 queue offline resend 驗過，server 沒重複統計。
- 兩個 browser context 的跨裝置/version/cover 自動驗收通過。
- 同一 BrowserContext 的兩個同源 page 已以受控 refresh response 驗證最新 accounts 不被覆寫。
- runtime tzdata 與 server/browser 的 <code>Asia/Taipei</code> 已確認；首次寫入前完成設定，隔離容器的凌晨/跨午夜 daily_stats、今日時長、日期範圍與小時分布驗收通過。
- 正式桌面瀏覽器完整 scan → download → launch → close → stats 通過。
- **實體手機**能管理遊戲庫且 bridge controls 正確 disabled。
- rollback 已保存部署前 running frontend/reinamanager 的 immutable image ID（若有既有 reina），不是 candidate movable tag。
- 文件與部署/rollback 步驟已更新，驗收記錄沒有敏感資訊。

若最後一項實體手機或任一真實硬體流程無法執行，狀態必須明確保持「自動驗證通過，仍待實機驗收」，不可宣稱 Plan C completed。
