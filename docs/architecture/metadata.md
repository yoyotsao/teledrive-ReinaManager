# 元数据适配架构

本文档描述外部游戏元数据的注册、请求、标准化和展示合并边界。

## 模块地图

```text
src/metadata/
├── sourceAdapter.ts       Adapter 接口、请求上下文与绑定器
├── sourceRegistry.ts      Adapter 注册表和查询入口
├── constants.ts           注册、搜索和混合源常量
├── sourceCandidate.ts     搜索候选的统一中间形态
├── sourceRecord.ts        聚合 `sources` 记录的读取工具
├── sourceAutoResolve.ts   单源自动匹配
├── adapters/              各数据源差异
├── api/                   HTTP 客户端、限流与各源 API
└── data/                  搜索编排、数据转换和展示合并
```

当前注册源由 `SOURCE_ADAPTERS` 决定，包括 BGM、VNDB、YMGal、Kungal、DLsite、ErogameScape、Hikarinagi、HGameFree 和 Steam。Steam 使用公开的 storesearch／appdetails（无需密钥），提供简介、类型标签、开发商、发售日和封面，仅 `type=game` 的条目有效。HGameFree 是下载站文章（WordPress REST API），只提供标题、封面和下载链接里的压缩包文件名（存入 `aliases`），用于云端扫描按文件名匹配；MEGA 链接不含文件名，只能靠标题匹配。网页版搜索 HGameFree 时优先查 reina-server 的本机索引，索引未就绪或桌面版则直接请求站台（`src/metadata/api/hgamefree.ts`）。新增源时，网页版还需在 `reina-server/src/upstream/policy.rs` 登记 host 与限速，桌面版在 `src-tauri/capabilities/default.json` 放行域名。不在文档中复制派生源列表；以 `sourceRegistry.ts` 和 `constants.ts` 为准。

### 废弃源与历史兼容

`constants.ts` 的 `DEPRECATED_SOURCE_KEYS` 将废弃源与在线源分开。注册表仍保留只读 Adapter，
`SEARCHABLE_SOURCE_KEYS` 和 `MIXED_SOURCE_KEYS` 则只包含在线源。不要用在线源集合过滤历史展示、
封面、简介或外链。详情页允许切换到已保存的废弃源，但不能搜索、修改其请求 ID 或刷新。

旧 `kun` 为 Kungal v1，只保留历史类型、显示字段、ID 校验和旧外链；旧网络实现已经移除。
服务层及旧 Adapter 均拒绝在线操作，mixed 请求过滤它。元数据更新 Payload 不覆盖或删除废弃源，
避免刷新其他源时丢失旧数据及封面引用。

持久化的 Kungal 单源和 mixed 偏好仍保留，不发起请求。单源选择中的旧值标为已废弃；
mixed 设置只显示在线源，不展示废弃源的勾选项，数量约束也只计算在线源。
旧偏好不占名额，停用后只有一个在线源的存量配置仍可使用该源。
当前不迁移源偏好，不改写游戏的旧 `kun` ID、数据或封面来源。

## Adapter 边界

`MetadataSourceAdapter<TData>` 将每个数据源统一为以下能力：

- 描述源标识、显示名和图标。
- 校验外部 ID，生成外部页面 URL。
- 按 ID 获取 `GameMetadataDraft`。
- 按名称搜索 `SourceCandidate<TData>[]`。
- 必要时在用户选中后继续补全。
- 将源私有数据投影为统一展示字段。

Adapter 只处理本数据源的差异。混合搜索、优先级合并、写入本地数据库和 UI 不属于 Adapter。

## 请求上下文

`MetadataRequestContext` 携带一次元数据会话共享的信息：代理、取消信号、剧透等级和认证 token。`bindSourceAdapters` 将该上下文绑定到 adapters，业务流只需传入 `limit` 或 `enrichCrossSource` 等单次选项。

请求上下文由 `src/services/requestContext.ts` 与认证 service 组装，不要在页面或 Adapter 中重复读取全局设置。

## 云端扫描的名称解析

`src/metadata/cloudScanResolve.ts` 处理 TeleDrive 里 zip 去掉扩展名后的名称，只有精确相符才自动套用：

1. RJ 号码：查 DLsite 作品类型，游戏类直接采用。
2. 纯数字：依序在 HGameFree 索引里按外部 ID 反查（`dlsite:RJ…`、`getchu:<id>`、`steam:<id>`），查不到再用 VNDB 的 Steam 反查。数字可能是 Getchu 编号，所以不直接当 Steam App ID 去问 Steam。
3. 其他名称：去掉结尾的 `v1.0.9`、`[…]` 后，依 `CLOUD_SCAN_SOURCES` 顺序搜索（HGameFree → Steam → VNDB → BGM → YMGal）。
4. 命中 HGameFree 文章后，用文章里的 Steam／DLsite ID 与标题补完整资料；Steam 名称命中时反过来附上下载站文章（含 `file_url`）。补资料失败不影响命中。
5. 没有精确命中时，列出候选（包含关系）或各来源搜索前几名，交给用户确认。

待确认清单（`GET /game/api/scan/pending`）只含仍是扫描占位的条目：`id_type` 已不是 `custom`、名称与文件夹名不同，或填了其他自定义字段（简介、开发商、标签等）的条目视为用户已手动处理，不再列入，也不会被重新扫描覆盖。详情页的文件大小来自 `GET /game/api/scan/sizes`（读 TeleDrive 列表，取 `file_hash` 尾端记录的真实长度），文件夹型游戏没有大小。

