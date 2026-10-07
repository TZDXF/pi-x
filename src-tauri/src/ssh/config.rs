//! 远程连接配置的持久化（契约 §2.1 与多后端契约 §3）。
//!
//! 复用 `~/.pix/config.json`：只读写 `sshConnections` 字段（历史命名，语义已是
//! "远程连接"），其余字段经 `serde(flatten)` 原样保留（`AppConfig` 归
//! `commands::config` 所有，互不越界）。凭据不落盘：仅 ssh key / ssh-agent
//! （`BatchMode=yes`），只存私钥路径；WSL/Docker 复用本机身份，无凭据字段。
//! `kind` 字段（多后端契约 §3.1）：`"ssh" | "wsl" | "docker"`，缺省 `"ssh"`
//! ——读路径即迁移（多后端契约 §3.2），旧 config.json 无需迁移脚本。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::backend::{DockerEndpoint, RemoteEndpoint, WslEndpoint};
use super::identity;
use crate::data_dir;
use crate::errors::{pix_error, pix_error_detail, pix_error_with};

/// 连接类型（多后端契约 §3.1）。serde 缺省 = Ssh：旧数据（无 kind 字段）
/// 读取后全部视为 ssh 连接，读路径即迁移。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ConnectionKind {
    #[default]
    Ssh,
    Wsl,
    Docker,
}

impl ConnectionKind {
    /// 新增连接时 id 的前缀（多后端契约 §3.1）。
    pub fn id_prefix(self) -> &'static str {
        match self {
            ConnectionKind::Ssh => "ssh-",
            ConnectionKind::Wsl => "wsl-",
            ConnectionKind::Docker => "docker-",
        }
    }
}

/// probe 结果缓存（仅 UI 展示与错误指引，spawn 不依赖）。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshProbeInfo {
    pub probed_at: String,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uname: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arch: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pi_version: Option<String>,
}

/// 一条已保存的远程连接配置。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub kind: ConnectionKind,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    /// kind = "wsl" 专用：发行版名。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    /// kind = "docker" 专用：容器名。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe: Option<SshProbeInfo>,
}

/// 保存入参：有 `id` 时 upsert，无 `id` 时后端生成 `<kind 前缀> + UUID v4`。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default)]
    pub kind: ConnectionKind,
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distro: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container: Option<String>,
}

/// config.json 的本模块视图：只关心 `sshConnections`，
/// 其余顶层字段 flatten 保留、原样写回。
#[derive(Serialize, Deserialize, Default)]
struct ConfigView {
    #[serde(
        rename = "sshConnections",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    ssh_connections: Option<Vec<SshConnection>>,
    #[serde(flatten)]
    rest: Map<String, Value>,
}

pub fn config_path() -> PathBuf {
    data_dir::root().join("config.json")
}

fn read_view(path: &Path) -> Result<ConfigView, String> {
    if !path.exists() {
        return Ok(ConfigView::default());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| pix_error_detail("configReadFailed", "无法读取配置文件: {detail}", e))?;
    serde_json::from_str(&raw)
        .map_err(|e| pix_error_detail("configParseFailed", "配置文件解析失败: {detail}", e))
}

fn write_view(path: &Path, view: &ConfigView) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| {
                pix_error_detail("configDirCreateFailed", "无法创建配置目录: {detail}", e)
            })?;
        }
    }
    let body = serde_json::to_string_pretty(view)
        .map_err(|e| pix_error_detail("configSerializeFailed", "配置序列化失败: {detail}", e))?;
    // 原子写，沿用 commands/config.rs 的 write_config 模式。
    crate::atomic_write::write(path, body.as_bytes())
        .map_err(|e| pix_error_detail("configWriteFailed", "无法写入配置文件: {detail}", e))
}

fn timestamp_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 全部连接，按 `createdAt` 升序。
pub fn list_connections() -> Result<Vec<SshConnection>, String> {
    list_connections_in(&config_path())
}

