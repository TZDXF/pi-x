//! SSH 远程连接的 Tauri 命令（契约 `docs/plans/ssh-remote-p1-contracts.md` §2）。
//!
//! 五条命令名与参数与契约逐字一致，前端 `src/api/client/ssh.ts` 已按契约封装。
//! 连接 CRUD 委托 `ssh::config`（纯库层），probe 委托 `ssh::transport` 的
//! `SystemSsh` 实现；本模块只做参数校验、coded error 归类与缓存写回。

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

use crate::errors::{pix_error, pix_error_detail};
use crate::ssh::transport::{
    ssh_exec_with_stdin, SshEndpoint, SshError, SshErrorKind, SshTransport, SystemSsh,
};
use crate::ssh::{config, identity, payload};

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

/// SSH 失败统一归一化为 coded error（契约 §2.4 / P2 §5）。
/// `Remote` 类携带 stderr 摘要（含退出码），供 i18n 的 `{detail}` 插值。
pub(crate) fn ssh_error_coded(e: &SshError) -> String {
    match &e.kind {
        SshErrorKind::SshMissing => pix_error(
            "sshMissing",
            "未找到本机 ssh 客户端。Windows 可在「设置 → 应用 → 可选功能」中安装 OpenSSH 客户端。",
        ),
        SshErrorKind::HostKey => host_key_error(e),
        SshErrorKind::Auth => pix_error(
            "sshAuthFailed",
            "SSH 认证失败。请检查密钥或 agent。",
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

/// HostKey 细分的 coded error（契约 P2 §5.2）：单一 `SshErrorKind::HostKey`
/// 变体承载两种场景，凭 stderr 摘要关键词二分。
fn host_key_error(e: &SshError) -> String {
    if e.detail.to_lowercase().contains("remote host identification has changed") {
        pix_error(
            "sshHostKeyChanged",
            "远程主机指纹与 known_hosts 记录不一致，可能是主机重装或中间人攻击。核实后在 ~/.ssh/known_hosts 中删除该主机条目再重试。",
        )
    } else {
        pix_error(
            "sshHostKeyUnverified",
            "主机指纹尚未确认。请先在终端手动 ssh 一次该主机并确认指纹，然后重试。",
        )
    }
}

fn error_kind_label(kind: &SshErrorKind) -> &'static str {
    match kind {
        SshErrorKind::SshMissing => "sshMissing",
        SshErrorKind::HostKey => "hostKey",
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

/// 远程命令（会话列表 / 信任）共享的校验链（对齐 `spawn_remote`，
/// `commands/pi.rs` 的连接一致性比较；契约 P2 §2.1/§4.2）：
/// `parse_ssh_uri` 失败 → `sshConnectionInvalid`；连接 id 空 →
/// `sshConnectionMissing`；连接不存在 → `sshConnectionNotFound`；
/// 连接 host/port/user 与 URI 不一致 → `sshConnectionMismatch`。
pub(crate) fn resolve_ssh_connection(
    project: &str,
    ssh_connection_id: &str,
) -> Result<(identity::SshTarget, config::SshConnection), String> {
    let target = identity::parse_ssh_uri(project).ok_or_else(|| {
        pix_error("sshConnectionInvalid", "SSH 连接配置与项目地址不一致")
    })?;
    let connection_id = ssh_connection_id.trim();
    if connection_id.is_empty() {
        return Err(pix_error("sshConnectionMissing", "远程项目没有匹配的 SSH 连接"));
    }
    let connection = config::find_connection(connection_id)?.ok_or_else(|| {
        pix_error("sshConnectionNotFound", "SSH 连接不存在，可能已被删除")
    })?;
    if connection.host != target.host
        || connection.port != target.port
        || connection.user != target.user
    {
        return Err(pix_error("sshConnectionMismatch", "SSH 连接配置与项目地址不一致"));
    }
    Ok((target, connection))
}

/// 已完成 mjs 上传的缓存键集合：mjs 内容随编译期常量固定（`PI_DATA_MJS`），
/// 进程内无需再比对哈希；上传失败不写入集合，下次调用重试（契约 P2 §4.1）。
fn uploaded_set() -> &'static Mutex<HashSet<String>> {
    static UPLOADED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    UPLOADED.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 上传幂等缓存键：连接 id + 端点要素（host/port/user/key）。
///
/// 连接编辑保留 id 但 host/port/user/keyPath 均可变（`ssh::config::save_connection_in`
/// 按 id upsert），缓存键若只含连接 id，编辑连接指向新主机后仍会命中缓存
/// 跳过上传——新主机的 `~/.pix/pi_data.mjs` 缺失，`TRUST_RUN_SCRIPT` 的
/// `cat` 读到空内容使 `node --eval ""` exit 0 且 stdout 为空，最终报误导性
/// `sshTrustFailed`。键必须随任一端点要素变化。
fn upload_cache_key(connection_id: &str, endpoint: &SshEndpoint) -> String {
    format!(
        "{connection_id}|{}|{}|{}|{}",
        endpoint.host,
        endpoint.port,
        endpoint.user.as_deref().unwrap_or(""),
        endpoint.key_path.as_deref().unwrap_or(""),
    )
}

/// 仅测试用：按连接 + 端点重置上传幂等缓存（实机用例 S-R5 重置首传状态）。
#[cfg(test)]
fn clear_upload_cache(connection_id: &str, endpoint: &SshEndpoint) {
    uploaded_set()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&upload_cache_key(connection_id, endpoint));
}

/// 信任流程的 exec 超时（契约 P2 §4.1：30s，node 冷启动）。
const TRUST_EXEC_TIMEOUT: Duration = Duration::from_secs(30);

/// 编译期内嵌的 pi_data.mjs（与本地 `pi_data.rs` 用同一份源）。
const PI_DATA_MJS: &str = include_str!("../../resources/pi_data.mjs");

/// 上传进程内串行化：并发首传共用远端固定临时名 `pi_data.mjs.pixtmp`
///（契约 P2 §4.1 冻结脚本），交错写入可能 mv 出损坏的 mjs，而此时缓存已
/// 标记上传完成、进程内不会重传，损坏会持续到重启。实机复现（2026-10-06）。
static UPLOAD_SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

/// 每连接进程内一次：上传 pi_data.mjs 到远端 `~/.pix/pi_data.mjs`
///（内容走 ssh stdin、原子落盘），带完成标记校验（契约 P2 §4.1 第 1 步）。
async fn ensure_mjs_uploaded(connection_id: &str, endpoint: &SshEndpoint) -> Result<(), String> {
    let cache_key = upload_cache_key(connection_id, endpoint);
    if uploaded_set()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&cache_key)
    {
        return Ok(());
    }
    let _serial = UPLOAD_SERIAL
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    // 双重检查：等待上传串行锁期间可能已有同键上传完成。
    if uploaded_set()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&cache_key)
    {
        return Ok(());
    }
    let output = ssh_exec_with_stdin(
        endpoint,
        payload::TRUST_UPLOAD_SCRIPT,
        PI_DATA_MJS.as_bytes(),
        TRUST_EXEC_TIMEOUT,
    )
    .await
    .map_err(|e| upload_exec_error(&e))?;
    if !output.stdout.contains("PIX_TRUST_UPLOAD_DONE") {
        return Err(pix_error_detail(
            "sshRemoteFailed",
            "远程操作失败: {detail}",
            "上传输出缺少完成标记 PIX_TRUST_UPLOAD_DONE",
        ));
    }
    uploaded_set()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(cache_key);
    Ok(())
}

/// 上传失败的退出码映射（契约 P2 §4.1）：95=写临时文件失败、96=目录创建/
/// 改名失败 → `sshRemoteFailed`；其余按通用归类。
fn upload_exec_error(e: &SshError) -> String {
    match e.exit_code {
        Some(code)
            if code == payload::EXIT_CODE_UPLOAD_WRITE_FAILED
                || code == payload::EXIT_CODE_UPLOAD_STAGE_FAILED =>
        {
            pix_error_detail("sshRemoteFailed", "远程操作失败: {detail}", &e.detail)
        }
        _ => ssh_error_coded(e),
    }
}

/// 远端执行信任 op 的退出码映射（契约 P2 §4.1/§4.2）：92 → `sshRemotePiMissing`
///（复用）、93 → `sshSdkDistMissing`、其余按通用归类。
fn trust_exec_error(e: &SshError) -> String {
    match e.exit_code {
        Some(code) if code == payload::EXIT_CODE_PI_MISSING => pix_error(
            "sshRemotePiMissing",
            "远程主机未安装 pi。请先在远程主机上安装 pi CLI（需要 Node.js）。",
        ),
        Some(code) if code == payload::EXIT_CODE_SDK_DIST_MISSING => pix_error(
            "sshSdkDistMissing",
            "未找到远程 pi 的 SDK 安装目录，无法执行远程信任操作。请确认远程主机已完整安装 pi。",
        ),
        _ => ssh_error_coded(e),
    }
}

/// 从 stdout 取最后一个可解析的 JSON 对象（banner/motd 容忍语义，契约 §3.8）。
fn parse_last_json(stdout: &str) -> Option<Value> {
    stdout
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str(line).ok())
}

