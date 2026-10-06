//! Bridge to `pi --mode rpc` child processes.
//!
//! Protocol notes (see pi docs/rpc.md):
//! - stdin/stdout carry LF-delimited JSONL. Split records on `\n` ONLY
//!   (never on U+2028/U+2029 which are valid inside JSON strings), strip a
//!   trailing `\r`, and decode UTF-8 across chunk boundaries.
//! - Responses echo the numeric `id` we attached to the request; everything
//!   else (agent events, extension UI requests) is forwarded to the frontend.
//!
//! Layout: this module owns the runtime pool ([`RpcState`]), the request path
//! and the event naming; [`child`] owns the child-process wiring (spawn,
//! stdio readers, kill). Session-file surgery driven by the live transport
//! (prompt rewind, serialized rename) lives in [`crate::sessions::edit`].

mod child;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot, Mutex};

pub use child::{SshSpawnSpec, SpawnProgram};
// 仅实机集成测试（S-R1，`#[ignore]`）消费；对齐 commands/mod.rs 的既有做法。
#[allow(unused_imports)]
pub(crate) use child::{PathRebind, resolve_path_rebind};
use child::{SessionInner, SessionTransport};

// Scheduled workers also have a backend completion listener; all workers are visible to PiX.
fn emit_process_event(app: &AppHandle, event: &str, runtime_id: &str, payload: Value) {
    if runtime_id.starts_with("schedule-") {
        use tauri::Emitter;
        let name = event.replace("pi://", "pi://schedule-");
        let _ = app.emit(&name, payload.clone());
    }
    crate::remote::emit(app, event, payload);
}

const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const EVENT: &str = "pi://event";
const STDERR_EVENT: &str = "pi://stderr";
const EXIT_EVENT: &str = "pi://exit";
/// 重连 realpath 回绑事件（契约 §3.8）：payload 为 `{ runtimeId, project, path }`，
/// `project` 是 path 回绑后重建的 `ssh://` 展示 URI，供前端更新项目展示。
const SSH_PATH_BOUND_EVENT: &str = "pi://sshPathBound";

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

impl ProcessState {
    /// Snapshot the transport together with the generation: the pair
    /// identifies the session the snapshot belongs to. A concurrent spawn
    /// bumps the generation while holding the session lock, before replacing
    /// `inner`, so the two must be read under one lock acquisition.
    pub(crate) async fn transport_and_generation(&self) -> (Option<SessionTransport>, u64) {
        let guard = self.inner.lock().await;
        let generation = self.generation.load(Ordering::Relaxed);
        (guard.as_ref().map(SessionTransport::snapshot), generation)
    }

    /// Snapshot the transport and release the session lock: slow round trips
    /// must not block other RPCs. If the session is respawned meanwhile, the
    /// stale transport's writes fail instead of hitting the wrong process.
    pub(crate) async fn transport(&self) -> Option<SessionTransport> {
        self.inner.lock().await.as_ref().map(SessionTransport::snapshot)
    }

    /// Current session generation; stale callers detect a respawn by
    /// comparing against the value captured with their transport snapshot.
    pub(crate) fn current_generation(&self) -> u64 {
        self.generation.load(Ordering::Relaxed)
    }

    /// Serialize navigation operations (session switch, fork, rename).
    pub(crate) async fn lock_navigation(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.navigation.lock().await
    }
}

/// Send a correlated request; resolves with the matching `response` object.
/// No timeout: user-driven commands (e.g. `prompt`) legitimately take as long
/// as the agent run does. Internal probes use `process_request_timeout`.
pub async fn process_request(state: &ProcessState, mut command: Value) -> Result<Value, String> {
    process_request_timeout(state, &mut command, None).await
}

/// Remove a timed-out request's pending entry, but only if the session that
/// issued it is still current. `next_id` restarts at 1 on every respawn, so a
/// stale timeout must never delete the new session's in-flight entry.
async fn remove_pending_if_current(state: &ProcessState, id: u64, generation: u64) {
    if state.generation.load(Ordering::Relaxed) != generation {
        return;
    }
    if let Some(inner) = state.inner.lock().await.as_ref() {
        inner.pending.lock().await.remove(&id);
    }
}

