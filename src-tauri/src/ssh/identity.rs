//! 远程项目身份模型：展示 URI 与内部身份键的构造、解析与归一化
//! （契约 P1 §1 与多后端契约 §2）。
//!
//! 六种标识（三后端 × 展示 URI / 内部身份键）：
//! - ssh：`ssh://[user@]host[:port]/abs/path` ↔ `remote:ssh:<host>:<port>:<user>:<path>`
//! - wsl：`wsl://[user@]distro/abs/path` ↔ `remote:wsl:<distro>:<user>:<path>`
//! - docker：`docker://container/abs/path` ↔ `remote:docker:<container>:<path>`
//!
//! 禁止在模块外手拼这些字符串，一律经由本模块的构造/解析函数。
//! 共用规则：path 复用 [`normalize_ssh_path`]；所有字段禁 `:`（身份键分隔符）、
//! 禁空白与控制字符。wsl distro 大小写保留、`default`（任何大小写）防御性拒绝；
//! docker 容器名/短 ID 保留输入原样、不做 lowercase。

/// 展示 URI 前缀（小写字面量）。
pub const SSH_URI_PREFIX: &str = "ssh://";
/// 内部身份键前缀。契约 P1 §1.4 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
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
/// 契约 P1 §1.4 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
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
/// 契约 P1 §1.4 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
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

// ---- WSL / Docker 身份（多后端契约 §2）----

/// 展示 URI 前缀：WSL。
pub const WSL_URI_PREFIX: &str = "wsl://";
/// 内部身份键前缀：WSL。多后端契约 §2.3 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
pub const WSL_IDENTITY_KEY_PREFIX: &str = "remote:wsl:";
/// 展示 URI 前缀：Docker。
pub const DOCKER_URI_PREFIX: &str = "docker://";
/// 内部身份键前缀：Docker。多后端契约 §2.3 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
pub const DOCKER_IDENTITY_KEY_PREFIX: &str = "remote:docker:";

/// WSL 远端目标。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WslTarget {
    /// 发行版名（大小写保留，不做归一）。
    pub distro: String,
    /// `None` 表示发行版默认用户。
    pub user: Option<String>,
    /// 归一化后的绝对 POSIX 路径。
    pub path: String,
}

/// Docker 远端目标。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DockerTarget {
    /// 容器名或短 ID（保留输入原样）。
    pub container: String,
    /// 归一化后的绝对 POSIX 路径。
    pub path: String,
}

/// 三后端伞型：本地路径与全部非远程输入返回 `None`（经 [`parse_remote_uri`]）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteTarget {
    Ssh(SshTarget),
    Wsl(WslTarget),
    Docker(DockerTarget),
}

impl RemoteTarget {
    /// 目标路径（已归一化）。
    pub fn path(&self) -> &str {
        match self {
            RemoteTarget::Ssh(t) => &t.path,
            RemoteTarget::Wsl(t) => &t.path,
            RemoteTarget::Docker(t) => &t.path,
        }
    }

    /// 以 `resolved` 替换路径后重建展示 URI（realpath 回绑用）。
    pub fn with_path(&self, resolved: String) -> RemoteTarget {
        let mut cloned = self.clone();
        match &mut cloned {
            RemoteTarget::Ssh(t) => t.path = resolved,
            RemoteTarget::Wsl(t) => t.path = resolved,
            RemoteTarget::Docker(t) => t.path = resolved,
        }
        cloned
    }
}

/// 是否以 `ssh://` / `wsl://` / `docker://` 前缀开头（仅前缀判断，不做完整校验）。
pub fn is_remote_uri(value: &str) -> bool {
    is_ssh_uri(value) || value.starts_with(WSL_URI_PREFIX) || value.starts_with(DOCKER_URI_PREFIX)
}

/// 伞型解析：依次尝试 ssh / wsl / docker 前缀；前缀互斥故顺序无关。
pub fn parse_remote_uri(uri: &str) -> Option<RemoteTarget> {
    if let Some(target) = parse_ssh_uri(uri) {
        return Some(RemoteTarget::Ssh(target));
    }
    if let Some(target) = parse_wsl_uri(uri) {
        return Some(RemoteTarget::Wsl(target));
    }
    if let Some(target) = parse_docker_uri(uri) {
        return Some(RemoteTarget::Docker(target));
    }
    None
}

