use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

use crate::{fs_search, pi_locate, rpc, sessions, trust};

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    #[serde(rename = "minimizeToTray", default)]
    pub minimize_to_tray: bool,
    #[serde(rename = "closeToTray", default)]
    pub close_to_tray: bool,
    #[serde(rename = "closeNoticeShown", default)]
    pub close_notice_shown: bool,
    #[serde(rename = "piPath", default, skip_serializing_if = "Option::is_none")]
    pub pi_path: Option<String>,
    #[serde(rename = "lastProject", default, skip_serializing_if = "Option::is_none")]
    pub last_project: Option<String>,
    #[serde(rename = "titleModel", default, skip_serializing_if = "Option::is_none")]
    pub title_model: Option<crate::title_generation::TitleModel>,
    #[serde(rename = "globalPrompt", default)]
    pub global_prompt: String,
    /// None preserves Pi discovery; Some([]) disables all skills.
    #[serde(rename = "managedSkills", default)]
    pub managed_skills: Option<Vec<ManagedSkill>>,
    /// Title generation follows the default model instead of `title_model`.
    #[serde(rename = "titleFollowMain", default, skip_serializing_if = "is_false")]
    pub title_follow_main: bool,
    /// Main model: default for new conversations, followed by feature items.
    #[serde(rename = "defaultModel", default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<crate::title_generation::TitleModel>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ManagedSkill {
    pub path: String,
    pub enabled: bool,
}

/// Validate before replacing a running process, and pass each path as one argument.
pub fn runtime_args(config: &AppConfig) -> Result<Vec<String>, String> {
    let mut args = Vec::new();
    if let Some(skills) = &config.managed_skills {
        args.push("--no-skills".into());
        for skill in skills.iter().filter(|s| s.enabled) {
            let path = std::path::Path::new(&skill.path);
            if !path.is_absolute() || !path.is_file() {
                return Err(format!("Skill 文件不存在或不是绝对路径：{}", skill.path));
            }
            args.extend(["--skill".into(), skill.path.clone()]);
        }
    }
    Ok(args)
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn config_path(_app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::data_dir::root();
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
    let mut extra_args = runtime_args(&cfg)?;
    if !cfg.global_prompt.trim().is_empty() {
        let prompt_path = config_path(&app)?.with_file_name("global-prompt.md");
        std::fs::create_dir_all(prompt_path.parent().ok_or("Missing config directory")?)
            .map_err(|e| e.to_string())?;
        std::fs::write(&prompt_path, &cfg.global_prompt).map_err(|e| e.to_string())?;
        extra_args.extend(["--append-system-prompt".into(), prompt_path.to_string_lossy().into_owned()]);
    }
    let info = pi_locate::detect(cfg.pi_path).await;
    if !info.found {
        return Err(
            "pi not found. Install it with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
                .to_string(),
        );
    }
    rpc::spawn(app, &state, &info, &project, session_file, extra_args).await
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

// ---- pi models.json (custom provider / model management) ----

fn models_config_path() -> std::path::PathBuf {
    trust::agent_dir().join("models.json")
}

/// Read pi's `~/.pix/agent/models.json`. Returns `{ "providers": {} }` when the
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

/// Write pi's `~/.pix/agent/models.json` (2-space pretty JSON + trailing newline,
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

#[cfg(test)]
mod agent_config_tests {
    use super::*;

    #[test]
    fn old_config_keeps_automatic_discovery() {
        let config: AppConfig = serde_json::from_str(r#"{"piPath":"pi","lastProject":"demo"}"#).unwrap();
        assert!(config.global_prompt.is_empty());
        assert!(config.managed_skills.is_none());
        assert!(runtime_args(&config).unwrap().is_empty());
    }

    #[test]
    fn empty_manual_list_disables_discovery() {
        let config = AppConfig { managed_skills: Some(vec![]), ..Default::default() };
        assert_eq!(runtime_args(&config).unwrap(), vec!["--no-skills"]);
    }

    #[test]
    fn disabled_missing_skills_are_not_validated_or_loaded() {
        let config = AppConfig {
            managed_skills: Some(vec![ManagedSkill { path: "missing.md".into(), enabled: false }]),
            ..Default::default()
        };
        assert_eq!(runtime_args(&config).unwrap(), vec!["--no-skills"]);
    }

    #[test]
    fn enabled_relative_paths_are_rejected() {
        let config = AppConfig {
            managed_skills: Some(vec![ManagedSkill { path: "SKILL.md".into(), enabled: true }]),
            ..Default::default()
        };
        assert!(runtime_args(&config).is_err());
    }

    #[test]
    fn enabled_absolute_files_are_passed_as_separate_arguments() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml").to_string_lossy().into_owned();
        let config = AppConfig {
            global_prompt: "中文\nGlobal instruction".into(),
            managed_skills: Some(vec![ManagedSkill { path: path.clone(), enabled: true }]),
            ..Default::default()
        };
        assert_eq!(runtime_args(&config).unwrap(), vec!["--no-skills", "--skill", &path]);
        let roundtrip: AppConfig = serde_json::from_value(serde_json::to_value(&config).unwrap()).unwrap();
        assert_eq!(roundtrip.global_prompt, config.global_prompt);
        assert_eq!(runtime_args(&roundtrip).unwrap(), runtime_args(&config).unwrap());
    }
}
