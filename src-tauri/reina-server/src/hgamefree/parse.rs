//! 把 WordPress REST API 的文章整理成索引需要的最少字段。

use serde::Deserialize;

/// k2s 系列网盘的链接带原始文件名。
const FILE_HOSTS: &[&str] = &[
    "k2s.cc",
    "www.k2s.cc",
    "keep2share.cc",
    "keep2share.com",
    "fileboom.me",
    "fboom.me",
    "tezfiles.com",
];

/// MEGA 链接是加密的，取不到文件名，但仍是原始下载链接。
const MEGA_HOSTS: &[&str] = &["mega.nz", "mega.co.nz"];

#[derive(Debug, Deserialize)]
pub struct WpPost {
    pub id: i64,
    #[serde(default)]
    pub modified: String,
    #[serde(default)]
    title: Rendered,
    #[serde(default)]
    content: Rendered,
    #[serde(default, rename = "_embedded")]
    embedded: Option<Embedded>,
}

#[derive(Debug, Default, Deserialize)]
struct Rendered {
    #[serde(default)]
    rendered: String,
}

#[derive(Debug, Default, Deserialize)]
struct Embedded {
    #[serde(default, rename = "wp:featuredmedia")]
    featured_media: Vec<Media>,
}

// 封面被删除时 `_embedded` 里会是错误对象，没有 source_url
#[derive(Debug, Deserialize)]
struct Media {
    source_url: Option<String>,
}

/// 写进索引的一篇文章。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedPost {
    pub id: i64,
    /// 已解码 HTML 实体、尚未去掉 `[大小]`、`官方中文` 等标记的原始标题；清理交给前端。
    pub title: String,
    /// 下载链接里的压缩包文件名，不含扩展名与分卷后缀。
    pub file_names: Vec<String>,
    /// 文章里的原始下载链接（k2s 系列与 MEGA），保持文章中的顺序。
    pub file_url: Vec<String>,
    /// 文章里链接到的外部作品 ID，格式 `steam:3329430`、`getchu:1065742`、`dlsite:RJ01664642`。
    /// 让 Steam App ID、Getchu 编号、RJ 号码都能反查到这篇文章。
    pub external_ids: Vec<String>,
    pub image_url: Option<String>,
    pub modified: String,
}

impl WpPost {
    pub fn parse(self) -> ParsedPost {
        let image_url = self
            .embedded
            .and_then(|embedded| embedded.featured_media.into_iter().next())
            .and_then(|media| media.source_url)
            .filter(|url| !url.is_empty());
        let file_url = extract_download_links(&self.content.rendered);
        ParsedPost {
            id: self.id,
            title: decode_entities(self.title.rendered.trim()),
            file_names: file_names_from_links(&file_url),
            file_url,
            external_ids: extract_external_ids(&self.content.rendered),
            image_url,
            modified: self.modified,
        }
    }
}

