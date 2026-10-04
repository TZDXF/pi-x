//! Child-process wiring: spawn `pi --mode rpc`, wire up the stdio bridge
//! (stdin writer plus LF-framed stdout/stderr readers) and kill the process
//! tree. Pool management stays in the parent [`super`] module.

use super::{emit_process_event, write_line, ProcessState, CREATE_NO_WINDOW, EVENT, EXIT_EVENT, STDERR_EVENT};
use crate::pi_locate::{is_windows_script, Launcher, PiInfo};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

pub(super) struct SessionInner {
    pub(super) child: Child,
    pub(super) stdin_tx: mpsc::Sender<String>,
    pub(super) pending: PendingMap,
    pub(super) next_id: Arc<AtomicU64>,
}

/// A request-transport snapshot cloned out of `SessionInner`. All fields are
/// independently synchronized, so slow requests can run without holding the
/// session lock that guards the child handle.
pub(crate) struct SessionTransport {
    stdin_tx: mpsc::Sender<String>,
    pending: PendingMap,
    next_id: Arc<AtomicU64>,
}

impl SessionTransport {
    pub(super) fn snapshot(inner: &SessionInner) -> Self {
        Self {
            stdin_tx: inner.stdin_tx.clone(),
            pending: inner.pending.clone(),
            next_id: inner.next_id.clone(),
        }
    }

    /// Send a correlated request against the snapshot and await the matching
    /// `response` object, with a fixed timeout: a hung pi process must not
    /// block session rename/rewind indefinitely.
    pub(crate) async fn request(&self, mut command: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        command["id"] = json!(id);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let result = async {
            write_line(&self.stdin_tx, command.to_string()).await?;
            let response = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
                .await
                .map_err(|_| "Pi session name request timed out".to_string())?
                .map_err(|_| "Pi exited before responding".to_string())?;
            if response["success"] != true {
                return Err(response["error"].to_string());
            }
            Ok(response)
        }
        .await;
        self.pending.lock().await.remove(&id);
        result
    }
}

/// Soft cap for one buffered JSONL record on stdout/stderr. A line without a
/// newline beyond this size is dropped (and logged) instead of letting the
/// reader buffer grow without bound.
const MAX_LINE_BYTES: usize = 64 * 1024 * 1024;

/// Pop the next complete LF-delimited record from `buf`: split on `\n` ONLY
/// (never on U+2028/U+2029 which are valid inside JSON strings) and strip a
/// trailing `\r`. Returns None while no newline is buffered.
fn pop_line(buf: &mut Vec<u8>) -> Option<Vec<u8>> {
    let pos = buf.iter().position(|&b| b == b'\n')?;
    let mut line: Vec<u8> = buf.drain(..=pos).collect();
    line.pop(); // \n
    if line.last() == Some(&b'\r') {
        line.pop();
    }
    Some(line)
}

/// No newline is buffered (complete lines were drained): the record itself is
/// oversized. Drop the rest of it instead of buffering and later copying it
/// in full.
fn drop_oversized_record(buf: &mut Vec<u8>, runtime_id: &str, stream: &str) {
    if buf.len() > MAX_LINE_BYTES {
        buf.clear();
        crate::logs::write(
            runtime_id,
            &format!("dropped oversized {stream} line (>64MiB)"),
        );
    }
}

fn build_spawn_args(session_file: Option<&str>, extra_args: Vec<String>) -> Vec<String> {
    let mut args: Vec<String> = vec!["--mode".into(), "rpc".into()];
    if let Some(sf) = session_file {
        args.push("--session".into());
        args.push(sf.into());
    }
    args.extend(extra_args);
    args
}