/// 信任 op 执行（契约 P2 §4.1 第 2 步）：请求 JSON 走 ssh stdin、响应 JSON
/// 走 stdout，单次 exec 完成 SDK dist 发现 + node 调用。
async fn trust_run(endpoint: &SshEndpoint, request: &Value) -> Result<Value, String> {
    let output = ssh_exec_with_stdin(
        endpoint,
        payload::TRUST_RUN_SCRIPT,
        request.to_string().as_bytes(),
        TRUST_EXEC_TIMEOUT,
    )
    .await
    .map_err(|e| trust_exec_error(&e))?;
    parse_last_json(&output.stdout).ok_or_else(|| {
        pix_error_detail(
            "sshTrustFailed",
            "远程信任操作失败: {detail}",
            "输出不是有效的 JSON 响应",
        )
    })
}

/// 信任 op 完整链路：上传（幂等）+ 执行。实机集成测试（S-R3~S-R5）直接驱动。
async fn remote_trust_call(
    endpoint: &SshEndpoint,
    connection_id: &str,
    request: Value,
) -> Result<Value, String> {
    ensure_mjs_uploaded(connection_id, endpoint).await?;
    trust_run(endpoint, &request).await
}

/// 远程项目信任状态（契约 P1 §4.1 冻结名、P2 §4.2 落地）：返回形状与本地
/// `trust_status` 逐字段一致，前端 `TrustStatus` 类型零改动消费。
#[tauri::command]
pub async fn ssh_trust_status(
    ssh_connection_id: String,
    project: String,
) -> Result<Value, String> {
    let (target, connection) = resolve_ssh_connection(&project, &ssh_connection_id)?;
    let request = json!({ "op": "trust_status", "project": target.path });
    remote_trust_call(&connection.to_endpoint(), &ssh_connection_id.trim(), request).await
}

