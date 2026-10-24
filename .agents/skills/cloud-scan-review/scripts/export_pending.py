"""列出待確認的雲端掃描條目與候選，供人工判斷。

用法：python3 -I export_pending.py <reina_manager.db> <輸出目錄>
輸出 pending.txt（可讀清單，候選以 1 起算編號，與網頁上的順序一致）與 pending.json。
"""
import json
import sqlite3
import sys
from pathlib import Path

db_path, out_dir = sys.argv[1], Path(sys.argv[2])
out_dir.mkdir(parents=True, exist_ok=True)

conn = sqlite3.connect(db_path)
rows = conn.execute(
    "select id, teledrive_path, scan_candidates from games "
    "where scan_status in ('pending', 'needs_confirmation') order by id"
).fetchall()

items, lines = [], []
for game_id, path, raw in rows:
    candidates = json.loads(raw or "[]")
    name = path.split("/", 1)[1] if path and "/" in path else path
    items.append({"id": game_id, "name": name, "candidates": candidates})
    lines.append(f"#{game_id} {name}")
    for index, candidate in enumerate(candidates, start=1):
        lines.append(
            f"   {index}. [{candidate['source']}:{candidate['externalId']}] {candidate['name']}"
        )

(out_dir / "pending.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
(out_dir / "pending.json").write_text(
    json.dumps(items, ensure_ascii=False, indent=1), encoding="utf-8"
)
print(f"{len(items)} 筆待確認，其中 {sum(1 for i in items if not i['candidates'])} 筆沒有候選")
