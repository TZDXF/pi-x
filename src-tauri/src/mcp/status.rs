//! pi list reports and best-effort concurrent tool definition collection.
use super::config::read_scope_docs;
use super::http::fetch_http_tools;
use super::process::build_list_command;
use super::stdio::fetch_stdio_tools;
use crate::errors::{pix_error, pix_error_detail};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
/// pi mcp list connects to every server; cap the overall wait.
const LIST_TIMEOUT: Duration = Duration::from_secs(120);

/// One server report from `pi mcp list --json`. Extra fields (toolExposure,
/// resources, …) are ignored.
#[derive(Deserialize)]
pub struct McpServerReport {
    pub name: String,
    #[serde(default)]
    pub scope: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub exposure: String,
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub state: String,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Deserialize)]
pub struct McpListOutput {
    #[serde(default)]
    pub servers: Vec<McpServerReport>,
    #[serde(default)]
    pub errors: Vec<String>,
    /// pi adds a note when a project `.pi/mcp.json` exists but the project is
    /// not trusted (so the file is ignored).
    #[serde(default)]
    pub note: Option<String>,
}

/// Run `pi mcp list --json` with cwd = project (or home for global-only) and
/// parse the report. pi sets cwd-dependent trust itself, so project servers
/// appear exactly when pi would read them. Exit code 1 only means "something
/// failed"; the JSON report is still returned so the UI can show states and
/// errors per server.
pub async fn mcp_list_json(
    info: &crate::pi_locate::PiInfo,
    project: Option<&str>,
) -> Result<(i32, McpListOutput), String> {
    let cwd: PathBuf = match project {
        Some(p) => {
            crate::commands::validate_project_dir(p)?;
            PathBuf::from(p)
        }
        None => dirs::home_dir().ok_or("Cannot locate user home directory")?,
    };
    let mut cmd = build_list_command(info, &["mcp", "list", "--json"])?;
    cmd.current_dir(&cwd);
    let child = cmd
        .spawn()
        .map_err(|e| pix_error_detail("mcpStatusFailed", "执行 pi mcp list 失败: {detail}", e))?;
    let output = match tokio::time::timeout(LIST_TIMEOUT, child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| {
            pix_error_detail("mcpStatusFailed", "执行 pi mcp list 失败: {detail}", e)
        })?,
        Err(_) => {
            return Err(pix_error(
                "mcpStatusTimeout",
                "获取 MCP 状态超时（2 分钟），服务器可能响应过慢",
            ));
        }
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    // pi prints the JSON via its log channel; take the first `{` to be robust.
    let json_start = stdout.find('{').ok_or_else(|| {
        pix_error_detail(
            "mcpStatusFailed",
            "pi mcp list 未返回状态 JSON: {detail}",
            String::from_utf8_lossy(&output.stderr).trim(),
        )
    })?;
    let parsed: McpListOutput = serde_json::from_str(&stdout[json_start..]).map_err(|e| {
        pix_error_detail(
            "mcpStatusParseFailed",
            "解析 pi mcp list 输出失败: {detail}",
            e,
        )
    })?;
    Ok((output.status.code().unwrap_or(-1), parsed))
}

/// Live status for the settings page. Returns the parsed report plus the exit
/// code; `ok` is false when pi reported failures (exit 1).
pub async fn mcp_status(app: tauri::AppHandle, project: Option<String>) -> Result<Value, String> {
    let cfg = crate::commands::app_config_get(app)?;
    let info = crate::pi_locate::detect(cfg.pi_path).await;
    if !info.found {
        return Err(pix_error(
            "piNotFound",
            "未找到 pi，请先在设置中配置 pi 路径",
        ));
    }
    let (code, report) = mcp_list_json(&info, project.as_deref()).await?;
    // Tool definitions for the load-cost estimate, fetched concurrently from
    // the enabled connected servers (see collect_tool_defs).
    let tool_defs = collect_tool_defs(&report, project.as_deref()).await;
    let servers: Vec<Value> = report
        .servers
        .iter()
        .map(|s| {
            let scope = if s.scope.is_empty() {
                "global"
            } else {
                &s.scope
            };
            json!({
                "name": s.name,
                "scope": scope,
                "source": s.source,
                "enabled": s.enabled,
                "exposure": if s.exposure.is_empty() { "codemode" } else { &s.exposure },
                "transport": s.transport,
                "state": if s.state.is_empty() { "unknown" } else { &s.state },
                "tools": s.tools,
                "error": s.error,
                "toolDefs": tool_defs.get(&format!("{scope}:{}", s.name)),
            })
        })
        .collect();
    Ok(json!({
        "ok": code == 0,
        "exitCode": code,
        "servers": servers,
        "errors": report.errors,
        "note": report.note,
    }))
}

/// Tool definitions of one server definition; the transport dispatch mirrors
/// the connection check (url present → Streamable HTTP, else stdio).
async fn fetch_tool_defs(def: &Value) -> Result<Vec<Value>, String> {
    if def.get("url").is_some() {
        fetch_http_tools(def).await
    } else {
        fetch_stdio_tools(def).await
    }
}

/// Fetch tool definitions concurrently for every enabled, connected,
/// non-hidden server in the report. Failures simply omit the entry — the
/// estimate is decorative and must not fail the status call.
async fn collect_tool_defs(
    report: &McpListOutput,
    project: Option<&str>,
) -> HashMap<String, Vec<Value>> {
    let docs = read_scope_docs(project);
    let mut tasks = Vec::new();
    for server in &report.servers {
        let scope = if server.scope.is_empty() {
            "global"
        } else {
            &server.scope
        };
        if !server.enabled || server.state != "connected" || server.exposure == "hidden" {
            continue;
        }
        let Some(def) = docs
            .get(scope)
            .and_then(|doc| doc.get("mcpServers"))
            .and_then(|servers| servers.get(&server.name))
            .filter(|def| def.is_object())
            .cloned()
        else {
            continue;
        };
        let key = format!("{scope}:{}", server.name);
        tasks.push(tokio::spawn(async move {
            match fetch_tool_defs(&def).await {
                Ok(tools) => Some((key, tools)),
                Err(_) => None,
            }
        }));
    }
    let mut defs = HashMap::new();
    for task in tasks {
        if let Ok(Some((key, tools))) = task.await {
            defs.insert(key, tools);
        }
    }
    defs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_list_report_from_stdout_noise() {
        let report = r#"{"servers":[{"name":"fs","scope":"project","source":"x","enabled":true,
            "exposure":"direct","transport":"cmd","state":"failed","tools":["t1"],
            "error":"stderr tail"}],"errors":["bad entry"],"note":"ignored"}"#;
        let noisy = format!("log line\n{report}\n");
        let start = noisy.find('{').unwrap();
        let parsed: McpListOutput = serde_json::from_str(&noisy[start..]).unwrap();
        assert_eq!(parsed.servers.len(), 1);
        assert_eq!(parsed.servers[0].state, "failed");
        assert_eq!(parsed.servers[0].error.as_deref(), Some("stderr tail"));
        assert_eq!(parsed.errors, vec!["bad entry"]);
        assert_eq!(parsed.note.as_deref(), Some("ignored"));
    }

    #[test]
    fn list_report_defaults_missing_fields() {
        let parsed: McpListOutput =
            serde_json::from_str("{\"servers\":[{\"name\":\"a\"}]}").unwrap();
        assert!(parsed.servers[0].enabled == false);
        assert!(parsed.errors.is_empty());
        assert!(parsed.note.is_none());
    }
}
