//! Bridge to a `pi --mode rpc` child process.
//!
//! Protocol notes (see pi docs/rpc.md):
//! - stdin/stdout carry LF-delimited JSONL. Split records on `\n` ONLY
//!   (never on U+2028/U+2029 which are valid inside JSON strings), strip a
//!   trailing `\r`, and decode UTF-8 across chunk boundaries.
//! - Responses echo the numeric `id` we attached to the request; everything
//!   else (agent events, extension UI requests) is forwarded to the frontend.

use crate::pi_locate::{is_windows_script, Launcher, PiInfo};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const EVENT: &str = "pi://event";
const STDERR_EVENT: &str = "pi://stderr";
const EXIT_EVENT: &str = "pi://exit";

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

struct SessionInner {
    child: Child,
    stdin_tx: mpsc::Sender<String>,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
}

/// Bound for internal `get_state` probes (spawn duplicate checks, session
/// listing). A hung pi process must never block these indefinitely.
const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);

#[derive(Default)]
pub struct ProcessState {
    runtime_id: String,
    project: String,
    inner: Mutex<Option<SessionInner>>,
    navigation: Mutex<()>,
    /// Incremented on every spawn; lets stale readers detect they are dead.
    generation: Arc<AtomicU64>,
}

/// Spawn `pi --mode rpc` inside `project` and wire up the stdio bridge.
/// `session_file` resumes a stored session (`--session <path>`).
pub async fn process_spawn(
    app: AppHandle,
    state: &ProcessState,
    pi: &PiInfo,
    project: &str,
    session_file: Option<String>,
    extra_args: Vec<String>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    state.generation.fetch_add(1, Ordering::Relaxed);
    if let Some(mut old) = guard.take() {
        let _ = kill_inner(&mut old).await;
    }

    let mut args: Vec<String> = vec!["--mode".into(), "rpc".into()];
    if let Some(sf) = session_file {
        args.push("--session".into());
        args.push(sf);
    }

    args.extend(extra_args);

    // Prefer the resolved launcher (node + cli.js); never route npm .cmd
    // shims through cmd.exe — its shim trick can exit silently under pipes.
    let mut cmd = match &pi.launcher {
        Some(Launcher::Node { node, script }) => {
            let mut c = Command::new(node);
            c.arg(script).args(&args);
            c
        }
        Some(Launcher::Binary { path }) => {
            let mut c = Command::new(path);
            c.args(&args);
            c
        }
        None => {
            let path = pi.path.clone().ok_or("pi path not resolved")?;
            if cfg!(windows) && is_windows_script(&path) {
                let mut c = Command::new("cmd");
                c.arg("/C").arg(&path).args(&args);
                c
            }
            else {
                let mut c = Command::new(&path);
                c.args(&args);
                c
            }
        }
    };

    cmd.current_dir(project)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd.spawn().map_err(|e| format!("failed to spawn pi: {e}"))?;

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(256);
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicU64::new(1));

    // stdin writer
    tokio::spawn(async move {
        let mut stdin = stdin;
        while let Some(line) = stdin_rx.recv().await {
            if stdin.write_all(line.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });

    // stdout reader: strict LF framing at the byte level
    {
        let app = app.clone();
        let pending = pending.clone();
        let generation = state.generation.clone();
        let own_gen = generation.load(Ordering::Relaxed);
        let runtime_id = state.runtime_id.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stdout);
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 8192];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let mut line: Vec<u8> = buf.drain(..=pos).collect();
                    line.pop(); // \n
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                        continue;
                    };
                    dispatch(&app, &pending, &runtime_id, value).await;
                }
            }
            // stdout closed => process exited (or is gone).
            // Only surface it if this reader still belongs to the current session.
            if generation.load(Ordering::Relaxed) == own_gen {
                pending.lock().await.clear();
                crate::remote::emit(&app, EXIT_EVENT, json!({ "runtimeId": runtime_id }));
            }
        });
    }

    // stderr reader: forward raw lines for logging
    {
        let app = app.clone();
        let runtime_id = state.runtime_id.clone();
        tokio::spawn(async move {
            let mut reader = tokio::io::BufReader::new(stderr);
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
                while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
                    let mut line: Vec<u8> = buf.drain(..=pos).collect();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    let text = String::from_utf8_lossy(&line).to_string();
                    if !text.is_empty() {
                        crate::remote::emit(&app, STDERR_EVENT, json!({ "line": text, "runtimeId": runtime_id }));
                    }
                }
            }
        });
    }

    *guard = Some(SessionInner {
        child,
        stdin_tx,
        pending,
        next_id,
    });
    Ok(())
}

