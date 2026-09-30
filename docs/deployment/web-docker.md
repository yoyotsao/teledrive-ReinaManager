# 网页版部署与运维

ReinaManager 网页版以 Docker 服务形式部署在 TeleDrive 的 `/game/` 子路径下。本页只记录稳定的部署边界、运维流程和常见问题；具体 compose/nginx 配置以 TeleDrive 部署仓库为准，验收结果不写在这里。

> 状态：生产环境与真实设备（Windows + 实体手机）验收尚未完成。本页描述设计边界和操作步骤，不代表已在生产验证。

## 部署路径

```text
浏览器 ──HTTPS──▶ Cloudflare Tunnel ──▶ TeleDrive nginx (:3000)
                                          ├─ /            TeleDrive 前端（CSP 不变）
                                          ├─ /api/…       TeleDrive backend
                                          └─ /game/…      ──▶ reinamanager:8787 (reina-server)

浏览器 ──HTTP loopback──▶ 127.0.0.1:8081 本机 bridge（下载/执行，仅 Windows 桌面）
```

- 入口为 TeleDrive 域名下的 `/game/`，不新增 tunnel hostname，不公开 `8787`（compose 服务没有 `ports`）。
- nginx 的 `/game/` location 使用完整的 Reina 安全响应头（CSP 的 `connect-src` 额外允许 `http://127.0.0.1:8081`）。TeleDrive 根站 CSP 不放宽。因为 location 自带 `add_header` 会覆盖上层继承，所以必须 include 完整的一组头，不能只覆写 CSP。
- `proxy_pass` 不带 URI 部分，保留 `/game` 前缀；reina-server 自己按 `/game/…` 路由。
- `/game` 由 nginx 308 到 `/game/`；`/game/healthz` 是容器健康检查。
- frontend 不依赖 reinamanager 的健康状态：Reina 故障时 `/game` 返回 502，但不影响 TeleDrive 根站与 tunnel。

## 职责边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| reina-server（容器） | 静态页面、`/game/api`（游戏库 RPC、封面、元数据代理、云端扫描、游玩记录入库、`data_version`）、SQLite 事实源 | 下载游戏文件、启动本机进程 |
| 本机 bridge | 把 TeleDrive 游戏下载到本机、列出可执行文件、启动并追踪进程、记录游玩时长并补送 | 保存游戏库资料；只在本机 loopback 监听 |
| 浏览器 | 界面、Query 缓存、携带 TeleDrive JWT 调用 server 与 bridge | 保存 bridge 状态到服务器 |

认证：reina-server 与 TeleDrive backend 共享同一个 `JWT_SECRET`（仅容器环境变量，不进前端构建、静态文件或日志）；`REINA_OWNER_ID` 指定唯一 owner，真值只放部署 `.env`，不入库。

没有 bridge（手机、未启动、非 Windows）时页面仍可增删改、扫描、封面；仅下载/执行控制不可用。

## 一致性模型

- **server 查询**：所有来自 server 的 Query key 挂在 `["server", ...]` 下。前台每 60 秒读一次 `GET /game/api/version`，`data_version` 变化时整体失效该前缀；游戏结束、窗口聚焦、重新联网时也会立刻检查。
- **bridge 查询**：`["bridge", "games", ...]` 是独立命名空间，不受 `data_version` 影响，按下载（2 秒）/运行（10 秒）状态轮询。
- **游玩记录是最终一致的**：游戏结束后 bridge 先把记录落盘到本机队列，再向 `POST /game/api/sessions` 补送；server 在同一 transaction 里写入会话、更新统计并递增 `data_version`。因此结束后统计不会立即出现——server 不可达、401、限流时记录留在队列里退避重试，成功后其他设备通过 `data_version` 看到。重送同一个 session id 是幂等的（不重复计入，也不递增版本）。
- 详细缓存规则见 [`../architecture/game-library.md`](../architecture/game-library.md)。

## 构建、部署与回滚

Windows 与 WSL 共用同一个 Docker Desktop 引擎，镜像 `reinamanager:local` 在任一侧构建即可。若某次发现两侧引擎不同，必须在 WSL 同一 context 从源码目录重新构建。

### 镜像

仓库根目录的 `Dockerfile` 为三阶段构建：Node 构建 `dist-web`，Rust 构建 `reina-server`，runtime 只含二进制、静态文件、SQLite 运行库、CA 证书、`curl` 与 `tzdata`。

```text
docker build -t reinamanager:local .
```

冷构建约 5 分钟，需要网络（有一个 git 形式的 cargo 依赖）。运行时环境变量默认值：`REINA_PORT=8787`、`REINA_DATA_DIR=/data`、`REINA_STATIC_DIR=/app/static`、`TZ=Asia/Taipei`。密钥不是构建参数。

### 部署步骤

1. 构建候选镜像 `reinamanager:local` 并先做离线检查（`docker compose run` 一律 `--no-deps`，不能让候选实例提前挂载正式 `reina-data`）。
2. 在替换前，从**当前运行容器**的不可变镜像 ID 打回滚 tag（不要从会移动的 `reinamanager:local` 复制）：

   ```text
   docker inspect --format '{{.Image}}' <当前 reinamanager 容器>
   docker tag <上一步得到的 image ID> reinamanager:rollback-<日期>
   ```