/// 伞型重建：按 kind 分发到各后端的 `build_*_uri`。
pub fn build_remote_uri(target: &RemoteTarget) -> Result<String, String> {
    match target {
        RemoteTarget::Ssh(t) => build_ssh_uri(t),
        RemoteTarget::Wsl(t) => build_wsl_uri(t),
        RemoteTarget::Docker(t) => build_docker_uri(t),
    }
}

/// 校验 WSL 发行版名：字母、数字、`.`、`_`、`-`，不以 `.`/`-` 开头，
/// 大小写保留；`default`（任何大小写）是模糊输入，防御性拒绝
/// ——身份必须锚定 `$WSL_DISTRO_NAME`（多后端契约 §2.2）。
pub fn validate_wsl_distro(distro: &str) -> Result<(), String> {
    if distro.eq_ignore_ascii_case("default") {
        return Err(format!(
            "WSL 发行版名不能为 'default'（请从发行版列表中选择真实名称）: {distro:?}"
        ));
    }
    if is_valid_distro(distro) {
        Ok(())
    } else {
        Err(format!("WSL 发行版名为空或含非法字符: {distro:?}"))
    }
}

fn is_valid_distro(distro: &str) -> bool {
    !distro.is_empty()
        && !distro.starts_with('.')
        && !distro.starts_with('-')
        && distro
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 校验 Docker 容器名/短 ID：`^[A-Za-z0-9][A-Za-z0-9_.-]+$`（docker 名称规则，
/// 至少 2 字符——对齐 moby `restrictedNamePattern`，短 ID 为其子集）；
/// 保留输入原样，不做 lowercase。
pub fn validate_docker_container(container: &str) -> Result<(), String> {
    if is_valid_container(container) {
        Ok(())
    } else {
        Err(format!("Docker 容器名为空或含非法字符: {container:?}"))
    }
}

fn is_valid_container(container: &str) -> bool {
    // 多后端契约 §2.2：至少 2 字符（moby 拒绝单字符容器名）。
    if container.chars().count() < 2 {
        return false;
    }
    let mut chars = container.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    container
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// 解析 `wsl://[user@]distro/abs/path`；非法或非 wsl 返回 `None`。
pub fn parse_wsl_uri(uri: &str) -> Option<WslTarget> {
    let rest = uri.strip_prefix(WSL_URI_PREFIX)?;
    // 必须带路径：`wsl://Ubuntu`（无 `/`）不是远程项目。
    let slash = rest.find('/')?;
    let authority = &rest[..slash];
    let raw_path = &rest[slash..];

    let (user, distro) = match authority.split_once('@') {
        Some((user, distro)) => {
            if !is_valid_user(user) {
                return None;
            }
            (Some(user.to_string()), distro)
        }
        None => (None, authority),
    };
    validate_wsl_distro(distro).ok()?;
    let path = normalize_ssh_path(raw_path).ok()?;
    Some(WslTarget {
        distro: distro.to_string(),
        user,
        path,
    })
}

/// 重建 `wsl://` 展示 URI：无 user 可省段；path 用归一化后的值。
pub fn build_wsl_uri(target: &WslTarget) -> Result<String, String> {
    validate_wsl_distro(&target.distro)?;
    let path = normalize_ssh_path(&target.path)?;
    Ok(match &target.user {
        Some(user) => {
            validate_user(user)?;
            format!("{WSL_URI_PREFIX}{user}@{}{path}", target.distro)
        }
        None => format!("{WSL_URI_PREFIX}{}{path}", target.distro),
    })
}

/// 构造内部身份键：`remote:wsl:<distro>:<user>:<path>`（4 段，user 空段 = 缺省）。
/// 多后端契约 §2.3 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
pub fn wsl_identity_key(target: &WslTarget) -> Result<String, String> {
    validate_wsl_distro(&target.distro)?;
    let user = match &target.user {
        Some(user) => {
            validate_user(user)?;
            user.as_str()
        }
        None => "",
    };
    let path = normalize_ssh_path(&target.path)?;
    Ok(format!("{WSL_IDENTITY_KEY_PREFIX}{}:{user}:{path}", target.distro))
}

/// 解析 `remote:wsl:` 身份键；user 字段为空串还原为 `None`。
/// path 必须已是归一化形式（否则拒绝，防止身份键被手拼绕过归一化）。
/// 多后端契约 §2.3 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
pub fn parse_wsl_identity_key(key: &str) -> Option<WslTarget> {
    let rest = key.strip_prefix(WSL_IDENTITY_KEY_PREFIX)?;
    // path 不允许含 `:`，因此整键恰为 3 段（distro/user/path）。
    let parts: Vec<&str> = rest.split(':').collect();
    let [distro, user, path] = parts.as_slice() else {
        return None;
    };
    validate_wsl_distro(distro).ok()?;
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
    Some(WslTarget {
        distro: (*distro).to_string(),
        user,
        path: (*path).to_string(),
    })
}

/// 解析 `docker://container/abs/path`；非法或非 docker 返回 `None`。
/// 无 user、无 port 段（多后端契约 §2.1）。
pub fn parse_docker_uri(uri: &str) -> Option<DockerTarget> {
    let rest = uri.strip_prefix(DOCKER_URI_PREFIX)?;
    // 必须带路径：`docker://x`（无 `/`）不是远程项目。
    let slash = rest.find('/')?;
    let container = &rest[..slash];
    validate_docker_container(container).ok()?;
    let path = normalize_ssh_path(&rest[slash..]).ok()?;
    Some(DockerTarget {
        container: container.to_string(),
        path,
    })
}

/// 重建 `docker://` 展示 URI：`docker://<container><path>`，path 用归一化后的值。
pub fn build_docker_uri(target: &DockerTarget) -> Result<String, String> {
    validate_docker_container(&target.container)?;
    let path = normalize_ssh_path(&target.path)?;
    Ok(format!("{DOCKER_URI_PREFIX}{}{path}", target.container))
}

/// 构造内部身份键：`remote:docker:<container>:<path>`（3 段，无 user 段）。
/// 多后端契约 §2.3 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
pub fn docker_identity_key(target: &DockerTarget) -> Result<String, String> {
    validate_docker_container(&target.container)?;
    let path = normalize_ssh_path(&target.path)?;
    Ok(format!("{DOCKER_IDENTITY_KEY_PREFIX}{}:{path}", target.container))
}

/// 解析 `remote:docker:` 身份键。path 必须已是归一化形式。
/// 多后端契约 §2.3 冻结 API，P4 身份快照持久化启用。
#[allow(dead_code)]
pub fn parse_docker_identity_key(key: &str) -> Option<DockerTarget> {
    let rest = key.strip_prefix(DOCKER_IDENTITY_KEY_PREFIX)?;
    // 恰为 2 段（container/path）。
    let parts: Vec<&str> = rest.split(':').collect();
    let [container, path] = parts.as_slice() else {
        return None;
    };
    validate_docker_container(container).ok()?;
    if normalize_ssh_path(path).ok().as_deref() != Some(*path) {
        return None;
    }
    Some(DockerTarget {
        container: (*container).to_string(),
        path: (*path).to_string(),
    })
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

    // 多后端契约 §2.4 测试用例表（Rust 侧）。

    #[test]
    fn wsl_case1_parses_full_uri_and_round_trips() {
        let target = parse_wsl_uri("wsl://tzdxf@Ubuntu-22.04/home/dev/proj").unwrap();
        assert_eq!(target.distro, "Ubuntu-22.04");
        assert_eq!(target.user.as_deref(), Some("tzdxf"));
        assert_eq!(target.path, "/home/dev/proj");
        assert_eq!(
            build_wsl_uri(&target).unwrap(),
            "wsl://tzdxf@Ubuntu-22.04/home/dev/proj"
        );
        assert_eq!(
            wsl_identity_key(&target).unwrap(),
            "remote:wsl:Ubuntu-22.04:tzdxf:/home/dev/proj"
        );
    }

    #[test]
    fn wsl_case2_keeps_case_and_empty_user_segment() {
        let target = parse_wsl_uri("wsl://Ubuntu/Proj").unwrap();
        assert_eq!(target.user, None);
        assert_eq!(target.path, "/Proj");
        assert_eq!(wsl_identity_key(&target).unwrap(), "remote:wsl:Ubuntu::/Proj");
        assert_eq!(build_wsl_uri(&target).unwrap(), "wsl://Ubuntu/Proj");
        // 身份键中的空 user 字段应还原为 None。
        assert_eq!(parse_wsl_identity_key("remote:wsl:Ubuntu::/Proj").unwrap(), target);
    }

    #[test]
    fn wsl_case3_normalizes_path_segments() {
        assert_eq!(parse_wsl_uri("wsl://Ubuntu/a/b///").unwrap().path, "/a/b");
        assert_eq!(parse_wsl_uri("wsl://Ubuntu/./a").unwrap().path, "/a");
        assert!(parse_wsl_uri("wsl://Ubuntu/../etc").is_none());
        // normalizeWslPath 不单独存在：复用 normalizeSshPath。
        assert_eq!(normalize_ssh_path("\\home\\dev").unwrap(), "/home/dev");
    }

    #[test]
    fn wsl_case4_rejects_invalid_inputs() {
        for uri in [
            "wsl://default/x",
            "wsl://Default/x",
            "wsl://Ubuntu",
            "wsl:///x",
            "wsl://@U/x",
            "wsl://U a/x",
            "wsl://U:b/x",
            "C:/code",
            "/home/u",
        ] {
            assert!(parse_wsl_uri(uri).is_none(), "应拒绝 {uri:?}");
        }
    }

    #[test]
    fn docker_case5_parses_and_round_trips() {
        let target = parse_docker_uri("docker://pix-docker-test/root/pix-docker-demo").unwrap();
        assert_eq!(target.container, "pix-docker-test");
        assert_eq!(target.path, "/root/pix-docker-demo");
        assert_eq!(
            docker_identity_key(&target).unwrap(),
            "remote:docker:pix-docker-test:/root/pix-docker-demo"
        );
        assert_eq!(
            build_docker_uri(&target).unwrap(),
            "docker://pix-docker-test/root/pix-docker-demo"
        );
    }

    #[test]
    fn docker_case6_accepts_short_id_and_rejects_invalid() {
        let short = parse_docker_uri("docker://fdc995e5a8fc/root/demo").unwrap();
        assert_eq!(short.container, "fdc995e5a8fc");
        for uri in ["docker://-x/y", "docker://x", "docker://x:1/y", "docker:///y"] {
            assert!(parse_docker_uri(uri).is_none(), "应拒绝 {uri:?}");
        }
    }

    #[test]
    fn case7_identity_keys_round_trip_for_wsl_and_docker() {
        let wsl_targets = [
            WslTarget {
                distro: "Ubuntu".into(),
                user: Some("tzdxf".into()),
                path: "/a".into(),
            },
            WslTarget {
                distro: "Ubuntu-22.04".into(),
                user: None,
                path: "/home/u/proj".into(),
            },
            WslTarget {
                distro: "Debian".into(),
                user: None,
                path: "/".into(),
            },
        ];
        for target in wsl_targets {
            let key = wsl_identity_key(&target).unwrap();
            assert_eq!(parse_wsl_identity_key(&key).unwrap(), target);
        }
        let docker_targets = [
            DockerTarget {
                container: "pix-docker-test".into(),
                path: "/root/demo".into(),
            },
            DockerTarget {
                container: "fdc995e5a8fc".into(),
                path: "/".into(),
            },
        ];
        for target in docker_targets {
            let key = docker_identity_key(&target).unwrap();
            assert_eq!(parse_docker_identity_key(&key).unwrap(), target);
        }
        // 缺 path 段 → null。
        assert!(parse_wsl_identity_key("remote:wsl:Ubuntu:tzdxf").is_none());
        assert!(parse_docker_identity_key("remote:docker:ctr").is_none());
        // 未归一化 path → null。
        assert!(parse_wsl_identity_key("remote:wsl:Ubuntu::/a/").is_none());
        assert!(parse_wsl_identity_key("remote:wsl:Ubuntu::relative").is_none());
        assert!(parse_docker_identity_key("remote:docker:ctr:/a/").is_none());
        assert!(parse_docker_identity_key("remote:docker:ctr:relative").is_none());
        // 非法字段。
        assert!(parse_wsl_identity_key("remote:wsl:de fault::/a").is_none());
        assert!(parse_docker_identity_key("remote:docker:-bad:/a").is_none());
        // 单字符容器名 → null（moby 规则至少 2 字符，契约 §2.4 用例 7）。
        assert!(parse_docker_identity_key("remote:docker:c:/a").is_none());
    }

    #[test]
    fn case8_umbrella_parse_and_prefix_guard() {
        assert!(matches!(
            parse_remote_uri("ssh://dev@h:22/a"),
            Some(RemoteTarget::Ssh(_))
        ));
        assert!(matches!(
            parse_remote_uri("wsl://U/a"),
            Some(RemoteTarget::Wsl(_))
        ));
        assert!(matches!(
            parse_remote_uri("docker://ci/a"),
            Some(RemoteTarget::Docker(_))
        ));
        // 单字符容器名 → None（moby 规则至少 2 字符，契约 §2.4 用例 8）。
        assert!(parse_remote_uri("docker://c/a").is_none());
        assert!(parse_remote_uri("C:/code").is_none());
        assert!(parse_remote_uri("wslx://a/b").is_none());
        // 本地路径与全部非远程输入零影响（对齐 P1 §1.5 第 8 条输入集）。
        for value in ["C:/code", "/home/u", "", "https://host/x", "ssh:host"] {
            assert!(!is_remote_uri(value), "应拒绝 {value:?}");
        }
        assert!(is_remote_uri("ssh://host/x"));
        assert!(is_remote_uri("wsl://Ubuntu/x"));
        assert!(is_remote_uri("docker://c/x"));
    }

    #[test]
    fn build_rejects_invalid_wsl_and_docker_fields() {
        assert!(build_wsl_uri(&WslTarget {
            distro: "default".into(),
            user: None,
            path: "/a".into(),
        })
        .is_err());
        assert!(build_wsl_uri(&WslTarget {
            distro: "Ubuntu".into(),
            user: Some("de v".into()),
            path: "/a".into(),
        })
        .is_err());
        assert!(build_wsl_uri(&WslTarget {
            distro: "Ubuntu".into(),
            user: None,
            path: "relative".into(),
        })
        .is_err());
        assert!(build_docker_uri(&DockerTarget {
            container: "-bad".into(),
            path: "/a".into(),
        })
        .is_err());
        assert!(build_docker_uri(&DockerTarget {
            container: "ctr".into(),
            path: "/a:x".into(),
        })
        .is_err());
        // 单字符容器名 → 拒绝（moby 规则至少 2 字符）。
        assert!(build_docker_uri(&DockerTarget {
            container: "c".into(),
            path: "/a".into(),
        })
        .is_err());
        // 身份键同样拒绝非法字段。
        assert!(wsl_identity_key(&WslTarget {
            distro: "de:fault".into(),
            user: None,
            path: "/a".into(),
        })
        .is_err());
        assert!(docker_identity_key(&DockerTarget {
            container: "c d".into(),
            path: "/a".into(),
        })
        .is_err());
    }

    #[test]
    fn remote_target_path_and_with_path_support_rebind() {
        let target = parse_remote_uri("wsl://Ubuntu/a/b").unwrap();
        assert_eq!(target.path(), "/a/b");
        let rebound = target.with_path("/phys/a/b".to_string());
        assert_eq!(build_remote_uri(&rebound).unwrap(), "wsl://Ubuntu/phys/a/b");
        let docker = parse_remote_uri("docker://ctr/x").unwrap();
        assert_eq!(docker.path(), "/x");
    }
}