async fn dispatch(app: &AppHandle, pending: &PendingMap, runtime_id: &str, mut value: Value) {
    if value.get("type").and_then(|t| t.as_str()) == Some("response") {
        if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
            let tx = pending.lock().await.remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(value);
            }
        }
        return;
    }
    value["runtimeId"] = json!(runtime_id);
    crate::remote::emit(app, EVENT, value);
}

async fn write_line(inner: &SessionInner, line: String) -> Result<(), String> {
    inner
        .stdin_tx
        .send(line)
        .await
        .map_err(|_| "pi is not running (stdin closed)".to_string())
}

/// Send a correlated request; resolves with the matching `response` object.
/// No timeout: user-driven commands (e.g. `prompt`) legitimately take as long
/// as the agent run does. Internal probes use `process_request_timeout`.
pub async fn process_request(state: &ProcessState, mut command: Value) -> Result<Value, String> {
    process_request_timeout(state, &mut command, None).await
}

/// Same as `process_request`, with an optional per-request timeout. On timeout
/// the pending entry is removed so a late response cannot be misattributed.
pub async fn process_request_timeout(state: &ProcessState, command: &mut Value, timeout: Option<std::time::Duration>) -> Result<Value, String> {
    let _navigation = if matches!(command["type"].as_str(), Some("switch_session" | "new_session" | "fork" | "clone" | "set_session_name")) {
        Some(state.navigation.lock().await)
    } else { None };
    let guard = state.inner.lock().await;
    let inner = guard.as_ref().ok_or("pi is not running")?;

    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    command["id"] = json!(id);

    let (tx, rx) = oneshot::channel();
    inner.pending.lock().await.insert(id, tx);

    if let Err(e) = write_line(inner, command.to_string()).await {
        inner.pending.lock().await.remove(&id);
        return Err(e);
    }
    drop(guard);

    let result = match timeout {
        Some(t) => tokio::time::timeout(t, rx).await
            .map_err(|_| format!("pi did not respond within {}s", t.as_secs()))
            .and_then(|r| r.map_err(|_| "pi exited before responding".into())),
        None => rx.await.map_err(|_| "pi exited before responding".into()),
    };
    if result.is_err() {
        if let Some(inner) = state.inner.lock().await.as_ref() {
            inner.pending.lock().await.remove(&id);
        }
    }
    result
}

/// Serialize name writes with navigation so a delayed title cannot rename a different session.
pub(crate) async fn process_set_session_name(state: &ProcessState, path: &std::path::Path, title: String, only_if_empty: bool) -> Result<Option<String>, String> {
    let _navigation = state.navigation.lock().await;
    let guard = state.inner.lock().await;
    if let Some(inner) = guard.as_ref() {
        let response = name_request(inner, json!({"type": "get_state"})).await?;
        let data = &response["data"];
        let active = data["sessionFile"].as_str().map(|f| dunce::canonicalize(f).unwrap_or_else(|_| f.into()));
        if active.as_deref() == Some(path) {
            if only_if_empty {
                if let Some(name) = data["sessionName"].as_str().filter(|s| !s.is_empty()) { return Ok(Some(name.into())); }
            }
            name_request(inner, json!({"type": "set_session_name", "name": title})).await?;
            return Ok(Some(title));
        }
    }
    // Keep navigation locked while the SDK updates an inactive log as well.
    if !path.is_file() { return Err("Pi session has not been persisted".into()); }
    let request = json!({"op": "session_name", "file": path, "title": title, "onlyIfEmpty": only_if_empty});
    let result = tokio::task::spawn_blocking(move || crate::pi_data::call(request)).await.map_err(|e| e.to_string())??;
    drop(guard);
    Ok(result.as_str().map(str::to_owned))
}