pub fn list_connections_in(path: &Path) -> Result<Vec<SshConnection>, String> {
    let mut list = read_view(path)?.ssh_connections.unwrap_or_default();
    list.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    Ok(list)
}

pub fn find_connection(id: &str) -> Result<Option<SshConnection>, String> {
    find_connection_in(&config_path(), id)
}

pub fn find_connection_in(path: &Path, id: &str) -> Result<Option<SshConnection>, String> {
    Ok(read_view(path)?
        .ssh_connections
        .unwrap_or_default()
        .into_iter()
        .find(|c| c.id == id))
}

/// 按 `id` upsert 连接配置：校验 name/host/port/user（host 走 identity 归一化规则），
/// 新增补 `createdAt`；更新保留 `createdAt`/`lastUsedAt`/`lastProbe`。
pub fn save_connection(input: SshConnectionInput) -> Result<SshConnection, String> {
    save_connection_in(&config_path(), input)
}

pub fn save_connection_in(path: &Path, input: SshConnectionInput) -> Result<SshConnection, String> {
    let name = input.name.trim();
    if name.is_empty() {
        return Err(pix_error("sshConnectionInvalid", "SSH 连接名称不能为空"));
    }
    let kind = input.kind;
    let invalid = |detail: String| {
        pix_error_with("sshConnectionInvalid", "SSH 连接配置无效: {detail}", json!({ "detail": detail }))
    };
    // per-kind 字段校验与裁剪（多后端契约 §3.1 表）。
    let (host, port, user, key_path, distro, container) = match kind {
        ConnectionKind::Ssh => {
            let host = identity::normalize_host(input.host.trim()).map_err(invalid)?;
            let port = input.port.unwrap_or(identity::DEFAULT_PORT);
            if port == 0 {
                return Err(pix_error(
                    "sshConnectionInvalid",
                    "SSH 端口必须在 1-65535 之间",
                ));
            }
            let user = validate_optional_user(input.user.as_deref())?;
            // keyPath 只存路径字符串（支持 ~ 前缀，使用时展开），无任何凭据内容。
            let key_path = trimmed_non_empty(input.key_path.as_deref());
            (host, port, user, key_path, None, None)
        }
        ConnectionKind::Wsl => {
            let distro = input
                .distro
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .ok_or_else(|| invalid("WSL 发行版名不能为空".to_string()))?;
            identity::validate_wsl_distro(distro).map_err(invalid)?;
            let user = validate_optional_user(input.user.as_deref())?;
            (String::new(), 0, user, None, Some(distro.to_string()), None)
        }
        ConnectionKind::Docker => {
            let container = input
                .container
                .as_deref()
                .map(str::trim)
                .filter(|c| !c.is_empty())
                .ok_or_else(|| invalid("Docker 容器名不能为空".to_string()))?;
            identity::validate_docker_container(container).map_err(invalid)?;
            (String::new(), 0, None, None, None, Some(container.to_string()))
        }
    };

    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("{}{}", kind.id_prefix(), uuid::Uuid::new_v4()));

    let mut view = read_view(path)?;
    let list = view.ssh_connections.get_or_insert_with(Vec::new);
    if let Some(existing) = list.iter_mut().find(|c| c.id == id) {
        existing.kind = kind;
        existing.name = name.to_string();
        existing.host = host;
        existing.port = port;
        existing.user = user;
        existing.key_path = key_path;
        existing.distro = distro;
        existing.container = container;
        let connection = existing.clone();
        write_view(path, &view)?;
        return Ok(connection);
    }
    let connection = SshConnection {
        id,
        kind,
        name: name.to_string(),
        host,
        port,
        user,
        key_path,
        distro,
        container,
        created_at: timestamp_now(),
        last_used_at: None,
        last_probe: None,
    };
    list.push(connection.clone());
    write_view(path, &view)?;
    Ok(connection)
}

