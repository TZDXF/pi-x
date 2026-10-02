//! MCP server settings: read/write `mcp.json` (global / project) and query
//! live server status by running `pi mcp list --json` as a one-shot process.
//!
//! Config files are passed through as raw text (validated as JSON) so unknown
//! fields survive a read/edit/save round trip. `pi mcp list` actually connects
//! to every enabled server (exit code 1 means something failed, but the JSON
//! report on stdout is still complete), so status is only fetched on explicit
//! user request.

mod config;
mod http;
mod process;
mod protocol;
mod status;
mod stdio;
mod tools;

pub use config::{config_path, validate_config_text, McpConfigFile};
// Preserve the original public list API even though current callers only use commands.
#[allow(unused_imports)]
pub use status::{mcp_list_json, McpListOutput, McpServerReport};

use crate::errors::pix_error_detail;
use config::server_def;
use http::check_http;
use serde_json::{json, Value};
use stdio::check_stdio;

// Keep the Tauri command macros at the original module path as well as the
// public function signatures; desktop and remote callers need no changes.
#[tauri::command]
pub fn mcp_config_read(scope: String, project: Option<String>) -> Result<McpConfigFile, String> {
    config::mcp_config_read(scope, project)
}

#[tauri::command]
pub fn mcp_config_save(
    scope: String,
    content: String,
    project: Option<String>,
) -> Result<(), String> {
    config::mcp_config_save(scope, content, project)
}

#[tauri::command]
pub async fn mcp_status(app: tauri::AppHandle, project: Option<String>) -> Result<Value, String> {
    status::mcp_status(app, project).await
}

/// Connection check for one server in a mcp.json scope. Returns ok, latency
/// and (on failure) an error message; the handshake is a real MCP
/// `initialize`, so a passing check means pi can talk to the server.
#[tauri::command]
pub async fn mcp_check(
    scope: String,
    name: String,
    project: Option<String>,
) -> Result<Value, String> {
    let path = config_path(&scope, project.as_deref())?;
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| pix_error_detail("mcpReadFailed", "读取 mcp.json 失败: {detail}", e))?;
    let doc = validate_config_text(raw.trim_start_matches('\u{feff}'))?;
    let def = server_def(&doc, &name)?.clone();
    let result = if def.get("url").is_some() {
        check_http(&def).await
    } else {
        check_stdio(&def).await
    };
    Ok(match result {
        Ok(latency_ms) => json!({ "ok": true, "latencyMs": latency_ms, "error": Value::Null }),
        Err(error) => json!({ "ok": false, "latencyMs": Value::Null, "error": error }),
    })
}