async fn name_request(inner: &SessionInner, mut command: Value) -> Result<Value, String> {
    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    command["id"] = json!(id);
    let (tx, rx) = oneshot::channel();
    inner.pending.lock().await.insert(id, tx);
    let result = async {
        write_line(inner, command.to_string()).await?;
        let response = tokio::time::timeout(std::time::Duration::from_secs(10), rx).await
            .map_err(|_| "Pi session name request timed out".to_string())?
            .map_err(|_| "Pi exited before responding".to_string())?;
        if response["success"] != true { return Err(response["error"].to_string()); }
        Ok(response)
    }.await;
    inner.pending.lock().await.remove(&id);
    result
}

/// Fire-and-forget write (e.g. `extension_ui_response`).
pub async fn process_notify(state: &ProcessState, command: Value) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let inner = guard.as_ref().ok_or("pi is not running")?;
    write_line(inner, command.to_string()).await
}

pub async fn process_running(state: &ProcessState) -> bool {
    let mut guard = state.inner.lock().await;
    guard.as_mut().is_some_and(|inner| matches!(inner.child.try_wait(), Ok(None)))
}

async fn kill_inner(inner: &mut SessionInner) -> Result<(), String> {
    // Drop pending response waiters first so callers fail fast.
    inner.pending.lock().await.clear();
    if let Some(pid) = inner.child.id() {
        #[cfg(windows)]
        {
            // pi.cmd runs under cmd.exe: kill the whole tree.
            let mut tk = Command::new("taskkill");
            tk.args(["/PID", &pid.to_string(), "/T", "/F"]);
            tk.creation_flags(CREATE_NO_WINDOW);
            let _ = tk.output().await;
        }
        #[cfg(not(windows))]
        {
            let _ = inner.child.start_kill();
        }
    }
    Ok(())
}

pub async fn process_kill(state: &ProcessState) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::Relaxed);
    let mut guard = state.inner.lock().await;
    if let Some(mut inner) = guard.take() {
        kill_inner(&mut inner).await?;
    }
    Ok(())
}


/// Each runtime owns a process, request correlation table and navigation lock.
/// The pool lock is never held while waiting for an agent response.
#[derive(Default)]
pub struct RpcState {
    processes: Mutex<HashMap<String, Arc<ProcessState>>>,
}

impl RpcState {
    async fn process(&self, runtime_id: Option<&str>) -> Result<Arc<ProcessState>, String> {
        self.processes.lock().await.get(runtime_id.unwrap_or("default")).cloned()
            .ok_or_else(|| "pi is not running".into())
    }
}

pub async fn spawn(app: AppHandle, state: &RpcState, pi: &PiInfo, project: &str,
    session_file: Option<String>, extra_args: Vec<String>, runtime_id: Option<String>) -> Result<(), String> {
    let id = runtime_id.unwrap_or_else(|| "default".into());
    let mut pool = state.processes.lock().await;
    if let Some(existing) = pool.get(&id) {
        if process_running(existing).await { return Err("Runtime is already running".into()); }
    }
    // Never open the same persisted conversation in two processes. Probes are
    // time-bounded: a hung pi process must not block spawning forever.
    if let Some(file) = &session_file {
        let path = dunce::canonicalize(file).map_err(|e| e.to_string())?;
        for process in pool.values() {
            if !process_running(process).await { continue; }
            let mut probe = json!({"type": "get_state"});
            let Ok(response) = process_request_timeout(process, &mut probe, Some(PROBE_TIMEOUT)).await else { continue };
            if response["data"]["sessionFile"].as_str()
                .and_then(|f| dunce::canonicalize(f).ok()).as_ref() == Some(&path) {
                return Err(format!("Session already open in runtime {}", process.runtime_id));
            }
        }
    }
    let process = Arc::new(ProcessState { runtime_id: id.clone(), project: project.into(), ..Default::default() });
    process_spawn(app, &process, pi, project, session_file, extra_args).await?;
    pool.insert(id, process);
    Ok(())
}

