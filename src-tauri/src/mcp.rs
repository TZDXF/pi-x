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
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;
use tokio::io::BufReader;
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

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
    // Tool definitions for the load-cost estimate, fetched concurrently from
    // the enabled connected servers (see collect_tool_defs).
    let tool_defs = collect_tool_defs(&report, project.as_deref()).await;
    let servers: Vec<Value> = report
        .servers
        .iter()
        .map(|s| {
            let scope = if s.scope.is_empty() { "global" } else { &s.scope };
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

/// Build the command line handed to `cmd /s /c` for a .cmd/.bat shim (same
/// shape cross-spawn builds): quoted executable plus quoted arguments.
#[cfg(windows)]
fn windows_cmd_line(resolved: &str, args: &[&str]) -> String {
    let mut line = format!("\"{resolved}\"");
    for arg in args {
        line.push(' ');
        line.push_str(&windows_quote_arg(arg));
    }
    line
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
                // Backslashes preceding a quote are doubled and the quote is
                // escaped, or CommandLineToArgvW swallows it (a"b -> ab) or
                // splits the argument (a\"b -> two args).
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push_str("\\\"");
            }
            _ => {
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    for _ in 0..backslashes {
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
        let mut c = Command::new("cmd");
        c.arg("/d").arg("/s").arg("/c");
        // The line is appended verbatim and wrapped in one outer quote pair:
        // `cmd /s` strips exactly that pair and keeps the inner quotes intact.
        // Handed over as a regular argument, the inner quotes would be
        // \"-escaped by the standard quoting and cmd would fail to resolve
        // the shim (exit before the MCP handshake). Verified against
        // `npx`-style shims and paths containing spaces.
        #[cfg(windows)]
        c.raw_arg(format!("\"{}\"", windows_cmd_line(&resolved, &args)));
        #[cfg(not(windows))]
        {
            let _ = (&resolved, &args);
        }
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

/// Match a parsed JSON-RPC response to `id`: Some(Ok(result)) = success
/// result, Some(Err(text)) = JSON-RPC error, None = a different message.
fn response_result<'a>(value: &'a Value, id: i64) -> Option<Result<&'a Value, String>> {
    let object = value.as_object()?;
    if object.get("id").and_then(|v| v.as_i64()) != Some(id) {
        return None;
    }
    if let Some(result) = object.get("result") {
        return Some(Ok(result));
    }
    let error = object.get("error");
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("request error");
    Some(Err(message.to_string()))
}

/// Match a parsed JSON-RPC response: Some(Ok(())) = initialize result,
/// Some(Err(text)) = JSON-RPC error, None = not a response to id 1.
fn classify_response(value: &Value) -> Option<Result<(), String>> {
    response_result(value, 1).map(|result| result.map(|_| ()))
}

/// How the initialize handshake failed. Error strings are built only after
/// the child is gone so the stderr tail can be attached to the message.
enum HandshakeFailure {
    Write(std::io::Error),
    Read(std::io::Error),
    /// stdout hit EOF: the process died before answering.
    Exited,
    Timeout,
    /// The server answered with a JSON-RPC error.
    Rpc(String),
}

impl std::fmt::Display for HandshakeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeFailure::Write(e) => write!(f, "{e}"),
            HandshakeFailure::Read(e) => write!(f, "{e}"),
            HandshakeFailure::Exited => write!(f, "服务器进程在返回结果前退出"),
            HandshakeFailure::Timeout => write!(f, "等待响应超时"),
            HandshakeFailure::Rpc(message) => write!(f, "{message}"),
        }
    }
}

