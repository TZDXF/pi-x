//! Application config (`config.json`): model refs, update channel, feature
//! switches and the projectless working directory.

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::AppHandle;

use crate::errors::{pix_error_detail, pix_error_with};

/// A provider/model pair selected in the app configuration.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider: String,
    pub model_id: String,
}

/// PiX 应用自身的更新通道：正式版（语义化版本）或预览版（每日日期版本号）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Preview,
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AppConfig {
    #[serde(rename = "piPath", default, skip_serializing_if = "Option::is_none")]
    pub pi_path: Option<String>,
    #[serde(
        rename = "lastProject",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub last_project: Option<String>,
    /// 应用自身更新通道，见 `app_update` 模块。
    #[serde(
        rename = "updateChannel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub update_channel: Option<UpdateChannel>,
    /// Default model for auxiliary features such as title generation.
    /// Independent of pi's own default model in `settings.json`.
    #[serde(
        rename = "defaultModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub default_model: Option<ModelRef>,
    /// Custom title model; ignored while `title_follow_main` is set.
    #[serde(
        rename = "titleModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub title_model: Option<ModelRef>,
    /// Title generation follows the default model instead of `title_model`.
    #[serde(rename = "titleFollowMain", default, skip_serializing_if = "is_false")]
    pub title_follow_main: bool,
    /// Translation model for package resource file content translation.
    #[serde(
        rename = "translationModel",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub translation_model: Option<ModelRef>,
    /// 无项目会话的工作目录；缺省为 `~/.pix/workspace`。
    #[serde(
        rename = "projectlessDir",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub projectless_dir: Option<String>,
    /// 新会话创建 worktree 的父目录；支持绝对路径与相对项目的相对路径。
    /// 缺省为项目根目录下的 `.pix-worktrees`。
    #[serde(
        rename = "worktreeDir",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub worktree_dir: Option<String>,
    /// PiX 内置的 pi extension 开关；缺省为启用。
    #[serde(
        rename = "builtinFileChanges",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub builtin_file_changes: Option<bool>,
    /// PiX 内置的延迟发送插件开关；缺省为启用。
    #[serde(
        rename = "builtinDelayedSend",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub builtin_delayed_send: Option<bool>,
    /// 多目录项目组开关；缺省为启用。关闭后会话不再注入工作区清单，
    /// 「添加项目」退化为直接选择单目录。
    #[serde(
        rename = "workspaceGroups",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub workspace_groups: Option<bool>,
}

fn is_false(v: &bool) -> bool {
    !*v
}

fn config_path(_app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = crate::data_dir::root();
    Ok(dir.join("config.json"))
}

fn write_config(path: &std::path::Path, config: &AppConfig) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            pix_error_detail("configDirCreateFailed", "无法创建配置目录: {detail}", e)
        })?;
    }
    let body = serde_json::to_string_pretty(config)
        .map_err(|e| pix_error_detail("configSerializeFailed", "配置序列化失败: {detail}", e))?;
    // 原子写：中途崩溃不会留下截断的 config.json。
    crate::atomic_write::write(path, body.as_bytes())
        .map_err(|e| pix_error_detail("configWriteFailed", "无法写入配置文件: {detail}", e))
}

#[tauri::command]
pub fn app_config_get(app: AppHandle) -> Result<AppConfig, String> {
    let path = config_path(&app)?;
    if !path.exists() {
        return Ok(AppConfig::default());
    }
    let raw = std::fs::read_to_string(path)
        .map_err(|e| pix_error_detail("configReadFailed", "无法读取配置文件: {detail}", e))?;
    serde_json::from_str(&raw)
        .map_err(|e| pix_error_detail("configParseFailed", "配置文件解析失败: {detail}", e))
}

#[tauri::command]
pub fn app_config_save(app: AppHandle, config: AppConfig) -> Result<(), String> {
    write_config(&config_path(&app)?, &config)
}

/// 无项目会话的工作目录：`dir` 为实际使用路径，`default_dir` 用于设置页展示与「恢复默认」。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectlessDirInfo {
    pub dir: String,
    pub default_dir: String,
    pub is_default: bool,
}

/// 解析并确保无项目会话目录存在；会话在该目录中运行，pi 的会话记录仍按 cwd 归档。
#[tauri::command]
pub fn projectless_dir_resolve(app: AppHandle) -> Result<ProjectlessDirInfo, String> {
    let configured = app_config_get(app)?.projectless_dir;
    let dir = crate::data_dir::resolve_projectless_dir(configured.as_deref());
    std::fs::create_dir_all(&dir).map_err(|e| {
        pix_error_with(
            "projectlessDirUnusable",
            "无法使用无项目会话目录 {dir}: {detail}",
            json!({ "dir": dir.display().to_string(), "detail": e.to_string() }),
        )
    })?;
    // 规范化后再返回：会话列表按 cwd 精确匹配，短路径/符号链接会造成两份记录。
    let resolved = dunce::canonicalize(&dir).unwrap_or(dir);
    let default_dir = crate::data_dir::default_projectless_dir();
    let is_default =
        resolved == dunce::canonicalize(&default_dir).unwrap_or_else(|_| default_dir.clone());
    Ok(ProjectlessDirInfo {
        dir: resolved.to_string_lossy().into_owned(),
        default_dir: default_dir.to_string_lossy().into_owned(),
        is_default,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_config_does_not_keep_pi_owned_fields() {
        let config = AppConfig {
            pi_path: Some("pi".into()),
            ..Default::default()
        };
        let value = serde_json::to_value(config).unwrap();
        assert_eq!(value["piPath"], "pi");
        assert!(value.get("managedSkills").is_none());
        assert!(value.get("defaultModel").is_none());
    }

    #[test]
    fn app_config_round_trips_projectless_dir_and_stays_compatible() {
        let config = AppConfig {
            projectless_dir: Some("D:/pix/scratch".into()),
            worktree_dir: Some("../trees".into()),
            ..Default::default()
        };
        let value = serde_json::to_value(&config).unwrap();
        assert_eq!(value["projectlessDir"], "D:/pix/scratch");
        assert_eq!(value["worktreeDir"], "../trees");
        let parsed: AppConfig = serde_json::from_value(value).unwrap();
        assert_eq!(parsed.projectless_dir.as_deref(), Some("D:/pix/scratch"));
        assert_eq!(parsed.worktree_dir.as_deref(), Some("../trees"));
        // 未配置时不写入该字段；旧配置缺少它也应正常加载（用默认目录）。
        assert!(serde_json::to_value(AppConfig::default())
            .unwrap()
            .get("projectlessDir")
            .is_none());
        assert!(serde_json::to_value(AppConfig::default())
            .unwrap()
            .get("worktreeDir")
            .is_none());
        let legacy: AppConfig = serde_json::from_str(r#"{"lastProject":"C:/code"}"#).unwrap();
        assert_eq!(legacy.projectless_dir, None);
        assert_eq!(legacy.worktree_dir, None);
    }
}
