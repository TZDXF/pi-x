//! SSH 远程连接的 Tauri 命令（契约 `docs/plans/ssh-remote-p1-contracts.md` §2）。
//!
//! 五条命令名与参数与契约逐字一致，前端 `src/api/client/ssh.ts` 已按契约封装。
//! 连接 CRUD 委托 `ssh::config`（纯库层），probe 委托 `ssh::transport` 的
//! `SystemSsh` 实现；本模块只做参数校验、coded error 归类与缓存写回。

use serde::Serialize;
use tauri::AppHandle;

use crate::errors::{pix_error, pix_error_detail};
use crate::ssh::transport::{SshEndpoint, SshError, SshErrorKind, SshTransport, SystemSsh};
use crate::ssh::{config, identity};

/// probe 结果（契约 §2.1 的 `SshProbeResult`）：成功时填远端信息，
/// 失败时 `errorKind`/`error` 分别给 errorKind 归类与 coded error。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshProbeResult {
    pub ok: bool,
    pub uname: Option<String>,
    pub arch: Option<String>,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
    pub node_found: bool,
    pub pi_found: bool,
    pub error_kind: Option<&'static str>,
    pub error: Option<String>,
}

/// SSH 失败统一归一化为 coded error（契约 §2.4）。
/// `Remote` 类携带 stderr 摘要（含退出码），供 i18n 的 `{detail}` 插值。
pub(crate) fn ssh_error_coded(e: &SshError) -> String {
    match &e.kind {
        SshErrorKind::SshMissing => pix_error(
            "sshMissing",
            "未找到本机 ssh 客户端。Windows 可在「设置 → 应用 → 可选功能」中安装 OpenSSH 客户端。",
        ),
        SshErrorKind::Auth => pix_error(
            "sshAuthFailed",
            "SSH 认证失败。请检查密钥或 agent；若为主机指纹校验失败，请先在终端手动 ssh 一次该主机。",
        ),
        SshErrorKind::Network => pix_error(
            "sshConnectFailed",
            "无法连接到远程主机，请检查主机、端口与网络。",
        ),
        SshErrorKind::Timeout => pix_error("sshTimeout", "连接超时，网络过慢或主机无响应。"),
        SshErrorKind::Remote => {
            pix_error_detail("sshProbeFailed", "远程操作失败: {detail}", &e.detail)
        }
    }
}

fn error_kind_label(kind: &SshErrorKind) -> &'static str {
    match kind {
        SshErrorKind::SshMissing => "sshMissing",
        SshErrorKind::Auth => "auth",
        SshErrorKind::Network => "network",
        SshErrorKind::Timeout => "timeout",
        SshErrorKind::Remote => "remote",
    }
}

fn probe_ok(probe: &crate::ssh::transport::RemoteProbe) -> SshProbeResult {
    SshProbeResult {
        ok: true,
        uname: probe.uname.clone(),
        arch: probe.arch.clone(),
        node_version: probe.node_version.clone(),
        pi_version: probe.pi_version.clone(),
        node_found: probe.node_found,
        pi_found: probe.pi_found,
        error_kind: None,
        error: None,
    }
}

fn probe_failed(e: &SshError) -> SshProbeResult {
    SshProbeResult {
        ok: false,
        uname: None,
        arch: None,
        node_version: None,
        pi_version: None,
        node_found: false,
        pi_found: false,
        error_kind: Some(error_kind_label(&e.kind)),
        error: Some(ssh_error_coded(e)),
    }
}

async fn probe_endpoint(endpoint: &SshEndpoint) -> SshProbeResult {
    match SystemSsh::new(endpoint.clone()).probe().await {
        Ok(probe) => probe_ok(&probe),
        Err(e) => probe_failed(&e),
    }
}

/// 校验并构造临时探测端点：host 走 identity 归一化（小写），port 缺省 22，
/// user 校验字符集，keyPath 支持 ~ 前缀（展开规则同 `data_dir::expand_home`）。
fn endpoint_for_target(
    host: &str,
    port: Option<u16>,
    user: Option<String>,
    key_path: Option<String>,
) -> Result<SshEndpoint, String> {
    let host = identity::normalize_host(host.trim()).map_err(|e| {
        crate::errors::pix_error_with(
            "sshConnectionInvalid",
            "SSH 连接 host 无效: {detail}",
            serde_json::json!({ "detail": e }),
        )
    })?;
    let port = port.unwrap_or(identity::DEFAULT_PORT);
    if port == 0 {
        return Err(pix_error("sshConnectionInvalid", "SSH 端口必须在 1-65535 之间"));
    }
    let user = match user.as_deref().map(str::trim).filter(|u| !u.is_empty()) {
        Some(user) => {
            identity::validate_user(user).map_err(|e| {
                crate::errors::pix_error_with(
                    "sshConnectionInvalid",
                    "SSH 连接 user 无效: {detail}",
                    serde_json::json!({ "detail": e }),
                )
            })?;
            Some(user.to_string())
        }
        None => None,
    };
    let key_path = key_path
        .as_deref()
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(|k| match dirs::home_dir() {
            Some(home) => crate::data_dir::expand_home(k, &home).to_string_lossy().into_owned(),
            None => k.to_string(),
        });
    Ok(SshEndpoint {
        host,
        port,
        user,
        key_path,
    })
}

#[tauri::command]
pub async fn ssh_connection_list(_app: AppHandle) -> Result<Vec<config::SshConnection>, String> {
    config::list_connections()
}

