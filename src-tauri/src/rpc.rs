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

mod activity;
pub mod aux_launch;
mod child;
#[cfg(test)]
mod gateway_tests;
mod policy;

pub use policy::RuntimePolicy;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::AppHandle;
use tokio::sync::{mpsc, oneshot, Mutex};

pub use child::{RemoteSpawnSpec, SpawnProgram};
// 仅实机集成测试（S-R1，`#[ignore]`）消费；对齐 commands/mod.rs 的既有做法。
#[allow(unused_imports)]
pub(crate) use child::{resolve_path_rebind, PathRebind};
use child::{SessionInner, SessionTransport};

// Scheduled workers also have a backend completion listener; all workers are visible to PiX.
fn emit_process_event(app: &AppHandle, event: &str, runtime_id: &str, payload: Value) {
    if event == EXIT_EVENT
        || (event == EVENT
            && matches!(
                payload["type"].as_str(),
                Some("agent_start" | "agent_settled")
            ))
    {
        crate::commands::workspace_state::record_runtime_activity(app, &payload);
    } else if event == SSH_PATH_BOUND_EVENT {
        crate::commands::workspace_state::rebind_runtime_activity(app, &payload);
    }
    if runtime_id.starts_with("schedule-") {
        use tauri::Emitter;
        let name = event.replace("pi://", "pi://schedule-");
        let _ = app.emit(&name, payload.clone());
    }
    crate::remote::emit(app, event, payload);
}

