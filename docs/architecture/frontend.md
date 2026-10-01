# 前端架构

## 启动与路由

`src/main.tsx` 先初始化持久化状态、游戏计时、启动页、托盘和路径缓存，再挂载 Provider 与 React。`src/App.tsx` 组合 i18n、Snackbar、Toolpad 导航、OAuth token 刷新和 Tauri 环境处理器。

路由集中在 `src/providers/router.tsx`，页面使用 `React.lazy` 按路由分割。同一份 `appRoutes` 同时驱动 Router 和 Toolpad 导航。

| 路径 | 页面职责 |
| --- | --- |
| `/` | 首页统计、运行中游戏、近期动态 |
| `/libraries` | 游戏库搜索、筛选、排序和虚拟列表 |
| `/libraries/:id` | 详情、编辑、统计、存档和评价 |
| `/collection` | 分组、分类、开发商虚拟分类 |
| `/stats` | 按时间范围汇总全库游玩概览、排行和趋势 |
| `/settings` | 账号、数据源、界面、系统和备份设置 |

## 分层职责

| 位置 | 放置内容 |
| --- | --- |
| `pages/` | 路由页面、页面私有组件和就近派生逻辑 |
| `components/` | 跨页面 UI 和交互组件 |
| `hooks/common/` | 不含业务语义的通用 React 能力 |
| `hooks/queries/` | Query key、query、mutation、缓存 patch 与失效策略 |
| `hooks/features/` | 组合 Query、Zustand、service 和业务规则的用例门面 |
| `services/invoke/` | Tauri command 的类型化封装 |
| `services/` | 文件、游戏运行时、OAuth、插件和云状态工作流 |
| `metadata/` | 外部元数据的请求、适配、合并和转换 |
| `store/` | Zustand 客户端状态和持久化迁移 |
| `providers/` | Router、QueryClient、i18n、主题和全局 Provider |

页面私有逻辑优先就近放置；只有跨页面复用时才上移。

持久化的用户配置路径使用 `PathInput`，支持原始环境变量表达式及预览。一次性选择、
扫描、拖拽和文件导入路径使用实际绝对路径，不提供变量输入能力。消费已持久化配置的
操作仍须在执行前解析变量。`PathInput` 展示数据库中的原始配置，并通过
`useUserPathInspection` 在首次加载、失焦、按下 Enter 或外部选值后获取实际绝对路径及
文件类型；用户编辑过程中清除旧检查结果，解析失败或路径不存在只影响预览，不在前端
改写配置。设置弹窗只提交本次实际变更的字段，路径语法和绝对性由 Rust command 统一
校验；文件选择器返回的绝对路径直接作为配置值，实际 I/O 的最终解析和类型校验仍由
Rust command 负责。存档备份根目录变更使用专用 service，由后端统一完成文件迁移和配置
切换；前端在失焦或按下 Enter 时保存，存在历史备份时只有迁移成功才切换配置。没有历史
备份且环境变量暂未定义时保留原始表达式并根据 `saved_with_warning` 展示警告；该状态也用于
表示迁移完成但旧目录清理留下残留。迁移时会自动清理文件明确不存在的失效记录，并在完成后
显示清理数量；权限或网络错误不会被当作文件缺失。

Windows 的「工具联动」弹窗集中配置 LE 与 Magpie 路径和新游戏默认开关，设置页与游戏工具栏
共用该弹窗；安装和备份路径仍由「路径设置」弹窗管理。编辑路径后可直接切换默认开关，
弹窗会先保存非空路径再提交开关状态；清空路径时由后端同时关闭默认开关。默认值保存在
用户设置中，由后端新增游戏时写入逐游戏状态；修改默认值不追溯已有游戏。

详情页删除游戏时，主布局中的 `src/providers/GameDeletionProvider.tsx` 暂存当前游戏展示数据，供详情和工具栏通过 `useGameById` 共同读取。删除成功仍立即更新 Query 缓存，并保持删除弹窗的等待状态直到返回导航完成；过渡数据按路由 key 隔离，离开后释放，删除失败则立即释放。这份临时数据不写回缓存，返回页直接读取删除后的游戏库。存档备份文件删除若返回 `missing_file` 或 `file_inaccessible`，页面先关闭文件删除弹窗，再询问用户是否仅按 `backup_id` 清除数据库记录；取消则保留记录。

## 状态边界

