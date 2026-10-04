//! Scheduled-task commands.

use super::{handled, text, to_json, UNHANDLED};
use crate::errors::pix_error_with;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub(super) async fn handle(
    app: &AppHandle,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "schedule_list" => Ok(to_json(
                crate::schedules::schedule_list(app.state::<crate::schedules::ScheduleState>())
                    .await?,
            )?),
            "schedule_save" => {
                let input: crate::schedules::TaskInput = serde_json::from_value(a["input"].clone())
                    .map_err(|e| {
                        pix_error_with("invalidTask", format!("任务参数无效: {e}"), json!({ "detail": e.to_string() }))
                    })?;
                let task = crate::schedules::schedule_save(
                    app.state::<crate::schedules::ScheduleState>(),
                    input,
                )
                .await?;
                Ok(to_json(task)?)
            }
            "schedule_delete" => {
                crate::schedules::schedule_delete(
                    app.state::<crate::schedules::ScheduleState>(),
                    text(a, "id")?,
                )
                .await?;
                Ok(Value::Null)
            }
            "schedule_run" => {
                crate::schedules::schedule_run(
                    app.clone(),
                    app.state::<crate::schedules::ScheduleState>(),
                    text(a, "id")?,
                )
                .await?;
                Ok(Value::Null)
            }
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
