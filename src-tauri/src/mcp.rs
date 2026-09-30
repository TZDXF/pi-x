//! MCP server settings: read/write `mcp.json` (global / project) and query
//! live server status by running `pi mcp list --json` as a one-shot process.
//!
//! Config files are passed through as raw text (validated as JSON) so unknown
//! fields survive a read/edit/save round trip. `pi mcp list` actually connects
//! to every enabled server (exit code 1 means something failed, but the JSON
//! report on stdout is still complete), so status is only fetched on explicit
//! user request.

use serde::Deserialize;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::time::Duration;
use tokio::process::Command;

use crate::errors::{pix_error, pix_error_detail};
use crate::pi_locate::{is_windows_script, Launcher};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// `pi mcp list` connects to every enabled server (HTTP ones retry on
/// transient errors); cap the wait so a stuck server cannot hang the UI.
const LIST_TIMEOUT: Duration = Duration::from_secs(120);

/// Resolve the `mcp.json` path for a scope. `project` is required for the
/// project scope (`<project>/.pi/mcp.json`), which pi only reads for
/// trusted projects — the file itself can be edited either way.
pub fn config_path(scope: &str, project: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(crate::trust::agent_dir().join("mcp.json")),
        "project" => {
            let project = project
                .ok_or_else(|| pix_error("projectDirRequired", "请选择要操作的项目文件夹"))?;
            crate::commands::validate_project_dir(project)?;
            Ok(PathBuf::from(project).join(".pi").join("mcp.json"))
        }
        other => Err(pix_error_detail(
            "mcpScopeInvalid",
            "未知的配置范围: {detail}",
            other,
        )),
    }
}

#[derive(serde::Serialize)]
pub struct McpConfigFile {
    pub path: String,
    pub exists: bool,
    pub content: String,
}

/// Read a `mcp.json` as raw text; missing files come back empty so the editor
/// can offer a fresh template without silently creating anything.
#[tauri::command]
pub fn mcp_config_read(scope: String, project: Option<String>) -> Result<McpConfigFile, String> {
    let path = config_path(&scope, project.as_deref())?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(McpConfigFile {
            path: path.to_string_lossy().to_string(),
            exists: true,
            content: raw.trim_start_matches('\u{feff}').to_string(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(McpConfigFile {
            path: path.to_string_lossy().to_string(),
            exists: false,
            content: String::new(),
        }),
        Err(e) => Err(pix_error_detail(
            "mcpReadFailed",
            "读取 mcp.json 失败: {detail}",
            e,
        )),
    }
}

/// Validate the edited document and write it back verbatim (plus a trailing
/// newline, matching pi's own file style). Validation is deliberately shallow
/// — pi itself skips and reports invalid server entries — but the document
/// must be a JSON object and `mcpServers` (when present) an object so the
/// file cannot become unreadable noise.
pub fn validate_config_text(content: &str) -> Result<Value, String> {
    if content.trim().is_empty() {
        return Err(pix_error("mcpJsonEmpty", "mcp.json 内容为空"));
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|e| pix_error_detail("mcpJsonParseFailed", "mcp.json 解析失败: {detail}", e))?;
    if !value.is_object() {
        return Err(pix_error("mcpJsonInvalid", "mcp.json 顶层必须是 JSON 对象"));
    }
    if let Some(servers) = value.get("mcpServers") {
        if !servers.is_object() {
            return Err(pix_error(
                "mcpServersInvalid",
                "mcpServers 必须是对象（服务器名 -> 配置）",
            ));
        }
    }
    Ok(value)
}

/// Save a `mcp.json`. The text is written as typed (unknown top-level fields
/// preserved); only JSON validity is enforced.
#[tauri::command]
pub fn mcp_config_save(
    scope: String,
    content: String,
    project: Option<String>,
) -> Result<(), String> {
    let path = config_path(&scope, project.as_deref())?;
    validate_config_text(&content)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            pix_error_detail("mcpDirCreateFailed", "无法创建 .pi 目录: {detail}", e)
        })?;
    }
    let body = content.trim_end();
    std::fs::write(&path, format!("{body}\n"))
        .map_err(|e| pix_error_detail("mcpWriteFailed", "无法写入 mcp.json: {detail}", e))
}

// ---- `pi mcp list --json` ----

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

fn build_list_command(info: &crate::pi_locate::PiInfo, args: &[&str]) -> Result<Command, String> {
    let mut cmd = match &info.launcher {
        Some(Launcher::Node { node, script }) => {
            let mut c = Command::new(node);
            c.arg(script).args(args);
            c
        }
        Some(Launcher::Binary { path }) => {
            let mut c = Command::new(path);
            c.args(args);
            c
        }
        None => {
            let path = info.path.clone().ok_or("pi path not resolved")?;
            if cfg!(windows) && is_windows_script(&path) {
                let mut c = Command::new("cmd");
                c.arg("/C").arg(&path).args(args);
                c
            } else {
                let mut c = Command::new(&path);
                c.args(args);
                c
            }
        }
    };
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
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
#[tauri::command]
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
    let servers: Vec<Value> = report
        .servers
        .iter()
        .map(|s| {
            json!({
                "name": s.name,
                "scope": if s.scope.is_empty() { "global" } else { &s.scope },
                "source": s.source,
                "enabled": s.enabled,
                "exposure": if s.exposure.is_empty() { "codemode" } else { &s.exposure },
                "transport": s.transport,
                "state": if s.state.is_empty() { "unknown" } else { &s.state },
                "tools": s.tools,
                "error": s.error,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_scope_requires_project() {
        assert!(config_path("project", None).is_err());
        assert!(config_path("unknown", None).is_err());
    }

    #[test]
    fn global_scope_targets_agent_dir() {
        let path = config_path("global", None).unwrap();
        assert!(path.to_string_lossy().contains("mcp.json"));
    }

    #[test]
    fn validate_accepts_document_with_unknown_fields() {
        let v =
            validate_config_text("{\"mcpServers\":{\"a\":{\"command\":\"npx\"}},\"custom\":true}")
                .unwrap();
        assert_eq!(v["custom"], serde_json::json!(true));
    }

    #[test]
    fn validate_rejects_broken_or_misshapen_documents() {
        assert!(validate_config_text("").is_err());
        assert!(validate_config_text("{").is_err());
        assert!(validate_config_text("[]").is_err());
        assert!(validate_config_text("{\"mcpServers\":[]}").is_err());
    }

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
