//! 由 TeleDrive 的 game 資料夾列表推導遊戲名稱。
//! 規則與 bridge 一致：同檔名取較新、.zip 不分大小寫算遊戲、
//! Windows 名稱不分大小寫，同組以完全相同的 `.zip` 後綴優先。

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct ListingRow {
    pub file_id: String,
    pub filename: String,
    #[serde(rename = "isDir", default)]
    pub is_dir: bool,
    /// TeleDrive 存的是無時區 UTC ISO 字串；同格式可以直接字串比較。
    #[serde(default)]
    pub created_at: String,
}

fn is_zip_name(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".zip")
}

fn strip_zip_suffix(name: &str) -> &str {
    if is_zip_name(name) {
        &name[..name.len() - 4]
    } else {
        name
    }
}

/// 優先順序：完全相同 `.zip`（新者優先）> 其他大小寫 zip（新者優先）> 資料夾。
fn rank(row: &ListingRow) -> (u8, &str) {
    let tier = if !row.is_dir && row.filename.ends_with(".zip") {
        2
    } else if !row.is_dir {
        1
    } else {
        0
    };
    (tier, row.created_at.as_str())
}

pub fn derive_game_names(rows: &[ListingRow]) -> Vec<String> {
    // 對齊 tdapi.children_by_name：完全相同檔名只保留 created_at 較新者。
    let mut newest: BTreeMap<&str, &ListingRow> = BTreeMap::new();
    for row in rows {
        match newest.get(row.filename.as_str()) {
            Some(previous) if previous.created_at >= row.created_at => {}
            _ => {
                newest.insert(row.filename.as_str(), row);
            }
        }
    }

    // Windows 路徑不分大小寫；每個名稱群組挑 bridge 最終會解析到的一筆。
    let mut groups: BTreeMap<String, &ListingRow> = BTreeMap::new();
    for row in newest.values() {
        if !row.is_dir && !is_zip_name(&row.filename) {
            continue;
        }
        let key = strip_zip_suffix(&row.filename).to_lowercase();
        match groups.get(&key) {
            Some(previous) if rank(previous) >= rank(row) => {}
            _ => {
                groups.insert(key, row);
            }
        }
    }

    let mut names: Vec<String> = groups
        .values()
        .map(|row| strip_zip_suffix(&row.filename).to_string())
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(name: &str, is_dir: bool, created_at: &str) -> ListingRow {
        ListingRow {
            file_id: format!("id-{name}-{created_at}"),
            filename: name.into(),
            is_dir,
            created_at: created_at.into(),
        }
    }

    #[test]
    fn 資料夾與_zip_都算遊戲_一般檔案不算() {
        let rows = vec![
            row("Foo", true, "2026-01-01T00:00:00"),
            row("Bar.zip", false, "2026-01-01T00:00:00"),
            row("readme.txt", false, "2026-01-01T00:00:00"),
            row("Baz.ZIP", false, "2026-01-01T00:00:00"),
        ];
        assert_eq!(derive_game_names(&rows), vec!["Bar", "Baz", "Foo"]);
    }

    #[test]
    fn 同名資料夾與_zip_只算一款() {
        let rows = vec![
            row("Foo", true, "2026-01-01T00:00:00"),
            row("Foo.zip", false, "2026-01-02T00:00:00"),
        ];
        assert_eq!(derive_game_names(&rows), vec!["Foo"]);
    }

    #[test]
    fn 大小寫不同只算一款_名稱取完全相同_zip_優先() {
        let rows = vec![
            row("Foo.ZIP", false, "2026-03-01T00:00:00"),
            row("foo.zip", false, "2026-01-01T00:00:00"),
        ];
        assert_eq!(derive_game_names(&rows), vec!["foo"]);
    }

    #[test]
    fn 沒有完全相同_zip_時取最新的候選() {
        let rows = vec![
            row("Foo.ZIP", false, "2026-01-01T00:00:00"),
            row("foo.Zip", false, "2026-03-01T00:00:00"),
        ];
        assert_eq!(derive_game_names(&rows), vec!["foo"]);
    }

    #[test]
    fn 完全相同的檔名重複時保留較新的列() {
        let rows = vec![
            row("Foo.zip", false, "2026-01-01T00:00:00"),
            row("Foo.zip", false, "2026-02-01T00:00:00"),
        ];
        assert_eq!(derive_game_names(&rows), vec!["Foo"]);
    }

    #[test]
    fn 非_ascii_與逗號名稱原樣保留() {
        let rows = vec![
            row("廃村少女, 体験版.zip", false, "2026-01-01T00:00:00"),
            row("サブ救って!", true, "2026-01-01T00:00:00"),
        ];
        assert_eq!(
            derive_game_names(&rows),
            vec!["サブ救って!", "廃村少女, 体験版"]
        );
    }
}
