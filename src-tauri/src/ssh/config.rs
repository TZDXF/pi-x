//! SSH 连接配置的持久化（契约 §2.1）。
//!
//! 复用 `~/.pix/config.json`：只读写 `sshConnections` 字段，其余字段经
//! `serde(flatten)` 原样保留（`AppConfig` 归 `commands::config` 所有，互不越界）。
//! 凭据不落盘：P1 认证仅 ssh key / ssh-agent（`BatchMode=yes`），只存私钥路径。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::identity;
use super::transport::SshEndpoint;
use crate::data_dir;
use crate::errors::{pix_error, pix_error_detail, pix_error_with};

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

/// 一条已保存的 SSH 连接配置。
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SshConnection {
    #[serde(default)]
    pub id: String,
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
    #[serde(default)]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_probe: Option<SshProbeInfo>,
}

/// 保存入参：有 `id` 时 upsert，无 `id` 时后端生成 `"ssh-" + UUID v4`。
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectionInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub name: String,
    pub host: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_path: Option<String>,
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
    let host = identity::normalize_host(input.host.trim()).map_err(|e| {
        pix_error_with(
            "sshConnectionInvalid",
            "SSH 连接 host 无效: {detail}",
            json!({ "detail": e }),
        )
    })?;
    let port = input.port.unwrap_or(identity::DEFAULT_PORT);
    if port == 0 {
        return Err(pix_error(
            "sshConnectionInvalid",
            "SSH 端口必须在 1-65535 之间",
        ));
    }
    let user = match input.user.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(user) => {
            identity::validate_user(user).map_err(|e| {
                pix_error_with(
                    "sshConnectionInvalid",
                    "SSH 连接 user 无效: {detail}",
                    json!({ "detail": e }),
                )
            })?;
            Some(user.to_string())
        }
        None => None,
    };
    // keyPath 只存路径字符串（支持 ~ 前缀，使用时展开），无任何凭据内容。
    let key_path = input
        .key_path
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string);

    let id = input
        .id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| format!("ssh-{}", uuid::Uuid::new_v4()));

    let mut view = read_view(path)?;
    let list = view.ssh_connections.get_or_insert_with(Vec::new);
    if let Some(existing) = list.iter_mut().find(|c| c.id == id) {
        existing.name = name.to_string();
        existing.host = host;
        existing.port = port;
        existing.user = user;
        existing.key_path = key_path;
        let connection = existing.clone();
        write_view(path, &view)?;
        return Ok(connection);
    }
    let connection = SshConnection {
        id,
        name: name.to_string(),
        host,
        port,
        user,
        key_path,
        created_at: timestamp_now(),
        last_used_at: None,
        last_probe: None,
    };
    list.push(connection.clone());
    write_view(path, &view)?;
    Ok(connection)
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
    /// 转换为传输层端点；keyPath 的 `~` 前缀按 `data_dir::expand_home` 展开。
    pub fn to_endpoint(&self) -> SshEndpoint {
        let key_path = self.key_path.as_deref().map(|key_path| {
            match dirs::home_dir() {
                Some(home) => data_dir::expand_home(key_path, &home),
                None => PathBuf::from(key_path),
            }
            .to_string_lossy()
            .into_owned()
        });
        SshEndpoint {
            host: self.host.clone(),
            port: self.port,
            user: self.user.clone(),
            key_path,
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
            name: name.to_string(),
            host: host.to_string(),
            port: None,
            user: None,
            key_path: None,
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
    fn to_endpoint_expands_tilde_key_path() {
        let connection = SshConnection {
            id: "ssh-1".to_string(),
            name: "n".to_string(),
            host: "HOST.test".to_string(),
            port: 2222,
            user: Some("dev".to_string()),
            key_path: Some("~/keys/id_ed25519".to_string()),
            created_at: String::new(),
            last_used_at: None,
            last_probe: None,
        };
        let endpoint = connection.to_endpoint();
        assert_eq!(endpoint.host, "HOST.test");
        assert_eq!(endpoint.port, 2222);
        assert_eq!(endpoint.user.as_deref(), Some("dev"));
        let expanded = endpoint.key_path.unwrap().replace('\\', "/");
        assert!(expanded.ends_with("/keys/id_ed25519"), "{expanded}");
        assert!(!expanded.starts_with('~'));
    }
}