/// Same as `process_request`, with an optional per-request timeout. On timeout
/// the pending entry is removed so a late response cannot be misattributed
/// (unless the process was respawned meanwhile, in which case the id belongs
/// to a dead session and the new session's pending table is left alone).
pub async fn process_request_timeout(
    state: &ProcessState,
    command: &mut Value,
    timeout: Option<std::time::Duration>,
) -> Result<Value, String> {
    // Remote callers can submit arbitrary JSON; a non-object command cannot
    // carry the correlation id and would panic serde_json's IndexMut below.
    if command.as_object_mut().is_none() {
        return Err("rpc command must be a JSON object".into());
    }
    let _navigation = if matches!(
        command["type"].as_str(),
        Some("switch_session" | "new_session" | "fork" | "clone" | "set_session_name")
    ) {
        Some(state.navigation.lock().await)
    } else {
        None
    };
    let guard = state.inner.lock().await;
    let inner = guard.as_ref().ok_or("pi is not running")?;
    // Read the generation while the session lock is held: a concurrent spawn
    // bumps it before replacing `inner`, so this pair identifies the session
    // the request is issued against.
    let generation = state.generation.load(Ordering::Relaxed);

    let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
    command["id"] = json!(id);

    let (tx, rx) = oneshot::channel();
    inner.pending.lock().await.insert(id, tx);

    if let Err(e) = write_line(&inner.stdin_tx, command.to_string()).await {
        inner.pending.lock().await.remove(&id);
        return Err(e);
    }
    drop(guard);

    let result = match timeout {
        Some(t) => tokio::time::timeout(t, rx)
            .await
            .map_err(|_| format!("pi did not respond within {}s", t.as_secs()))
            .and_then(|r| r.map_err(|_| "pi exited before responding".into())),
        None => rx.await.map_err(|_| "pi exited before responding".into()),
    };
    if result.is_err() {
        remove_pending_if_current(state, id, generation).await;
    }
    result
}

async fn write_line(stdin_tx: &mpsc::Sender<String>, line: String) -> Result<(), String> {
    stdin_tx
        .send(line)
        .await
        .map_err(|_| "pi is not running (stdin closed)".to_string())
}

/// Fire-and-forget write (e.g. `extension_ui_response`).
pub async fn process_notify(state: &ProcessState, command: Value) -> Result<(), String> {
    let guard = state.inner.lock().await;
    let inner = guard.as_ref().ok_or("pi is not running")?;
    write_line(&inner.stdin_tx, command.to_string()).await
}

/// Each runtime owns a process, request correlation table and navigation lock.
/// The pool lock is never held while waiting for an agent response.
#[derive(Default)]
pub struct RpcState {
    processes: Mutex<HashMap<String, Arc<ProcessState>>>,
    /// 每个 runtime 的最后用户请求时间，供 schedule runtime 延迟回收判定是否已被前端 attach。
    pub last_activity: Mutex<HashMap<String, Instant>>,
}

impl RpcState {
    async fn process(&self, runtime_id: Option<&str>) -> Result<Arc<ProcessState>, String> {
        let process = self
            .processes
            .lock()
            .await
            .get(runtime_id.unwrap_or("default"))
            .cloned()
            .ok_or_else(|| "pi is not running".to_string())?;
        self.last_activity
            .lock()
            .await
            .insert(process.runtime_id.clone(), Instant::now());
        Ok(process)
    }
}

