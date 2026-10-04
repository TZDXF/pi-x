//! Application-level commands: settings, app config, trust, prompts, models,
//! MCP config, file browsing and editor integration.

use super::{handled, text, to_json, UNHANDLED};
use crate::commands;
use serde_json::{json, Value};
use tauri::AppHandle;

pub(super) async fn handle(
    app: &AppHandle,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "pi_settings_get" => crate::commands::pi_settings_get().await,
            "pi_settings_save" => {
                crate::commands::pi_settings_save(a["settings"].clone()).await?;
                Ok(Value::Null)
            }
            "app_config_get" => to_json(crate::commands::app_config_get(app.clone())?),
            "app_config_save" => {
                let mut cfg = crate::commands::app_config_get(app.clone())?;
                apply_remote_app_config(&mut cfg, &a["config"]);
                crate::commands::app_config_save(app.clone(), cfg)?;
                Ok(Value::Null)
            }
            "projectless_dir_resolve" => Ok(to_json(crate::commands::projectless_dir_resolve(
                app.clone(),
            )?)?),
            "pi_detect" => Ok(to_json(
                crate::commands::pi_detect(crate::commands::app_config_get(app.clone())?.pi_path)
                    .await,
            )?),
            "trust_status" => crate::commands::trust_status(text(a, "project")?).await,
            "trust_save" => {
                crate::commands::trust_save(
                    text(a, "project")?,
                    a["trusted"].as_bool().ok_or("Missing trusted")?,
                    a["trustParent"].as_bool().unwrap_or(false),
                )
                .await
            }
            "global_prompt_list" => Ok(to_json(crate::commands::global_prompt_list()?)?),
            "global_prompt_save" => {
                crate::commands::global_prompt_save(text(a, "fileName")?, text(a, "prompt")?)?;
                Ok(Value::Null)
            }
            "models_config_get" => crate::commands::models_config_get(),
            "models_config_save" => {
                crate::commands::models_config_save(a["config"].clone())?;
                Ok(Value::Null)
            }
            "models_fetch" => Ok(to_json(crate::commands::models_fetch(a["provider"].clone()).await?)?),
            "mcp_config_read" => Ok(to_json(crate::mcp::mcp_config_read(
                text(a, "scope")?,
                a["project"].as_str().map(str::to_owned),
            )?)?),
            "mcp_config_save" => {
                crate::mcp::mcp_config_save(
                    text(a, "scope")?,
                    text(a, "content")?,
                    a["project"].as_str().map(str::to_owned),
                )?;
                Ok(Value::Null)
            }
            "mcp_status" => Ok(to_json(
                crate::mcp::mcp_status(app.clone(), a["project"].as_str().map(str::to_owned)).await?,
            )?),
            "mcp_check" => Ok(to_json(
                crate::mcp::mcp_check(
                    text(a, "scope")?,
                    text(a, "name")?,
                    a["project"].as_str().map(str::to_owned),
                )
                .await?,
            )?),
            "detect_editors" => Ok(to_json(crate::editor::detect_editors())?),
            "editor_icons" => Ok(to_json(crate::editor_icon::editor_icons().await?)?),
            "preview_proxy_info" => {
                Ok(json!({ "base": format!("/api/preview/{}", crate::preview_proxy::secret()) }))
            }
            "list_project_directory" => Ok(to_json(
                crate::commands::list_project_directory(text(a, "project")?, text(a, "path")?).await?,
            )?),
            "read_file_preview" => Ok(to_json(
                crate::commands::read_file_preview(text(a, "project")?, text(a, "path")?).await?,
            )?),
            "search_files" => Ok(to_json(
                crate::commands::search_files(text(a, "project")?, text(a, "query")?).await?,
            )?),
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}

fn parse_model_ref(v: &Value) -> Option<commands::ModelRef> {
    serde_json::from_value(v.clone()).ok()
}
fn apply_remote_app_config(cfg: &mut commands::AppConfig, config: &Value) {
    cfg.last_project = config["lastProject"].as_str().map(str::to_owned);
    // 远程端不可改 piPath 等主机环境；其余应用配置与桌面端保持一致。
    cfg.projectless_dir = config["projectlessDir"].as_str().map(str::to_owned);
    cfg.worktree_dir = config["worktreeDir"].as_str().map(str::to_owned);
    cfg.default_model = parse_model_ref(&config["defaultModel"]);
    cfg.title_model = parse_model_ref(&config["titleModel"]);
    cfg.title_follow_main = config["titleFollowMain"].as_bool().unwrap_or(false);
    cfg.translation_model = parse_model_ref(&config["translationModel"]);
    if let Ok(channel) =
        serde_json::from_value::<commands::UpdateChannel>(config["updateChannel"].clone())
    {
        cfg.update_channel = Some(channel);
    }
    if let Some(enabled) = config["builtinFileChanges"].as_bool() {
        cfg.builtin_file_changes = Some(enabled);
    }
    if let Some(enabled) = config["builtinDelayedSend"].as_bool() {
        cfg.builtin_delayed_send = Some(enabled);
    }
    // 完整配置保存：字段省略时清除旧值，恢复默认启用，而不是保留旧开关。
    cfg.workspace_groups = config["workspaceGroups"].as_bool();
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_workspace_groups_round_trip(next: Option<bool>) {
        for previous in [None, Some(false), Some(true)] {
            let mut cfg = commands::AppConfig {
                pi_path: Some("host-pi".to_owned()),
                workspace_groups: previous,
                ..Default::default()
            };
            let mut request = serde_json::to_value(&cfg).unwrap();
            match next {
                Some(enabled) => request["workspaceGroups"] = json!(enabled),
                None => {
                    request.as_object_mut().unwrap().remove("workspaceGroups");
                }
            }
            apply_remote_app_config(&mut cfg, &request);

            // 与 app_config_save/get 相同的 JSON 往返，不触碰主机配置文件。
            let saved = serde_json::to_string_pretty(&cfg).unwrap();
            let loaded: commands::AppConfig = serde_json::from_str(&saved).unwrap();
            assert_eq!(loaded.workspace_groups, next);
            assert_eq!(
                loaded.workspace_groups.unwrap_or(true),
                next.unwrap_or(true)
            );
            let response = serde_json::to_value(&loaded).unwrap();
            assert_eq!(
                response.get("workspaceGroups"),
                next.map(|v| json!(v)).as_ref()
            );
            assert_eq!(loaded.pi_path.as_deref(), Some("host-pi"));
        }
    }

    #[test]
    fn remote_workspace_groups_false_round_trip() {
        assert_workspace_groups_round_trip(Some(false));
    }

    #[test]
    fn remote_workspace_groups_true_round_trip() {
        assert_workspace_groups_round_trip(Some(true));
    }

    #[test]
    fn remote_workspace_groups_omitted_restores_default_round_trip() {
        assert_workspace_groups_round_trip(None);
    }

    #[test]
    fn remote_app_config_preserves_host_pi_path() {
        for request in [
            json!({}),
            json!({"piPath": "remote-pi", "workspaceGroups": false}),
        ] {
            let mut cfg = commands::AppConfig {
                pi_path: Some("host-pi".to_owned()),
                ..Default::default()
            };
            apply_remote_app_config(&mut cfg, &request);
            assert_eq!(cfg.pi_path.as_deref(), Some("host-pi"));
        }
    }
}
