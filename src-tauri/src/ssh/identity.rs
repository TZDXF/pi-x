//! SSH 远程项目身份模型：展示 URI 与内部身份键的构造、解析与归一化（契约 §1）。
//!
//! 两种标识：
//! - 展示 URI：`ssh://[user@]host[:port]/abs/posix/path`
//! - 内部身份键：`remote:ssh:<host>:<port>:<user>:<posixPath>`
//!
//! 禁止在模块外手拼这两种字符串，一律经由本模块的构造/解析函数。

/// 展示 URI 前缀（小写字面量）。
pub const SSH_URI_PREFIX: &str = "ssh://";
/// 内部身份键前缀。
pub const IDENTITY_KEY_PREFIX: &str = "remote:ssh:";
/// 缺省 SSH 端口。
pub const DEFAULT_PORT: u16 = 22;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshTarget {
    /// 归一化小写。
    pub host: String,
    /// 1–65535，缺省 22。
    pub port: u16,
    /// `None` 表示缺省用户。
    pub user: Option<String>,
    /// 归一化后的绝对 POSIX 路径。
    pub path: String,
}

/// 是否以 `ssh://` 开头（仅前缀判断，不做完整校验）。
pub fn is_ssh_uri(value: &str) -> bool {
    value.starts_with(SSH_URI_PREFIX)
}

/// 解析展示 URI；非法或非 `ssh://` 返回 `None`。
pub fn parse_ssh_uri(uri: &str) -> Option<SshTarget> {
    let rest = uri.strip_prefix(SSH_URI_PREFIX)?;
    // 必须带路径：`ssh://host`（无 `/`）不是远程项目。
    let slash = rest.find('/')?;
    let authority = &rest[..slash];
    let raw_path = &rest[slash..];

    let (user, hostport) = match authority.split_once('@') {
        Some((user, hostport)) => {
            if !is_valid_user(user) {
                return None;
            }
            (Some(user.to_string()), hostport)
        }
        None => (None, authority),
    };

    let (raw_host, port) = match hostport.rsplit_once(':') {
        Some((host, port)) => {
            // host 不得含 `:`：P1 不支持 IPv6 字面量。
            if host.contains(':') || host.is_empty() {
                return None;
            }
            (host, parse_port(port)?)
        }
        None => (hostport, DEFAULT_PORT),
    };

    let host = normalize_host(raw_host).ok()?;
    let path = normalize_ssh_path(raw_path).ok()?;
    Some(SshTarget {
        host,
        port,
        user,
        path,
    })
}

/// 重建展示 URI；path 用归一化后的值，host 归一化小写。
/// `port == 22 && user == None` 时省略端口与用户段。
pub fn build_ssh_uri(target: &SshTarget) -> Result<String, String> {
    let host = normalize_host(&target.host)?;
    require_port(target.port)?;
    let user = match &target.user {
        Some(user) => {
            validate_user(user)?;
            Some(user.as_str())
        }
        None => None,
    };
    let path = normalize_ssh_path(&target.path)?;
    Ok(match (user, target.port == DEFAULT_PORT) {
        (None, true) => format!("{SSH_URI_PREFIX}{host}{path}"),
        (Some(user), true) => format!("{SSH_URI_PREFIX}{user}@{host}{path}"),
        (None, false) => format!("{SSH_URI_PREFIX}{host}:{}{path}", target.port),
        (Some(user), false) => format!("{SSH_URI_PREFIX}{user}@{host}:{}{path}", target.port),
    })
}

/// 构造内部身份键：`remote:ssh:<host>:<port>:<user>:<path>`。
/// user 为 `None` 时写空串；host/user/path 任一含 `:` 时报错。
pub fn identity_key(target: &SshTarget) -> Result<String, String> {
    let host = normalize_host(&target.host)?;
    require_port(target.port)?;
    let user = match &target.user {
        Some(user) => {
            validate_user(user)?;
            user.as_str()
        }
        None => "",
    };
    let path = normalize_ssh_path(&target.path)?;
    Ok(format!("{IDENTITY_KEY_PREFIX}{host}:{}:{user}:{path}", target.port))
}

/// 解析内部身份键；user 字段为空串还原为 `None`。
/// path 必须已是归一化形式（否则拒绝，防止身份键被手拼绕过归一化）。
pub fn parse_identity_key(key: &str) -> Option<SshTarget> {
    let rest = key.strip_prefix(IDENTITY_KEY_PREFIX)?;
    // path 不允许含 `:`，因此整键恰为 4 段。
    let parts: Vec<&str> = rest.split(':').collect();
    let [host, port, user, path] = parts.as_slice() else {
        return None;
    };
    let host = normalize_host(host).ok()?;
    let port = parse_port(port)?;
    let user = if user.is_empty() {
        None
    } else if is_valid_user(user) {
        Some((*user).to_string())
    } else {
        return None;
    };
    // 身份键中的 path 必须已是归一化形式：再次归一化结果必须与原值一致。
    if normalize_ssh_path(path).ok().as_deref() != Some(*path) {
        return None;
    }
    Some(SshTarget {
        host,
        port,
        user,
        path: (*path).to_string(),
    })
}