pub async fn request(state: &RpcState, command: Value, runtime_id: Option<&str>) -> Result<Value, String> {
    let process = state.process(runtime_id).await?;
    let exporting = command["type"] == "export_html";
    let mut response = process_request(&process, command).await?;
    if exporting {
        resolve_export_path(&mut response, &process.project)?;
    }
    Ok(response)
}

/// Pi writes the default HTML export relative to its own working directory,
/// not the desktop process's. Return a real absolute path for open_path (and
/// for remote clients, whose browser runs on yet another machine).
fn resolve_export_path(response: &mut Value, project: &str) -> Result<(), String> {
    if response["success"] != true { return Ok(()); }
    let Some(path) = response["data"]["path"].as_str() else { return Ok(()); };
    let absolute = dunce::canonicalize(Path::new(project).join(path))
        .map_err(|e| format!("Cannot locate exported HTML {path}: {e}"))?;
    response["data"]["path"] = json!(absolute.to_string_lossy());
    Ok(())
}
pub async fn notify(state: &RpcState, command: Value, runtime_id: Option<&str>) -> Result<(), String> {
    let process = state.process(runtime_id).await?;
    process_notify(&process, command).await
}
pub async fn running(state: &RpcState, runtime_id: Option<&str>) -> bool {
    match state.process(runtime_id).await { Ok(process) => process_running(&process).await, Err(_) => false }
}
pub async fn kill(state: &RpcState, runtime_id: Option<&str>) -> Result<(), String> {
    let process = state.processes.lock().await.remove(runtime_id.unwrap_or("default"));
    if let Some(process) = process { process_kill(&process).await?; }
    Ok(())
}
pub async fn kill_all(state: &RpcState) -> Result<(), String> {
    let processes = std::mem::take(&mut *state.processes.lock().await);
    for process in processes.values() { process_kill(process).await?; }
    Ok(())
}
pub async fn list(state: &RpcState) -> Vec<Value> {
    let processes: Vec<_> = state.processes.lock().await.values().cloned().collect();
    let mut result = Vec::new();
    for process in processes {
        if !process_running(&process).await { continue; }
        let mut probe = json!({"type": "get_state"});
        if let Ok(response) = process_request_timeout(&process, &mut probe, Some(PROBE_TIMEOUT)).await {
            result.push(json!({"runtimeId": process.runtime_id, "project": process.project, "state": response["data"]}));
        }
    }
    result
}
pub(crate) async fn set_session_name(state: &RpcState, path: &std::path::Path, title: String, only_if_empty: bool) -> Result<Option<String>, String> {
    let processes: Vec<_> = state.processes.lock().await.values().cloned().collect();
    for process in processes {
        if !process_running(&process).await { continue; }
        let mut probe = json!({"type": "get_state"});
        // Time-bounded probe: skip hung runtimes instead of failing the rename.
        let Ok(response) = process_request_timeout(&process, &mut probe, Some(PROBE_TIMEOUT)).await else { continue };
        let active = response["data"]["sessionFile"].as_str().and_then(|f| dunce::canonicalize(f).ok());
        if active.as_deref() == Some(path) {
            return process_set_session_name(&process, path, title, only_if_empty).await;
        }
    }
    process_set_session_name(&ProcessState::default(), path, title, only_if_empty).await
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn resolves_relative_export_against_pi_project_not_desktop_cwd() {
        let project = std::env::temp_dir().join(format!("pix-export-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&project).unwrap();
        let file = project.join("session.html");
        std::fs::write(&file, "<html></html>").unwrap();

        let mut relative = json!({ "success": true, "data": { "path": "session.html" } });
        resolve_export_path(&mut relative, project.to_str().unwrap()).unwrap();
        let expected = dunce::canonicalize(&file).unwrap().to_string_lossy().to_string();
        assert_eq!(relative["data"]["path"], expected);

        let mut absolute = json!({ "success": true, "data": { "path": expected } });
        resolve_export_path(&mut absolute, project.to_str().unwrap()).unwrap();
        assert_eq!(absolute["data"]["path"], expected);

        let mut failed = json!({ "success": false, "error": "Nothing to export yet" });
        resolve_export_path(&mut failed, project.to_str().unwrap()).unwrap();
        assert_eq!(failed["error"], "Nothing to export yet");

        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(project).unwrap();
    }
}
