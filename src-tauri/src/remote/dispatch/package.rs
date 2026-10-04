//! Package management commands.

use super::{handled, text, to_json, UNHANDLED};
use serde_json::{json, Value};
use tauri::AppHandle;

pub(super) async fn handle(
    app: &AppHandle,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "package_catalog" => Ok(to_json(
                crate::packages::package_catalog(
                    a["query"].as_str().map(str::to_owned),
                    a["sort"].as_str().map(str::to_owned),
                    a["packageType"].as_str().map(str::to_owned),
                    a["page"].as_u64().and_then(|page| u32::try_from(page).ok()),
                )
                .await?,
            )?),
            "package_list" => Ok(to_json(crate::packages::package_list(
                a["project"].as_str().map(str::to_owned),
            ))?),
            "package_install" => Ok(Value::String(
                crate::packages::package_install(
                    app.clone(),
                    text(a, "source")?,
                    a["scope"].as_str().map(str::to_owned),
                    a["project"].as_str().map(str::to_owned),
                )
                .await?,
            )),
            "package_remove" => Ok(Value::String(
                crate::packages::package_remove(
                    app.clone(),
                    text(a, "source")?,
                    a["scope"].as_str().map(str::to_owned),
                    a["project"].as_str().map(str::to_owned),
                )
                .await?,
            )),
            "package_update" => Ok(Value::String(
                crate::packages::package_update(app.clone(), a["source"].as_str().map(str::to_owned))
                    .await?,
            )),
            "package_resources" => Ok(to_json(crate::packages::package_resources(
                text(a, "source")?,
                text(a, "scope")?,
                a["project"].as_str().map(str::to_owned),
            )?)?),
            "package_list_files" => Ok(json!(crate::packages::package_list_files(
                text(a, "source")?,
                text(a, "scope")?,
                a["project"].as_str().map(str::to_owned),
            )?)),
            "package_read_file" => Ok(json!(crate::packages::package_read_file(
                text(a, "source")?,
                text(a, "scope")?,
                text(a, "path")?,
                a["project"].as_str().map(str::to_owned),
            )?)),
            "package_set_resource" => {
                crate::packages::package_set_resource(
                    text(a, "source")?,
                    text(a, "scope")?,
                    a["project"].as_str().map(str::to_owned),
                    text(a, "resourceType")?,
                    text(a, "path")?,
                    a["enabled"]
                        .as_bool()
                        .ok_or_else(|| crate::errors::pix_error("missingEnabled", "缺少 enabled 参数"))?,
                )?;
                Ok(Value::Null)
            }
            "package_translate" => Ok(json!(crate::packages::package_translate(
                app.clone(),
                text(a, "content")?,
                text(a, "targetLang")?,
            )
            .await?)),
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