impl HandshakeFailure {
    /// Build the coded error; `detail` is the pre-formatted stderr suffix
    /// (empty when the server printed nothing).
    fn into_error(self, detail: String) -> String {
        match self {
            HandshakeFailure::Write(e) => pix_error_detail(
                "mcpCheckWriteFailed",
                "写入 initialize 请求失败: {detail}",
                e,
            ),
            HandshakeFailure::Read(e) => pix_error_detail(
                "mcpCheckReadFailed",
                "读取服务器输出失败: {detail}",
                e,
            ),
            HandshakeFailure::Exited => pix_error_detail(
                "mcpCheckExited",
                "服务器进程在握手前退出{detail}",
                detail,
            ),
            HandshakeFailure::Timeout => pix_error_detail(
                "mcpCheckTimeout",
                "连接检测超时（15 秒），服务器未响应 initialize{detail}",
                detail,
            ),
            HandshakeFailure::Rpc(message) => message,
        }
    }
}

/// Background stderr drain so a chatty server cannot block on a full pipe;
/// the tail (last STDERR_TAIL bytes) is collected after the exchange ends and
/// attached to failure reports (a server that exits early usually explains
/// why there).
fn drain_stderr(child: &mut Child) -> Option<tokio::task::JoinHandle<String>> {
    let mut stderr = child.stderr.take()?;
    Some(tokio::spawn(async move {
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
    }))
}

/// Tail of the drained stderr, formatted as an error detail suffix (empty
/// when the server printed nothing).
async fn stderr_tail_detail(stderr_task: Option<tokio::task::JoinHandle<String>>) -> String {
    let Some(task) = stderr_task else {
        return String::new();
    };
    // The child is gone, so the stderr pipe closes and the drain task
    // finishes promptly; the timeout only guards a stuck pipe.
    match tokio::time::timeout(Duration::from_secs(2), task).await {
        Ok(Ok(text)) if !text.trim().is_empty() => format!(": {}", text.trim()),
        _ => String::new(),
    }
}

/// Kill a stdio server process. cmd.exe wrappers (npx & friends) fork the
/// real server, so kill the whole process tree the same way pi-mcp does.
async fn kill_stdio_child(child: &mut Child, wrapped: bool) {
    #[cfg(windows)]
    if wrapped {
        if let Some(pid) = child.id() {
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
    #[cfg(not(windows))]
    let _ = wrapped;
    let _ = child.kill().await;
}

/// Write one JSON-RPC message as a newline-terminated line.
async fn write_line(stdin: &mut ChildStdin, line: &str) -> Result<(), HandshakeFailure> {
    use tokio::io::AsyncWriteExt;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(HandshakeFailure::Write)?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(HandshakeFailure::Write)?;
    stdin.flush().await.map_err(HandshakeFailure::Write)
}

/// Read JSON-RPC lines until the response to `id` arrives: Ok(result payload)
/// on success, the JSON-RPC error message on error, HandshakeFailure when the
/// process dies or the pipe breaks first.
async fn read_rpc_response(
    stdout: &mut BufReader<ChildStdout>,
    id: i64,
) -> Result<Value, HandshakeFailure> {
    use tokio::io::AsyncBufReadExt;
    let mut line = String::new();
    loop {
        line.clear();
        match stdout.read_line(&mut line).await {
            Ok(0) => return Err(HandshakeFailure::Exited),
            Ok(_) => {}
            Err(e) => return Err(HandshakeFailure::Read(e)),
        }
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(result) = response_result(&value, id) {
                return result.map(|result| result.clone()).map_err(HandshakeFailure::Rpc);
            }
        }
    }
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
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| pix_error("mcpCheckReadFailed", "无法读取服务器标准输出"))?,
    );
    let stderr_task = drain_stderr(&mut child);

    // Latency only covers the initialize handshake round trip, not the
    // process startup time (intentional).
    let started = std::time::Instant::now();
    let handshake = async {
        write_line(&mut stdin, &initialize_request()).await?;
        let read = read_rpc_response(&mut stdout, 1);
        match tokio::time::timeout(CHECK_TIMEOUT, read).await {
            Ok(result) => result.map(|_| started.elapsed().as_millis()),
            Err(_) => Err(HandshakeFailure::Timeout),
        }
    };
    let outcome = handshake.await;
    kill_stdio_child(&mut child, wrapped).await;
    match outcome {
        Ok(latency) => Ok(latency),
        Err(failure) => {
            Err(failure.into_error(stderr_tail_detail(stderr_task).await))
        }
    }
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

