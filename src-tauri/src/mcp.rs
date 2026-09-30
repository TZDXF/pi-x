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

// ---- per-server connection check ----
// Unlike `pi mcp list --json` (which connects to every server), this runs a
// single MCP `initialize` handshake against one server definition straight
// from mcp.json, so a single slow server cannot stall the others.

const CHECK_TIMEOUT: Duration = Duration::from_secs(15);
/// Stderr tail kept for stdio failure reports.
const STDERR_TAIL: usize = 2000;

fn server_def<'a>(doc: &'a Value, name: &str) -> Result<&'a Value, String> {
    doc.get("mcpServers")
        .and_then(|servers| servers.get(name))
        .filter(|def| def.is_object())
        .ok_or_else(|| {
            pix_error_detail("mcpServerNotFound", "mcp.json 中不存在该服务器: {detail}", name)
        })
}

fn def_str<'a>(def: &'a Value, key: &str) -> Option<&'a str> {
    def.get(key).and_then(|v| v.as_str())
}

fn def_string_record(def: &Value, key: &str) -> Vec<(String, String)> {
    def.get(key)
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Windows: resolve a bare command name to a real executable via PATH +
/// PATHEXT, mirroring what cross-spawn (used by pi itself) does for MCP
/// servers — `npx` on Windows is actually `npx.cmd`, which CreateProcess
/// cannot launch directly. Returns the input unchanged when nothing resolves
/// (the spawn error then surfaces as before).
#[cfg(windows)]
fn resolve_windows_command(command: &str) -> String {
    use std::path::Path;
    let path = Path::new(command);
    // Relative/absolute paths are used as-is; the OS handles them.
    if path.components().count() > 1 {
        return command.to_string();
    }
    let path_ext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<&str> = path_ext
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .collect();
    // A name with an explicit extension (e.g. "npx.cmd") is looked up as-is;
    // otherwise try every PATHEXT entry in order.
    let names: Vec<String> = if path.extension().is_some() {
        vec![command.to_string()]
    } else {
        exts.iter().map(|ext| format!("{command}{ext}")).collect()
    };
    if let Some(dirs) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&dirs) {
            for name in &names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }
    command.to_string()
}

#[cfg(not(windows))]
fn resolve_windows_command(command: &str) -> String {
    command.to_string()
}

/// Quote one argument for a `cmd /s /c` command line (same shape cross-spawn
/// builds for .cmd/.bat shims).
#[cfg(windows)]
fn windows_quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '"')) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                for _ in 0..=backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push('"');
            }
            _ => {
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    for _ in 0..=backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Build the spawn command for a stdio server definition (command + args +
/// env + cwd). The child inherits this process's environment so PATH-based
/// launchers like `npx` keep working; def.env entries are layered on top.
/// Returns the command plus whether it was wrapped in `cmd /c` (Windows
/// script shims) — those need a taskkill of the whole process tree.
fn spawn_command(def: &Value) -> Result<(Command, bool), String> {
    let command = def_str(def, "command")
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| pix_error("mcpServerInvalid", "该服务器缺少 command（stdio）或 url（HTTP）"))?;
    let args: Vec<&str> = def
        .get("args")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let resolved = resolve_windows_command(command);
    let is_script = {
        let lower = resolved.to_ascii_lowercase();
        #[cfg(windows)]
        {
            lower.ends_with(".cmd") || lower.ends_with(".bat")
        }
        #[cfg(not(windows))]
        {
            let _ = lower;
            false
        }
    };
    let mut cmd = if is_script {
        // cross-spawn style: one quoted command line handed to `cmd /s /c`.
        let mut line = format!("\"{resolved}\"");
        for arg in &args {
            line.push(' ');
            line.push_str(&windows_quote_arg(arg));
        }
        let mut c = Command::new("cmd");
        c.arg("/d").arg("/s").arg("/c").arg(line);
        c
    } else {
        let mut c = Command::new(&resolved);
        c.args(&args);
        c
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in def_string_record(def, "env") {
        cmd.env(key, value);
    }
    if let Some(cwd) = def_str(def, "cwd").filter(|c| !c.trim().is_empty()) {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok((cmd, is_script))
}

/// JSON-RPC `initialize` request; id 1 is matched in responses.
fn initialize_request() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "pix", "version": env!("CARGO_PKG_VERSION") }
        }
    })
    .to_string()
}