/// Spawn `pi --mode rpc` inside `project` and wire up the stdio bridge.
/// `session_file` resumes a stored session (`--session <path>`).
pub(super) async fn process_spawn(
    app: AppHandle,
    state: &ProcessState,
    pi: &PiInfo,
    project: &str,
    session_file: Option<String>,
    extra_args: Vec<String>,
    workspace_manifest: Option<String>,
) -> Result<(), String> {
    let mut guard = state.inner.lock().await;
    state.generation.fetch_add(1, Ordering::Relaxed);
    if let Some(mut old) = guard.take() {
        let _ = kill_inner(&state.runtime_id, &mut old, "respawn").await;
    }

    let args = build_spawn_args(session_file.as_deref(), extra_args);

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
            } else {
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
    // Error paths below (e.g. missing stdio pipes) drop the Child before the
    // readers are wired up; tokio does not kill on drop by default, so make
    // sure the pi process never leaks as an orphan.
    cmd.kill_on_drop(true);

    // Consumed by the pix-workspace extension to render the <pix_workspace>
    // prompt section; plain sessions leave the variable unset.
    if let Some(manifest) = &workspace_manifest {
        cmd.env("PIX_WORKSPACE", manifest);
    }

    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn pi: {e}"))?;
    let session_label = session_file.clone().unwrap_or_else(|| "<new>".into());
    crate::logs::write(
        &state.runtime_id,
        &format!(
            "spawn pid={} project={} session={} args={:?}",
            child
                .id()
                .map(|p| p.to_string())
                .unwrap_or_else(|| "?".into()),
            project,
            session_label,
            args
        ),
    );

    let stdout = child.stdout.take().ok_or("no stdout")?;
    let stderr = child.stderr.take().ok_or("no stderr")?;
    let stdin = child.stdin.take().ok_or("no stdin")?;

    let (stdin_tx, mut stdin_rx) = mpsc::channel::<String>(256);
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let next_id = Arc::new(AtomicU64::new(1));

    // stdin writer
    {
        let runtime_id = state.runtime_id.clone();
        tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    crate::logs::write(&runtime_id, "stdin write failed (pi process gone)");
                    break;
                }
            }
        });
    }

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
            // PiX-side measure of pi's cold start: first stdout line after spawn.
            let spawned_at = std::time::Instant::now();
            let mut first_output = true;
            loop {
                match reader.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => buf.extend_from_slice(&chunk[..n]),
                }
                while let Some(line) = pop_line(&mut buf) {
                    if line.is_empty() {
                        continue;
                    }
                    if first_output {
                        first_output = false;
                        crate::logs::write(
                            &runtime_id,
                            &format!("[perf] pi first output after {}ms", spawned_at.elapsed().as_millis()),
                        );
                    }
                    let Ok(value) = serde_json::from_slice::<Value>(&line) else {
                        continue;
                    };
                    dispatch(&app, &pending, &runtime_id, value).await;
                }
                drop_oversized_record(&mut buf, &runtime_id, "stdout");
            }
            // stdout closed => process exited (or is gone).
            // Only surface it if this reader still belongs to the current session.
            if generation.load(Ordering::Relaxed) == own_gen {
                crate::logs::write(
                    &runtime_id,
                    "unexpected exit: stdout closed (pi process exited)",
                );
                pending.lock().await.clear();
                emit_process_event(
                    &app,
                    EXIT_EVENT,
                    &runtime_id,
                    json!({ "runtimeId": runtime_id }),
                );
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
                while let Some(line) = pop_line(&mut buf) {
                    let text = String::from_utf8_lossy(&line).to_string();
                    if !text.is_empty() {
                        crate::logs::write(&runtime_id, &format!("stderr: {text}"));
                        emit_process_event(
                            &app,
                            STDERR_EVENT,
                            &runtime_id,
                            json!({ "line": text, "runtimeId": runtime_id }),
                        );
                    }
                }
                drop_oversized_record(&mut buf, &runtime_id, "stderr");
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

/// Log run-lifecycle events so notification/kill decisions can be audited
/// against the exact event stream pi produced. Streaming deltas and tool
/// chatter are deliberately excluded.
fn log_lifecycle_event(runtime_id: &str, value: &Value) {
    let ty = value["type"].as_str().unwrap_or("");
    let detail = match ty {
        "agent_start" | "agent_settled" => String::new(),
        "agent_end" => format!(
            " willRetry={}",
            value["willRetry"].as_bool().unwrap_or(false)
        ),
        "auto_retry_start" => format!(
            " attempt={}/{}",
            value["attempt"].as_u64().unwrap_or(0),
            value["maxAttempts"].as_u64().unwrap_or(0)
        ),
        "auto_retry_end" => format!(" success={}", value["success"].as_bool().unwrap_or(false)),
        "message_end" => match value["message"]["stopReason"].as_str() {
            Some(reason @ ("error" | "aborted")) => format!(" stopReason={reason}"),
            _ => return,
        },
        "compaction_start" => format!(" reason={}", value["reason"].as_str().unwrap_or("?")),
        "compaction_end" => format!(
            " willRetry={}",
            value["willRetry"].as_bool().unwrap_or(false)
        ),
        _ => return,
    };
    crate::logs::write(runtime_id, &format!("event {ty}{detail}"));
}

async fn dispatch(app: &AppHandle, pending: &PendingMap, runtime_id: &str, value: Value) {
    if value.get("type").and_then(|t| t.as_str()) == Some("response") {
        if let Some(id) = value.get("id").and_then(|v| v.as_u64()) {
            let tx = pending.lock().await.remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(value);
            }
        }
        return;
    }
    let Some(value) = prepare_event(value, runtime_id) else {
        crate::logs::write(runtime_id, "dropped non-object stdout record");
        return;
    };
    emit_process_event(app, EVENT, runtime_id, value);
}

