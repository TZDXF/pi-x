//! pi detection and trust, RPC spawn/passthrough to the per-runtime process
//! pool, pi settings and frontend diagnostics logging.

use serde_json::Value;
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::errors::{pix_error, pix_error_detail};
use crate::ssh::transport::SshErrorKind;
use crate::{pi_locate, rpc, ssh, trust};

use super::config::app_config_get;
use super::ssh::{connection_matches_remote, remote_error_coded};
use super::workspace::{workspace_manifest_for, WorkspaceContext};

#[tauri::command]
pub async fn pi_detect(custom_path: Option<String>) -> pi_locate::PiInfo {
    pi_locate::detect(custom_path).await
}

#[tauri::command]
pub async fn trust_status(project: String) -> Result<Value, String> {
    trust::status(&project).await
}

#[tauri::command]
pub async fn trust_save(
    project: String,
    trusted: bool,
    trust_parent: bool,
) -> Result<Value, String> {
    trust::save(&project, trusted, trust_parent).await
}

/// spawn 前校验项目目录。空字符串会让 CreateProcessW 以晦涩的
/// 「文件名、目录名或卷标语法不正确 (os error 123)」失败，这里统一转成编码错误。
pub(crate) fn validate_project_dir(project: &str) -> Result<(), String> {
    if project.trim().is_empty() || !std::path::Path::new(project).is_dir() {
        return Err(pix_error("projectDirMissing", "项目目录不存在"));
    }
    Ok(())
}

/// Spawn `pi --mode rpc` for `project`. A local project resolves the pi
/// executable from app config (falling back to auto-detection); a remote
/// project URI (`ssh://` / `wsl://` / `docker://`) routes to the remote branch
/// (契约 §3.1 与多后端契约 §5.1). `session_file` optionally resumes a stored
/// session via `--session <path>`.
#[tauri::command]
pub async fn rpc_spawn(
    app: AppHandle,
    state: State<'_, rpc::RpcState>,
    project: String,
    session_file: Option<String>,
    runtime_id: Option<String>,
    workspace: Option<WorkspaceContext>,
    ssh_connection_id: Option<String>,
) -> Result<(), String> {
    // 分流判据：parse 成功即远程分支；本地路径（含 C:/code 等盘符路径）照旧。
    let Some(target) = ssh::parse_remote_uri(&project) else {
        validate_project_dir(&project)?;
        let cfg = app_config_get(app.clone())?;
        let workspace_manifest = workspace_manifest_for(
            &project,
            workspace,
            cfg.workspace_groups.unwrap_or(true),
        )?;
        let info = pi_locate::detect(cfg.pi_path).await;
        if !info.found {
            return Err(pix_error(
                "piNotFound",
                "未找到 pi。请安装：npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
            ));
        }
        return rpc::spawn(
            app,
            &state,
            &rpc::SpawnProgram::LocalPi(info),
            &project,
            session_file,
            Vec::new(),
            workspace_manifest,
            runtime_id,
        )
        .await;
    };
    spawn_remote(
        app,
        &state,
        &project,
        &target,
        session_file,
        workspace.is_some(),
        ssh_connection_id,
        runtime_id,
    )
    .await
}

