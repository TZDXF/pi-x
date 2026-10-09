//! Workspace commands: git worktrees and artifact-based file rewind.

use super::{handled, text, to_json, UNHANDLED};
use crate::errors::{pix_error, pix_error_with};
use serde_json::{json, Value};
use tauri::AppHandle;

pub(super) async fn handle(app: &AppHandle, cmd: &str, a: &Value) -> Option<Result<Value, String>> {
    handled(
        async {
            match cmd {
                "workspace_git_info" => Ok(to_json(
                    crate::workspace_git::workspace_git_info(text(a, "project")?).await?,
                )?),
                "workspace_git_create" => Ok(Value::String(
                    crate::workspace_git::workspace_git_create(
                        app.clone(),
                        text(a, "project")?,
                        text(a, "branch")?,
                        a["worktree"]
                            .as_bool()
                            .ok_or_else(|| pix_error("missingWorktree", "缺少 worktree 参数"))?,
                    )
                    .await?,
                )),
                "workspace_git_prepare" => Ok(Value::String(
                    crate::workspace_git::workspace_git_prepare(
                        app.clone(),
                        text(a, "project")?,
                        text(a, "branch")?,
                        a["worktree"]
                            .as_bool()
                            .ok_or_else(|| pix_error("missingWorktree", "缺少 worktree 参数"))?,
                    )
                    .await?,
                )),
                "session_file_rewind_preview" => {
                    let artifacts: Vec<crate::session_file_rewind::FileRewindArtifact> =
                        serde_json::from_value(a["artifacts"].clone()).map_err(|e| {
                            pix_error_with(
                                "missingArtifacts",
                                format!("缺少 artifacts 参数: {e}"),
                                json!({ "detail": e.to_string() }),
                            )
                        })?;
                    Ok(to_json(
                        crate::session_file_rewind::session_file_rewind_preview(
                            text(a, "project")?,
                            artifacts,
                        )
                        .await?,
                    )?)
                }
                "session_file_rewind_apply" => {
                    let artifacts: Vec<crate::session_file_rewind::FileRewindArtifact> =
                        serde_json::from_value(a["artifacts"].clone()).map_err(|e| {
                            pix_error_with(
                                "missingArtifacts",
                                format!("缺少 artifacts 参数: {e}"),
                                json!({ "detail": e.to_string() }),
                            )
                        })?;
                    Ok(to_json(
                        crate::session_file_rewind::session_file_rewind_apply(
                            text(a, "project")?,
                            artifacts,
                            a["file"].as_str().map(str::to_owned),
                        )
                        .await?,
                    )?)
                }
                "session_file_rewind_state_get" => Ok(to_json(
                    crate::session_file_rewind::session_file_rewind_state_get(text(a, "file")?)
                        .await?,
                )?),
                _ => return Err(UNHANDLED.to_owned()),
            }
        }
        .await,
    )
}