/// 解码 WordPress 标题里常见的 HTML 实体。
pub fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let tail = &rest[start..];
        // 实体最长约 10 个字符，超出就当成普通的 &
        let decoded = tail
            .find(';')
            .filter(|end| *end <= 10)
            .and_then(|end| decode_entity(&tail[1..end]).map(|ch| (ch, end + 1)));
        match decoded {
            Some((ch, consumed)) => {
                out.push(ch);
                rest = &tail[consumed..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn decode_entity(name: &str) -> Option<char> {
    match name {
        "amp" => Some('&'),
        "lt" => Some('<'),
        "gt" => Some('>'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "nbsp" => Some(' '),
        _ => {
            let digits = name.strip_prefix('#')?;
            let code = match digits.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => digits.parse().ok()?,
            };
            char::from_u32(code)
        }
    }
}

/// 依出现顺序取出内容里所有 `href` 的值（已解码 HTML 实体）。
fn hrefs(html: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = html;
    while let Some(at) = rest.find("href=") {
        rest = &rest[at + "href=".len()..];
        let Some(quote) = rest.chars().next().filter(|ch| matches!(ch, '"' | '\'')) else {
            continue;
        };
        let value = &rest[1..];
        let Some(end) = value.find(quote) else {
            break;
        };
        out.push(decode_entities(&value[..end]).trim().to_string());
        rest = &value[end..];
    }
    out
}

/// 收集文章内容里所有下载链接（k2s 系列与 MEGA），同一个链接只留一个。
pub fn extract_download_links(html: &str) -> Vec<String> {
    let mut links: Vec<String> = Vec::new();
    for href in hrefs(html) {
        if is_download_link(&href) && !links.contains(&href) {
            links.push(href);
        }
    }
    links
}

/// 从文章里的 Steam、Getchu、DLsite 链接取出作品 ID，同一个 ID 只留一个。
pub fn extract_external_ids(html: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    for href in hrefs(html) {
        if let Some(id) = external_id_from_href(&href)
            && !ids.contains(&id)
        {
            ids.push(id);
        }
    }
    ids
}

fn external_id_from_href(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    let host = url.host_str()?.to_ascii_lowercase();

    if host == "store.steampowered.com" {
        let mut segments = url.path_segments()?;
        if segments.next()? != "app" {
            return None;
        }
        let id = segments.next()?;
        return all_digits(id).then(|| format!("steam:{id}"));
    }
    if host == "getchu.com" || host.ends_with(".getchu.com") {
        let id = url
            .query_pairs()
            .find(|(key, _)| key == "id")
            .map(|(_, value)| value.into_owned())?;
        return all_digits(&id).then(|| format!("getchu:{id}"));
    }
    if host == "dlsite.com" || host.ends_with(".dlsite.com") {
        // .../work/=/product_id/RJ01664642.html
        let segments: Vec<&str> = url.path_segments()?.collect();
        let at = segments.iter().position(|segment| *segment == "product_id")?;
        let raw = segments.get(at + 1)?.trim_end_matches(".html");
        let raw = raw.to_ascii_uppercase();
        let digits = raw.strip_prefix("RJ").or_else(|| raw.strip_prefix("VJ"))?;
        return ((6..=8).contains(&digits.len()) && all_digits(digits))
            .then(|| format!("dlsite:{raw}"));
    }
    None
}

fn all_digits(text: &str) -> bool {
    !text.is_empty() && text.chars().all(|ch| ch.is_ascii_digit())
}

fn is_download_link(href: &str) -> bool {
    url::Url::parse(href)
        .ok()
        .and_then(|url| url.host_str().map(str::to_ascii_lowercase))
        .is_some_and(|host| {
            FILE_HOSTS.contains(&host.as_str()) || MEGA_HOSTS.contains(&host.as_str())
        })
}

/// 从下载链接取出 k2s 系列的文件名（去掉扩展名，同名只留一个）。
///
/// 去扩展名的规则与前端 `archiveStem` 一致：云端扫描的名称来自上传时转成 zip 的压缩包，
/// 名称部分与原始文件名相同。
pub fn file_names_from_links(links: &[String]) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for name in links.iter().filter_map(|link| file_name_from_href(link)) {
        if !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

#[cfg(test)]
fn extract_file_names(html: &str) -> Vec<String> {
    file_names_from_links(&extract_download_links(html))
}

fn file_name_from_href(href: &str) -> Option<String> {
    let url = url::Url::parse(href).ok()?;
    if !FILE_HOSTS.contains(&url.host_str()?.to_ascii_lowercase().as_str()) {
        return None;
    }
    let mut segments = url.path_segments()?;
    if segments.next()? != "file" {
        return None;
    }
    segments.next()?; // 文件 ID
    let raw = segments.collect::<Vec<_>>().join("/");
    let stem = archive_stem(percent_decode(&raw).trim());
    (!stem.is_empty()).then_some(stem)
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        let hex = bytes
            .get(index + 1..index + 3)
            .filter(|_| bytes[index] == b'%')
            .and_then(|pair| std::str::from_utf8(pair).ok())
            .and_then(|pair| u8::from_str_radix(pair, 16).ok());
        match hex {
            Some(byte) => {
                out.push(byte);
                index += 3;
            }
            None => {
                out.push(bytes[index]);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn archive_stem(file_name: &str) -> String {
    let lower = file_name.to_lowercase();
    let mut end = file_name.len();
    for ext in [".zip", ".rar", ".7z"] {
        if lower.ends_with(ext) {
            end -= ext.len();
            break;
        }
    }
    let mut stem = &file_name[..end];
    // 分卷：Foo.part1 / Foo.001
    if let Some(dot) = stem.rfind('.') {
        let suffix = stem[dot + 1..].to_lowercase();
        let is_part = suffix
            .strip_prefix("part")
            .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
            || (suffix.len() == 3 && suffix.chars().all(|c| c.is_ascii_digit()));
        if is_part {
            stem = &stem[..dot];
        }
    }
    stem.trim().to_string()
}

/// 搜索用的正规化：全角 ASCII 转半角、转小写、空白合并。
/// 只用来缩小候选范围，最终的精确判断由前端的 NFKC 比对负责。
pub fn fold(text: &str) -> String {
    let mapped: String = text
        .chars()
        .map(|ch| match ch {
            '\u{3000}' => ' ',
            '\u{FF01}'..='\u{FF5E}' => char::from_u32(ch as u32 - 0xFEE0).unwrap_or(ch),
            _ => ch,
        })
        .flat_map(char::to_lowercase)
        .collect();
    mapped.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 解码标题里的常见实体() {
        assert_eq!(
            decode_entities("脫衣麻將 &#8211; A &amp; B &#x2019;s &quot;x&quot;"),
            "脫衣麻將 – A & B ’s \"x\""
        );
        assert_eq!(decode_entities("AT&T 与 a&b;c"), "AT&T 与 a&b;c");
    }

    #[test]
    fn 取出_k2s_文件名并去掉扩展名() {
        let html = r#"<a href="http://k2s.cc/file/623830e25e66a/ThornSin.rar">k2s</a>
            <a href="http://k2s.cc/file/36c2ebc647dc1/Stranded with You.rar">k2s</a>"#;
        assert_eq!(extract_file_names(html), ["ThornSin", "Stranded with You"]);
    }

    #[test]
    fn 百分号编码的文件名会解码() {
        let html = r#"<a href="https://k2s.cc/file/3557ebf7eb1f7/%E9%AD%94%E6%B3%95%E5%B0%91%E5%A5%B3%E3%82%AA%E3%83%91%E3%83%BC%E3%83%AB.rar">k2S</a>"#;
        assert_eq!(extract_file_names(html), ["魔法少女オパール"]);
    }

    #[test]
    fn 分卷去掉后缀且同名只留一个() {
        let html = r#"<a href="http://k2s.cc/file/a/Romantic Escapades.part1.rar">1</a>
            <a href="http://k2s.cc/file/b/Romantic Escapades.part2.rar">2</a>
            <a href="http://k2s.cc/file/c/Game.001">3</a>"#;
        assert_eq!(extract_file_names(html), ["Romantic Escapades", "Game"]);
    }

    #[test]
    fn mega_与其他链接不产生文件名() {
        let html = r#"<a href="https://mega.nz/file/pQ00nT5T#key">MEGA</a>
            <a href="https://store.steampowered.com/app/1/x/">Steam</a>
            <a href="https://evil.example/file/1/Fake.rar">x</a>
            <a href="http://k2s.cc/other/1/Nope.rar">x</a>"#;
        assert!(extract_file_names(html).is_empty());
    }

    #[test]
    fn 原始下载链接只收_k2s_与_mega_并保留原文() {
        let html = r#"<a href="https://store.steampowered.com/app/1/x/">Steam</a>
            <a href="http://k2s.cc/file/a/My Game.part1.rar">1</a>
            <a href="https://mega.nz/folder/LGgFkR4A#88Qa55zcktQB8JwiGqfL6w">MEGA</a>
            <a href="http://k2s.cc/file/a/My Game.part1.rar">重复</a>
            <a href="https://evil.example/file/1/Fake.rar">x</a>"#;
        assert_eq!(
            extract_download_links(html),
            [
                "http://k2s.cc/file/a/My Game.part1.rar",
                "https://mega.nz/folder/LGgFkR4A#88Qa55zcktQB8JwiGqfL6w",
            ]
        );
    }

    #[test]
    fn 取出_steam_getchu_dlsite_的作品_id() {
        let html = r#"<a href="https://store.steampowered.com/app/3329430/_/?l=schinese">Steam</a>
            <a href="https://www.getchu.com/soft.phtml?id=1065742&amp;gc=gc">Getchu</a>
            <a href="https://www.dlsite.com/maniax/work/=/product_id/rj01664642.html">DL</a>
            <a href="https://store.steampowered.com/app/3329430/Again/">重複</a>
            <a href="https://store.steampowered.com/agecheck/app/1/">不是作品页</a>
            <a href="https://www.getchu.com/soft.phtml?id=abc">坏 id</a>
            <a href="https://evil.example/app/9/">其他</a>"#;
        assert_eq!(
            extract_external_ids(html),
            ["steam:3329430", "getchu:1065742", "dlsite:RJ01664642"]
        );
    }

    #[test]
    fn 全角与大小写在正规化后相同() {
        assert_eq!(fold("ＮＴＲ　Ｅｘ  Ｇａｍｅ"), "ntr ex game");
        assert_eq!(fold("Stranded WITH You"), "stranded with you");
    }

    #[test]
    fn 文章整理出标题_封面与文件名() {
        let post: WpPost = serde_json::from_value(serde_json::json!({
            "id": 680535,
            "modified": "2026-09-27T17:38:59",
            "title": {"rendered": "與你流落荒島 官方中文 [420m]"},
            "content": {"rendered": "<a href=\"http://k2s.cc/file/1/Stranded with You.rar\">k2s</a>"},
            "_embedded": {"wp:featuredmedia": [{"source_url": "https://hgamefree.info/c.webp"}]}
        }))
        .unwrap();
        assert_eq!(
            post.parse(),
            ParsedPost {
                id: 680535,
                title: "與你流落荒島 官方中文 [420m]".into(),
                file_names: vec!["Stranded with You".into()],
                file_url: vec!["http://k2s.cc/file/1/Stranded with You.rar".into()],
                external_ids: vec![],
                image_url: Some("https://hgamefree.info/c.webp".into()),
                modified: "2026-09-27T17:38:59".into(),
            }
        );
    }

    #[test]
    fn 封面被删除时_embedded_是错误对象也不会失败() {
        let post: WpPost = serde_json::from_value(serde_json::json!({
            "id": 1,
            "title": {"rendered": "A"},
            "content": {"rendered": ""},
            "_embedded": {"wp:featuredmedia": [{"code": "rest_post_invalid_id"}]}
        }))
        .unwrap();
        assert_eq!(post.parse().image_url, None);
    }
}