/// JSON-RPC `notifications/initialized`, sent after the initialize result.
fn initialized_notification() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    })
    .to_string()
}

/// JSON-RPC `tools/list` request; ids are assigned by the caller for matching.
fn tools_list_request(id: i64, cursor: Option<&str>) -> String {
    let mut params = serde_json::Map::new();
    if let Some(cursor) = cursor {
        params.insert("cursor".to_string(), json!(cursor));
    }
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/list",
        "params": params
    })
    .to_string()
}

// ---- per-server tool definitions (load-cost estimate) ----
// The model-facing cost of a loaded MCP server is dominated by its tool
// definitions (name, description, input schema), which `pi mcp list --json`
// does not expose. After the `pi mcp list` report, the settings backend
// connects once more to every enabled connected server and runs `tools/list`
// itself; the frontend turns the definitions into a token estimate.

/// Cap on the whole stdio tools/list exchange.
const TOOLS_TIMEOUT: Duration = Duration::from_secs(30);
/// Cap on `tools/list` pagination rounds.
const TOOLS_MAX_PAGES: usize = 10;

/// Model-facing fields of one `tools/list` entry: name, description (falling
/// back to the title, like pi's tool definitions) and the input schema. The
/// estimate only needs these; annotations and output schema stay out.
fn parse_tool_defs(result: &Value) -> Vec<Value> {
    let Some(tools) = result.get("tools").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(|v| v.as_str())?;
            let mut entry = serde_json::Map::new();
            entry.insert("name".to_string(), Value::String(name.to_string()));
            let description = tool
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|d| !d.trim().is_empty())
                .or_else(|| {
                    tool.get("title")
                        .and_then(|v| v.as_str())
                        .filter(|d| !d.trim().is_empty())
                });
            if let Some(description) = description {
                entry.insert("description".to_string(), Value::String(description.to_string()));
            }
            if let Some(schema) = tool.get("inputSchema").filter(|s| s.is_object()) {
                entry.insert("inputSchema".to_string(), schema.clone());
            }
            Some(Value::Object(entry))
        })
        .collect()
}

/// Extract the JSON-RPC response with `id` from an HTTP body that is either
/// plain JSON or an SSE stream of `data:` lines. None = no matching response.
fn extract_rpc_body(body: &str, content_type: &str, id: i64) -> Option<Result<Value, String>> {
    if content_type.contains("text/event-stream") {
        for line in body.lines() {
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                if let Some(result) = response_result(&value, id) {
                    return Some(result.cloned());
                }
            }
        }
        None
    } else {
        let value: Value = serde_json::from_str(body.trim()).ok()?;
        response_result(&value, id).map(|result| result.cloned())
    }
}

/// POST one JSON-RPC message to a Streamable HTTP endpoint; returns the
/// lowercase content type, the `Mcp-Session-Id` response header and the body.
async fn post_rpc(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    body: &str,
) -> Result<(String, Option<String>, String), String> {
    let mut request = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_owned());
    for (name, value) in headers {
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
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let text = response
        .text()
        .await
        .map_err(|e| pix_error_detail("mcpCheckBodyFailed", "读取服务器响应失败: {detail}", e))?;
    Ok((content_type, session, text))
}