pub async fn spawn(
    app: AppHandle,
    state: &RpcState,
    program: &SpawnProgram,
    project: &str,
    session_file: Option<String>,
    mut extra_args: Vec<String>,
    workspace_manifest: Option<String>,
    runtime_id: Option<String>,
) -> Result<(), String> {
    // P1 远程分支（契约 §3.1 第 7 条）：不注入 builtin extensions——它们物化的
    // 是本地文件路径（builtin_extensions.rs），对远端无效；PIX_WORKSPACE 同理不设。
    if matches!(program, SpawnProgram::LocalPi(_)) {
        extra_args.extend(crate::builtin_extensions::rpc_args(&app)?);
        if workspace_manifest.is_some() {
            extra_args.extend(crate::builtin_extensions::workspace_extension_args()?);
        }
    }
    let id = runtime_id.unwrap_or_else(|| "default".into());
    // Probe from a snapshot: each probe can take up to PROBE_TIMEOUT, so the
    // pool lock must never be held while a hung runtime is being probed.
    let snapshot: Vec<Arc<ProcessState>> =
        state.processes.lock().await.values().cloned().collect();
    if let Some(existing) = snapshot.iter().find(|p| p.runtime_id == id) {
        if child::process_running(existing).await {
            return Err("Runtime is already running".into());
        }
    }
    // Never open the same persisted conversation in two processes. Probes are
    // time-bounded: a hung pi process must not block spawning forever.
    // 远端 POSIX 会话路径不做本地 canonicalize（Windows 上必失败），按原串比对。
    let session_key: Option<PathBuf> = match (&session_file, program) {
        (None, _) => None,
        (Some(file), SpawnProgram::LocalPi(_)) => {
            Some(dunce::canonicalize(file).map_err(|e| e.to_string())?)
        }
        (Some(file), SpawnProgram::Ssh(_)) => Some(PathBuf::from(file)),
    };
    if let Some(path) = &session_key {
        for process in &snapshot {
            if !child::process_running(process).await {
                continue;
            }
            let mut probe = json!({"type": "get_state"});
            let Ok(response) =
                process_request_timeout(process, &mut probe, Some(PROBE_TIMEOUT)).await
            else {
                continue;
            };
            let matched = match program {
                SpawnProgram::LocalPi(_) => response["data"]["sessionFile"]
                    .as_str()
                    .and_then(|f| dunce::canonicalize(f).ok())
                    .as_ref()
                    == Some(path),
                SpawnProgram::Ssh(_) => response["data"]["sessionFile"]
                    .as_str()
                    .is_some_and(|f| f == path.to_string_lossy()),
            };
            if matched {
                return Err(format!(
                    "Session already open in runtime {}",
                    process.runtime_id
                ));
            }
        }
    }
    let process = Arc::new(ProcessState {
        runtime_id: id.clone(),
        project: project.into(),
        ..Default::default()
    });
    child::process_spawn(
        app,
        &process,
        program,
        project,
        session_file,
        extra_args,
        workspace_manifest,
    )
    .await?;
    state.processes.lock().await.insert(id.clone(), process);
    state.last_activity.lock().await.insert(id, Instant::now());
    Ok(())
}

pub async fn request(
    state: &RpcState,
    command: Value,
    runtime_id: Option<&str>,
) -> Result<Value, String> {
    let process = state.process(runtime_id).await?;
    if command["type"] == "rewind_prompt" {
        return crate::sessions::edit::rewind_prompt(&process, &command).await;
    }
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
    if response["success"] != true {
        return Ok(());
    }
    let Some(path) = response["data"]["path"].as_str() else {
        return Ok(());
    };
    // ssh:// 远程项目：导出路径位于远端文件系统，本地无法 canonicalize，
    // 原样返回 pi 给的路径作为防御性兜底（契约 §5）。
    if crate::ssh::is_ssh_uri(project) {
        return Ok(());
    }
    let absolute = dunce::canonicalize(Path::new(project).join(path))
        .map_err(|e| format!("Cannot locate exported HTML {path}: {e}"))?;
    response["data"]["path"] = json!(absolute.to_string_lossy());
    Ok(())
}
pub async fn notify(
    state: &RpcState,
    command: Value,
    runtime_id: Option<&str>,
) -> Result<(), String> {
    let process = state.process(runtime_id).await?;
    process_notify(&process, command).await
}
pub async fn running(state: &RpcState, runtime_id: Option<&str>) -> bool {
    match state.process(runtime_id).await {
        Ok(process) => child::process_running(&process).await,
        Err(_) => false,
    }
}
pub async fn kill(state: &RpcState, runtime_id: Option<&str>) -> Result<(), String> {
    let process = state
        .processes
        .lock()
        .await
        .remove(runtime_id.unwrap_or("default"));
    if let Some(process) = process {
        child::process_kill(&process, "rpc_kill").await?;
        state.last_activity.lock().await.remove(&process.runtime_id);
    }
    Ok(())
}
pub async fn kill_all(state: &RpcState) -> Result<(), String> {
    let processes = std::mem::take(&mut *state.processes.lock().await);
    state.last_activity.lock().await.clear();
    for process in processes.values() {
        child::process_kill(process, "kill_all (app exit)").await?;
    }
    Ok(())
}
pub async fn list(state: &RpcState) -> Vec<Value> {
    let processes: Vec<_> = state.processes.lock().await.values().cloned().collect();
    let mut result = Vec::new();
    for process in processes {
        if !child::process_running(&process).await {
            continue;
        }
        let mut probe = json!({"type": "get_state"});
        if let Ok(response) =
            process_request_timeout(&process, &mut probe, Some(PROBE_TIMEOUT)).await
        {
            result.push(json!({"runtimeId": process.runtime_id, "project": process.project, "state": response["data"]}));
        }
    }
    result
}
pub(crate) async fn set_session_name(
    state: &RpcState,
    path: &std::path::Path,
    title: String,
    only_if_empty: bool,
) -> Result<Option<String>, String> {
    let processes: Vec<_> = state.processes.lock().await.values().cloned().collect();
    for process in processes {
        if !child::process_running(&process).await {
            continue;
        }
        let mut probe = json!({"type": "get_state"});
        // Time-bounded probe: skip hung runtimes instead of failing the rename.
        let Ok(response) = process_request_timeout(&process, &mut probe, Some(PROBE_TIMEOUT)).await
        else {
            continue;
        };
        let active = response["data"]["sessionFile"]
            .as_str()
            .map(crate::sessions::edit::normalize_session_file);
        if active.as_deref() == Some(path) {
            return crate::sessions::edit::process_set_session_name(&process, path, title, only_if_empty)
                .await;
        }
    }
    crate::sessions::edit::process_set_session_name(&ProcessState::default(), path, title, only_if_empty)
        .await
}

