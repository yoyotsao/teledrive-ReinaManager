# 游戏库数据与缓存

本文档只描述游戏数据从 SQLite 到 UI 的读写路径，以及 Query 与 `GameIndex` 的一致性约束。

## 核心数据形态

| 形态 | 含义 | 主要用途 |
| --- | --- | --- |
| `FullGameData` | 后端返回的完整聚合，含 `sources` 和 `custom_data` | Query 主缓存、编辑、数据源更新 |
| `GameData` | `getDisplayGameData` 将多源和自定义覆盖展平后的数据 | 卡片、详情、搜索和分类 UI |
| `GameIndex` | 从 `FullGameData[]` 派生的 List、Map 和分类索引 | 按 ID 查找、源可用性、开发商虚拟分类 |

`GameIndex` 同时保存 `rawList/rawById`、`displayList/displayById`、ID、数据源可用性和开发商索引。业务代码应按需选择 raw 或 display，不要在组件中重复转换。

`GameData` 展平后的 `teledrive_path` 与 `exe_relpath` 是服务器保存的 canonical 相对路径。Web bridge feature 只使用这两个展示字段，不从 raw cache 读取 Windows 绝对路径；本机 bridge 状态位于独立的 `['bridge', 'games', ...]` Query namespace，不进入 `GameIndex` 或服务器游戏缓存。

## Query key

`src/hooks/queries/useGames.ts` 维护：

- `gameKeys.all`：`FullGameData[]` 主缓存。
- `gameKeys.index()`：`GameIndex` 派生缓存。
- `gameKeys.idList(params)`：后端排序/筛选后的轻量 ID 列表。
- `gameKeys.bgmIds()` / `vndbIds()`：新增和导入时的重复检测辅助数据。

## 读取路径

```text
useAllGames → find_all_games → FullGameData[] → gameKeys.all
                                             ↓
                                         GameIndex
                                             ↓
useGameIdList → find_game_ids → number[] → displayById 组装
                                             ↓
                         状态 / 标签 / NSFW / 搜索过滤
                                             ↓
                                      虚拟化卡片列表
```

前端首次加载完整游戏聚合。切换基础类型筛选或排序时，`find_game_ids` 只传输 ID，前端再从 `displayById` 取展示数据，避免重复传输整个游戏库。

列表标准入口是 `useGameListFacade`。详情页默认读 `displayById`；只有编辑外部源或底层字段时才读 `rawById`。

自定义收藏分类通过 `preferencesScope: "collection"` 复用列表门面，使用独立的搜索与筛选排序偏好，且保持收藏夹不过滤 NSFW 的现有规则。手动排序保留分类成员 ID 的原始顺序，其他排序使用后端排序 ID 与分类成员的交集。搜索和筛选只派生显示列表，不修改分类成员或已保存的手动顺序。

自定义分类只有在手动排序、无搜索和筛选、搜索派生已完成且未进入批量模式时使用全量拖拽网格；其他场景复用虚拟网格。保存期间只暂停下一次拖拽，不切换网格。虚拟网格拖拽尚未接入。

自定义分类的卡片控制器由分类视图持有，两种网格只负责卡片渲染；批量选择与右键菜单不会因网格切换或筛选为空而重置。虚拟网格沿用分类操作与排序字段展示。搜索、筛选或排序变化时回到顶部并清理当前分类的滚动快照；从分类页进入也回到顶部，从详情返回则恢复列表位置。全量网格与虚拟网格共用列表内滚动坐标，进入或退出批量模式时接续当前位置；没有虚拟网格快照时，使用实际像素位置恢复，不估算行高。

普通、虚拟和拖拽网格共用 `GameCardItem`，传入稳定的 `GameData` 引用和 `getCardProps`，仅 ID 顺序变化时跳过卡片属性派生。拖拽位移与事件绑定在外层容器；`CardItem` 负责点击、选中与批量操作，内部展示层只比较封面语义键、名称、排序字段文字和选中态。交互回调或非展示游戏字段变化仍更新外层，避免使用过期数据；封面 URL 中的更新时间不会单独触发内容重绘或图片加载。排序保存期间只禁用拖拽，不重新挂载整个卡片树。

拖拽状态也由分类视图持有，切换网格时保留正在保存的状态，避免快速进入并退出批量模式后重复提交排序。

普通、虚拟和拖拽网格通过 `useCardsGridLayout` 统一监听容器宽度，以 160 CSS px 的卡片最小宽度和 16 CSS px 的间距计算列数，最多 10 列。界面缩放、窗口调整和侧栏展开都会重新排布；虚拟网格等待首次宽度测量完成后挂载，按实际列数选择滚动快照。

拖拽源使用 CSS 类隐藏，避免落下动画恢复内联透明度时覆盖下一次拖拽。
拖拽正式开始时通过卡片控制器关闭已打开的右键菜单，菜单状态仍隔离在菜单宿主中。
确认进入拖拽后，源卡片与拖拽预览停用按压缩放和涟漪，避免松手后出现点击反馈；普通卡片仍保留点击与键盘焦点效果。拖拽预览不参与鼠标命中，并显示悬停时的外观；源卡片保留悬停缩放与阴影，使落下动画期间的样式与最终悬停状态连续。拖拽状态只传给卡片交互层，展示层不因此重绘。