/// stdio tools/list: connect, initialize, then page through `tools/list`.
async fn fetch_stdio_tools(def: &Value) -> Result<Vec<Value>, String> {
    let (mut cmd, wrapped) = spawn_command(def)?;
    let mut child = cmd
        .spawn()
        .map_err(|e| pix_error_detail("mcpToolsSpawnFailed", "无法启动服务器进程: {detail}", e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| pix_error("mcpCheckWriteFailed", "无法写入服务器标准输入"))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| pix_error("mcpCheckReadFailed", "无法读取服务器标准输出"))?,
    );
    let stderr_task = drain_stderr(&mut child);

    let exchange = async {
        write_line(&mut stdin, &initialize_request()).await?;
        read_rpc_response(&mut stdout, 1).await?;
        // The notification is fire-and-forget; servers answer only the requests.
        let _ = write_line(&mut stdin, &initialized_notification()).await;
        let mut tools: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        for id in 2..(2 + TOOLS_MAX_PAGES as i64) {
            write_line(&mut stdin, &tools_list_request(id, cursor.as_deref())).await?;
            let result = read_rpc_response(&mut stdout, id).await?;
            tools.extend(parse_tool_defs(&result));
            cursor = result
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok::<Vec<Value>, HandshakeFailure>(tools)
    };
    let outcome = tokio::time::timeout(TOOLS_TIMEOUT, exchange).await;
    kill_stdio_child(&mut child, wrapped).await;
    let detail = stderr_tail_detail(stderr_task).await;
    match outcome {
        Ok(Ok(tools)) => Ok(tools),
        Ok(Err(failure)) => Err(pix_error_detail(
            "mcpToolsFailed",
            "获取工具定义失败: {detail}",
            format!("{failure}{detail}"),
        )),
        Err(_) => Err(pix_error_detail(
            "mcpToolsTimeout",
            "获取工具定义超时（30 秒）{detail}",
            detail,
        )),
    }
}