3. 备份 `reina-data`（见下）。
4. 在 TeleDrive 部署目录重建/重启 `reinamanager` 服务与 nginx；等待 `/game/healthz` 健康。
5. 出问题时：把 compose 使用的镜像重新指向回滚 tag 并重启 `reinamanager`。schema 迁移只向前，回滚旧镜像前若新版本已迁移过数据库，应同时恢复部署前的备份。

重启 bridge 是另一件事：见 bridge 文档，只用既有 `restart.bat`，重启前先看 `/rpc/status`，不要杀 rclone 或下载进程。

## 数据与备份

持久化数据只有一个 Docker 卷：`reina-data` → 容器 `/data`（compose 项目名为 `teledrive` 时，卷全名为 `teledrive_reina-data`）。

| 路径（容器内） | 内容 |
| --- | --- |
| `/data/reina_manager.db` | SQLite 事实源（游戏、合集、统计、设置、`data_version`） |
| `/data/covers/game_<id>/<sha256>.<ext>` | 封面文件 |

备份要点：

- 数据库与封面要在同一时间点备份；备份前先停止 `reinamanager` 服务，或使用 SQLite 在线备份，避免复制到半写入的文件。运行时镜像不含 `sqlite3` 命令行工具。
- 恢复时先停服务，再把两者一起放回卷内。
- 不要 bind-mount 源码目录到 runtime；`/data` 是唯一持久化位置。

## 统计时区

- 统计按日期/小时/星期聚合，server 使用进程本地时区（`chrono::Local`），浏览器统计页使用浏览器本地日期。本次单 owner 部署统一为 `Asia/Taipei`：容器 `TZ=Asia/Taipei`（镜像已安装 `tzdata`），桌面、手机和自动化浏览器也必须使用同一时区。
- 这**不等于**已支持任意时区的浏览器；跨时区使用需要另行统一前后端日期计算。
- 已有游玩数据后，**不能直接改 `TZ`**：`daily_stats` 等投影是按写入当时的时区落盘的，直接切换会让历史日期与新数据错位。变更时区需要一次从 `game_sessions` 重建统计投影的数据迁移，并在迁移完成前保持原 `TZ`。
- 首次写入游玩记录之前就必须确认容器 `TZ` 正确；不带 `tzdata` 的容器会静默按 UTC 运行。

## 自动化测试

`pnpm test:e2e` 会先执行 `pnpm build:web`，再用 Playwright 对隔离的临时数据目录、测试专用 JWT 和 fake bridge 跑一遍；fake bridge 监听临时端口，浏览器通过路由转发到 `http://127.0.0.1:8081`。它不接触正式 DB，也不能取代真实 bridge 与实体手机验收（尚未完成）。

## 常见问题

**页面提示没有 bridge / 下载与执行按钮不可用**
bridge 未启动、浏览器不在装有 bridge 的 Windows 电脑上（如手机），或请求被拦。其余功能不受影响。在装有 bridge 的电脑上检查 `http://127.0.0.1:8081/rpc/health` 是否可达。

**浏览器控制台报 CORS / Private Network Access（PNA）错误**
bridge 只放行 `[reina] allowed_origin` 中配置的那一个 Origin，必须与访问页面的 Origin 完全一致（协议、域名、端口；不接受通配符）；预检会回应 `Access-Control-Allow-Private-Network`。同时检查 `/game/` 响应上的 CSP `connect-src` 是否包含 `http://127.0.0.1:8081`，且响应中只有一条 CSP（两条 CSP 会取交集，仍会拦截）。`allowed_origin` 或 `server_url` 为空时 bridge 的游戏 RPC 整体停用（503 `game_rpc_disabled`）。

**401**
TeleDrive JWT 过期或无效。网页会刷新一次后重试，仍失败则要求重新登录。bridge 回 401 `invalid_bearer_token`；回 403 `bridge_owner_mismatch` 表示登录用户不是该 bridge 的主 Telegram 账号；回 403 `teledrive_forbidden` 不代表登录失效。bridge 补送游玩记录时若持续 401，说明 reina-server 与 TeleDrive 的 `JWT_SECRET` 或 owner 设置不一致，bridge 会暂停 30 分钟再试。

**下载不完整（状态 `incomplete`）**
下载被取消、失败或 bridge 重启中断。没有 `.reina-complete` 标记的目录不会被当作 `ready`，也不能启动。重新点击下载：已存在的文件会跳过续传。失败原因会显示在状态的 `error` 中（已去除凭证与本机路径）。

**游玩时长没有出现（playtime queue pending）**
这是预期的最终一致：记录先在 bridge 本机 `playtime-queue.jsonl` 排队，server 接受后才会出现，并在其他设备通过 `data_version` 同步。排查：server 是否健康（`/game/healthz`）、bridge 日志是否有 `playtime send deferred`/`retained`、`REINA_OWNER_ID` 与 JWT 是否一致；被永久拒绝的单条（游戏已删除、数据无效）会被搁置而不阻塞后面的记录。不要手工删除队列文件，除非已确认记录不再需要。