/// Match a parsed JSON-RPC response: Some(Ok(())) = initialize result,
/// Some(Err(text)) = JSON-RPC error, None = not a response to id 1.
fn classify_response(value: &Value) -> Option<Result<(), String>> {
    let object = value.as_object()?;
    if object.get("id").and_then(|v| v.as_i64()) != Some(1) {
        return None;
    }
    if object.contains_key("result") {
        return Some(Ok(()));
    }
    let error = object.get("error");
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("initialize error");
    Some(Err(message.to_string()))
}

async fn check_stdio(def: &Value) -> Result<u128, String> {
    let (mut cmd, wrapped) = spawn_command(def)?;
    let mut child = cmd
        .spawn()
        .map_err(|e| pix_error_detail("mcpCheckSpawnFailed", "无法启动服务器进程: {detail}", e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| pix_error("mcpCheckWriteFailed", "无法写入服务器标准输入"))?;
    let mut stdout = tokio::io::BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| pix_error("mcpCheckReadFailed", "无法读取服务器标准输出"))?,
    );
    // Drain stderr in the background so a chatty server cannot block on a full
    // pipe; kept alive (but unused) until the end of the handshake.
    let _stderr_task = child.stderr.take().map(|mut stderr| {
        tokio::spawn(async move {
            use tokio::io::AsyncReadExt;
            let mut buf = Vec::new();
            let mut chunk = [0u8; 512];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > STDERR_TAIL {
                            let drop = buf.len() - STDERR_TAIL;
                            buf.drain(..drop);
                        }
                    }
                }
            }
            String::from_utf8_lossy(&buf).to_string()
        })
    });

    use tokio::io::AsyncWriteExt;
    let request = initialize_request();
    let write_error = |e: std::io::Error| {
        pix_error_detail("mcpCheckWriteFailed", "写入 initialize 请求失败: {detail}", e)
    };
    stdin.write_all(request.as_bytes()).await.map_err(write_error)?;
    stdin.write_all(b"\n").await.map_err(write_error)?;
    stdin.flush().await.map_err(write_error)?;

    // Latency only covers the initialize handshake round trip, not the
    // process startup time (intentional).
    let started = std::time::Instant::now();
    let outcome = tokio::time::timeout(CHECK_TIMEOUT, async {
        let mut line = String::new();
        loop {
            line.clear();
            let n = tokio::io::AsyncBufReadExt::read_line(&mut stdout, &mut line)
                .await
                .map_err(|e| {
                    pix_error_detail("mcpCheckReadFailed", "读取服务器输出失败: {detail}", e)
                })?;
            if n == 0 {
                return Err(pix_error("mcpCheckExited", "服务器进程在握手前退出"));
            }
            if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
                if let Some(classified) = classify_response(&value) {
                    return classified;
                }
            }
        }
    })
    .await;
    // cmd.exe wrappers (npx & friends) fork the real server, so kill the
    // whole tree the same way pi-mcp does.
    #[cfg(not(windows))]
    let _ = wrapped;
    #[cfg(windows)]
    let pid = child.id();
    #[cfg(windows)]
    if wrapped {
        if let Some(pid) = pid {
            let mut killer = Command::new("taskkill");
            killer
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            killer.creation_flags(CREATE_NO_WINDOW);
            let _ = killer.status().await;
        }
    }
    let _ = child.kill().await;
    match outcome {
        Err(_) => Err(pix_error(
            "mcpCheckTimeout",
            "连接检测超时（15 秒），服务器未响应 initialize",
        )),
        Ok(Err(message)) => Err(message),
        Ok(Ok(())) => Ok(started.elapsed().as_millis()),
    }
    // Dropping _stderr_task detaches it rather than aborting it; the task
    // finishes on its own once the child is killed and its stderr pipe closes.
    // The error paths above already carry actionable messages, so its output
    // is only drained, never reported.
}

fn check_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        .build()
        .map_err(|e| pix_error_detail("mcpCheckClientFailed", "无法创建 HTTP 客户端: {detail}", e))
}