/// Streamable HTTP tools/list: initialize (capturing the session id), send
/// the initialized notification, then page through `tools/list`.
async fn fetch_http_tools(def: &Value) -> Result<Vec<Value>, String> {
    let url = def_str(def, "url")
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| pix_error("mcpServerInvalid", "该服务器缺少 command（stdio）或 url（HTTP）"))?;
    let client = check_http_client()?;
    let headers = def_string_record(def, "headers");

    let (content_type, session, body) = post_rpc(&client, &url, &headers, &initialize_request()).await?;
    let initialize = extract_rpc_body(&body, &content_type, 1)
        .ok_or_else(|| pix_error("mcpCheckNoInitialize", "服务器响应流中没有 initialize 结果"))?
        .map_err(|message| pix_error_detail("mcpCheckRpc", "{detail}", message))?;
    if initialize.is_null() {
        return Err(pix_error("mcpCheckNotInitialize", "服务器响应不是 initialize 结果"));
    }
    let headers = match &session {
        Some(session) => {
            let mut with_session = headers;
            with_session.push(("Mcp-Session-Id".to_string(), session.clone()));
            with_session
        }
        None => headers,
    };
    // Notifications usually answer 202 with an empty body; the result is ignored.
    let _ = post_rpc(&client, &url, &headers, &initialized_notification()).await;

    let mut tools: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for id in 2..(2 + TOOLS_MAX_PAGES as i64) {
        let request = tools_list_request(id, cursor.as_deref());
        let (content_type, _, body) = post_rpc(&client, &url, &headers, &request).await?;
        let result = extract_rpc_body(&body, &content_type, id)
            .ok_or_else(|| pix_error("mcpToolsNoResponse", "服务器响应中没有 tools/list 结果"))?
            .map_err(|message| pix_error_detail("mcpCheckRpc", "{detail}", message))?;
        tools.extend(parse_tool_defs(&result));
        cursor = result
            .get("nextCursor")
            .and_then(|v| v.as_str())
            .map(String::from);
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
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

/// Parsed mcp.json documents per scope, for looking up server definitions.
fn read_scope_docs(project: Option<&str>) -> HashMap<String, Value> {
    let mut docs = HashMap::new();
    for scope in ["global", "project"] {
        let Ok(path) = config_path(scope, project) else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(doc) = validate_config_text(raw.trim_start_matches('\u{feff}')) {
            docs.insert(scope.to_string(), doc);
        }
    }
    docs
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
        let scope = if server.scope.is_empty() { "global" } else { &server.scope };
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
    fn response_result_matches_requested_id() {
        let ok: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}"#).unwrap();
        assert_eq!(response_result(&ok, 3).unwrap().unwrap()["tools"], serde_json::json!([]));
        let error: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":3,"error":{"message":"nope"}}"#).unwrap();
        assert_eq!(response_result(&ok, 2), None);
        assert_eq!(response_result(&error, 3), Some(Err("nope".into())));
    }

    #[test]
    fn parse_tool_defs_keeps_model_facing_fields() {
        let result: Value = serde_json::from_str(
            r#"{"tools":[
                {"name":"read","description":"Read a file","inputSchema":{"type":"object","properties":{}}},
                {"name":"titled","title":"Titled tool","inputSchema":"not-an-object"},
                {"name":"bare"},
                {"description":"no name"}
            ]}"#,
        )
        .unwrap();
        let tools = parse_tool_defs(&result);
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], "read");
        assert_eq!(tools[0]["description"], "Read a file");
        assert_eq!(tools[0]["inputSchema"]["type"], "object");
        // Title falls in when the description is missing; a non-object schema
        // and tools without a name are dropped.
        assert_eq!(tools[1]["description"], "Titled tool");
        assert!(tools[1].get("inputSchema").is_none());
        assert!(tools[2].get("description").is_none());
    }

    #[test]
    fn parse_tool_defs_ignores_whitespace_descriptions() {
        let result: Value = serde_json::from_str(
            r#"{"tools":[{"name":"a","description":"   "},{"name":"b","title":"T"}]}"#,
        )
        .unwrap();
        let tools = parse_tool_defs(&result);
        assert!(tools[0].get("description").is_none());
        assert_eq!(tools[1]["description"], "T");
    }

    #[test]
    fn extract_rpc_body_reads_json_and_sse() {
        let json_body = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"}]}}"#;
        let extracted = extract_rpc_body(json_body, "application/json", 2).unwrap().unwrap();
        assert_eq!(extracted["tools"][0]["name"], "a");
        let sse_body = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
        let extracted = extract_rpc_body(sse_body, "text/event-stream", 2).unwrap().unwrap();
        assert!(extracted["tools"].is_array());
        // Non-matching ids and JSON-RPC errors surface distinctly.
        assert!(extract_rpc_body(json_body, "application/json", 9).is_none());
        let error_body = r#"{"jsonrpc":"2.0","id":2,"error":{"message":"boom"}}"#;
        assert_eq!(
            extract_rpc_body(error_body, "application/json", 2).unwrap(),
            Err("boom".into())
        );
        // Notifications (202, empty body) yield no result.
        assert!(extract_rpc_body("", "application/json", 2).is_none());
    }

    #[test]
    fn tools_list_request_carries_cursor() {
        let first: Value = serde_json::from_str(&tools_list_request(2, None)).unwrap();
        assert_eq!(first["method"], "tools/list");
        assert!(first["params"].as_object().unwrap().is_empty());
        let paged: Value =
            serde_json::from_str(&tools_list_request(3, Some("cur"))).unwrap();
        assert_eq!(paged["params"]["cursor"], "cur");
    }

    #[test]
    fn spawn_command_builds_stdio_definition() {
        let def: Value = serde_json::from_str(
            r#"{"command":"npx","args":["-y","pkg"],"env":{"KEY":"v"},"cwd":"."}"#,
        )
        .unwrap();
        let (cmd, wrapped) = spawn_command(&def).unwrap();
        // The Debug output no longer carries the shim line (raw_arg), so only
        // the wrap flag is asserted here; the line itself is covered below.
        let _ = cmd;
        #[cfg(windows)]
        assert!(wrapped);
        let no_command: Value = serde_json::from_str(r#"{"args":[]}"#).unwrap();
        assert!(spawn_command(&no_command).is_err());
        // Resolution of a nonexistent bare name cannot wrap it in cmd.
        let missing: Value = serde_json::from_str(r#"{"command":"definitely-not-a-real-pix-cmd"}"#).unwrap();
        let (_, wrapped_missing) = spawn_command(&missing).unwrap();
        assert!(!wrapped_missing);
        // Keep the unused-variable shape identical on every platform.
        let _ = wrapped;
    }

    // `cmd /s /c` strips exactly one outer quote pair, so the whole line is
    // double-wrapped before being handed to raw_arg verbatim. Without the
    // outer pair a spaced path would be cut at the first space; passing the
    // line as a regular argument would escape inner quotes to \" and cmd
    // would fail to resolve the shim (regression: every npx-style stdio
    // server exited before the MCP handshake on Windows).
    #[cfg(windows)]
    #[test]
    fn windows_cmd_line_is_quoted_for_s_strip() {
        assert_eq!(
            windows_cmd_line(r"C:\Program Files\nodejs\npx.cmd", &["-y", "pkg"]),
            r#""C:\Program Files\nodejs\npx.cmd" -y pkg"#
        );
        assert_eq!(
            windows_cmd_line(r"C:\tools\x.cmd", &["a b", "c"]),
            r#""C:\tools\x.cmd" "a b" c"#
        );
    }

    // Embedded quotes must be escaped per the Windows argument rules:
    // backslashes before a quote are doubled and the quote becomes \".
    // A bare quote is swallowed by CommandLineToArgvW (a"b parses as ab)
    // and an unescaped backslash-quote pair splits into two arguments.
    #[cfg(windows)]
    #[test]
    fn windows_quote_arg_escapes_embedded_quotes() {
        assert_eq!(windows_quote_arg("a\"b"), r#""a\"b""#);
        assert_eq!(windows_quote_arg("a\\\"b"), r#""a\\\"b""#);
        assert_eq!(windows_quote_arg("x y\\"), r#""x y\\""#);
        assert_eq!(windows_quote_arg("plain"), "plain");
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

/// A mock stdio MCP server that answers initialize and tools/list with two
/// pages, exercising the whole fetch round trip. Needs `node` on PATH —
/// always true in a development environment — and skips otherwise.
#[cfg(test)]
mod fetch_stdio_tests {
    use super::*;

    const MOCK_SERVER: &str = r#"
import { createInterface } from "node:readline";
const page1 = { tools: [
  { name: "alpha", description: "Alpha tool", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
  { name: "beta", title: "Beta titled", inputSchema: { type: "object" } },
], nextCursor: "page2" };
const page2 = { tools: [
  { name: "gamma", inputSchema: "not-an-object" },
  { description: "no name" },
] };
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.params?.cursor === "page2" ? page2 : page1 }) + "\n");
  }
}
"#;

    #[tokio::test]
    async fn fetch_stdio_tools_round_trip() {
        let Some(node) = which_node() else {
            return; // no node on PATH: nothing to run the mock server with
        };
        let mock = std::env::temp_dir().join(format!("pix-mock-mcp-{}.mjs", std::process::id()));
        std::fs::write(&mock, MOCK_SERVER).unwrap();
        let def = serde_json::json!({ "command": node, "args": [mock.to_string_lossy()] });
        let result = fetch_stdio_tools(&def).await;
        let _ = std::fs::remove_file(&mock);
        let tools = result.expect("fetch should succeed");
        // The nameless page-2 tool is dropped; the schema-less one is kept.
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], "alpha");
        assert_eq!(tools[0]["description"], "Alpha tool");
        assert_eq!(tools[0]["inputSchema"]["properties"]["a"]["type"], "string");
        assert_eq!(tools[1]["name"], "beta");
        // Title fallback applied, like pi's tool definitions.
        assert_eq!(tools[1]["description"], "Beta titled");
        assert!(tools[2].get("inputSchema").is_none(), "non-object schema is dropped");
    }

    /// Locate `node` via PATH, like the frontend toolchain always provides.
    fn which_node() -> Option<String> {
        let ext = if cfg!(windows) { ".cmd" } else { "" };
        for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
            let candidate = dir.join(format!("node{ext}"));
            if candidate.is_file() {
                return Some(candidate.to_string_lossy().into_owned());
            }
            let bare = dir.join("node");
            if bare.is_file() {
                return Some(bare.to_string_lossy().into_owned());
            }
        }
        None
    }
}