删除游戏时可勾选「同时将 TeleDrive 云端文件移到垃圾桶」（默认不勾选，仅网页版）：前端先调用 `POST /game/api/scan/cloud-trash`（按 `teledrive_path` 找到 `game/` 下的 zip 与同名文件夹，调用 TeleDrive `DELETE /files/{id}` 移入垃圾桶，可在 TeleDrive 还原），成功后才删除数据库记录；云端失败则记录保留，可重试。

## 数据形态

| 形态 | 职责 |
| --- | --- |
| 源 API 原始类型 | Adapter 内部解析和源特有字段 |
| `SourceCandidate<TData>` | 统一搜索候选，同时保留原始源数据和标准展示字段 |
| `GameMetadataDraft` | 可供新增/更新流程使用的标准化草稿 |
| `GameSourceRecord` | 存入 `game_sources` 聚合的外部 ID 和 JSON 数据 |
| `GameData` | 按当前源、混合规则和自定义覆盖展平的 UI 数据 |

## 主要数据流

### 单源搜索

```text
UI → GameMetadataSession
→ bound adapter.searchByName 或 fetchById
→ SourceCandidate
→ adapter.enrichOnSelect（可选）
→ GameMetadataDraft
```

### 混合搜索

```text
UI → GameMetadataSession
→ 从 MIXED_SOURCE_KEYS 选取启用 adapters
→ 并行搜索，保留每个源的成功/失败结果
→ 用户选择或自动解析
→ 必要时补全所选候选
→ 组合 GameMetadataDraft
```

单个源失败不应立即使混合搜索失败；只有所有已尝试源都失败时才向上抛出整体错误。

### 下载安装元数据

安装任务进入 `matching_metadata` 后，由 `InstallRequestHandler` 获取元数据并交回后端导入。
请求来源取安装协议携带的 BGM、VNDB、Hikarinagi ID 与匹配开始时 `mixedEnabledSources` 的交集；
不会按名称补查未携带 ID 的来源。Hikarinagi 还要求已配置 access token，必要时先刷新再请求；
BGM、VNDB 不以登录状态作为请求开关。没有可请求来源时，使用安装标题创建自定义条目。

### 展示合并

```text
FullGameData.sources
→ sourceRecord 建立源映射
→ 各 Adapter.toDisplayFields
→ displayMergeRules 按字段优先级合并
→ custom_data 覆盖/补充
→ GameData
```

### 云端收藏导入

```text
BGM / VNDB / Hikarinagi 用户收藏
→ 统一收藏候选（来源 ID、状态、评分、评论、预览）
→ 按同源 ID 排除本地已有游戏
→ 获取完整 GameMetadataDraft
→ 批量写入 localpath 为空的云端游戏
```

- BGM 收藏列表只用于预览和个人数据，选中后逐项读取完整条目详情。
- VNDB 在 `ulist` 中显式选择个人字段及嵌套 `vn` 详情，同一次分页请求完成转换。
- Hikarinagi 状态列表用于预览和个人数据，选中后逐项读取完整 Galgame 详情。
- 收藏状态写入 `games.clear`，有效评分和非空评论写入 `custom_data`。详情失败的项目不使用预览数据降级入库。
- 导入任务复用批量新增、身份去重和游戏缓存 patch；外部 API 请求统一沿用请求上下文、取消信号与限速队列。

字段优先级属于 `displayMergeRules.ts`，不应复制到 Adapter 或 UI。

## HTTP 边界

`src/metadata/api/http.ts` 统一使用 Tauri HTTP，并处理：

- query 参数、JSON/文本响应与 HTTP 错误。
- 代理和局域网绕过。
- `AbortSignal` 取消。
- 按数据源限流、429 退避和稳定错误分类。

网页版没有 Tauri HTTP：元数据请求经 reina-server 的 `/game/api/metadata/request` 与 `/game/api/metadata/image` 代理（服务器端有主机白名单、限流和大小限制），TeleDrive JWT 只发往同源 `/game/api/` 与 bridge，不会带给第三方数据源。

新 API 实现应复用该边界，不在 Adapter 里自建重复 HTTP 客户端。

## 新增数据源

1. 在 `src/types` 定义源数据类型，并扩展 `SourceType` / `SOURCE_TYPES`。
2. 在 `metadata/api` 实现该源请求和响应转换；若请求新域名，同步更新 Tauri capability。
3. 在 `metadata/adapters` 实现 `MetadataSourceAdapter<TData>`。
4. 在 `sourceRegistry.ts` 注册 Adapter 并扩展 `SourceAdapterMap`。
5. 根据产品行为调整 `constants.ts` 中的搜索/混合源集合和默认值。
6. 若新源对字段合并有意义，更新 `displayMergeRules.ts`；参与基础字段合并时，同步前后端的 `MIXED_BASIC_SOURCE_PRIORITY`。
7. 若新源可作为用户选定的封面来源，同步扩展 Rust `CustomData::cover_source` 使用的 `SourceType` 枚举。
8. 更新跨层类型、国际化文案和相关设置 UI，再按 i18n Skill 验证。

新源应尽可能通过 registry 自动进入通用流程。仅在有真实产品差异时，才在上层增加源特有分支。