async fn retire_process(process: &ProcessState) {
    let guard = process.inner.lock().await;
    let mut activity = process.activity.lock().await;
    let generation = process.generation.fetch_add(1, Ordering::Relaxed) + 1;
    // The process may already have exited while its stdout reader has not yet
    // observed EOF. Publish the terminal event before invalidating that reader.
    activity.stop_and_emit(generation, true);
    if let Some(inner) = guard.as_ref() {
        inner.pending.lock().await.clear();
    }
}

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
    project: Arc<Mutex<String>>,
    inner: Mutex<Option<SessionInner>>,
    navigation: Mutex<()>,
    /// Incremented on every spawn; lets stale readers detect they are dead.
    generation: Arc<AtomicU64>,
    activity: Arc<Mutex<activity::RuntimeActivity>>,
    /// 运行策略：`Main` 是既有会话默认值；aux 由 spawn 时显式写入，不从命令读取。
    policy: RuntimePolicy,
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
        self.inner
            .lock()
            .await
            .as_ref()
            .map(SessionTransport::snapshot)
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
    let guard = state.inner.lock().await;
    if state.generation.load(Ordering::Relaxed) == generation {
        if let Some(inner) = guard.as_ref() {
            inner.pending.lock().await.remove(&id);
        }
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
    let (tx, rx) = oneshot::channel();
    let (id, generation) = accept_command(state, command, Some(tx)).await?;

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

/// Wait for queue capacity without blocking stdout, request expiry or kill.
/// Queue insertion and its activity update then share one generation check and
/// lock acquisition, so stdout cannot overtake an accepted abort/UI response.
async fn accept_command(
    state: &ProcessState,
    command: &mut Value,
    response: Option<oneshot::Sender<Value>>,
) -> Result<(u64, u64), String> {
    let ui_response = command["type"] == "extension_ui_response";
    let (stdin_tx, generation, ui_token) = {
        let guard = state.inner.lock().await;
        let inner = guard.as_ref().ok_or("pi is not running")?;
        let mut activity = state.activity.lock().await;
        let generation = state.current_generation();
        if !activity.is_current(generation) {
            return Err("pi is not running".into());
        }
        let token = if ui_response {
            Some(
                activity
                    .response_token(command)
                    .ok_or("extension UI request is no longer pending")?,
            )
        } else {
            None
        };
        (inner.stdin_tx.clone(), generation, token)
    };
    let permit = stdin_tx
        .reserve_owned()
        .await
        .map_err(|_| "pi is not running (stdin closed)".to_string())?;
    let guard = state.inner.lock().await;
    let inner = guard.as_ref().ok_or("pi is not running")?;
    let mut activity = state.activity.lock().await;
    if state.current_generation() != generation || !activity.is_current(generation) {
        return Err("pi session changed before accepting command".into());
    }
    if ui_response && activity.response_token(command) != ui_token {
        return Err("extension UI request is no longer pending".into());
    }
    let id = if let Some(tx) = response {
        let id = inner.next_id.fetch_add(1, Ordering::Relaxed);
        command["id"] = json!(id);
        inner.pending.lock().await.insert(id, tx);
        id
    } else {
        0
    };
    permit.send(command.to_string());
    activity.command(command);
    Ok((id, generation))
}
/// Fire-and-forget write (e.g. `extension_ui_response`).
pub async fn process_notify(state: &ProcessState, mut command: Value) -> Result<(), String> {
    accept_command(state, &mut command, None).await.map(|_| ())
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

// Pi reserves a session filename before its first message creates the file.
fn local_session_key(file: &str, project: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(file);
    let path = if path.is_absolute() {
        path
    } else {
        PathBuf::from(project).join(path)
    };
    match dunce::canonicalize(&path) {
        Ok(path) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let parent = path.parent().ok_or("Session path has no parent")?;
            let name = path.file_name().ok_or("Session path has no filename")?;
            Ok(dunce::canonicalize(parent)
                .map_err(|e| e.to_string())?
                .join(name))
        }
        Err(e) => Err(e.to_string()),
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
    policy: RuntimePolicy,
) -> Result<(), String> {
    // P1 远程分支（契约 §3.1 第 7 条）：不注入 builtin extensions——它们物化的
    // 是本地文件路径（builtin_extensions.rs），对远端无效；PIX_WORKSPACE 同理不设。
    if policy.is_aux() {
        // aux 只用规格里的固定 argv（docs/aux-chat-spec.md §1），不叠加 PiX 扩展；
        // `-e` 白名单由调用方构造后经 extra_args 传入。
    } else if matches!(program, SpawnProgram::LocalPi(_)) {
        extra_args.extend(crate::builtin_extensions::rpc_args(&app)?);
        if workspace_manifest.is_some() {
            extra_args.extend(crate::builtin_extensions::workspace_extension_args()?);
        }
    }
    if policy.ephemeral() && session_file.is_some() {
        // `--session` 与 `--no-session` 互斥：aux 必须无文件（--no-session 只在
        // `aux_launch::aux_extra_args()` 里产出，这里挡住反向用法）。
        return Err(crate::errors::pix_error(
            "auxSessionForbidden",
            "辅助对话不接受会话文件",
        ));
    }
    let id = runtime_id.unwrap_or_else(|| "default".into());
    // Probe from a snapshot: each probe can take up to PROBE_TIMEOUT, so the
    // pool lock must never be held while a hung runtime is being probed.
    let snapshot: Vec<Arc<ProcessState>> = state.processes.lock().await.values().cloned().collect();
    if let Some(existing) = snapshot.iter().find(|p| p.runtime_id == id) {
        if child::process_running(existing).await {
            return Err("Runtime is already running".into());
        }
        // A replacement uses a new ProcessState. Retire the old state's readers
        // and timers before either worker can publish events with the same id.
        retire_process(existing).await;
    }
    // Never open the same persisted conversation in two processes. Probes are
    // time-bounded: a hung pi process must not block spawning forever.
    // 远端 POSIX 会话路径不做本地 canonicalize（Windows 上必失败），按原串比对。
    let session_key: Option<PathBuf> = match (&session_file, program) {
        (None, _) => None,
        (Some(file), SpawnProgram::LocalPi(_)) => Some(local_session_key(file, project)?),
        (Some(file), SpawnProgram::Remote(_)) => Some(PathBuf::from(file)),
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
                SpawnProgram::LocalPi(_) => {
                    response["data"]["sessionFile"]
                        .as_str()
                        .and_then(|f| local_session_key(f, project).ok())
                        .as_ref()
                        == Some(path)
                }
                SpawnProgram::Remote(_) => response["data"]["sessionFile"]
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
        project: Arc::new(Mutex::new(project.into())),
        policy,
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
    // M0：策略判定在统一入口，rewind_prompt 特判必须在其之后。
    process.policy.guard_request(&command)?;
    if command["type"] == "rewind_prompt" {
        return crate::sessions::edit::rewind_prompt(&process, &command).await;
    }
    let exporting = command["type"] == "export_html";
    let mut response = process_request(&process, command).await?;
    if exporting {
        resolve_export_path(&mut response, &process.project.lock().await)?;
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
    // 远程项目（ssh/wsl/docker URI）：导出路径位于远端文件系统，本地无法
    // canonicalize，原样返回 pi 给的路径作为防御性兜底（契约 §5）。
    if crate::ssh::is_remote_uri(project) {
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
    process.policy.guard_notify(&command)?;
    process_notify(&process, command).await
}
pub async fn running(state: &RpcState, runtime_id: Option<&str>) -> bool {
    match state.process(runtime_id).await {
        Ok(process) => child::process_running(&process).await,
        Err(_) => false,
    }
}

/// Snapshot the owning endpoint for session-file operations without navigating pi.
pub(crate) async fn session_endpoint(
    state: &RpcState,
    runtime_id: &str,
) -> Result<Option<crate::ssh::RemoteEndpoint>, String> {
    let process = state.process(Some(runtime_id)).await?;
    // aux 无 session 文件，复制/导出会话属于结构类越界操作。
    if process.policy.is_aux() {
        return Err(crate::errors::pix_error(
            "auxRpcDenied",
            "辅助对话不支持会话文件操作",
        ));
    }
    let guard = process.inner.lock().await;
    let inner = guard.as_ref().ok_or("pi is not running")?;
    Ok(inner.remote.as_ref().map(|remote| remote.endpoint.clone()))
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
        let generation = process.current_generation();
        let mut probe = json!({"type": "get_state"});
        if let Ok(response) =
            process_request_timeout(&process, &mut probe, Some(PROBE_TIMEOUT)).await
        {
            let mut activity = process.activity.lock().await;
            if !activity.is_current(generation) {
                continue;
            }
            let project = process.project.lock().await.clone();
            let mut snapshot = json!({"runtimeId": process.runtime_id, "project": project, "state": response["data"]});
            activity.snapshot(&mut snapshot);
            result.push(snapshot);
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
        // 内部 rename 绕过 rpc::request，这里复用同一策略：aux 永不收到 set_session_name。
        if process.policy.is_aux() {
            continue;
        }
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
            return crate::sessions::edit::process_set_session_name(
                &process,
                path,
                title,
                only_if_empty,
            )
            .await;
        }
    }
    crate::sessions::edit::process_set_session_name(
        &ProcessState::default(),
        path,
        title,
        only_if_empty,
    )
    .await
}

#[cfg(test)]
mod pending_cleanup_tests {
    use super::*;
    use std::future::Future;
    use std::pin::Pin;
    use std::process::Stdio;
    use std::sync::Mutex as StdMutex;
    use tokio::process::Command;

    #[derive(Default)]
    struct Sink(StdMutex<Vec<Value>>);

    impl child::EventSink for Sink {
        fn emit(&self, _: &'static str, _: &str, payload: Value) {
            self.0.lock().unwrap().push(payload);
        }
    }

    /// `SessionInner` needs a live child handle; a trivially exiting process
    /// is enough because only the pending map is exercised here.
    async fn state_with_session() -> ProcessState {
        let state = ProcessState::default();
        let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
        if cfg!(windows) {
            cmd.args(["/C", "exit 0"]);
        }
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
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
    async fn respawn_retires_exited_process_before_eof_with_error_exit_event() {
        #[derive(Default)]
        struct ExitSink(StdMutex<Vec<(&'static str, Value)>>);
        impl child::EventSink for ExitSink {
            fn emit(&self, event: &'static str, _: &str, payload: Value) {
                self.0.lock().unwrap().push((event, payload));
            }
        }

        let state = state_with_session().await;
        let sink = Arc::new(ExitSink::default());
        state.activity.lock().await.reset(
            0,
            "test",
            "project",
            Some("session.jsonl".into()),
            sink.clone(),
        );
        state
            .activity
            .lock()
            .await
            .event(json!({"type":"agent_start"}));
        while child::process_running(&state).await {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        // Model the restart race: waitpid has observed exit, but no stdout EOF
        // reader has emitted a terminal event yet.
        retire_process(&state).await;
        let events = sink.0.lock().unwrap();
        let exit = events
            .iter()
            .find(|(event, _)| *event == EXIT_EVENT)
            .expect("restart must emit pi://exit");
        assert_eq!(exit.1["pixRunStatus"], "error");
        assert_eq!(exit.1["pixSessionFile"], "session.jsonl");
        assert!(exit.1["pixRunId"].as_str().is_some_and(|id| !id.is_empty()));
    }

    #[tokio::test]
    async fn timeout_cleanup_removes_pending_from_the_current_generation() {
        let state = state_with_session().await;
        let (tx, _rx) = oneshot::channel::<Value>();
        let inner = state.inner.lock().await;
        inner.as_ref().unwrap().pending.lock().await.insert(7, tx);
        drop(inner);
        let generation = state.generation.load(Ordering::Relaxed);
        remove_pending_if_current(&state, 7, generation).await;
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
                .is_empty(),
            "timed-out entry of the current session is removed"
        );
    }

    #[tokio::test]
    async fn timeout_cleanup_skips_pending_from_an_older_generation() {
        let state = state_with_session().await;
        let (tx, _rx) = oneshot::channel::<Value>();
        let inner = state.inner.lock().await;
        inner.as_ref().unwrap().pending.lock().await.insert(7, tx);
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

    #[tokio::test]
    async fn accepted_ui_response_clears_snapshot_and_broadcasts_to_other_clients() {
        let state = state_with_session().await;
        let (stdin_tx, mut stdin_rx) = mpsc::channel(8);
        state.inner.lock().await.as_mut().unwrap().stdin_tx = stdin_tx;
        let sink = Arc::new(Sink::default());
        state
            .activity
            .lock()
            .await
            .reset(0, "test", "project", None, sink.clone());
        state.activity.lock().await.event(json!({
            "type":"extension_ui_request", "id":"question", "method":"confirm"
        }));
        let response = json!({"type":"extension_ui_response", "id":"question", "confirmed":true});
        process_notify(&state, response.clone()).await.unwrap();
        assert_eq!(stdin_rx.recv().await.unwrap(), response.to_string());
        let mut snapshot = json!({});
        state.activity.lock().await.snapshot(&mut snapshot);
        assert!(snapshot["pendingUiRequests"].as_array().unwrap().is_empty());
        let emitted = sink.0.lock().unwrap();
        assert_eq!(emitted.last().unwrap()["type"], "extension_ui_resolved");
        assert_eq!(emitted.last().unwrap()["id"], "question");
        assert_eq!(emitted.last().unwrap()["runtimeId"], "test");
    }

    #[tokio::test]
    async fn failed_ui_response_write_keeps_request_available_for_reconnect() {
        let state = state_with_session().await;
        let sink = Arc::new(Sink::default());
        state
            .activity
            .lock()
            .await
            .reset(0, "test", "project", None, sink.clone());
        state.activity.lock().await.event(json!({
            "type":"extension_ui_request", "id":"question", "method":"input"
        }));
        assert!(process_notify(
            &state,
            json!({
                "type":"extension_ui_response", "id":"question", "value":"answer"
            })
        )
        .await
        .is_err());
        let mut snapshot = json!({});
        state.activity.lock().await.snapshot(&mut snapshot);
        assert_eq!(snapshot["pendingUiRequests"].as_array().unwrap().len(), 1);
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }

    async fn backpressured_state() -> (ProcessState, mpsc::Receiver<String>, Arc<Sink>) {
        let state = state_with_session().await;
        let (stdin_tx, stdin_rx) = mpsc::channel(1);
        stdin_tx.try_send("queued".into()).unwrap();
        state.inner.lock().await.as_mut().unwrap().stdin_tx = stdin_tx;
        let sink = Arc::new(Sink::default());
        state.activity.lock().await.reset(
            0,
            "test",
            "project",
            Some("session.jsonl".into()),
            sink.clone(),
        );
        (state, stdin_rx, sink)
    }

    async fn assert_pending<F: Future>(mut future: Pin<&mut F>) {
        std::future::poll_fn(|cx| {
            assert!(
                future.as_mut().poll(cx).is_pending(),
                "queue must actually apply backpressure"
            );
            std::task::Poll::Ready(())
        })
        .await;
    }

    #[tokio::test]
    async fn backpressured_request_releases_locks_and_registers_only_on_acceptance() {
        let (state, mut stdin_rx, _) = backpressured_state().await;
        let mut command = json!({"type":"get_state"});
        let request = process_request_timeout(&state, &mut command, Some(PROBE_TIMEOUT));
        tokio::pin!(request);
        assert_pending(request.as_mut()).await;
        {
            let inner = state
                .inner
                .try_lock()
                .expect("backpressure must release inner");
            assert!(inner.as_ref().unwrap().pending.lock().await.is_empty());
            assert!(
                state.activity.try_lock().is_ok(),
                "backpressure must release activity"
            );
        }
        assert_eq!(stdin_rx.recv().await.as_deref(), Some("queued"));
        assert_pending(request.as_mut()).await;
        let accepted: Value = serde_json::from_str(&stdin_rx.recv().await.unwrap()).unwrap();
        assert_eq!(accepted["id"], 1);
        let inner = state.inner.lock().await;
        inner
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .await
            .remove(&1)
            .unwrap()
            .send(json!({"success":true}))
            .unwrap();
        drop(inner);
        assert_eq!(request.await.unwrap()["success"], true);
    }

    #[tokio::test]
    async fn backpressured_notify_does_not_block_kill_or_lose_idle_exit_metadata() {
        let (state, mut stdin_rx, sink) = backpressured_state().await;
        state
            .activity
            .lock()
            .await
            .event(json!({"type":"agent_start"}));
        let started = sink.0.lock().unwrap()[0].clone();
        let notify = process_notify(&state, json!({"type":"abort"}));
        tokio::pin!(notify);
        assert_pending(notify.as_mut()).await;
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            child::process_kill(&state, "test"),
        )
        .await
        .expect("kill must not wait for stdin capacity")
        .unwrap();
        let exit = sink.0.lock().unwrap().last().unwrap().clone();
        assert_eq!(exit["runtimeId"], "test");
        assert_eq!(exit["pixProject"], "project");
        assert_eq!(exit["pixSessionFile"], "session.jsonl");
        assert_eq!(exit["pixRunId"], started["pixRunId"]);
        assert_eq!(exit["pixRunStatus"], "idle");
        assert!(exit["pixRunUpdatedAt"].as_u64() > started["pixRunUpdatedAt"].as_u64());
        stdin_rx.recv().await.unwrap();
        assert!(notify.await.is_err());
        assert!(
            stdin_rx.try_recv().is_err(),
            "retired generation cannot enqueue its command"
        );
    }

    #[tokio::test]
    async fn backpressured_request_cannot_register_in_a_replacement_generation() {
        let (state, mut stdin_rx, sink) = backpressured_state().await;
        let mut command = json!({"type":"get_state"});
        let request = process_request_timeout(&state, &mut command, Some(PROBE_TIMEOUT));
        tokio::pin!(request);
        assert_pending(request.as_mut()).await;
        {
            let guard = state.inner.lock().await;
            let mut activity = state.activity.lock().await;
            state.generation.store(1, Ordering::Relaxed);
            activity.reset(1, "test", "project", None, sink);
            let (tx, _rx) = oneshot::channel();
            guard.as_ref().unwrap().pending.lock().await.insert(1, tx);
        }
        stdin_rx.recv().await.unwrap();
        assert!(request.await.unwrap_err().contains("session changed"));
        assert!(stdin_rx.try_recv().is_err());
        assert!(state
            .inner
            .lock()
            .await
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .await
            .contains_key(&1));
    }

    #[tokio::test]
    async fn ui_response_waiting_for_capacity_cannot_resolve_a_reused_id_after_timeout() {
        let (state, mut stdin_rx, _) = backpressured_state().await;
        let (token, deadline) = state
            .activity
            .lock()
            .await
            .event(json!({
                "type":"extension_ui_request", "id":"question", "method":"input", "timeout":20
            }))
            .unwrap();
        activity::schedule_timeout(Arc::downgrade(&state.activity), 0, token, deadline);
        let response = json!({"type":"extension_ui_response", "id":"question", "value":"old"});
        let notify = process_notify(&state, response);
        tokio::pin!(notify);
        assert_pending(notify.as_mut()).await;
        tokio::time::sleep_until(deadline + std::time::Duration::from_millis(1)).await;
        let mut snapshot = json!({});
        state.activity.lock().await.snapshot(&mut snapshot);
        assert!(snapshot["pendingUiRequests"].as_array().unwrap().is_empty());
        state.activity.lock().await.event(json!({
            "type":"extension_ui_request", "id":"question", "method":"input"
        }));
        stdin_rx.recv().await.unwrap();
        assert!(notify.await.unwrap_err().contains("no longer pending"));
        assert!(stdin_rx.try_recv().is_err());
        state.activity.lock().await.snapshot(&mut snapshot);
        assert_eq!(snapshot["pendingUiRequests"].as_array().unwrap().len(), 1);
        process_notify(
            &state,
            json!({"type":"extension_ui_response", "id":"question", "value":"new"}),
        )
        .await
        .unwrap();
        assert!(stdin_rx.recv().await.unwrap().contains("new"));
        state.activity.lock().await.snapshot(&mut snapshot);
        assert!(snapshot["pendingUiRequests"].as_array().unwrap().is_empty());
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

#[cfg(test)]
mod session_key_tests {
    use super::*;
    #[test]
    fn accepts_allocated_but_unwritten_session_file() {
        let dir = std::env::temp_dir().join(format!("pix-session-key-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let project = dir.to_str().unwrap();
        let expected = dunce::canonicalize(&dir).unwrap().join("new.jsonl");
        assert_eq!(local_session_key("new.jsonl", project).unwrap(), expected);
        std::fs::write(&expected, "").unwrap();
        assert_eq!(local_session_key("new.jsonl", project).unwrap(), expected);
        assert!(local_session_key("missing/new.jsonl", project).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
