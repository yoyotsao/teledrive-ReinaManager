//! 依文件头判断图片格式。只接受浏览器能显示的常见格式，
//! 不依赖 `image` crate 的解码功能（项目只开了 png feature）。

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageKind {
    Jpeg,
    Png,
    Gif,
    Webp,
    Bmp,
    Avif,
}

impl ImageKind {
    pub fn ext(self) -> &'static str {
        match self {
            Self::Jpeg => "jpg",
            Self::Png => "png",
            Self::Gif => "gif",
            Self::Webp => "webp",
            Self::Bmp => "bmp",
            Self::Avif => "avif",
        }
    }

    pub fn mime(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
            Self::Gif => "image/gif",
            Self::Webp => "image/webp",
            Self::Bmp => "image/bmp",
            Self::Avif => "image/avif",
        }
    }

    pub fn from_ext(ext: &str) -> Option<Self> {
        match ext {
            "jpg" => Some(Self::Jpeg),
            "png" => Some(Self::Png),
            "gif" => Some(Self::Gif),
            "webp" => Some(Self::Webp),
            "bmp" => Some(Self::Bmp),
            "avif" => Some(Self::Avif),
            _ => None,
        }
    }
}

pub fn sniff(bytes: &[u8]) -> Option<ImageKind> {
    // 各格式的魔数长度不同（JPEG 只需 3 字节，PNG 需要完整的 8 字节签名），
    // 不能用统一的最短长度拦在最前面；`starts_with` 本身在 bytes 比魔数短时会安全返回 false。
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(ImageKind::Jpeg);
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some(ImageKind::Png);
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some(ImageKind::Gif);
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some(ImageKind::Webp);
    }
    if bytes.starts_with(b"BM") {
        return Some(ImageKind::Bmp);
    }
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" && matches!(&bytes[8..12], b"avif" | b"avis") {
        return Some(ImageKind::Avif);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 认得常见格式() {
        assert_eq!(
            sniff(&[0xFF, 0xD8, 0xFF, 0xE0, 0, 0]),
            Some(ImageKind::Jpeg)
        );
        assert_eq!(sniff(b"\x89PNG\r\n\x1a\n0000"), Some(ImageKind::Png));
        assert_eq!(sniff(b"GIF89a000000"), Some(ImageKind::Gif));
        assert_eq!(
            sniff(b"RIFF\x10\x00\x00\x00WEBPVP8 "),
            Some(ImageKind::Webp)
        );
        assert_eq!(sniff(b"BM\x00\x00\x00\x00\x00\x00"), Some(ImageKind::Bmp));
        assert_eq!(
            sniff(b"\x00\x00\x00\x1cftypavif0000"),
            Some(ImageKind::Avif)
        );
    }

    #[test]
    fn 拒绝非图片与过短内容() {
        assert_eq!(sniff(b"<html>not an image</html>"), None);
        assert_eq!(sniff(b"RIFF\x10\x00\x00\x00WAVEfmt "), None);
        assert_eq!(sniff(&[0xFF, 0xD8]), None);
        assert_eq!(sniff(&[]), None);
    }

    #[test]
    fn 扩展名与_mime_对应() {
        assert_eq!(ImageKind::Jpeg.ext(), "jpg");
        assert_eq!(ImageKind::Webp.mime(), "image/webp");
        assert_eq!(ImageKind::from_ext("png"), Some(ImageKind::Png));
        assert_eq!(ImageKind::from_ext("exe"), None);
    }
}