/// 远程项目信任决策持久化（契约 P1 §4.1 冻结名、P2 §4.2 落地）：返回决策后
/// 的状态（与本地 `trust_save` 同形状），写入远端 `~/.pi/agent/trust.json`。
#[tauri::command]
pub async fn ssh_trust_save(
    ssh_connection_id: String,
    project: String,
    trusted: bool,
    trust_parent: bool,
) -> Result<Value, String> {
    let (target, connection) = resolve_ssh_connection(&project, &ssh_connection_id)?;
    let request = json!({
        "op": "trust_save",
        "project": target.path,
        "trusted": trusted,
        "trustParent": trust_parent,
    });
    remote_trust_call(&connection.to_endpoint(), &ssh_connection_id.trim(), request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_kind_labels_follow_contract_enum() {
        // 契约 §2.1 + P2 §5.1：errorKind ∈ "auth" | "hostKey" | "network" | "sshMissing" | "remote" | "timeout"。
        assert_eq!(error_kind_label(&SshErrorKind::SshMissing), "sshMissing");
        assert_eq!(error_kind_label(&SshErrorKind::HostKey), "hostKey");
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
    fn host_key_kind_splits_by_stderr_keyword() {
        // 契约 P2 §5.2：同一 HostKey 变体凭 stderr 二分为两个 coded error。
        let changed = SshError::new(
            SshErrorKind::HostKey,
            "ssh 退出码 255: @ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @",
        );
        let coded = ssh_error_coded(&changed);
        assert!(coded.contains("sshHostKeyChanged"), "{coded}");
        let unverified = SshError::new(
            SshErrorKind::HostKey,
            "ssh 退出码 255: Host key verification failed.",
        );
        let coded = ssh_error_coded(&unverified);
        assert!(coded.contains("sshHostKeyUnverified"), "{coded}");
        // 无 stderr 线索时归为「尚未确认」（更安全的缺省）。
        let unknown = SshError::new(SshErrorKind::HostKey, "boom");
        assert!(ssh_error_coded(&unknown).contains("sshHostKeyUnverified"));
    }

    #[test]
    fn trust_exec_error_maps_contract_exit_codes() {
        // 契约 P2 §4.1：92 → sshRemotePiMissing（复用）、93 → sshSdkDistMissing。
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(payload::EXIT_CODE_PI_MISSING),
            detail: "ssh 退出码 92".into(),
        };
        assert!(trust_exec_error(&e).contains("sshRemotePiMissing"));
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(payload::EXIT_CODE_SDK_DIST_MISSING),
            detail: "ssh 退出码 93".into(),
        };
        assert!(trust_exec_error(&e).contains("sshSdkDistMissing"));
        // 其余按通用归类（Remote → sshProbeFailed）。
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(1),
            detail: "ssh 退出码 1: node error".into(),
        };
        assert!(trust_exec_error(&e).contains("sshProbeFailed"));
    }

    #[test]
    fn upload_exec_error_maps_write_and_stage_failures() {
        // 契约 P2 §4.1：95/96 → sshRemoteFailed。
        for code in [
            payload::EXIT_CODE_UPLOAD_WRITE_FAILED,
            payload::EXIT_CODE_UPLOAD_STAGE_FAILED,
        ] {
            let e = SshError {
                kind: SshErrorKind::Remote,
                exit_code: Some(code),
                detail: format!("ssh 退出码 {code}"),
            };
            assert!(upload_exec_error(&e).contains("sshRemoteFailed"), "{code}");
        }
        let e = SshError {
            kind: SshErrorKind::Auth,
            exit_code: Some(255),
            detail: "Permission denied".into(),
        };
        assert!(upload_exec_error(&e).contains("sshAuthFailed"));
    }

    #[test]
    fn parse_last_json_tolerates_banner_lines() {
        // mjs 输出无尾随换行，前面可能有 banner/motd 行。
        let stdout = "banner line\n{\"projectPath\":\"/p\",\"decision\":true}";
        let value = parse_last_json(stdout).expect("应取到 JSON");
        assert_eq!(value["projectPath"], "/p");
        assert!(parse_last_json("not json\nbanner").is_none());
        assert!(parse_last_json("").is_none());
    }

    #[test]
    fn upload_cache_key_changes_with_endpoint_elements() {
        // 回归（评审修复）：连接编辑保留 id 但端点可变（config.rs save_connection_in
        // 按 id upsert），缓存键必须随任一端点要素变化，否则编辑指向新主机后
        // 命中旧缓存跳过上传，远端 mjs 缺失 → 误导性 sshTrustFailed。
        let base = SshEndpoint {
            host: "host.test".into(),
            port: 22,
            user: Some("dev".into()),
            key_path: Some("k1".into()),
        };
        let key = |ep: &SshEndpoint| upload_cache_key("ssh-1", ep);
        // 同 id + 同端点 → 同键。
        assert_eq!(key(&base.clone()), key(&base));
        // 任一端点要素变化 → 换键。
        for changed in [
            SshEndpoint { host: "other.test".into(), ..base.clone() },
            SshEndpoint { port: 2222, ..base.clone() },
            SshEndpoint { user: Some("root".into()), ..base.clone() },
            SshEndpoint { user: None, ..base.clone() },
            SshEndpoint { key_path: Some("k2".into()), ..base.clone() },
        ] {
            assert_ne!(key(&base), key(&changed), "端点变化应换缓存键: {changed:?}");
        }
        // 连接 id 变化 → 换键。
        assert_ne!(key(&base), upload_cache_key("ssh-2", &base));
    }

    #[test]
    fn resolve_ssh_connection_follows_validation_chain() {
        // 项目 URI 非法 → sshConnectionInvalid（契约 P2 §2.1）。
        let err = resolve_ssh_connection("C:/code", "ssh-x").unwrap_err();
        assert!(err.contains("sshConnectionInvalid"), "{err}");
        // 连接 id 为空 → sshConnectionMissing。
        let err = resolve_ssh_connection("ssh://dev@host/a", "  ").unwrap_err();
        assert!(err.contains("sshConnectionMissing"), "{err}");
        // 其余两步（notFound / mismatch）依赖 config.json 中的真实连接，
        // 由 trust/sessions 的命令层与 spawn_remote 同构保证，这里不重复落盘。
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

// ---- 实机集成测试（契约 P2 §6）：需 WSL 测试环境（wsl-test-env.md）。
// 运行：cargo test ssh_real -- --ignored；环境变量任一缺失则跳过。

#[cfg(test)]
mod ssh_real_tests {
    use super::*;
    use crate::ssh::transport::ssh_exec;

    struct RealEnv {
        endpoint: SshEndpoint,
        project: String,
    }

    fn real_env() -> Option<RealEnv> {
        let missing: Vec<&str> = [
            "PIX_SSH_TEST_HOST",
            "PIX_SSH_TEST_PORT",
            "PIX_SSH_TEST_USER",
            "PIX_SSH_TEST_KEY_PATH",
            "PIX_SSH_TEST_PROJECT",
        ]
        .iter()
        .copied()
        .filter(|key| std::env::var(key).is_err())
        .collect();
        if !missing.is_empty() {
            eprintln!("跳过实机测试：缺少环境变量 {missing:?}");
            return None;
        }
        let host = std::env::var("PIX_SSH_TEST_HOST").unwrap();
        let port: u16 = std::env::var("PIX_SSH_TEST_PORT")
            .unwrap()
            .parse()
            .expect("PIX_SSH_TEST_PORT 必须是十进制端口");
        let user = std::env::var("PIX_SSH_TEST_USER").unwrap();
        let key_path = std::env::var("PIX_SSH_TEST_KEY_PATH").unwrap();
        let project = std::env::var("PIX_SSH_TEST_PROJECT").unwrap();
        Some(RealEnv {
            endpoint: SshEndpoint {
                host,
                port,
                user: Some(user),
                key_path: Some(key_path),
            },
            project,
        })
    }

    const TRUST_CONNECTION_ID: &str = "ssh-pix-real-test";
    /// S-R5 专用的上传连接 id：与其它用例隔离，避免并发上传干扰 mtime 断言。
    const UPLOAD_CONNECTION_ID: &str = "ssh-pix-real-test-upload";

    /// S-R3：`ssh_trust_status` 链路（上传 mjs + dist 发现 + node 执行），
    /// 返回形状含全部 6 字段，projectPath 为远端绝对路径。
    #[tokio::test]
    #[ignore]
    async fn ssh_real_trust_status_returns_contract_shape() {
        let Some(env) = real_env() else { return };
        // 实机用例共享单 sshd 与远端 ~/.pix 文件，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        let status = remote_trust_call(
            &env.endpoint,
            TRUST_CONNECTION_ID,
            json!({ "op": "trust_status", "project": env.project }),
        )
        .await
        .expect("远程信任状态查询应成功");
        for field in [
            "projectPath",
            "parentPath",
            "hasTrustRequiringResources",
            "decision",
            "policy",
            "needsDecision",
        ] {
            assert!(status.get(field).is_some(), "缺少字段 {field}: {status}");
        }
        let project_path = status["projectPath"].as_str().expect("projectPath 应为字符串");
        assert!(project_path.starts_with('/'), "projectPath 应为远端绝对路径: {project_path}");
    }

    /// S-R4：`ssh_trust_save` 往返 save(true) → status=true → save(false) →
    /// status=false；远端 trust.json 落盘且用例后还原。
    #[tokio::test]
    #[ignore]
    async fn ssh_real_trust_save_round_trip() {
        let Some(env) = real_env() else { return };
        // 实机用例共享单 sshd 与远端 ~/.pix 文件，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        // 备份远端 trust.json（不存在则用例后删除）。
        let backup = ssh_exec(
            &env.endpoint,
            concat!(
                "if [ -f \"$HOME/.pi/agent/trust.json\" ]; then ",
                "cp \"$HOME/.pi/agent/trust.json\" \"$HOME/.pi/agent/trust.json.pix-test-bak\" && echo PIX_TEST_BACKED_UP; ",
                "else echo PIX_TEST_ABSENT; fi\n"
            ),
            Duration::from_secs(15),
        )
        .await
        .expect("备份 trust.json 应成功");
        let backed_up = backup.stdout.contains("PIX_TEST_BACKED_UP");
        let restore = |backed_up: bool| {
            let script = if backed_up {
                "mv \"$HOME/.pi/agent/trust.json.pix-test-bak\" \"$HOME/.pi/agent/trust.json\"\n".to_string()
            } else {
                "rm -f \"$HOME/.pi/agent/trust.json\"\n".to_string()
            };
            let endpoint = env.endpoint.clone();
            async move {
                let _ = ssh_exec(&endpoint, &script, Duration::from_secs(15)).await;
            }
        };

        let save = |trusted: bool, endpoint: &SshEndpoint, project: &str| {
            let endpoint = endpoint.clone();
            let project = project.to_string();
            async move {
                remote_trust_call(
                    &endpoint,
                    TRUST_CONNECTION_ID,
                    json!({ "op": "trust_save", "project": project, "trusted": trusted, "trustParent": false }),
                )
                .await
            }
        };
        let saved_true = match save(true, &env.endpoint, &env.project).await {
            Ok(value) => value,
            Err(err) => {
                restore(backed_up).await;
                panic!("trust_save(true) 应成功: {err}");
            }
        };
        assert_eq!(saved_true["decision"], true, "save(true) 后 decision 应为 true");

        let status = remote_trust_call(
            &env.endpoint,
            TRUST_CONNECTION_ID,
            json!({ "op": "trust_status", "project": env.project }),
        )
        .await
        .expect("trust_status 应成功");
        assert_eq!(status["decision"], true);

        let saved_false = match save(false, &env.endpoint, &env.project).await {
            Ok(value) => value,
            Err(err) => {
                restore(backed_up).await;
                panic!("trust_save(false) 应成功: {err}");
            }
        };
        assert_eq!(saved_false["decision"], false);

        // 远端 trust.json 应已落盘，随后还原。
        let check = ssh_exec(
            &env.endpoint,
            "test -f \"$HOME/.pi/agent/trust.json\" && echo PIX_TEST_TRUST_FILE_PRESENT\n",
            Duration::from_secs(15),
        )
        .await
        .expect("检查 trust.json 应成功");
        assert!(check.stdout.contains("PIX_TEST_TRUST_FILE_PRESENT"));
        restore(backed_up).await;
    }

    /// S-R5：mjs 上传幂等——第二次调用不重复上传（远端文件 mtime 不变），
    /// 且上传后远端 `~/.pix/pi_data.mjs` 与本地 `resources/pi_data.mjs` 字节一致。
    #[tokio::test]
    #[ignore]
    async fn ssh_real_mjs_upload_is_idempotent_and_byte_identical() {
        let Some(env) = real_env() else { return };
        // 实机用例共享单 sshd 与远端 ~/.pix 文件，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        // 重置进程内上传缓存（按连接 + 端点键），强制首次真实上传。
        clear_upload_cache(UPLOAD_CONNECTION_ID, &env.endpoint);
        ensure_mjs_uploaded(UPLOAD_CONNECTION_ID, &env.endpoint)
            .await
            .expect("首次上传应成功");

        let mtime = |endpoint: &SshEndpoint| {
            let endpoint = endpoint.clone();
            async move {
                ssh_exec(
                    &endpoint,
                    "stat -c %Y \"$HOME/.pix/pi_data.mjs\"\n",
                    Duration::from_secs(15),
                )
                .await
                .expect("读取远端 mtime 应成功")
                .stdout
            }
        };
        let mtime1 = mtime(&env.endpoint).await;
        assert!(!mtime1.trim().is_empty(), "远端应已存在 pi_data.mjs");

        // 字节一致性：cmp 对比 stdin（本地源）与远端文件。
        let cmp = ssh_exec_with_stdin(
            &env.endpoint,
            "cmp -s \"$HOME/.pix/pi_data.mjs\" - && echo PIX_TEST_MATCH || echo PIX_TEST_MISMATCH\n",
            PI_DATA_MJS.as_bytes(),
            Duration::from_secs(15),
        )
        .await
        .expect("内容比对应成功");
        assert!(cmp.stdout.contains("PIX_TEST_MATCH"), "远端 mjs 应与本地字节一致");

        // 第二次调用命中进程内集合，不重复上传 → mtime 不变。
        ensure_mjs_uploaded(UPLOAD_CONNECTION_ID, &env.endpoint)
            .await
            .expect("第二次调用应成功");
        let mtime2 = mtime(&env.endpoint).await;
        assert_eq!(mtime1.trim(), mtime2.trim(), "第二次调用不应重复上传");
    }

    /// S-R6：dist 发现失败场景——`command -v pi` 命中一个无 SDK dist 的假
    /// pi（受限 PATH），祖先查找 5 级均无 `core/settings-manager.js` →
    /// exit 93 → coded error `sshSdkDistMissing`。
    ///
    /// 实测对契约原文「对 HOME 指向的空目录执行 TRUST_RUN_SCRIPT」的两点修正：
    /// 该机器 pi 装在 /usr/local/bin（不随 HOME 变化），祖先查找必然命中真实
    /// dist；而 `$(cat 空HOME下的mjs)` 得到空串，`node --eval ""` 反而 exit 0。
    /// 故改为让 dist 发现本身失败，语义（93 → sshSdkDistMissing）不变。
    #[tokio::test]
    #[ignore]
    async fn ssh_real_missing_sdk_dist_maps_to_coded_error() {
        let Some(env) = real_env() else { return };
        // 实机用例共享单 sshd 与远端 ~/.pix 文件，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        let script = format!(
            concat!(
                "T=$(mktemp -d) || exit 1\n",
                "mkdir -p \"$T/bin\"\n",
                "printf '#!/bin/sh\\n' > \"$T/bin/pi\"\n",
                "chmod +x \"$T/bin/pi\"\n",
                "PATH=\"$T/bin\"\n",
                "export PATH\n",
                "{}\n",
                "rc=$?\n",
                "rm -rf \"$T\"\n",
                "exit $rc\n"
            ),
            payload::TRUST_RUN_SCRIPT
        );
        let error = ssh_exec(&env.endpoint, &script, TRUST_EXEC_TIMEOUT)
            .await
            .err()
            .expect("无 SDK dist 的假 pi 应使 dist 发现失败");
        assert_eq!(error.exit_code, Some(payload::EXIT_CODE_SDK_DIST_MISSING));
        let coded = trust_exec_error(&error);
        assert!(coded.contains("sshSdkDistMissing"), "{coded}");
    }
}
