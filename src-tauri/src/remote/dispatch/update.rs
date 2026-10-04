//! Update commands: app version/updates and pi updates.

use super::{handled, to_json, UNHANDLED};
use serde_json::Value;
use tauri::AppHandle;

pub(super) async fn handle(
    app: &AppHandle,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "app_version_get" => Ok(serde_json::json!(crate::commands::app_version_get(app.clone()))),
            "app_update_check" => {
                let channel: crate::commands::UpdateChannel =
                    serde_json::from_value(a["channel"].clone())
                        .map_err(|e| format!("Invalid channel: {e}"))?;
                let status = crate::app_update::app_update_check(app.clone(), channel).await?;
                Ok(to_json(status)?)
            }
            "app_update_install" => {
                let channel: crate::commands::UpdateChannel =
                    serde_json::from_value(a["channel"].clone())
                        .map_err(|e| format!("Invalid channel: {e}"))?;
                crate::app_update::app_update_install(app.clone(), channel).await?;
                Ok(Value::Null)
            }
            "app_update_restart" => {
                crate::app_update::app_update_restart(app.clone())?;
                Ok(Value::Null)
            }
            "pi_update_check" => {
                let status = crate::pi_update::pi_update_check(app.clone()).await?;
                Ok(to_json(status)?)
            }
            "pi_update_execute" => {
                crate::pi_update::pi_update_execute(app.clone()).await?;
                Ok(Value::Null)
            }
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
