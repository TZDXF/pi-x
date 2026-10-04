//! pi detection and trust, RPC spawn/passthrough to the per-runtime process
//! pool, pi settings and frontend diagnostics logging.

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::errors::{pix_error, pix_error_detail};
use crate::{pi_locate, rpc, trust};

use super::config::app_config_get;
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

/// Spawn `pi --mode rpc` for `project`, resolving the pi executable from app
/// config (falling back to auto-detection). `session_file` optionally resumes
/// a stored session via `--session <path>`.
#[tauri::command]
pub async fn rpc_spawn(
    app: AppHandle,
    state: State<'_, rpc::RpcState>,
    project: String,
    session_file: Option<String>,
    runtime_id: Option<String>,
    workspace: Option<WorkspaceContext>,
) -> Result<(), String> {
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
    rpc::spawn(
        app,
        &state,
        &info,
        &project,
        session_file,
        Vec::new(),
        workspace_manifest,
        runtime_id,
    )
    .await
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