/// Streamable HTTP check: POST an `initialize` request; the response body may
/// be JSON or an SSE stream (scan `data:` lines for the id-1 response).
async fn check_http(def: &Value) -> Result<u128, String> {
    let url = def_str(def, "url")
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| pix_error("mcpServerInvalid", "该服务器缺少 command（stdio）或 url（HTTP）"))?;
    let client = check_http_client()?;
    let started = std::time::Instant::now();
    let mut request = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::from_str::<Value>(&initialize_request()).unwrap_or_default());
    for (name, value) in def_string_record(def, "headers") {
        request = request.header(name, value);
    }
    let response = request.send().await.map_err(|e| {
        pix_error_detail("mcpCheckConnectFailed", "无法连接到服务器: {detail}", e)
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(pix_error_detail(
            "mcpCheckHttp",
            "服务器返回 HTTP {detail}",
            status.as_u16(),
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = response.text().await.map_err(|e| {
        pix_error_detail("mcpCheckBodyFailed", "读取服务器响应失败: {detail}", e)
    })?;
    if content_type.contains("text/event-stream") {
        for line in body.lines() {
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                match classify_response(&value) {
                    Some(Ok(())) => return Ok(started.elapsed().as_millis()),
                    Some(Err(message)) => return Err(message),
                    None => {}
                }
            }
        }
        return Err(pix_error(
            "mcpCheckNoInitialize",
            "服务器响应流中没有 initialize 结果",
        ));
    }
    let value: Value = serde_json::from_str(body.trim()).map_err(|_| {
        pix_error("mcpCheckNotJsonRpc", "服务器响应不是合法的 JSON-RPC 消息")
    })?;
    match classify_response(&value) {
        Some(Ok(())) => Ok(started.elapsed().as_millis()),
        Some(Err(message)) => Err(message),
        None => Err(pix_error("mcpCheckNotInitialize", "服务器响应不是 initialize 结果")),
    }
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
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        pix_error_detail("mcpReadFailed", "读取 mcp.json 失败: {detail}", e)
    })?;
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

    #[test]
    fn server_def_resolves_from_mcp_servers() {
        let doc: Value = serde_json::from_str(r#"{"mcpServers":{"fs":{"command":"npx"}}}"#).unwrap();
        assert_eq!(server_def(&doc, "fs").unwrap()["command"], "npx");
        assert!(server_def(&doc, "missing").is_err());
        // Non-object defs are treated as absent.
        let broken: Value =
            serde_json::from_str(r#"{"mcpServers":{"bad":"text"}}"#).unwrap();
        assert!(server_def(&broken, "bad").is_err());
    }

    #[test]
    fn classify_response_matches_id_one() {
        let ok: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}"#,
        )
        .unwrap();
        assert!(classify_response(&ok) == Some(Ok(())));
        let error: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"boom"}}"#,
        )
        .unwrap();
        assert_eq!(classify_response(&error), Some(Err("boom".into())));
        let other: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"notifications/x"}"#).unwrap();
        assert!(classify_response(&other).is_none());
        let other_id: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#).unwrap();
        assert!(classify_response(&other_id).is_none());
    }

    #[test]
    fn spawn_command_builds_stdio_definition() {
        let def: Value = serde_json::from_str(
            r#"{"command":"npx","args":["-y","pkg"],"env":{"KEY":"v"},"cwd":"."}"#,
        )
        .unwrap();
        let (cmd, wrapped) = spawn_command(&def).unwrap();
        assert!(format!("{cmd:?}").contains("npx"));
        let no_command: Value = serde_json::from_str(r#"{"args":[]}"#).unwrap();
        assert!(spawn_command(&no_command).is_err());
        // Resolution of a nonexistent bare name cannot wrap it in cmd.
        let missing: Value = serde_json::from_str(r#"{"command":"definitely-not-a-real-pix-cmd"}"#).unwrap();
        let (_, wrapped_missing) = spawn_command(&missing).unwrap();
        assert!(!wrapped_missing);
        // Keep the unused-variable shape identical on every platform.
        let _ = wrapped;
    }

    #[cfg(windows)]
    #[test]
    fn resolve_windows_command_finds_cmd_shim() {
        assert!(resolve_windows_command("cmd").to_ascii_lowercase().ends_with(".exe"));
        assert!(resolve_windows_command("npx").to_ascii_lowercase().ends_with(".cmd"));
        // Unresolvable names come back unchanged.
        assert_eq!(
            resolve_windows_command("definitely-not-a-real-pix-cmd"),
            "definitely-not-a-real-pix-cmd"
        );
    }
}
