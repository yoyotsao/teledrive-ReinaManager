"""直接改資料庫：把辨認出的遊戲改成正確名稱並移出待確認清單，最後遞增 data_version。

用法：python -I rename_games.py <reina_manager.db> <names.json>
names.json 格式：{"names": {"208": "Muv-Luv"}, "dismiss": [278]}
- names：改 custom_data.name，scan_status 設為 complete（改過名的條目本來就不再列入待確認）。
- dismiss：不改名，只移出待確認（例如沒傳完的壞檔）。
只處理仍是待確認的條目。必須在 reina-server 停止時執行，見 SKILL.md。
"""
import json
import sqlite3
import sys

db_path, spec_path = sys.argv[1:3]
spec = json.loads(open(spec_path, encoding="utf-8").read())

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA foreign_keys = ON")
with conn:
    changed = 0
    for game_id, name in spec.get("names", {}).items():
        row = conn.execute(
            "select custom_data, scan_status from games where id = ?", (int(game_id),)
        ).fetchone()
        if row is None or row[1] not in ("pending", "needs_confirmation"):
            print("略過", game_id, row and row[1])
            continue
        data = json.loads(row[0] or "{}")
        data["name"] = name
        conn.execute(
            "update games set custom_data = ?, scan_status = 'complete', "
            "scan_candidates = NULL, updated_at = strftime('%s', 'now') where id = ?",
            (json.dumps(data, ensure_ascii=False, separators=(",", ":")), int(game_id)),
        )
        changed += 1
    for game_id in spec.get("dismiss", []):
        changed += conn.execute(
            "update games set scan_status = 'complete', scan_candidates = NULL, "
            "updated_at = strftime('%s', 'now') "
            "where id = ? and scan_status in ('pending', 'needs_confirmation')",
            (int(game_id),),
        ).rowcount
    # 其他裝置靠 data_version 變化才會重新讀取
    conn.execute("update server_state set data_version = data_version + 1 where id = 1")
    version = conn.execute("select data_version from server_state where id = 1").fetchone()[0]
    print(f"已修改 {changed} 筆，data_version = {version}")
conn.close()
