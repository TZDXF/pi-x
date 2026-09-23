use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::{fs_search, pi_locate, rpc, sessions, trust};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    #[serde(rename = "piPath", default, skip_serializing_if = "Option::is_none")]
    pub pi_path: Option<String>,
    #[serde(rename = "lastProject", default, skip_serializing_if = "Option::is_none")]
    pub last_project: Option<String>,
    #[serde(rename = "titleModel", default, skip_serializing_if = "Option::is_none")]
    pub title_model: Option<crate::title_generation::TitleModel>,
    /// Title generation follows the default model instead of `title_model`.
    #[serde(rename = "titleFollowMain", default, skip_serializing_if = "is_false")]
    pub title_follow_main: bool,
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn config_path(_app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::data_dir::root();
    Ok(dir.join("config.json"))
}

fn global_prompt_path() -> std::path::PathBuf {
    trust::agent_dir().join("SYSTEM.md")
}

fn write_config(path: &std::path::Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_config_get(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn app_config_save(app: AppHandle, config: AppConfig) -> Result<(), String> {
    write_config(&config_path(&app)?, &config)
}

#[tauri::command]
pub fn global_prompt_get() -> Result<String, String> {
    read_global_prompt(&global_prompt_path())
}

fn read_global_prompt(path: &std::path::Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path)
        .map(|s| s.trim_start_matches('\u{feff}').to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn global_prompt_save(prompt: String) -> Result<(), String> {
    save_global_prompt(&global_prompt_path(), &prompt)
}

fn save_global_prompt(path: &std::path::Path, prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, prompt).map_err(|e| e.to_string())
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
    runtime_id: Option<String>,
) -> Result<(), String> {
    let cfg = app_config_get(app.clone())?;
    let extra_args = Vec::new();
    let info = pi_locate::detect(cfg.pi_path).await;
    if !info.found {
        return Err(
            "pi not found. Install it with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
                .to_string(),
        );
    }
    rpc::spawn(app, &state, &info, &project, session_file, extra_args, runtime_id).await
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
pub async fn rpc_request(state: State<'_, rpc::RpcState>, command: Value, runtime_id: Option<String>) -> Result<Value, String> {
    rpc::request(&state, command, runtime_id.as_deref()).await
}

#[tauri::command]
pub async fn rpc_notify(state: State<'_, rpc::RpcState>, command: Value, runtime_id: Option<String>) -> Result<(), String> {
    rpc::notify(&state, command, runtime_id.as_deref()).await
}

#[tauri::command]
pub async fn rpc_kill(state: State<'_, rpc::RpcState>, runtime_id: Option<String>) -> Result<(), String> {
    rpc::kill(&state, runtime_id.as_deref()).await
}

#[tauri::command]
pub async fn rpc_running(state: State<'_, rpc::RpcState>, runtime_id: Option<String>) -> Result<bool, String> {
    Ok(rpc::running(&state, runtime_id.as_deref()).await)
}

// ---- pi models.json (custom provider / model management) ----

fn models_config_path() -> std::path::PathBuf {
    trust::agent_dir().join("models.json")
}

/// Read pi's `~/.pi/agent/models.json`. Returns `{ "providers": {} }` when the
/// file does not exist. The whole document is passed through as `Value` so
/// unknown fields (cost, compat, headers, samplingParams, modelOverrides, …)
/// survive a read/edit/save round trip untouched.
#[tauri::command]
pub fn models_config_get() -> Result<Value, String> {
    let path = models_config_path();
    if !path.exists() {
        return Ok(serde_json::json!({ "providers": {} }));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_str(&raw).map_err(|e| format!("models.json 解析失败: {e}"))?;
    if v.get("providers").is_none() {
        v["providers"] = serde_json::json!({});
    }
    Ok(v)
}

/// Write pi's `~/.pi/agent/models.json` (2-space pretty JSON + trailing newline,
/// matching pi's own file style). pi re-reads this file whenever the model
/// picker opens, so changes take effect without a restart.
#[tauri::command]
pub fn models_config_save(config: Value) -> Result<(), String> {
    let path = models_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let body = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, format!("{body}\n")).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_settings_get() -> Result<Value, String> {
    tokio::task::spawn_blocking(|| crate::pi_data::call(serde_json::json!({"op": "settings_get"})))
        .await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn pi_settings_save(settings: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || crate::pi_data::call(serde_json::json!({"op": "settings_save", "settings": settings})))
        .await.map_err(|e| e.to_string())??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn app_config_does_not_keep_pi_owned_fields() {
        let config = AppConfig { pi_path: Some("pi".into()), ..Default::default() };
        let value = serde_json::to_value(config).unwrap();
        assert_eq!(value["piPath"], "pi");
        assert!(value.get("managedSkills").is_none());
        assert!(value.get("defaultModel").is_none());
    }
    #[test]
    fn saving_blank_global_prompt_removes_pi_file() {
        let root = std::env::temp_dir().join(format!("pix-prompt-{}", uuid::Uuid::new_v4()));
        let path = root.join("SYSTEM.md");
        save_global_prompt(&path, " 中文 ").unwrap();
        assert_eq!(read_global_prompt(&path).unwrap(), " 中文 ");
        save_global_prompt(&path, " \n").unwrap();
        assert!(!path.exists());
        std::fs::remove_dir(root).unwrap();
    }
}

#[tauri::command]
pub async fn rpc_sessions(state: State<'_, rpc::RpcState>) -> Result<Vec<Value>, String> {
    Ok(rpc::list(&state).await)
}