#[tauri::command]
pub async fn ssh_connection_save(
    _app: AppHandle,
    connection: config::SshConnectionInput,
) -> Result<config::SshConnection, String> {
    config::save_connection(connection)
}

#[tauri::command]
pub async fn ssh_connection_delete(_app: AppHandle, id: String) -> Result<(), String> {
    config::delete_connection(&id)
}

/// 探测已保存连接；成功时把 `lastProbe`/`lastUsedAt` 写回配置（best-effort）。
#[tauri::command]
pub async fn ssh_connection_probe(_app: AppHandle, id: String) -> Result<SshProbeResult, String> {
    let connection = config::find_connection(&id)?
        .ok_or_else(|| pix_error("sshConnectionNotFound", "SSH 连接不存在，可能已被删除"))?;
    let result = probe_endpoint(&connection.to_endpoint()).await;
    if result.ok {
        let info = config::SshProbeInfo {
            probed_at: now_timestamp(),
            ok: true,
            uname: result.uname.clone(),
            arch: result.arch.clone(),
            node_version: result.node_version.clone(),
            pi_version: result.pi_version.clone(),
        };
        let _ = config::record_probe(&id, info);
        let _ = config::touch_connection(&id);
    }
    Ok(result)
}

/// 保存前的「测试连接」：参数即测，不写配置（契约 §2.2）。
#[tauri::command]
pub async fn ssh_probe_target(
    host: String,
    port: Option<u16>,
    user: Option<String>,
    key_path: Option<String>,
) -> Result<SshProbeResult, String> {
    let endpoint = endpoint_for_target(&host, port, user, key_path)?;
    Ok(probe_endpoint(&endpoint).await)
}

fn now_timestamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kind_labels_follow_contract_enum() {
        // 契约 §2.1：errorKind ∈ "auth" | "network" | "sshMissing" | "remote" | "timeout"。
        assert_eq!(error_kind_label(&SshErrorKind::SshMissing), "sshMissing");
        assert_eq!(error_kind_label(&SshErrorKind::Auth), "auth");
        assert_eq!(error_kind_label(&SshErrorKind::Network), "network");
        assert_eq!(error_kind_label(&SshErrorKind::Timeout), "timeout");
        assert_eq!(error_kind_label(&SshErrorKind::Remote), "remote");
    }

    #[test]
    fn ssh_error_coded_maps_kinds_to_coded_errors() {
        for (kind, expected) in [
            (SshErrorKind::SshMissing, "sshMissing"),
            (SshErrorKind::Auth, "sshAuthFailed"),
            (SshErrorKind::Network, "sshConnectFailed"),
            (SshErrorKind::Timeout, "sshTimeout"),
            (SshErrorKind::Remote, "sshProbeFailed"),
        ] {
            let e = SshError::new(kind, "boom");
            let coded = ssh_error_coded(&e);
            assert!(coded.starts_with("PIXERR:"), "{coded}");
            assert!(coded.contains(expected), "{expected} not in {coded}");
        }
        // Remote 类保留 stderr 摘要作为 {detail} 参数。
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(1),
            detail: "ssh 退出码 1: no such file".into(),
        };
        let coded = ssh_error_coded(&e);
        assert!(coded.contains("no such file"), "{coded}");
    }

    #[test]
    fn probe_result_serializes_contract_field_names() {
        let probe = crate::ssh::transport::RemoteProbe {
            uname: Some("Linux".into()),
            arch: Some("x86_64".into()),
            node_version: Some("v22.10.0".into()),
            pi_version: Some("0.9.3".into()),
            node_found: true,
            pi_found: true,
        };
        let raw = serde_json::to_value(probe_ok(&probe)).unwrap();
        for key in ["ok", "uname", "arch", "nodeVersion", "piVersion", "nodeFound", "piFound", "errorKind", "error"] {
            assert!(raw.get(key).is_some(), "missing field {key}");
        }
        let failed = probe_failed(&SshError::new(SshErrorKind::Auth, "denied"));
        let raw = serde_json::to_value(failed).unwrap();
        assert_eq!(raw["ok"], false);
        assert_eq!(raw["errorKind"], "auth");
        assert!(raw["error"].as_str().unwrap().starts_with("PIXERR:"));
    }

    #[test]
    fn endpoint_for_target_validates_and_expands() {
        let endpoint = endpoint_for_target("Host.Example.COM", None, None, None).unwrap();
        assert_eq!(endpoint.host, "host.example.com");
        assert_eq!(endpoint.port, 22);

        let err = endpoint_for_target("ho:st", None, None, None).unwrap_err();
        assert!(err.starts_with("PIXERR:"), "{err}");
        assert!(err.contains("sshConnectionInvalid"));
        let err = endpoint_for_target("host.test", Some(0), None, None).unwrap_err();
        assert!(err.starts_with("PIXERR:"));
        let err = endpoint_for_target("host.test", None, Some("de v".into()), None).unwrap_err();
        assert!(err.starts_with("PIXERR:"));

        // 空 user / 空 keyPath 视为未提供；keyPath 仅在使用时展开，未提供保持 None。
        let endpoint = endpoint_for_target("host.test", Some(2222), Some("  ".into()), Some("".into())).unwrap();
        assert_eq!(endpoint.user, None);
        assert_eq!(endpoint.key_path, None);
    }
}
