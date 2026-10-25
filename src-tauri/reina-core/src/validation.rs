//! 与平台无关的路径与文件名校验，桌面版与服务器共用。

use std::path::{Component, Path, PathBuf};

/// 清洗并校验游戏安装根目录，确保任务和默认设置使用相同规则。
pub fn normalize_install_root_path(value: &str) -> Result<PathBuf, String> {
    reina_path::resolve_user_path(value).map_err(|error| error.to_string())
}

/// 校验用户配置路径，但保留尚未在当前机器定义的变量表达式。
pub fn validate_configured_user_path(value: &str) -> Result<(), String> {
    match reina_path::resolve_user_path(value) {
        Ok(_) | Err(reina_path::PathResolveError::UndefinedVariable(_)) => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

/// 校验跨协议、压缩包和数据库共用的安全相对文件路径。
pub fn validate_safe_relative_path(value: &str) -> Result<(), String> {
    if value.is_empty() || value.contains('\0') || value.starts_with(['/', '\\']) {
        return Err("路径必须是安全相对路径".to_string());
    }
    let normalized = value.replace('\\', "/");
    if normalized
        .split('/')
        .any(|part| part.is_empty() || matches!(part, "." | "..") || part.contains(':'))
    {
        return Err("路径包含不安全组件".to_string());
    }
    if Path::new(&normalized)
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("路径包含不安全组件".to_string());
    }
    Ok(())
}

/// 校验游戏启动程序字段，只允许保存单个文件名。
pub fn validate_executable_name(value: &str) -> Result<(), String> {
    let mut components = Path::new(value).components();
    let is_single_file_name = matches!(components.next(), Some(Component::Normal(_)))
        && components.next().is_none()
        && !value.contains(['/', '\\']);
    if !is_single_file_name {
        return Err("executable 必须是单个文件名，不能包含路径".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_install_root_path, validate_configured_user_path, validate_executable_name,
        validate_safe_relative_path,
    };
    use std::path::PathBuf;

    #[test]
    fn install_root_path_must_be_absolute() {
        assert!(normalize_install_root_path("games").is_err());
        assert!(normalize_install_root_path("   ").is_err());
    }

    #[test]
    fn install_root_path_is_trimmed_and_normalized() {
        #[cfg(windows)]
        let root = r"C:\Games";
        #[cfg(not(windows))]
        let root = "/games";

        assert_eq!(
            normalize_install_root_path(&format!("  {root}/.  ")),
            Ok(PathBuf::from(root))
        );
    }

    #[test]
    fn safe_relative_path_rejects_escapes_and_drive_letters() {
        assert!(validate_safe_relative_path("01000250/haison.exe").is_ok());
        assert!(validate_safe_relative_path(r"01000250\haison.exe").is_ok());
        for bad in [
            "",
            "/abs.exe",
            r"\abs.exe",
            "../x.exe",
            "a/../x.exe",
            "a//x.exe",
            r"C:\x.exe",
            "a/./x",
        ] {
            assert!(validate_safe_relative_path(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn executable_name_must_be_single_file() {
        assert!(validate_executable_name("game.exe").is_ok());
        assert!(validate_executable_name("dir/game.exe").is_err());
        assert!(validate_executable_name(r"dir\game.exe").is_err());
    }

    #[test]
    fn configured_path_allows_undefined_variable() {
        #[cfg(windows)]
        let path = r"%REINA_TEST_UNDEFINED%\Games";
        #[cfg(not(windows))]
        let path = "$REINA_TEST_UNDEFINED/Games";

        assert!(validate_configured_user_path(path).is_ok());
    }

    #[test]
    fn configured_path_rejects_relative_path() {
        assert!(validate_configured_user_path("games").is_err());
    }
}