/// Stamp an outbound event with the runtime id for frontend delivery.
/// Returns None for non-object records (bare numbers, strings, arrays are
/// legal JSONL): they cannot carry the field, and serde_json's IndexMut would
/// panic on them, so they are skipped instead.
fn prepare_event(mut value: Value, runtime_id: &str) -> Option<Value> {
    log_lifecycle_event(runtime_id, &value);
    let object = value.as_object_mut()?;
    object.insert("runtimeId".into(), json!(runtime_id));
    Some(value)
}

pub(super) async fn process_running(state: &ProcessState) -> bool {
    let mut guard = state.inner.lock().await;
    guard
        .as_mut()
        .is_some_and(|inner| matches!(inner.child.try_wait(), Ok(None)))
}

async fn kill_inner(
    runtime_id: &str,
    inner: &mut SessionInner,
    reason: &str,
) -> Result<(), String> {
    crate::logs::write(
        runtime_id,
        &format!("kill pid={:?} reason={reason}", inner.child.id()),
    );
    // Drop pending response waiters first so callers fail fast.
    inner.pending.lock().await.clear();
    if let Some(pid) = inner.child.id() {
        #[cfg(windows)]
        {
            // pi.cmd runs under cmd.exe: kill the whole tree.
            let mut tk = Command::new("taskkill");
            tk.args(["/PID", &pid.to_string(), "/T", "/F"]);
            tk.creation_flags(CREATE_NO_WINDOW);
            match tk.output().await {
                Ok(output) if !output.status.success() => {
                    // A failed taskkill means the process may still be running
                    // and untracked; leave an audit trail.
                    crate::logs::write(
                        runtime_id,
                        &format!(
                            "taskkill /PID {pid} failed: {} stdout={} stderr={}",
                            output.status,
                            String::from_utf8_lossy(&output.stdout).trim_end(),
                            String::from_utf8_lossy(&output.stderr).trim_end(),
                        ),
                    );
                }
                Err(e) => {
                    crate::logs::write(
                        runtime_id,
                        &format!("taskkill /PID {pid} failed to run: {e}"),
                    );
                }
                Ok(_) => {}
            }
        }
        #[cfg(not(windows))]
        {
            let _ = inner.child.start_kill();
        }
    }
    Ok(())
}

pub(super) async fn process_kill(state: &ProcessState, reason: &str) -> Result<(), String> {
    state.generation.fetch_add(1, Ordering::Relaxed);
    let mut guard = state.inner.lock().await;
    if let Some(mut inner) = guard.take() {
        kill_inner(&state.runtime_id, &mut inner, reason).await?;
    }
    Ok(())
}

#[cfg(test)]
mod spawn_args_tests {
    use super::build_spawn_args;

    #[test]
    fn includes_session_and_extra_args() {
        let args = build_spawn_args(
            Some("C:\\tmp\\s.jsonl"),
            vec![
                "--provider".into(),
                "home".into(),
                "--model".into(),
                "agnes-3.0-flash".into(),
                "--thinking".into(),
                "medium".into(),
            ],
        );
        assert_eq!(
            args,
            vec![
                "--mode",
                "rpc",
                "--session",
                "C:\\tmp\\s.jsonl",
                "--provider",
                "home",
                "--model",
                "agnes-3.0-flash",
                "--thinking",
                "medium",
            ]
        );
    }

    #[test]
    fn omits_session_flag_without_session_file() {
        let args = build_spawn_args(None, vec!["--approve".into()]);
        assert_eq!(args, vec!["--mode", "rpc", "--approve"]);
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;

    #[test]
    fn non_object_stdout_records_are_skipped_without_panicking() {
        // serde_json's IndexMut panics on these; pi may emit legal JSONL
        // lines like these, and the reader task must survive them.
        for raw in ["42", "-1", "3.14", "\"hello\"", "[]", "[1,2]", "true", "null"] {
            let value: Value = serde_json::from_str(raw).unwrap();
            assert!(
                prepare_event(value, "default").is_none(),
                "non-object record {raw} must be skipped"
            );
        }
    }

    #[test]
    fn object_records_are_stamped_with_the_runtime_id() {
        let prepared = prepare_event(json!({"type": "agent_start"}), "runtime-1").unwrap();
        assert_eq!(prepared["runtimeId"], "runtime-1");
        assert_eq!(prepared["type"], "agent_start");
    }
}
