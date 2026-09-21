//! Bridge to a `pi --mode rpc` child process.
//!
//! Protocol notes (see pi docs/rpc.md):
//! - stdin/stdout carry LF-delimited JSONL. Split records on `\n` ONLY
//!   (never on U+2028/U+2029 which are valid inside JSON strings), strip a
//!   trailing `\r`, and decode UTF-8 across chunk boundaries.
//! - Responses echo the numeric `id` we attached to the request; everything
//!   else (agent events, extension UI requests) is forwarded to the frontend.

use crate::pi_locate::{Launcher, PiInfo};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
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

#[derive(Default)]
pub struct RpcState {
    inner: Mutex<Option<SessionInner>>,
    /// Incremented on every spawn; lets stale readers detect they are dead.
    generation: Arc<AtomicU64>,
}

fn is_windows_script(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// Spawn `pi --mode rpc` inside `project` and wire up the stdio bridge.
/// `session_file` resumes a stored session (`--session <path>`).
pub async fn spawn(
    app: AppHandle,
    state: &RpcState,
    pi: &PiInfo,
    project: &str,
    session_file: Option<String>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(mut old) = guard.take() {
        let _ = kill_inner(&mut old).await;
    }

    let mut args: Vec<String> = vec!["--mode".into(), "rpc".into()];
    if let Some(sf) = session_file {
        args.push("--session".into());
        args.push(sf);
    }

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
                    dispatch(&app, &pending, value).await;
                }
            }
            // stdout closed => process exited (or is gone).
            // Only surface it if this reader still belongs to the current session.
            if generation.load(Ordering::Relaxed) == own_gen {
                let _ = app.emit(EXIT_EVENT, json!({}));
            }
        });
    }

    // stderr reader: forward raw lines for logging
    {
        let app = app.clone();
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
                        let _ = app.emit(STDERR_EVENT, json!({ "line": text }));
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

async fn dispatch(app: &AppHandle, pending: &PendingMap, value: Value) {
    if value.get("type").and_then(|t| t.as_str()) == Some("response") {
        if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
            let tx = pending.lock().await.remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(value);
            }
        }
        return;
    }
    let _ = app.emit(EVENT, value);
}

async fn write_line(inner: &SessionInner, line: String) -> Result<(), String> {
    inner
        .stdin_tx
        .send(line)
        .await
        .map_err(|_| "pi is not running (stdin closed)".to_string())
}

/// Send a correlated request; resolves with the matching `response` object.
pub async fn request(state: &RpcState, mut command: Value) -> Result<Value, String> {
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

    match rx.await {
        Ok(response) => Ok(response),
        Err(_) => Err("pi exited before responding".into()),
    }
}

/// Fire-and-forget write (e.g. `extension_ui_response`).
pub async fn notify(state: &RpcState, command: Value) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let inner = guard.as_ref().ok_or("pi is not running")?;
    write_line(inner, command.to_string()).await
}

pub async fn running(state: &RpcState) -> bool {
    state.inner.lock().await.is_some()
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

pub async fn kill(state: &RpcState) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    if let Some(mut inner) = guard.take() {
        kill_inner(&mut inner).await?;
    }
    Ok(())
}
