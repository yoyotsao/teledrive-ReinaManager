//! 服务器代为连线的外部来源。数值必须与 `src/metadata/api/rateLimit.ts`
//! 的 API_RATE_LIMIT_POLICIES 一致，host 必须与 `src/metadata/api/*.ts` 实际使用的一致。

#[derive(Debug)]
pub struct SourcePolicy {
    pub source: &'static str,
    pub hosts: &'static [&'static str],
    pub min_interval_ms: u64,
    pub max_429_retries: u32,
    pub default_backoff_ms: u64,
    pub max_backoff_ms: u64,
}

pub static SOURCE_POLICIES: &[SourcePolicy] = &[
    SourcePolicy {
        source: "vndb",
        hosts: &["api.vndb.org", "vndb.org"],
        min_interval_ms: 1600,
        max_429_retries: 2,
        default_backoff_ms: 30_000,
        max_backoff_ms: 300_000,
    },
    SourcePolicy {
        source: "bgm",
        hosts: &["api.bgm.tv", "bgm.tv"],
        min_interval_ms: 250,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
    SourcePolicy {
        source: "ymgal",
        hosts: &["www.ymgal.games"],
        min_interval_ms: 500,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
    SourcePolicy {
        source: "kun",
        hosts: &["www.kungal.com"],
        min_interval_ms: 500,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
    SourcePolicy {
        source: "dlsite",
        hosts: &["www.dlsite.com"],
        min_interval_ms: 2000,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
    SourcePolicy {
        source: "erogamescape",
        hosts: &["erogamescape.org"],
        min_interval_ms: 3000,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
    SourcePolicy {
        source: "hikarinagi",
        hosts: &["api.hikarinagi.org", "www.hikarinagi.org"],
        min_interval_ms: 500,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
    // Steam 商店 API 约每 5 分钟 200 次；1.5 秒一次留足余量，被限流就直接停止。
    SourcePolicy {
        source: "steam",
        hosts: &["store.steampowered.com"],
        min_interval_ms: 1500,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
    SourcePolicy {
        source: "hgamefree",
        hosts: &["hgamefree.info"],
        min_interval_ms: 500,
        max_429_retries: 0,
        default_backoff_ms: 0,
        max_backoff_ms: 0,
    },
];

/// 封面与候选预览图可以来自这些域名（含子域名）。
/// Kungal、Hikarinagi 的图床子域名目前未公开文档，因此以域名后缀放行。
pub static IMAGE_HOST_SUFFIXES: &[&str] = &[
    "bgm.tv",
    "vndb.org",
    "ymgal.games",
    "kungal.com",
    "hikarinagi.org",
    "dlsite.jp",
    "dlsite.com",
    "erogamescape.org",
    "hgamefree.info",
    "steamstatic.com",
];

/// 桌面版在 `src-tauri/src/game/cover/cloud.rs` 对 Bangumi/VNDB 图床另有备援代理；服务器下载来源封面时沿用。
pub const BANGUMI_IMAGE_PROXY_PREFIX: &str = "https://imagesp.yurari.moe/bangumi/";
pub const VNDB_IMAGE_PROXY_PREFIX: &str = "https://imagesp.yurari.moe/vndb/";

pub fn policy_for_host(host: &str) -> Option<&'static SourcePolicy> {
    SOURCE_POLICIES
        .iter()
        .find(|policy| policy.hosts.contains(&host))
}

pub fn is_image_host(host: &str) -> bool {
    IMAGE_HOST_SUFFIXES
        .iter()
        .any(|suffix| host == *suffix || host.ends_with(&format!(".{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 依_host_找到来源与限速() {
        assert_eq!(policy_for_host("api.vndb.org").unwrap().source, "vndb");
        assert_eq!(policy_for_host("vndb.org").unwrap().source, "vndb");
        assert_eq!(policy_for_host("api.bgm.tv").unwrap().min_interval_ms, 250);
        assert_eq!(policy_for_host("bgm.tv").unwrap().source, "bgm");
        assert_eq!(
            policy_for_host("www.ymgal.games").unwrap().min_interval_ms,
            500
        );
        assert_eq!(policy_for_host("www.kungal.com").unwrap().source, "kun");
        assert_eq!(
            policy_for_host("www.dlsite.com").unwrap().min_interval_ms,
            2000
        );
        assert_eq!(
            policy_for_host("erogamescape.org").unwrap().min_interval_ms,
            3000
        );
        assert_eq!(
            policy_for_host("api.hikarinagi.org").unwrap().source,
            "hikarinagi"
        );
        assert_eq!(
            policy_for_host("www.hikarinagi.org").unwrap().source,
            "hikarinagi"
        );
        assert_eq!(policy_for_host("hgamefree.info").unwrap().source, "hgamefree");
        let steam = policy_for_host("store.steampowered.com").unwrap();
        assert_eq!((steam.source, steam.min_interval_ms), ("steam", 1500));
        assert!(policy_for_host("evil.example.com").is_none());
        assert!(policy_for_host("vndb.org.evil.com").is_none());
    }

    #[test]
    fn 只有_vndb_允许_429_重试() {
        let vndb = policy_for_host("api.vndb.org").unwrap();
        assert_eq!(vndb.max_429_retries, 2);
        assert_eq!(vndb.default_backoff_ms, 30_000);
        assert_eq!(vndb.max_backoff_ms, 300_000);
        for source in [
            "bgm",
            "ymgal",
            "kun",
            "dlsite",
            "erogamescape",
            "hikarinagi",
        ] {
            let policy = SOURCE_POLICIES.iter().find(|p| p.source == source).unwrap();
            assert_eq!(policy.max_429_retries, 0, "{source}");
        }
    }

    #[test]
    fn 图床_host_以后缀比对() {
        for host in [
            "lain.bgm.tv",
            "t.vndb.org",
            "cdn.ymgal.games",
            "img.dlsite.jp",
            "www.dlsite.com",
            "erogamescape.org",
            "img.kungal.com",
            "cdn.hikarinagi.org",
        ] {
            assert!(is_image_host(host), "{host}");
        }
        for host in [
            "bgm.tv.evil.com",
            "evilvndb.org",
            "localhost",
            "127.0.0.1",
            "example.com",
        ] {
            assert!(!is_image_host(host), "{host}");
        }
    }
}
