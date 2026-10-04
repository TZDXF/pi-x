//! Terminal commands (remote terminals backed by the terminal module).

use super::{handled, text, UNHANDLED};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn term_id(a: &Value) -> Result<u32, String> {
    u32::try_from(a["id"].as_u64().ok_or("Missing id")?).map_err(|e| e.to_string())
}

pub(super) async fn handle(
    app: &AppHandle,
    cmd: &str,
    a: &Value,
) -> Option<Result<Value, String>> {
    handled(async {
        match cmd {
            "term_create" => {
                let cols = u16::try_from(a["cols"].as_u64().unwrap_or(80)).unwrap_or(80);
                let rows = u16::try_from(a["rows"].as_u64().unwrap_or(24)).unwrap_or(24);
                let id = crate::terminal::term_create(
                    app.clone(),
                    app.state::<crate::terminal::TerminalState>(),
                    text(a, "cwd")?,
                    cols,
                    rows,
                    a["owner"].as_str().map(str::to_owned),
                )?;
                Ok(json!(id))
            }
            "term_write" => {
                crate::terminal::term_write(
                    app.state::<crate::terminal::TerminalState>(),
                    term_id(a)?,
                    text(a, "data")?,
                )?;
                Ok(Value::Null)
            }
            "term_resize" => {
                let cols = u16::try_from(a["cols"].as_u64().unwrap_or(80)).unwrap_or(80);
                let rows = u16::try_from(a["rows"].as_u64().unwrap_or(24)).unwrap_or(24);
                crate::terminal::term_resize(
                    app.state::<crate::terminal::TerminalState>(),
                    term_id(a)?,
                    cols,
                    rows,
                )?;
                Ok(Value::Null)
            }
            "term_kill" => {
                crate::terminal::term_kill(app.state::<crate::terminal::TerminalState>(), term_id(a)?)?;
                Ok(Value::Null)
            }
            _ => return Err(UNHANDLED.to_owned()),
        }
    }
    .await)
}