fn trimmed_non_empty(value: Option<&str>) -> Option<String> {
    value.map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

fn validate_optional_user(user: Option<&str>) -> Result<Option<String>, String> {
    match user.map(str::trim).filter(|u| !u.is_empty()) {
        Some(user) => {
            identity::validate_user(user).map_err(|e| {
                pix_error_with(
                    "sshConnectionInvalid",
                    "SSH 连接 user 无效: {detail}",
                    json!({ "detail": e }),
                )
            })?;
            Ok(Some(user.to_string()))
        }
        None => Ok(None),
    }
}

/// 删除连接；id 不存在也返回 Ok（幂等）。
pub fn delete_connection(id: &str) -> Result<(), String> {
    delete_connection_in(&config_path(), id)
}

pub fn delete_connection_in(path: &Path, id: &str) -> Result<(), String> {
    let mut view = read_view(path)?;
    let Some(list) = view.ssh_connections.as_mut() else {
        return Ok(());
    };
    let before = list.len();
    list.retain(|c| c.id != id);
    if list.len() == before {
        return Ok(());
    }
    if list.is_empty() {
        view.ssh_connections = None;
    }
    write_view(path, &view)
}

/// 上次成功 spawn/probe 时间写回（`lastUsedAt`）；id 不存在时静默忽略。
pub fn touch_connection(id: &str) -> Result<(), String> {
    touch_connection_in(&config_path(), id)
}

pub fn touch_connection_in(path: &Path, id: &str) -> Result<(), String> {
    let mut view = read_view(path)?;
    let Some(list) = view.ssh_connections.as_mut() else {
        return Ok(());
    };
    let Some(connection) = list.iter_mut().find(|c| c.id == id) else {
        return Ok(());
    };
    connection.last_used_at = Some(timestamp_now());
    write_view(path, &view)
}

/// probe 结果缓存写回（`lastProbe`）；id 不存在时静默忽略。
pub fn record_probe(id: &str, probe: SshProbeInfo) -> Result<(), String> {
    record_probe_in(&config_path(), id, probe)
}

pub fn record_probe_in(path: &Path, id: &str, probe: SshProbeInfo) -> Result<(), String> {
    let mut view = read_view(path)?;
    let Some(list) = view.ssh_connections.as_mut() else {
        return Ok(());
    };
    let Some(connection) = list.iter_mut().find(|c| c.id == id) else {
        return Ok(());
    };
    connection.last_probe = Some(probe);
    write_view(path, &view)
}

impl SshConnection {
    /// 转换为传输层统一端点（多后端契约 §3.1），按 kind 装配。
    /// ssh 分支：keyPath 的 `~` 前缀按 `data_dir::expand_home` 展开。
    pub fn to_remote_endpoint(&self) -> RemoteEndpoint {
        match self.kind {
            ConnectionKind::Ssh => {
                let key_path = self.key_path.as_deref().map(|key_path| {
                    match dirs::home_dir() {
                        Some(home) => data_dir::expand_home(key_path, &home),
                        None => PathBuf::from(key_path),
                    }
                    .to_string_lossy()
                    .into_owned()
                });
                RemoteEndpoint::Ssh(super::transport::SshEndpoint {
                    host: self.host.clone(),
                    port: self.port,
                    user: self.user.clone(),
                    key_path,
                })
            }
            ConnectionKind::Wsl => RemoteEndpoint::Wsl(WslEndpoint {
                distro: self.distro.clone().unwrap_or_default(),
                user: self.user.clone(),
            }),
            ConnectionKind::Docker => RemoteEndpoint::Docker(DockerEndpoint {
                container: self.container.clone().unwrap_or_default(),
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn temp_config_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pix-ssh-config-{tag}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    fn input(name: &str, host: &str) -> SshConnectionInput {
        SshConnectionInput {
            id: None,
            kind: ConnectionKind::Ssh,
            name: name.to_string(),
            host: host.to_string(),
            port: None,
            user: None,
            key_path: None,
            distro: None,
            container: None,
        }
    }

    #[test]
    fn save_normalizes_and_lists_by_created_at() {
        let path = temp_config_path("list");
        let first = save_connection_in(
            &path,
            SshConnectionInput {
                name: "  office server  ".to_string(),
                host: "Host.Example.COM".to_string(),
                ..input("", "")
            },
        )
        .unwrap();
        assert!(first.id.starts_with("ssh-"));
        assert_eq!(first.name, "office server");
        assert_eq!(first.host, "host.example.com");
        assert_eq!(first.port, 22);
        assert!(!first.created_at.is_empty());

        let second = save_connection_in(
            &path,
            SshConnectionInput {
                host: "other.test".to_string(),
                port: Some(2200),
                user: Some("dev".to_string()),
                key_path: Some("  ~/.ssh/id_ed25519  ".to_string()),
                ..input("second", "")
            },
        )
        .unwrap();
        assert_eq!(second.key_path.as_deref(), Some("~/.ssh/id_ed25519"));

        let list = list_connections_in(&path).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, first.id);
        assert_eq!(list[1].id, second.id);
        // 序列化字段名与契约一致。
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"sshConnections\""));
        assert!(raw.contains("\"keyPath\""));
        assert!(raw.contains("\"createdAt\""));
        // kind 显式落盘（多后端契约 §3.2 第 1 条）。
        assert!(raw.contains("\"kind\": \"ssh\""), "{raw}");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn save_rejects_invalid_input_with_coded_error() {
        let path = temp_config_path("invalid");
        for bad in [
            input("", "host.test"),
            input("   ", "host.test"),
            SshConnectionInput {
                host: "ho:st".to_string(),
                ..input("name", "")
            },
            SshConnectionInput {
                host: "".to_string(),
                ..input("name", "")
            },
            SshConnectionInput {
                port: Some(0),
                ..input("name", "host.test")
            },
            SshConnectionInput {
                user: Some("de v".to_string()),
                ..input("name", "host.test")
            },
        ] {
            let err = save_connection_in(&path, bad).unwrap_err();
            assert!(err.starts_with("PIXERR:"), "应为 coded error: {err}");
        }
        // 校验失败时不会创建文件。
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn upsert_updates_fields_but_keeps_metadata() {
        let path = temp_config_path("upsert");
        let created = save_connection_in(
            &path,
            SshConnectionInput {
                id: Some("ssh-abc".to_string()),
                ..input("v1", "host.test")
            },
        )
        .unwrap();
        record_probe_in(
            &path,
            "ssh-abc",
            SshProbeInfo {
                probed_at: "2026-10-05T08:00:00.000Z".to_string(),
                ok: true,
                uname: Some("Linux".to_string()),
                arch: Some("x86_64".to_string()),
                node_version: Some("v22.10.0".to_string()),
                pi_version: None,
            },
        )
        .unwrap();
        touch_connection_in(&path, "ssh-abc").unwrap();

        let updated = save_connection_in(
            &path,
            SshConnectionInput {
                id: Some("ssh-abc".to_string()),
                name: "renamed".to_string(),
                host: "HOST.test".to_string(),
                port: Some(2222),
                ..input("", "")
            },
        )
        .unwrap();
        assert_eq!(updated.name, "renamed");
        assert_eq!(updated.host, "host.test");
        assert_eq!(updated.port, 2222);
        // createdAt / lastUsedAt / lastProbe 保留。
        assert_eq!(updated.created_at, created.created_at);
        assert!(updated.last_used_at.is_some());
        assert_eq!(updated.last_probe.as_ref().unwrap().uname.as_deref(), Some("Linux"));
        // 未提供的可选字段被清空。
        assert_eq!(updated.user, None);
        assert_eq!(updated.key_path, None);
        assert_eq!(list_connections_in(&path).unwrap().len(), 1);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn delete_is_idempotent_and_missing_list_yields_empty() {
        let path = temp_config_path("delete");
        // 配置不存在时列出为空。
        assert!(list_connections_in(&path).unwrap().is_empty());
        // 删除不存在的 id 也返回 Ok。
        delete_connection_in(&path, "ssh-nope").unwrap();

        let saved = save_connection_in(&path, input("a", "host.test")).unwrap();
        delete_connection_in(&path, &saved.id).unwrap();
        assert!(list_connections_in(&path).unwrap().is_empty());
        delete_connection_in(&path, &saved.id).unwrap();
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn unrelated_config_fields_survive_round_trip() {
        let path = temp_config_path("flatten");
        std::fs::write(&path, r#"{"lastProject":"C:/code","piPath":"pi"}"#).unwrap();
        save_connection_in(&path, input("a", "host.test")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(value["lastProject"], "C:/code");
        assert_eq!(value["piPath"], "pi");
        assert!(value["sshConnections"].as_array().unwrap().len() == 1);
        // 旧配置缺 sshConnections 也能正常读取。
        let legacy: ConfigView =
            serde_json::from_str(r#"{"lastProject":"C:/code"}"#).unwrap();
        assert!(legacy.ssh_connections.is_none());
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn to_remote_endpoint_expands_tilde_key_path() {
        let connection = SshConnection {
            id: "ssh-1".to_string(),
            name: "n".to_string(),
            host: "HOST.test".to_string(),
            port: 2222,
            user: Some("dev".to_string()),
            key_path: Some("~/keys/id_ed25519".to_string()),
            kind: ConnectionKind::Ssh,
            distro: None,
            container: None,
            created_at: String::new(),
            last_used_at: None,
            last_probe: None,
        };
        let RemoteEndpoint::Ssh(endpoint) = connection.to_remote_endpoint() else {
            panic!("ssh kind 应装配为 Ssh 分支");
        };
        assert_eq!(endpoint.host, "HOST.test");
        assert_eq!(endpoint.port, 2222);
        assert_eq!(endpoint.user.as_deref(), Some("dev"));
        let expanded = endpoint.key_path.unwrap().replace('\\', "/");
        assert!(expanded.ends_with("/keys/id_ed25519"), "{expanded}");
        assert!(!expanded.starts_with('~'));
    }

    #[test]
    fn save_trims_fields_per_kind_and_generates_prefixed_ids() {
        let path = temp_config_path("kinds");
        let wsl = save_connection_in(
            &path,
            SshConnectionInput {
                kind: ConnectionKind::Wsl,
                name: "  WSL Ubuntu  ".to_string(),
                distro: Some("  Ubuntu  ".to_string()),
                user: Some("  tzdxf  ".to_string()),
                // ssh/docker 专属字段全部被裁剪。
                host: "leftover.invalid".to_string(),
                port: Some(2222),
                key_path: Some("~/.ssh/id_ed25519".to_string()),
                container: Some("leftover".to_string()),
                ..input("", "")
            },
        )
        .unwrap();
        assert!(wsl.id.starts_with("wsl-"));
        assert_eq!(wsl.kind, ConnectionKind::Wsl);
        assert_eq!(wsl.distro.as_deref(), Some("Ubuntu"));
        assert_eq!(wsl.user.as_deref(), Some("tzdxf"));
        assert_eq!(wsl.host, "");
        assert_eq!(wsl.port, 0);
        assert_eq!(wsl.key_path, None);
        assert_eq!(wsl.container, None);

        let docker = save_connection_in(
            &path,
            SshConnectionInput {
                kind: ConnectionKind::Docker,
                name: "docker test".to_string(),
                container: Some("  pix-docker-test  ".to_string()),
                host: "leftover.invalid".to_string(),
                user: Some("leftover".to_string()),
                distro: Some("leftover".to_string()),
                ..input("", "")
            },
        )
        .unwrap();
        assert!(docker.id.starts_with("docker-"));
        assert_eq!(docker.kind, ConnectionKind::Docker);
        assert_eq!(docker.container.as_deref(), Some("pix-docker-test"));
        assert_eq!(docker.host, "");
        assert_eq!(docker.port, 0);
        assert_eq!(docker.user, None);
        assert_eq!(docker.key_path, None);
        assert_eq!(docker.distro, None);

        let list = list_connections_in(&path).unwrap();
        assert_eq!(list.len(), 2);
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn save_rejects_invalid_wsl_and_docker_fields_with_coded_error() {
        let path = temp_config_path("kind-invalid");
        for bad in [
            SshConnectionInput {
                kind: ConnectionKind::Wsl,
                name: "n".to_string(),
                distro: Some("default".to_string()),
                ..input("", "")
            },
            SshConnectionInput {
                kind: ConnectionKind::Wsl,
                name: "n".to_string(),
                distro: Some("  ".to_string()),
                ..input("", "")
            },
            SshConnectionInput {
                kind: ConnectionKind::Wsl,
                name: "n".to_string(),
                distro: Some("U buntu".to_string()),
                ..input("", "")
            },
            SshConnectionInput {
                kind: ConnectionKind::Wsl,
                name: "n".to_string(),
                distro: Some("Ubuntu".to_string()),
                user: Some("de v".to_string()),
                ..input("", "")
            },
            SshConnectionInput {
                kind: ConnectionKind::Docker,
                name: "n".to_string(),
                container: Some("-bad".to_string()),
                ..input("", "")
            },
            SshConnectionInput {
                kind: ConnectionKind::Docker,
                name: "n".to_string(),
                container: None,
                ..input("", "")
            },
        ] {
            let err = save_connection_in(&path, bad).unwrap_err();
            assert!(err.starts_with("PIXERR:"), "应为 coded error: {err}");
            assert!(err.contains("sshConnectionInvalid"), "{err}");
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_config_without_kind_reads_as_ssh() {
        // 多后端契约 §3.2：读路径即迁移——旧数据（无 kind）全部视为 ssh。
        let path = temp_config_path("legacy");
        std::fs::write(
            &path,
            r#"{"sshConnections":[{"id":"ssh-old","name":"old","host":"host.test","port":22,"createdAt":"2026-01-01T00:00:00.000Z"}]}"#,
        )
        .unwrap();
        let list = list_connections_in(&path).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].kind, ConnectionKind::Ssh);
        assert_eq!(list[0].distro, None);
        assert_eq!(list[0].container, None);
        // 首次任意写回时 kind 显式落盘。
        touch_connection_in(&path, "ssh-old").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"kind\": \"ssh\""), "{raw}");
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn to_remote_endpoint_assembles_per_kind() {
        let wsl = SshConnection {
            id: "wsl-1".to_string(),
            kind: ConnectionKind::Wsl,
            name: "n".to_string(),
            distro: Some("Ubuntu".to_string()),
            user: Some("tzdxf".to_string()),
            host: String::new(),
            port: 0,
            key_path: None,
            container: None,
            created_at: String::new(),
            last_used_at: None,
            last_probe: None,
        };
        assert_eq!(
            wsl.to_remote_endpoint(),
            RemoteEndpoint::Wsl(WslEndpoint {
                distro: "Ubuntu".to_string(),
                user: Some("tzdxf".to_string()),
            })
        );
        let docker = SshConnection {
            id: "docker-1".to_string(),
            kind: ConnectionKind::Docker,
            name: "n".to_string(),
            container: Some("pix-docker-test".to_string()),
            host: String::new(),
            port: 0,
            user: None,
            key_path: None,
            distro: None,
            created_at: String::new(),
            last_used_at: None,
            last_probe: None,
        };
        assert_eq!(
            docker.to_remote_endpoint(),
            RemoteEndpoint::Docker(DockerEndpoint {
                container: "pix-docker-test".to_string(),
            })
        );
    }
}