/// 仅路径归一化：`\` → `/`、折叠连续 `/`、删除 `.` 空段、去尾部 `/`（根保留）。
/// 相对路径、含 `..`、含 `:` 或控制字符（`\n` `\r` `\t` `\0` 等）返回 `Err`。
pub fn normalize_ssh_path(path: &str) -> Result<String, String> {
    if path.chars().any(|c| matches!(c, '\n' | '\r' | '\t' | '\0') || c.is_control()) {
        return Err(format!("路径含控制字符: {path:?}"));
    }
    let slashed = path.replace('\\', "/");
    if !slashed.starts_with('/') {
        return Err(format!("路径必须是 / 开头的绝对 POSIX 路径: {path:?}"));
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in slashed.split('/') {
        match segment {
            "" | "." => {}
            ".." => return Err(format!("路径不允许包含 '..': {path:?}")),
            s if s.contains(':') => return Err(format!("路径不允许包含 ':': {path:?}")),
            s => segments.push(s),
        }
    }
    if segments.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(format!("/{}", segments.join("/")))
    }
}

/// 校验并归一化 host：非空、不含 `:` `/` `@`、无空白与控制字符，转小写。
pub fn normalize_host(host: &str) -> Result<String, String> {
    if host.is_empty() {
        return Err("host 不能为空".to_string());
    }
    if let Some(bad) = host
        .chars()
        .find(|c| matches!(c, ':' | '/' | '@') || c.is_whitespace() || c.is_control())
    {
        return Err(format!("host 含非法字符 {bad:?}: {host:?}"));
    }
    Ok(host.to_lowercase())
}

/// 校验 user：非空，仅允许字母、数字、`.`、`_`、`-`（大小写保留）。
pub fn validate_user(user: &str) -> Result<(), String> {
    if is_valid_user(user) {
        Ok(())
    } else {
        Err(format!("user 为空或含非法字符: {user:?}"))
    }
}