拖拽通过 `useReorderCategoryGames` 调用专用 `reorder_category_games`，后端在同一事务内检查分类存在、成员集合一致且 ID 不重复，只更新关联的 `sort_order`，不增删成员。松手时先同步显示目标 ID 顺序，避免落下动画在 Query 通知到达前向旧位置回退；收到新的列表引用后立即使用外部列表，并清理这份短期交互状态。失败时也清理交互状态。前端不重复校验完整成员列表；Query 乐观更新当前分类的 ID 缓存，成功后无需失效查询，失败时回滚尚未被其他操作更新的缓存并仅刷新当前分类。管理游戏继续使用 `update_category_games` 替换成员，成功后失效收藏相关查询。

## 写入路径

```text
UI action
→ useAddGame / useUpdateGame / useDeleteGame / 批量 mutation
→ gameService
→ Rust transaction
→ 后端返回完整 FullGameData
→ gameCachePatch 增量维护 gameKeys.all + GameIndex
→ 按影响范围 invalidate ID、合集、统计或源 ID 缓存
```

`src/hooks/queries/gameCachePatch.ts` 是写缓存的统一入口：

- `appendGamesToCaches`：新增。
- `patchGameCaches` / `patchManyGameCaches`：更新。
- `removeGamesFromCaches`：删除。

这些函数同时维护 `gameKeys.all`、`gameKeys.index()` 和 WeakMap 派生缓存。它们会使用 React Query 最终保存的数组引用，避免 structural sharing 导致索引引用失配。

## 失效规则

- 新增、删除，或修改会影响归属/排序的字段：失效 `gameKeys.idLists()`。
- 修改 BGM/VNDB 来源绑定：失效对应源 ID 缓存。
- 删除游戏：同时失效合集和统计。
- 新增游戏：同时失效合集和重复检测缓存。
- 云端收藏导入复用批量新增路径；`localpath` 留空，并按各来源外部 ID 在准备和写入阶段双重去重。
- 不影响列表归属或排序的局部更新：只 patch 聚合和索引。
- 修改 TeleDrive 路径或 exe 相对路径：按游戏资料 mutation 更新 `GameIndex`；本机下载/运行状态由 bridge Query 自己刷新，不失效服务器 namespace。

## 网页版跨装置同步

网页版有多台装置同时修改同一份资料，另外提供一个全局版本：

- `src/hooks/queries/serverKeys.ts` 的 `serverKey(...)` 是所有服务器资料 key 的根，`gameKeys`、`collectionKeys`、`statsKeys`、`settingsKeys`、`playStatusKeys`、`saveDataKeys` 都挂在 `["server", ...]` 下。新增来自服务器的 query 时也必须使用它。
- `src/hooks/queries/useServerVersion.ts` 前景每 60 秒读取 `GET /game/api/version`；版本改变时失效整个 `["server"]` 前缀。这是「不因单个游戏更新而全量 refetch `gameKeys.all`」的**明确例外**：只在其他装置确实改过资料时发生。
- 已同步版本只由轮询结果推进，不采用写入回应里的版本。
- 本机写入仍照上面的规则用 `gameCachePatch.ts` 局部 patch；全量重新读取后，`useGameIndex` 会因 `rawList` 引用改变而重建 `GameIndex`。
- 桌面安装任务（`taskKeys`）与本机 bridge 状态（`["bridge", ...]`）不在这个前缀下，不受版本失效影响。

### bridge 与 server 的 Query key

| key 前缀 | 内容 | 失效时机 |
| --- | --- | --- |
| `["server", ...]` | 游戏、合集、统计、设置、存档等服务器事实 | `data_version` 变化、本机写入的 patch/invalidate |
| `["bridge", "games", "states", paths]` | 本机下载/运行状态（`running/downloading/ready/incomplete/absent`） | 自身轮询、下载/取消/启动 mutation 成功后 `bridgeKeys.all` |

游戏结束后（`running` → 非 `running`）会立即检查 `data_version`；若游玩记录仍在 bridge 队列，则要等 server 接受，再由 60 秒轮询或下一次检查刷新统计。这是最终一致，不是缺陷。

## 禁止的做法

- 不在业务代码中直接替换 `gameKeys.all`，这会绕过 `GameIndex`。
- 不在页面或组件中反复调用 `getDisplayGameData`。
- 不因单个游戏更新而全量 refetch `gameKeys.all`。
- 不用 `GameData` 执行需要原始 `sources` 的写入。

## 排查全量重建

单个更新如果触发接近游戏库总数的转换，依次检查：

1. 是否有代码绕过 `gameCachePatch.ts` 写 `gameKeys.all`。
2. 是否不必要地 invalidate/refetch 了 `gameKeys.all`。
3. `gameKeys.index()` 的 `rawList` 是否对应 Query 实际保存的数组引用。
4. 是否在渲染路径重复派生展示数据。