/// 远程分支（契约 §3.1 与多后端契约 §5.1）：跳过本地目录校验与
/// pi_locate::detect，先做连接一致性校验与远程目录检查，再经
/// remote_exec_stream 启动远端 `pi --mode rpc`。
async fn spawn_remote(
    app: AppHandle,
    state: &rpc::RpcState,
    project: &str,
    target: &ssh::RemoteTarget,
    session_file: Option<String>,
    has_workspace: bool,
    ssh_connection_id: Option<String>,
    runtime_id: Option<String>,
) -> Result<(), String> {
    let Some(connection_id) = ssh_connection_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return Err(pix_error("sshConnectionMissing", "远程项目没有匹配的 SSH 连接"));
    };
    let connection = ssh::config::find_connection(&connection_id)?.ok_or_else(|| {
        pix_error("sshConnectionNotFound", "SSH 连接不存在，可能已被删除")
    })?;
    // 连接 kind 与 URI 解析结果的 kind 必须一致，再按 kind 比对应字段
    //（ssh: host/port/user；wsl: distro/user；docker: container），
    // 两层冗余防止前端错配（多后端契约 §5.1 第 3 条）。
    if !connection_matches_remote(&connection, target) {
        return Err(pix_error("sshConnectionMismatch", "SSH 连接配置与项目地址不一致"));
    }
    // 远程项目 P1 不支持多目录组（前端保证传 null，这里防御性兜底）。
    if has_workspace {
        return Err(pix_error("sshWorkspaceUnsupported", "SSH 远程项目暂不支持多目录工作区"));
    }
    let endpoint = connection.to_remote_endpoint();
    // 远程目录校验：三后端同一脚本，一次 exec `test -d`；exit 1 →
    // projectDirMissing（复用现有键与文案），其余失败按端点 kind 归类
    //（多后端契约 §5.1 第 5 条；wsl/docker 的退出码传播已实测 V4）。
    let script = format!("test -d {}", ssh::posix_quote(target.path()));
    if let Err(e) = ssh::remote_exec(&endpoint, &script, Duration::from_secs(15)).await {
        if e.kind == SshErrorKind::Remote && e.exit_code == Some(1) {
            return Err(pix_error("projectDirMissing", "项目目录不存在"));
        }
        return Err(remote_error_coded(&endpoint, &e));
    }
    let spec = rpc::RemoteSpawnSpec {
        endpoint: endpoint.clone(),
        remote_path: target.path().to_string(),
    };
    // P1 远程 extra_args 恒为空（builtin extensions 不上传），workspace 不设。
    rpc::spawn(
        app,
        state,
        &rpc::SpawnProgram::Remote(spec),
        project,
        session_file,
        Vec::new(),
        None,
        runtime_id,
    )
    .await?;
    // 成功 spawn 记 lastUsedAt；写回失败不影响会话。
    let _ = ssh::config::touch_connection(&connection_id);
    Ok(())
}

#[tauri::command]
pub async fn rpc_request(
    state: State<'_, rpc::RpcState>,
    command: Value,
    runtime_id: Option<String>,
) -> Result<Value, String> {
    rpc::request(&state, command, runtime_id.as_deref()).await
}

#[tauri::command]
pub async fn rpc_notify(
    state: State<'_, rpc::RpcState>,
    command: Value,
    runtime_id: Option<String>,
) -> Result<(), String> {
    rpc::notify(&state, command, runtime_id.as_deref()).await
}

#[tauri::command]
pub async fn rpc_kill(
    state: State<'_, rpc::RpcState>,
    runtime_id: Option<String>,
) -> Result<(), String> {
    rpc::kill(&state, runtime_id.as_deref()).await
}

#[tauri::command]
pub async fn rpc_running(
    state: State<'_, rpc::RpcState>,
    runtime_id: Option<String>,
) -> Result<bool, String> {
    Ok(rpc::running(&state, runtime_id.as_deref()).await)
}

#[tauri::command]
pub async fn rpc_sessions(state: State<'_, rpc::RpcState>) -> Result<Vec<Value>, String> {
    Ok(rpc::list(&state).await)
}

#[tauri::command]
pub async fn pi_settings_get() -> Result<Value, String> {
    tokio::task::spawn_blocking(|| crate::pi_data::call(serde_json::json!({"op": "settings_get"})))
        .await
        .map_err(|e| pix_error_detail("settingsReadFailed", "读取 Pi 设置失败: {detail}", e))?
}

#[tauri::command]
pub async fn pi_settings_save(settings: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        crate::pi_data::call(serde_json::json!({"op": "settings_save", "settings": settings}))
    })
    .await
    .map_err(|e| pix_error_detail("settingsWriteFailed", "保存 Pi 设置失败: {detail}", e))??;
    Ok(())
}

/// Frontend decision-point logging (notifications, watcher rebuilds, exits).
/// Best-effort diagnostics; must never fail the caller.
#[tauri::command]
pub fn pix_log(message: String, runtime_id: Option<String>) {
    crate::logs::write(&runtime_id.unwrap_or_else(|| "ui".into()), &message);
}

/// 应用当前版本号；远程浏览器拿不到 Tauri 的 getVersion，由命令统一提供。
#[tauri::command]
pub fn app_version_get(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_rejects_empty_or_missing_project_dir() {
        // 空串会传导到 CreateProcessW 并报 os error 123，必须在 spawn 前拦截。
        assert!(validate_project_dir("").is_err());
        assert!(validate_project_dir("   ").is_err());
        assert!(validate_project_dir("Z:/definitely/missing/dir").is_err());
        let dir = std::env::temp_dir().join(format!("pix-spawn-proj-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(validate_project_dir(dir.to_str().unwrap()).is_ok());
        std::fs::remove_dir(dir).unwrap();
    }
}
