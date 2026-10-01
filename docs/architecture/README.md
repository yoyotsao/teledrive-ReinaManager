# 架构总览

ReinaManager 是 React 前端与 Rust 后端组成的 Tauri 2 桌面应用。本页只描述系统边界和主路径；实现细节由下方专题文档继续分发。

## 系统边界

```mermaid
flowchart LR
    UI["React 页面 / 组件"]
    Hooks["Feature / Query Hooks"]
    Services["前端 Services"]
    Bridge["Tauri IPC / Events"]
    Rust["Rust Commands / Workflows"]
    Repo["Repositories"]
    DB[("SQLite")]
    Native["文件 / 进程 / 系统 API"]
    Remote["外部元数据 API"]

    UI --> Hooks --> Services --> Bridge --> Rust
    Rust --> Repo --> DB
    Rust --> Native
    Services --> Remote
    Rust -. event .-> UI
```

主要职责：

- React 负责界面、用例编排、查询缓存和外部元数据整合。
- Rust 负责本地持久化、文件系统、游戏进程、安装任务、备份、OAuth 和桌面集成。
- SQLite 是核心业务数据的事实源。TanStack Query 缓存这些事实，Zustand 保存 UI 状态和用户偏好。

该图是常规路径，不是全局严格分层。安装、备份、OAuth 和游戏启动会直接组合 repository、SeaORM entity、文件系统、HTTP 或 Tauri event。

## 网页版边界

同一份 React 代码还有一个网页版：Linux `reina-server`（axum + 同一套 `reina-core`）在 Docker 中提供 `/game/` 静态页面和 `/game/api`，由 TeleDrive nginx 反代，与 TeleDrive 共享 JWT 登录。数据仍以 SQLite 为事实源，位于容器卷 `/data`。

- **server**：游戏库 RPC、封面、元数据/图片代理、云端扫描、游玩记录入库与全局 `data_version`。
- **本机 bridge**（Windows，`127.0.0.1:8081`）：游戏下载、可执行文件列表、启动与进程计时；浏览器直接调用 `/rpc/game/*`，不经过 server。
- 游玩记录经 bridge 本机队列补送给 server，属于最终一致；`data_version` 让其他设备发现变化。

部署、回滚、备份、时区和排错见 [`../deployment/web-docker.md`](../deployment/web-docker.md)。

## 目录地图

```text
src/
├── pages/              路由页面与页面私有逻辑
├── components/         跨页面 UI 组件
├── hooks/queries/      Query key、query、mutation、缓存策略
├── hooks/features/     用例级编排
├── services/invoke/    Tauri IPC 边界
├── services/           文件、运行时、认证、云端等工作流
├── metadata/           外部元数据源适配与合并
├── store/              Zustand 客户端状态
└── providers/          Router、Query、i18n 和主题

src-tauri/
├── src/                Tauri/Rust 应用代码
├── migration/          SeaORM 顺序迁移 crate
├── reina-path/         标准/便携模式路径策略
└── capabilities/       Tauri 权限声明
```

## 通信方式

- **IPC command**：有明确请求和响应的本地操作。前端统一经 `src/services/invoke` 调用。
- **Tauri event**：后端主动推送安装进度、游戏会话和 OAuth 结果。
- **Tauri HTTP**：前端元数据子系统经 `@tauri-apps/plugin-http` 访问外部 API。
- **自定义协议**：图片/封面协议向 WebView 提供本地资源；`reinamanager://` 接收安装请求。

## 启动主路径

```text
main.rs → lib::run
→ 注册协议、插件、State 和 Commands
→ 日志与旧文件迁移
→ 建立 SQLite 并执行 SeaORM migrations
→ 恢复中断安装任务
→ 前端初始化 Zustand、计时、托盘和路径缓存
→ 挂载 React
```

数据库连接或 schema migration 失败会停止启动，避免应用在未知 schema 上继续运行。

## 继续阅读

- React 分层和状态边界：[`frontend.md`](frontend.md)
- Rust 模块和存储：[`backend.md`](backend.md)
- 游戏库缓存与索引：[`game-library.md`](game-library.md)
- 外部元数据适配：[`metadata.md`](metadata.md)
- 网页版部署与运维：[`../deployment/web-docker.md`](../deployment/web-docker.md)