fn is_valid_user(user: &str) -> bool {
    !user.is_empty()
        && user
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn parse_port(raw: &str) -> Option<u16> {
    if raw.is_empty() || !raw.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    raw.parse::<u16>().ok().filter(|port| (1..=65535).contains(port))
}

fn require_port(port: u16) -> Result<(), String> {
    if (1..=65535).contains(&port) {
        Ok(())
    } else {
        Err(format!("port 必须在 1-65535 之间: {port}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 契约 §1.5 测试用例表（Rust 侧）。

    #[test]
    fn case1_parses_full_uri_and_round_trips() {
        let target = parse_ssh_uri("ssh://dev@host.example.com:2222/home/dev/proj").unwrap();
        assert_eq!(target.host, "host.example.com");
        assert_eq!(target.port, 2222);
        assert_eq!(target.user.as_deref(), Some("dev"));
        assert_eq!(target.path, "/home/dev/proj");
        assert_eq!(
            build_ssh_uri(&target).unwrap(),
            "ssh://dev@host.example.com:2222/home/dev/proj"
        );
        assert_eq!(
            identity_key(&target).unwrap(),
            "remote:ssh:host.example.com:2222:dev:/home/dev/proj"
        );
    }

    #[test]
    fn case2_lowercases_host_but_preserves_path_case() {
        let target = parse_ssh_uri("ssh://Host.Example.COM/Proj").unwrap();
        assert_eq!(target.host, "host.example.com");
        assert_eq!(target.port, 22);
        assert_eq!(target.user, None);
        assert_eq!(target.path, "/Proj");
        assert_eq!(
            identity_key(&target).unwrap(),
            "remote:ssh:host.example.com:22::/Proj"
        );
        assert_eq!(
            build_ssh_uri(&target).unwrap(),
            "ssh://host.example.com/Proj"
        );
        // 身份键中的空 user 字段应还原为 None。
        assert_eq!(
            parse_identity_key("remote:ssh:host.example.com:22::/Proj").unwrap(),
            target
        );
    }

    #[test]
    fn case3_collapses_trailing_slashes_and_backslashes() {
        let target = parse_ssh_uri("ssh://dev@host/a/b///").unwrap();
        assert_eq!(target.path, "/a/b");
        let root = parse_ssh_uri("ssh://dev@host/").unwrap();
        assert_eq!(root.path, "/");
        assert_eq!(normalize_ssh_path("\\home\\dev").unwrap(), "/home/dev");
    }

    #[test]
    fn case4_removes_dot_segments_and_rejects_dotdot() {
        let target = parse_ssh_uri("ssh://dev@host/./a/./b").unwrap();
        assert_eq!(target.path, "/a/b");
        assert!(parse_ssh_uri("ssh://dev@host/../etc").is_none());
    }

    #[test]
    fn case5_rejects_invalid_inputs() {
        for uri in [
            "ssh://host",
            "ssh:///path",
            "https://host/x",
            "C:/code",
            "/home/u",
            "ssh://host:70000/x",
            "ssh://@host/x",
            "ssh://host:99999/x",
        ] {
            assert!(parse_ssh_uri(uri).is_none(), "应拒绝 {uri:?}");
        }
    }

    #[test]
    fn case6_strips_leading_zero_port_and_rejects_colon_in_path() {
        let target = parse_ssh_uri("ssh://host:022/x").unwrap();
        assert_eq!(target.port, 22);
        assert!(parse_ssh_uri("ssh://Dev.Name@host/a:x").is_none());
        let named = parse_ssh_uri("ssh://Dev.Name@host/x").unwrap();
        assert_eq!(named.user.as_deref(), Some("Dev.Name"));
    }

    #[test]
    fn case7_identity_key_round_trips() {
        let targets = [
            SshTarget {
                host: "host".into(),
                port: 22,
                user: Some("dev".into()),
                path: "/a".into(),
            },
            SshTarget {
                host: "host.example.com".into(),
                port: 2200,
                user: None,
                path: "/home/u/proj".into(),
            },
            SshTarget {
                host: "10.0.0.1".into(),
                port: 65535,
                user: Some("root".into()),
                path: "/".into(),
            },
        ];
        for target in targets {
            let key = identity_key(&target).unwrap();
            assert_eq!(parse_identity_key(&key).unwrap(), target);
        }
        let parsed = parse_identity_key("remote:ssh:host:22:dev:/a").unwrap();
        assert_eq!(parsed.host, "host");
        assert_eq!(parsed.port, 22);
        assert_eq!(parsed.user.as_deref(), Some("dev"));
        assert_eq!(parsed.path, "/a");
        assert!(parse_identity_key("remote:ssh:host:22:dev:relative").is_none());
    }

    #[test]
    fn case8_non_ssh_values_are_not_remote() {
        assert!(!is_ssh_uri("C:/code"));
        assert!(!is_ssh_uri("/home/u"));
        assert!(!is_ssh_uri(""));
    }

    #[test]
    fn build_ssh_uri_variants() {
        let base = |port: u16, user: Option<&str>, path: &str| SshTarget {
            host: "host".into(),
            port,
            user: user.map(str::to_string),
            path: path.into(),
        };
        assert_eq!(build_ssh_uri(&base(22, None, "/a")).unwrap(), "ssh://host/a");
        assert_eq!(
            build_ssh_uri(&base(22, Some("dev"), "/a")).unwrap(),
            "ssh://dev@host/a"
        );
        assert_eq!(
            build_ssh_uri(&base(2222, None, "/a")).unwrap(),
            "ssh://host:2222/a"
        );
        assert_eq!(
            build_ssh_uri(&base(2222, Some("dev"), "/a")).unwrap(),
            "ssh://dev@host:2222/a"
        );
    }

    #[test]
    fn build_rejects_invalid_fields() {
        let invalid = |host: &str, port: u16, user: Option<&str>, path: &str| SshTarget {
            host: host.into(),
            port,
            user: user.map(str::to_string),
            path: path.into(),
        };
        assert!(build_ssh_uri(&invalid("", 22, None, "/a")).is_err());
        assert!(build_ssh_uri(&invalid("host", 0, None, "/a")).is_err());
        assert!(build_ssh_uri(&invalid("host", 22, Some("a b"), "/a")).is_err());
        assert!(build_ssh_uri(&invalid("host", 22, None, "relative")).is_err());
        assert!(build_ssh_uri(&invalid("host", 22, None, "/a:x")).is_err());
        // 身份键同样拒绝含 ':' 的字段。
        assert!(identity_key(&invalid("ho:st", 22, None, "/a")).is_err());
        assert!(identity_key(&invalid("host", 22, Some("de:v"), "/a")).is_err());
        assert!(identity_key(&invalid("host", 22, None, "/a:x")).is_err());
        assert!(identity_key(&invalid("host", 22, Some(""), "/a")).is_err());
    }

    #[test]
    fn parse_identity_key_rejects_unnormalized_or_malformed_keys() {
        // 缺段 / 多段（path 含 ':'）。
        assert!(parse_identity_key("remote:ssh:host:22:dev").is_none());
        assert!(parse_identity_key("remote:ssh:host:22:dev:/a:b").is_none());
        // 非 remote:ssh 前缀。
        assert!(parse_identity_key("remote:docker:host:22:dev:/a").is_none());
        // 非法端口。
        assert!(parse_identity_key("remote:ssh:host:0:dev:/a").is_none());
        assert!(parse_identity_key("remote:ssh:host:70000:dev:/a").is_none());
        // 未归一化的 path 不接受。
        assert!(parse_identity_key("remote:ssh:host:22:dev:/a/").is_none());
        assert!(parse_identity_key("remote:ssh:host:22:dev:/a//b").is_none());
        assert!(parse_identity_key("remote:ssh:host:22:dev:relative").is_none());
        // 非法 user。
        assert!(parse_identity_key("remote:ssh:host:22:de v:/a").is_none());
    }
}
