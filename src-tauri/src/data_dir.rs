use std::path::{Path, PathBuf};

pub fn root() -> PathBuf {
    root_in(&dirs::home_dir().expect("Cannot locate user home directory"))
}

fn root_in(home: &Path) -> PathBuf {
    home.join(".pix")
}

pub fn initialize() -> Result<(), std::io::Error> {
    let root = root();
    std::fs::create_dir_all(root)?;
    Ok(())
}

/// 无项目会话的默认工作目录：PiX 数据目录下的 workspace。
pub fn default_projectless_dir() -> PathBuf {
    resolve_projectless_dir(None)
}

/// 解析无项目会话的工作目录：未配置（或配置为空）时落在 `~/.pix/workspace`，
/// 支持 `~` 前缀；其余值按用户输入的原样路径使用。
pub fn resolve_projectless_dir(configured: Option<&str>) -> PathBuf {
    projectless_dir_in(configured, &dirs::home_dir().expect("Cannot locate user home directory"))
}

fn projectless_dir_in(configured: Option<&str>, home: &Path) -> PathBuf {
    match configured.map(str::trim).filter(|value| !value.is_empty()) {
        None => root_in(home).join("workspace"),
        Some("~") => home.to_path_buf(),
        Some(value) => match value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
            Some(rest) => home.join(rest),
            None => PathBuf::from(value),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projectless_dir_defaults_under_pix_data_dir() {
        let home = Path::new("/home/test");
        assert_eq!(projectless_dir_in(None, home), PathBuf::from("/home/test/.pix/workspace"));
        // 空值与纯空白等价于未配置，不能把 cwd 解析成当前目录。
        assert_eq!(projectless_dir_in(Some(""), home), PathBuf::from("/home/test/.pix/workspace"));
        assert_eq!(projectless_dir_in(Some("   "), home), PathBuf::from("/home/test/.pix/workspace"));
    }

    #[test]
    fn projectless_dir_accepts_configured_and_tilde_paths() {
        let home = Path::new("/home/test");
        assert_eq!(projectless_dir_in(Some("/data/pix/scratch"), home), PathBuf::from("/data/pix/scratch"));
        assert_eq!(projectless_dir_in(Some("  /data/pix/scratch  "), home), PathBuf::from("/data/pix/scratch"));
        assert_eq!(projectless_dir_in(Some("~"), home), PathBuf::from("/home/test"));
        assert_eq!(projectless_dir_in(Some("~/scratch"), home), PathBuf::from("/home/test/scratch"));
        assert_eq!(projectless_dir_in(Some("~\\scratch"), home), PathBuf::from("/home/test/scratch"));
        // 非 ~ 前缀的波浪号按普通字符处理。
        assert_eq!(projectless_dir_in(Some("~other/scratch"), home), PathBuf::from("~other/scratch"));
    }
}
