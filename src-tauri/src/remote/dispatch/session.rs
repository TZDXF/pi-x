//! Session and pi-process commands (rpc spawn/kill/request, session CRUD,
//! export and title generation).

use super::{handled, text, to_json, UNHANDLED};
use crate::errors::pix_error;
use crate::rpc;
use serde_json::{json, Value};
use tauri::{AppHandle, State};

pub(super) async fn handle(
    app: &AppHandle,
    state: State<'_, rpc::RpcState>,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "rpc_spawn" => {
                crate::commands::rpc_spawn(
                    app.clone(),
                    state.clone(),
                    text(a, "project")?,
                    a["sessionFile"].as_str().map(str::to_owned),
                    a["runtimeId"].as_str().map(str::to_owned),
                    serde_json::from_value(a["workspace"].clone()).map_err(|e| e.to_string())?,
                )
                .await?;
                Ok(Value::Null)
            }
            "rpc_sessions" => Ok(json!(rpc::list(&state).await)),
            "rpc_running" => Ok(json!(rpc::running(&state, a["runtimeId"].as_str()).await)),
            "rpc_kill" => {
                rpc::kill(&state, a["runtimeId"].as_str()).await?;
                Ok(Value::Null)
            }
            "pix_log" => {
                crate::logs::write(
                    a["runtimeId"].as_str().unwrap_or("ui"),
                    a["message"].as_str().unwrap_or(""),
                );
                Ok(Value::Null)
            }
            "rpc_request" => {
                rpc::request(&state, a["command"].clone(), a["runtimeId"].as_str()).await
            }
            // A remote browser cannot open host files. Export either the requested
            // saved session directly or the active runtime, then return its HTML.
            "session_export_html" => {
                let (path, temporary) = if let Some(file) = a["file"].as_str() {
                    (
                        crate::commands::session_export_file(file.to_owned(), None).await?,
                        true,
                    )
                } else {
                    let response = rpc::request(
                        &state,
                        json!({"type": "export_html"}),
                        a["runtimeId"].as_str(),
                    )
                    .await?;
                    if response["success"] != true {
                        return Err(response["error"]
                            .as_str()
                            .unwrap_or("Export failed")
                            .to_owned());
                    }
                    (
                        response["data"]["path"]
                            .as_str()
                            .ok_or("Export returned no path")?
                            .to_owned(),
                        false,
                    )
                };
                let html = std::fs::read_to_string(&path)
                    .map_err(|e| format!("Cannot read exported HTML: {e}"));
                if temporary {
                    let _ = std::fs::remove_file(&path);
                }
                let download_name = if temporary {
                    let file = a["file"].as_str().ok_or("Missing session file")?;
                    let stem = std::path::Path::new(file)
                        .file_stem()
                        .and_then(|s| s.to_str())
                        .ok_or("Invalid session name")?;
                    format!("pi-session-{stem}.html")
                } else {
                    path
                };
                Ok(json!({"path": download_name, "html": html?}))
            }
            "rpc_notify" => {
                rpc::notify(&state, a["command"].clone(), a["runtimeId"].as_str()).await?;
                Ok(Value::Null)
            }
            "session_generate_title" => {
                let title = crate::title_generation::session_generate_title(
                    app.clone(),
                    text(a, "file")?,
                    text(a, "message")?,
                    a["overwrite"].as_bool(),
                )
                .await?;
                Ok(to_json(title)?)
            }
            "session_update" => {
                let mtime = crate::sessions::session_update(
                    app.clone(),
                    text(a, "file")?,
                    a["title"].as_str().map(String::from),
                    a["archived"]
                        .as_bool()
                        .ok_or_else(|| pix_error("missingArchived", "缺少 archived 参数"))?,
                )
                .await?;
                Ok(json!(mtime))
            }
            "session_mtime" => Ok(json!(
                crate::sessions::session_mtime(text(a, "file")?).await?
            )),
            "session_delete" => {
                crate::sessions::session_delete(text(a, "file")?).await?;
                Ok(Value::Null)
            }
            "session_duplicate" => Ok(Value::String(
                crate::sessions::session_duplicate(text(a, "file")?).await?,
            )),
            "session_last_error" => Ok(to_json(
                crate::sessions::session_last_error(text(a, "file")?).await?,
            )?),
            "session_history" => Ok(Value::Array(
                crate::sessions::session_history(text(a, "file")?).await?,
            )),
            "session_list" => Ok(to_json(crate::commands::session_list(text(a, "project")?).await?)?),
            "session_list_archived" => {
                Ok(to_json(crate::sessions::session_list_archived().await?)?)
            }
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
