---
name: cloud-scan-review
description: 批量整理网页版云端扫描的待确认游戏：导出待确认清单与候选、通过本机 bridge 读 zip 内容辨认游戏、产生「添加游戏 → 导入建议」要贴上的 JSON，必要时直接改名。待确认数量多、需要人工判断候选时使用。
---

# 云端扫描待确认整理

网页版每次云端扫描后，名称无法精确命中的游戏会留在「添加游戏」的待确认清单（规则见 [metadata.md](../../../docs/architecture/metadata.md#云端扫描的名称解析)）。数量多时不必在网页上逐笔点「应用」：先在这里判断，产生一份 JSON，再到网页一次导入。

整个流程只读正式数据，**只有第 6 步会直接写数据库**。脚本都在 `scripts/`，产物放在 `.local/cloud-scan-review/`（已在 `.gitignore`）。

## 前提

- 在 WSL 的 TeleDrive 部署环境执行，`teledrive-reinamanager-1` 正在运行，数据卷为 `teledrive_reina-data`（见 [web-docker.md](../../../docs/deployment/web-docker.md)）。
- 第 4 步需要 Windows 上的 bridge 在 `127.0.0.1:8081` 运行（`curl http://127.0.0.1:8081/rpc/status` 能回应）。
- 不需要、也不要读取任何 TeleDrive token 或 `JWT_SECRET`。

## 1. 复制数据库（只读副本）

使用者数据在 `/data/users/<user_id>/reina_manager.db`，先确认目录名：

```bash
docker exec teledrive-reinamanager-1 ls /data/users
mkdir -p .local/cloud-scan-review
docker cp teledrive-reinamanager-1:/data/users/<user_id>/reina_manager.db .local/cloud-scan-review/r.db
# WAL 里可能还有未合并的写入，一起复制才是最新状态；不存在时忽略错误
docker cp teledrive-reinamanager-1:/data/users/<user_id>/reina_manager.db-wal .local/cloud-scan-review/r.db-wal
```

## 2. 导出待确认清单

```bash
python3 -I .agents/skills/cloud-scan-review/scripts/export_pending.py .local/cloud-scan-review/r.db .local/cloud-scan-review
```

`pending.txt` 每笔一段，候选以 1 起算编号，与网页显示顺序相同：

```text
#79 Body Pay OMG
   1. [steam:3351580] "Body Pay OMG! " Anime DLC
   2. [steam:3282510] Body Pay "OMG! The girl with the big titties is too hitting on me!"
```

## 3. 逐笔判断候选

把判断写成 `.local/cloud-scan-review/choices.json`，键是游戏 id，值是候选编号：

```json
{ "77": 1, "79": 2, "736": 4 }
```

判断要点：

- **不要默认选第 1 个。** 第 1 个常是 DLC、续作或同系列其他作（上例 #79 的第 1 个是 DLC）。
- 资料夹名常是中文译名或缩写：`魔导异元素` = `Sequence Palladium`，`兰斯` = `ランス`，`出云战记` = `IZUMO`，`特勤机甲队` = `POWER DoLLS`。
- 系列作要对上代数与集数，候选里没有该代就不要选别代。
- 重制版、加强版、完整版（`HD`、`Full voice ReBORN`、`Latest Edition`、`Exe`）可以选原版，资料与封面可用；但要告诉使用者这些是近似。
- 资料夹名对不上任何候选，或怀疑资料夹标错时，先做第 4 步再决定。不确定的不要列进去，留给使用者在网页上处理。

## 4. 读 zip 内容辨认游戏（选用）

bridge 提供 TeleDrive `game/` 文件夹的只读 WebDAV，zip 支持 HTTP Range。`probe_zip.py` 只读 zip 结尾的目录和几个能看出标题的设置文件，不下载整个游戏：

```bash
python3 -I .agents/skills/cloud-scan-review/scripts/probe_zip.py .local/cloud-scan-review/r.db 87,113,208 > .local/cloud-scan-review/probe.jsonl
```

每行一笔，看 `hints`（RPG Maker 标题、Unity 的「公司 / 产品」等）、`exes`（执行文件名）和 `top`（最上层文件夹名）。例如：

- `"hints": {"…/app_Data/app.info": "azucat / Hypnosis2"}` → 确认是 azucat 的 Hypnosis App 2。
- `"top": ["Super Smash Gals Ultimate Orgy"]` 但资料夹名是另一款 → 资料夹标错，不要套用候选。
- `"top": ["…​.7z.part"]` → 上传不完整的坏档。

资料夹型游戏（不是 `.zip`）会回报 `HTTP Error 404`，可用 `curl -X PROPFIND -H "Depth: 1" "http://127.0.0.1:8081/game/<名称>/"` 手动看内容。

## 5. 产生导入用 JSON

```bash
python3 -I .agents/skills/cloud-scan-review/scripts/build_decisions.py .local/cloud-scan-review/r.db .local/cloud-scan-review/choices.json .local/cloud-scan-review/建议套用.json
```

脚本会检查每笔仍是待确认、候选编号存在，有问题的会列出并略过。输出格式：

```json
[{ "id": 79, "source": "steam", "externalId": "3282510", "name": "Body Pay \"OMG! …\"" }]
```

`name` 只供人核对；网页只读 `id`、`source`、`externalId`。把文件交给使用者：Windows 可从 `\\wsl.localhost\<发行版>\<文件绝对路径>` 打开。

使用者在网页上：「添加游戏」→「导入建议」→ 贴上 →「开始套用」。每笔都走与手动「应用」相同的流程（抓完整资料、写入、设封面），已不在待确认清单的自动略过；遇到数据源限流会停止，之后重新导入同一份即可。

## 6. 直接改名（选用，会写正式数据库）

候选里都没有、但从 zip 内容认得出来的游戏，可以直接把名称改对，方便之后在详情页搜索。只改名称，不会有简介和封面。**不要用这个方法「应用候选」**：应用需要从数据源抓完整资料与封面，只能在网页上做。

写 `.local/cloud-scan-review/names.json`：

```json
{ "names": { "208": "Muv-Luv", "230": "Sequence Palladium" }, "dismiss": [278] }
```

先停服务并备份，再改，最后启动（停机期间 `/game` 回 502，约十几秒）。在 TeleDrive 部署目录执行：

```bash
docker compose stop reinamanager
docker run --rm -v teledrive_reina-data:/data -v "$PWD":/b debian:bookworm-slim tar czf /b/reina-$(date +%Y%m%d-%H%M).tgz -C /data .
docker run --rm -v teledrive_reina-data:/data -v <repo>/.agents/skills/cloud-scan-review/scripts:/s:ro -v <repo>/.local/cloud-scan-review:/w:ro \
  python:3.11-slim python -I /s/rename_games.py /data/users/<user_id>/reina_manager.db /w/names.json
docker compose start reinamanager
```

脚本只处理仍是待确认的条目，并递增 `data_version`，其他设备会自动重新读取。可以先对第 1 步的副本执行一次确认结果。出错时停服务，用刚才的备份还原（见 web-docker.md 的回滚）。

## 结束

- 向使用者报告：导入 JSON 的笔数（区分确定与近似）、直接改名的笔数、仍留待人工处理的项目及原因。
- 删除 `.local/cloud-scan-review/`，里面有使用者的游戏库副本。