| 状态 | 管理方 | 示例 |
| --- | --- | --- |
| 后端/远程事实 | TanStack Query | 游戏、合集、统计、设置、存档、任务 |
| UI 与用户偏好 | `useStore` | 筛选、排序、弹窗、NSFW、数据源、代理 |
| 运行中游戏 | `useGamePlayStore` | 当前进程、实时时长、会话结束 |
| 短期交互 | 组件本地状态 | 表单输入、弹窗内选择 |

`src/providers/queryClient.ts` 将本地事实默认视为长期 fresh，远程查询可使用单独的时效配置。Zustand `persist` 只保存选定偏好，并通过 `appStoreMigrations.ts` 迁移。不要将数据库实体复制到 Zustand 形成第二事实源。

网页版统计也属于 `["server", ...]` 资料。bridge 结束运行会话时立即检查 `data_version`；如果会话仍在本机队列，前景的 60 秒版本轮询会在服务器接受后刷新统计。桌面端仍由 Tauri 会话结束事件刷新本机统计。

网页版 TeleDrive 游戏通过 `useBridgeGames` 查询本机 bridge，使用独立的 `['bridge', ...]` Query namespace，不放进服务器资料版本前缀。bridge 查询显式使用即时过期策略：挂载、窗口聚焦、网络重连时重读；下载中每 2 秒、运行中每 10 秒轮询，页面置于背景或没有活跃工作时停止固定轮询。HTTP 仍经 `authenticatedFetch`，业务操作由 `useGameLaunchFlow` 编排，组件只消费 hook 状态。

数据库定时备份由应用启动后初始化的单例调度服务负责，不依赖设置页面是否挂载。调度配置和最近执行结果保存在 Zustand；应用运行或驻留托盘期间到期后调用后端自动备份 command，启动时发现逾期则延迟约一分钟补做。正常退出会先等待正在执行的定时备份，再按独立的退出间隔决定是否执行冷备份。网页版不启动该调度，备份由服务器负责。

全库统计页复用 `useAllGameStatistics` 的共享 Query，并与 `GameIndex` 中的展示游戏按 ID 关联。概览、排行和趋势在页面私有纯函数中按日期范围派生；24 小时与星期分布通过独立 Query 将当前可见游戏 ID 和日期范围交给后端聚合。统计读取失败必须保留 Query 错误态，不能转换为空数据。

网页版的两类 Query 不要混用：

| 命名空间 | 来源 | 刷新方式 |
| --- | --- | --- |
| `["server", ...]`（`serverKey(...)`） | reina-server `/game/api` | 前景每 60 秒查 `data_version`，变化时整体失效；游戏结束、聚焦、重连时立即查 |
| `["bridge", "games", ...]`（`bridgeKeys`） | 本机 bridge `/rpc/game/*` | 挂载/聚焦/重连重读；下载中 2 秒、运行中 10 秒轮询；不受 `data_version` 影响 |

bridge 不可用（`bridge_unavailable`）只禁用下载/执行，不影响 server 资料。游玩记录是最终一致：bridge 先入本机队列再补送，所以游戏结束后统计可能延迟到 server 接受、下一次版本检查后才出现。

## 标准数据流

```text
Page / Component
→ feature hook
→ query hook
→ invoke service
→ BaseService.invoke
→ Tauri command
→ mutation 成功后 patch / invalidate Query 缓存
→ UI 重渲染
```

`BaseService` 是底层 IPC 入口，负责检查 Tauri 运行时并将错误归一化为 `AppError`。组件和页面禁止直接 `invoke`，也不应自行操作 QueryClient。

当前 `src/pages/Home/HomePage.tsx` 仍直接使用 `useInfiniteQuery`，属于已知分层偏差，不是新代码的示例。

## 修改入口

- 增加后端调用：在 `services/invoke` 扩展对应 service。
- 增加数据查询或写入：在 `hooks/queries` 定义 key、hook 和缓存策略。
- 编排多个数据源或状态：在 `hooks/features` 提供业务门面。
- Web 本机 bridge RPC：在 `services/web` 复用 `authenticatedFetch`，在 `hooks/queries` 管理 bridge 状态与轮询，在游戏 feature hook 编排下载和启动。
- 增加页面：在 `pages` 实现，并更新集中路由配置。
- 增加全局偏好：更新 store 及其持久化选择；必要时增加 store migration。

## 相关文档

- 游戏数据的 Query 和索引规则：[`game-library.md`](game-library.md)
- 元数据搜索和适配器：[`metadata.md`](metadata.md)
