//! 验证服务器要代为连线的网址：只允许 http(s)、白名单 host、公开 IP。
//! DNS 解析结果会被固定下来交给 client，避免“验证时是公开 IP、连线时变成内网”的 DNS rebinding。

use std::net::{IpAddr, SocketAddr};

use url::Url;

use crate::config::Config;
use crate::upstream::policy::{SourcePolicy, is_image_host, policy_for_host};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostRule {
    /// 中继资料 API：host 必须在 SOURCE_POLICIES。
    MetadataApi,
    /// 图片：host 必须符合 IMAGE_HOST_SUFFIXES，或是桌面版使用的 yurari 备援代理。
    Image,
}

#[derive(Debug, thiserror::Error)]
pub enum UpstreamError {
    #[error("forbidden upstream: {0}")]
    Forbidden(String),
    #[error("upstream unreachable: {0}")]
    Unreachable(String),
    #[error("upstream response too large")]
    TooLarge,
}

#[derive(Debug, Clone)]
pub struct Target {
    /// 实际送出的网址（测试覆写时会变成 http://127.0.0.1:port/...）
    pub request_url: Url,
    /// 原本的 host，用来比对白名单与转址
    pub host: String,
    pub policy: Option<&'static SourcePolicy>,
    /// 固定的解析结果；None 代表测试覆写，直接连 request_url
    pub pinned: Option<Vec<SocketAddr>>,
}

pub fn is_public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_multicast()
                || v4.is_documentation()
                || a == 0
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_public_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            !(v6.is_loopback()
                || v6.is_unspecified()
                || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

fn host_allowed(host: &str, rule: HostRule) -> bool {
    match rule {
        HostRule::MetadataApi => policy_for_host(host).is_some(),
        HostRule::Image => is_image_host(host) || host == "imagesp.yurari.moe",
    }
}

pub async fn resolve_target(
    raw: &str,
    config: &Config,
    rule: HostRule,
) -> Result<Target, UpstreamError> {
    let url = Url::parse(raw).map_err(|_| UpstreamError::Forbidden("invalid url".into()))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(UpstreamError::Forbidden("scheme".into()));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(UpstreamError::Forbidden("credentials in url".into()));
    }
    let host = url
        .host_str()
        .ok_or_else(|| UpstreamError::Forbidden("host".into()))?
        .to_ascii_lowercase();
    if host.parse::<IpAddr>().is_ok() || !host_allowed(&host, rule) {
        return Err(UpstreamError::Forbidden(host));
    }
    let policy = policy_for_host(&host);

    if let Some(addr) = config.upstream_overrides.get(&host) {
        let mut request_url = url.clone();
        request_url
            .set_scheme("http")
            .map_err(|_| UpstreamError::Forbidden("scheme".into()))?;
        request_url
            .set_host(Some(&addr.ip().to_string()))
            .map_err(|_| UpstreamError::Forbidden("host".into()))?;
        request_url
            .set_port(Some(addr.port()))
            .map_err(|_| UpstreamError::Forbidden("port".into()))?;
        return Ok(Target {
            request_url,
            host,
            policy,
            pinned: None,
        });
    }

    let port = url.port_or_known_default().unwrap_or(443);
    let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|error| UpstreamError::Unreachable(error.to_string()))?
        .collect();
    if addrs.is_empty() || addrs.iter().any(|addr| !is_public_ip(addr.ip())) {
        return Err(UpstreamError::Forbidden(format!(
            "{host} resolves to a non-public address"
        )));
    }
    Ok(Target {
        request_url: url,
        host,
        policy,
        pinned: Some(addrs),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::IpAddr;

    #[test]
    fn 私有与保留地址都算不公开() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.1.1",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(!is_public_ip(ip), "{ip}");
        }
        for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip: IpAddr = ip.parse().unwrap();
            assert!(is_public_ip(ip), "{ip}");
        }
    }

    #[tokio::test]
    async fn 拒绝非_http_与不在白名单的_host() {
        let config = crate::config::Config::for_tests();
        assert!(matches!(
            resolve_target("file:///etc/passwd", &config, HostRule::MetadataApi).await,
            Err(UpstreamError::Forbidden(_))
        ));
        assert!(matches!(
            resolve_target("https://example.com/", &config, HostRule::MetadataApi).await,
            Err(UpstreamError::Forbidden(_))
        ));
        assert!(matches!(
            resolve_target("https://127.0.0.1/", &config, HostRule::Image).await,
            Err(UpstreamError::Forbidden(_))
        ));
        assert!(matches!(
            resolve_target(
                "https://user:pw@api.vndb.org/kana",
                &config,
                HostRule::MetadataApi
            )
            .await,
            Err(UpstreamError::Forbidden(_))
        ));
    }

    #[tokio::test]
    async fn 测试覆写会改写到本机且保留路径与查询() {
        let mut config = crate::config::Config::for_tests();
        config
            .upstream_overrides
            .insert("api.vndb.org".into(), "127.0.0.1:40001".parse().unwrap());
        let target = resolve_target(
            "https://api.vndb.org/kana/vn?x=1",
            &config,
            HostRule::MetadataApi,
        )
        .await
        .unwrap();
        assert_eq!(
            target.request_url.as_str(),
            "http://127.0.0.1:40001/kana/vn?x=1"
        );
        assert_eq!(target.host, "api.vndb.org");
        assert_eq!(target.policy.unwrap().source, "vndb");
    }
}
