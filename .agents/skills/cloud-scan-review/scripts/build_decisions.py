"""把人工判斷（遊戲 id → 第幾個候選）轉成網頁「匯入建議」要貼上的 JSON。

用法：python3 -I build_decisions.py <reina_manager.db> <choices.json> <輸出.json>
choices.json 格式：{"77": 1, "79": 2}，值是 pending.txt 裡的候選編號（1 起算）。
不要套用的遊戲不要列進去。
"""
import json
import sqlite3
import sys

db_path, choices_path, out_path = sys.argv[1:4]
choices = json.loads(open(choices_path, encoding="utf-8").read())

conn = sqlite3.connect(db_path)
decisions, problems = [], []
for game_id, number in sorted(choices.items(), key=lambda item: int(item[0])):
    row = conn.execute(
        "select scan_status, scan_candidates from games where id = ?", (int(game_id),)
    ).fetchone()
    if row is None:
        problems.append(f"#{game_id} 不存在")
        continue
    status, raw = row
    candidates = json.loads(raw or "[]")
    if status not in ("pending", "needs_confirmation"):
        problems.append(f"#{game_id} 已不是待確認（{status}）")
        continue
    if not 1 <= number <= len(candidates):
        problems.append(f"#{game_id} 沒有第 {number} 個候選")
        continue
    candidate = candidates[number - 1]
    # name 只給人核對用；網頁匯入只讀 id、source、externalId
    decisions.append(
        {
            "id": int(game_id),
            "source": candidate["source"],
            "externalId": candidate["externalId"],
            "name": candidate["name"],
        }
    )

with open(out_path, "w", encoding="utf-8") as file:
    json.dump(decisions, file, ensure_ascii=False, indent=1)
print(f"輸出 {len(decisions)} 筆到 {out_path}")
for problem in problems:
    print("略過：", problem)