#[cfg(test)]
mod pending_cleanup_tests {
    use super::*;
    use std::process::Stdio;
    use tokio::process::Command;

    /// `SessionInner` needs a live child handle; a trivially exiting process
    /// is enough because only the pending map is exercised here.
    async fn state_with_session() -> ProcessState {
        let state = ProcessState::default();
        let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
        if cfg!(windows) {
            cmd.args(["/C", "exit 0"]);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let child = cmd.spawn().expect("spawn dummy child");
        let (stdin_tx, _stdin_rx) = mpsc::channel::<String>(8);
        *state.inner.lock().await = Some(SessionInner {
            child,
            stdin_tx,
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(AtomicU64::new(1)),
            remote: None,
        });
        state
    }

    #[tokio::test]
    async fn timeout_cleanup_removes_pending_from_the_current_generation() {
        let state = state_with_session().await;
        let (tx, _rx) = oneshot::channel::<Value>();
        let inner = state.inner.lock().await;
        inner
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .await
            .insert(7, tx);
        drop(inner);
        let generation = state.generation.load(Ordering::Relaxed);
        remove_pending_if_current(&state, 7, generation).await;
        assert!(
            state.inner.lock().await.as_ref().unwrap().pending.lock().await.is_empty(),
            "timed-out entry of the current session is removed"
        );
    }

    #[tokio::test]
    async fn timeout_cleanup_skips_pending_from_an_older_generation() {
        let state = state_with_session().await;
        let (tx, _rx) = oneshot::channel::<Value>();
        let inner = state.inner.lock().await;
        inner
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .await
            .insert(7, tx);
        drop(inner);
        let stale = state.generation.load(Ordering::Relaxed);
        // Simulate a respawn: ids restart at 1 and the stale cleanup must not
        // delete the new session's in-flight entry with the same numeric id.
        state.generation.fetch_add(1, Ordering::Relaxed);
        remove_pending_if_current(&state, 7, stale).await;
        assert!(
            state
                .inner
                .lock()
                .await
                .as_ref()
                .unwrap()
                .pending
                .lock()
                .await
                .contains_key(&7),
            "a stale generation must never delete the new session's pending entry"
        );
    }

}

#[cfg(test)]
mod command_validation_tests {
    use super::*;

    #[tokio::test]
    async fn non_object_command_from_remote_is_rejected_without_panicking() {
        let state = ProcessState::default();
        for raw in ["42", "\"prompt\"", "[]"] {
            let mut command: Value = serde_json::from_str(raw).unwrap();
            let err = process_request_timeout(&state, &mut command, None)
                .await
                .unwrap_err();
            assert!(err.contains("JSON object"), "unexpected error: {err}");
        }
    }

    #[tokio::test]
    async fn object_command_without_a_process_reports_pi_not_running() {
        let state = ProcessState::default();
        let mut command = json!({"type": "prompt", "message": "hi"});
        let err = process_request_timeout(&state, &mut command, None)
            .await
            .unwrap_err();
        assert_eq!(err, "pi is not running");
    }
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
        let expected = dunce::canonicalize(&file)
            .unwrap()
            .to_string_lossy()
            .to_string();
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
