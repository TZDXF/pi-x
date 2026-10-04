//! Workspace commands: git worktrees, revert, file rewind and checkpoints.

use super::{handled, string_list, text, to_json, UNHANDLED};
use crate::errors::{pix_error, pix_error_with};
use serde_json::{json, Value};
use tauri::AppHandle;

pub(super) async fn handle(
    app: &AppHandle,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    handled(async {
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
            "session_revert_changes" => {
                let files: Vec<crate::session_revert::RevertFile> =
                    serde_json::from_value(a["files"].clone()).map_err(|e| {
                        pix_error_with(
                            "missingFiles",
                            format!("缺少 files 参数: {e}"),
                            json!({ "detail": e.to_string() }),
                        )
                    })?;
                Ok(to_json(
                    crate::session_revert::session_revert_changes(text(a, "project")?, files)
                        .await?,
                )?)
            }
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
                    crate::session_file_rewind::session_file_rewind_apply(text(a, "project")?, artifacts)
                        .await?,
                )?)
            }
            "session_file_rewind_state_get" => Ok(to_json(
                crate::session_file_rewind::session_file_rewind_state_get(text(a, "file")?).await?,
            )?),
            "session_file_rewind_state_mark" => {
                let ids = string_list(&a["toolCallIds"]).unwrap_or_default();
                Ok(to_json(
                    crate::session_file_rewind::session_file_rewind_state_mark(text(a, "file")?, ids)
                        .await?,
                )?)
            }
            "session_checkpoint_create" => Ok(to_json(
                crate::session_checkpoint::session_checkpoint_create(
                    text(a, "project")?,
                    text(a, "checkpointId")?,
                )
                .await?,
            )?),
            "session_checkpoint_diff" => Ok(to_json(
                crate::session_checkpoint::session_checkpoint_diff(
                    text(a, "project")?,
                    text(a, "from")?,
                    text(a, "to")?,
                )
                .await?,
            )?),
            "session_checkpoint_restore" => {
                let paths = string_list(&a["paths"]);
                let tool_files = string_list(&a["toolTouchedFiles"]);
                Ok(to_json(
                    crate::session_checkpoint::session_checkpoint_restore(
                        text(a, "project")?,
                        text(a, "from")?,
                        text(a, "to")?,
                        paths,
                        tool_files,
                    )
                    .await?,
                )?)
            }
            "session_checkpoint_manifest_get" => Ok(to_json(
                crate::session_checkpoint::session_checkpoint_manifest_get(text(a, "file")?).await?,
            )?),
            "session_checkpoint_manifest_set" => {
                crate::session_checkpoint::session_checkpoint_manifest_set(
                    text(a, "file")?,
                    a["manifest"].clone(),
                )
                .await?;
                Ok(Value::Null)
            }
            "session_checkpoint_manifest_delete" => {
                crate::session_checkpoint::session_checkpoint_manifest_delete(text(a, "file")?)
                    .await?;
                Ok(Value::Null)
            }
            "session_checkpoint_content" => Ok(to_json(
                crate::session_checkpoint::session_checkpoint_content(
                    text(a, "project")?,
                    text(a, "oid")?,
                    text(a, "path")?,
                )
                .await?,
            )?),
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
