//! 从环境变量读取服务器设定。

use std::fmt;
use std::path::PathBuf;

/// 服务器设定；密钥只存在内存，调试输出一律遮蔽
#[derive(Clone)]
pub struct Config {
    pub jwt_secret: String,
    pub owner_id: i64,
    pub teledrive_api: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub static_dir: PathBuf,
    /// 测试用：把指定的上游 host 导向本机假服务器。正式环境永远是空的，不从环境变量读取。
    pub upstream_overrides: std::collections::HashMap<String, std::net::SocketAddr>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ConfigError(pub String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// 以查询函数建立设定，测试时不必修改进程的环境变量
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // 选填字段去除前后空白，空字符串视为未设定
        let optional = |key: &str| {
            lookup(key)
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty())
        };

        // JWT_SECRET 必须和 TeleDrive backend 完全相同，所以不 trim
        let jwt_secret = lookup("JWT_SECRET")
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConfigError("缺少 JWT_SECRET".to_string()))?;

        let owner_id = optional("REINA_OWNER_ID")
            .ok_or_else(|| ConfigError("缺少 REINA_OWNER_ID".to_string()))?
            .parse::<i64>()
            .map_err(|_| ConfigError("REINA_OWNER_ID 必须是整数".to_string()))?;

        let port = match optional("REINA_PORT") {
            Some(value) => value
                .parse::<u16>()
                .map_err(|_| ConfigError("REINA_PORT 必须是 1–65535 的整数".to_string()))?,
            None => 8787,
        };

        let teledrive_api = optional("TELEDRIVE_API")
            .unwrap_or_else(|| "http://backend:8000".to_string())
            .trim_end_matches('/')
            .to_string();

        Ok(Self {
            jwt_secret,
            owner_id,
            teledrive_api,
            port,
            data_dir: optional("REINA_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/data")),
            static_dir: optional("REINA_STATIC_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/app/static")),
            upstream_overrides: std::collections::HashMap::new(),
        })
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("reina_manager.db")
    }

    /// 单元测试与集成测试共用的固定设定；目录由调用端覆写。
    /// 之后的任务新增字段时（任务 8 的 upstream_overrides、任务 9 的 game_folder），
    /// 必须同时在这里给测试用的值，tests/support.rs 以 `..Config::for_tests()` 构建，不需跟着改。
    #[doc(hidden)]
    pub fn for_tests() -> Self {
        Self {
            jwt_secret: "reina-test-secret".to_string(),
            owner_id: 42,
            // 测试不会连到 TeleDrive；给一个不会有服务的地址，需要时由测试覆写
            teledrive_api: "http://127.0.0.1:9".to_string(),
            port: 0,
            data_dir: PathBuf::from("/nonexistent/reina-data"),
            static_dir: PathBuf::from("/nonexistent/reina-static"),
            upstream_overrides: std::collections::HashMap::new(),
        }
    }
}

impl fmt::Debug for Config {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Config")
            .field("jwt_secret", &"<redacted>")
            .field("owner_id", &self.owner_id)
            .field("teledrive_api", &self.teledrive_api)
            .field("port", &self.port)
            .field("data_dir", &self.data_dir)
            .field("static_dir", &self.static_dir)
            .field("upstream_overrides", &self.upstream_overrides)
            .finish()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |key| map.get(key).cloned()
    }

    #[test]
    fn 必填字段齐全时套用预设值() {
        let config = Config::from_lookup(lookup(&[
            ("JWT_SECRET", "s3cret"),
            ("REINA_OWNER_ID", "42"),
        ]))
        .unwrap();
        assert_eq!(config.jwt_secret, "s3cret");
        assert_eq!(config.owner_id, 42);
        assert_eq!(config.teledrive_api, "http://backend:8000");
        assert_eq!(config.port, 8787);
        assert_eq!(config.data_dir, PathBuf::from("/data"));
        assert_eq!(config.static_dir, PathBuf::from("/app/static"));
        assert_eq!(
            config.db_path(),
            PathBuf::from("/data").join("reina_manager.db")
        );
        assert!(config.upstream_overrides.is_empty());
    }

    #[test]
    fn 可覆写选填字段并去掉网址结尾斜线() {
        let config = Config::from_lookup(lookup(&[
            ("JWT_SECRET", "s3cret"),
            ("REINA_OWNER_ID", "7"),
            ("TELEDRIVE_API", "http://backend:8000/"),
            ("REINA_PORT", "9000"),
            ("REINA_DATA_DIR", "/tmp/reina"),
            ("REINA_STATIC_DIR", "/tmp/static"),
        ]))
        .unwrap();
        assert_eq!(config.teledrive_api, "http://backend:8000");
        assert_eq!(config.port, 9000);
        assert_eq!(config.data_dir, PathBuf::from("/tmp/reina"));
        assert_eq!(config.static_dir, PathBuf::from("/tmp/static"));
    }

    #[test]
    fn 缺少密钥或拥有者时启动失败() {
        assert!(Config::from_lookup(lookup(&[("REINA_OWNER_ID", "1")])).is_err());
        assert!(Config::from_lookup(lookup(&[("JWT_SECRET", "")])).is_err());
        assert!(Config::from_lookup(lookup(&[("JWT_SECRET", "s")])).is_err());
        assert!(
            Config::from_lookup(lookup(&[("JWT_SECRET", "s"), ("REINA_OWNER_ID", "abc")])).is_err()
        );
        assert!(
            Config::from_lookup(lookup(&[
                ("JWT_SECRET", "s"),
                ("REINA_OWNER_ID", "1"),
                ("REINA_PORT", "99999"),
            ]))
            .is_err()
        );
    }

    #[test]
    fn 密钥原样保留而且调试输出不含密钥() {
        let config = Config::from_lookup(lookup(&[
            ("JWT_SECRET", " spaced secret "),
            ("REINA_OWNER_ID", "1"),
        ]))
        .unwrap();
        // TeleDrive 端不会 trim 密钥，这里也不能 trim，否则签名会对不上
        assert_eq!(config.jwt_secret, " spaced secret ");
        assert!(!format!("{config:?}").contains("spaced secret"));
    }

    #[test]
    fn 测试用设定使用固定的密钥与拥有者() {
        // tests/support.rs 的 SECRET、OWNER_ID 必须与这里一致
        let config = Config::for_tests();
        assert_eq!(config.jwt_secret, "reina-test-secret");
        assert_eq!(config.owner_id, 42);
        assert_eq!(config.teledrive_api, "http://127.0.0.1:9");
        assert_eq!(config.port, 0);
    }
}
