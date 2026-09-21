use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use crate::{fs_search, pi_locate, rpc, sessions, trust};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    #[serde(rename = "piPath", default, skip_serializing_if = "Option::is_none")]
    pub pi_path: Option<String>,
    #[serde(rename = "lastProject", default, skip_serializing_if = "Option::is_none")]
    pub last_project: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("config.json"))
}

#[tauri::command]
pub fn app_config_get(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_config_save(app: AppHandle, config: AppConfig) -> Result<(), String> {
    let path = config_path(&app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, body).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_detect(custom_path: Option<String>) -> pi_locate::PiInfo {
    pi_locate::detect(custom_path).await
}

#[tauri::command]
pub async fn trust_status(project: String) -> Result<Value, String> {
    trust::status(&project).await
}

#[tauri::command]
pub async fn trust_save(project: String, trusted: bool, trust_parent: bool) -> Result<Value, String> {
    trust::save(&project, trusted, trust_parent).await
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
) -> Result<(), String> {
    let cfg = app_config_get(app.clone())?;
    let info = pi_locate::detect(cfg.pi_path).await;
    if !info.found {
        return Err(
            "pi not found. Install it with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
                .to_string(),
        );
    }
    rpc::spawn(app, &state, &info, &project, session_file).await
}

/// List recent stored sessions for a project (newest first).
#[tauri::command]
pub async fn session_list(project: String) -> Result<Vec<sessions::SessionMeta>, String> {
    sessions::list(project).await
}

/// Search project files for @file mention completion.
#[tauri::command]
pub async fn search_files(project: String, query: String) -> Result<Vec<fs_search::FileHit>, String> {
    fs_search::search(project, query).await
}

/// Open a file or directory with the system default handler.
#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rpc_request(state: State<'_, rpc::RpcState>, command: Value) -> Result<Value, String> {
    rpc::request(&state, command).await
}

#[tauri::command]
pub async fn rpc_notify(state: State<'_, rpc::RpcState>, command: Value) -> Result<(), String> {
    rpc::notify(&state, command).await
}

#[tauri::command]
pub async fn rpc_kill(state: State<'_, rpc::RpcState>) -> Result<(), String> {
    rpc::kill(&state).await
}

#[tauri::command]
pub async fn rpc_running(state: State<'_, rpc::RpcState>) -> Result<bool, String> {
    Ok(rpc::running(&state).await)
}
