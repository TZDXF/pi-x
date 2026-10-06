//! Child-process wiring: spawn `pi --mode rpc`, wire up the stdio bridge
//! (stdin writer plus LF-framed stdout/stderr readers) and kill the process
//! tree. Pool management stays in the parent [`super`] module.

use super::{
    emit_process_event, write_line, ProcessState, CREATE_NO_WINDOW, EVENT, EXIT_EVENT,
    SSH_PATH_BOUND_EVENT, STDERR_EVENT,
};
use crate::errors::{pix_error, pix_error_detail};
use crate::pi_locate::{is_windows_script, Launcher, PiInfo};
use crate::ssh::transport::{classify_failure, SshEndpoint, SshErrorKind};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;

/// spawn 桥接层的事件出口：生产实现把进程事件转发进 Tauri/远程事件流，
/// 测试注入收集器以断言 mock ssh 的 spawn → JSONL → `pi://exit` 全链路
/// （契约 §7 验收第 2 条），无需构造 Tauri `AppHandle`。
pub(super) trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &'static str, runtime_id: &str, payload: Value);
}

struct TauriEventSink(AppHandle);

impl EventSink for TauriEventSink {
    fn emit(&self, event: &'static str, runtime_id: &str, payload: Value) {
        emit_process_event(&self.0, event, runtime_id, payload);
    }
}

/// spawn 程序的两个分支（契约 §3.7）：本地 pi 直连，或经本地 ssh 客户端
/// 中继远端 `pi --mode rpc`（stdout 同样是 JSONL，桥接层零改动）。
pub enum SpawnProgram {
    LocalPi(PiInfo),
    Ssh(SshSpawnSpec),
}

/// ssh 分支的 spawn 规格：endpoint 即连接配置展开后的权威来源，
/// `remote_path` 为项目 URI 解析出的远端绝对 POSIX 路径。
#[derive(Clone, Debug)]
pub struct SshSpawnSpec {
    pub endpoint: SshEndpoint,
    pub remote_path: String,
}

/// 一次远程会话的 kill 兜底信息：本地 ssh 子进程被杀后，远端 pi 可能
/// 因 stdin EOF 语义未实测而残留，保存 endpoint 与远端 pid 以便补刀。
pub(super) struct RemoteSession {
    pub(super) endpoint: SshEndpoint,
    /// 由 stderr reader 从 `PIX_PI_PID=` 行回填（payload 在 exec 前打印）。
    pub(super) remote_pid: Arc<Mutex<Option<u32>>>,
}

pub(super) struct SessionInner {
    pub(super) child: Child,
    pub(super) stdin_tx: mpsc::Sender<String>,
    pub(super) pending: PendingMap,
    pub(super) next_id: Arc<AtomicU64>,
    pub(super) remote: Option<RemoteSession>,
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

/// Spawn the program selected by `program` (local `pi --mode rpc`, or remote
/// pi relayed through a local ssh client) inside `project` and wire up the
/// stdio bridge. `session_file` resumes a stored session (`--session <path>`);
/// the ssh branch embeds it into the remote payload instead.
pub(super) async fn process_spawn(
    app: AppHandle,
    state: &ProcessState,
    program: &SpawnProgram,
    project: &str,
    session_file: Option<String>,
    extra_args: Vec<String>,
    workspace_manifest: Option<String>,
) -> Result<(), String> {
    process_spawn_impl(
        Arc::new(TauriEventSink(app)),
        state,
        program,
        project,
        session_file,
        extra_args,
        workspace_manifest,
    )
    .await
}

/// Same as [`process_spawn`] with the event outlet injected: production emits
/// Tauri/remote events, tests collect them to assert the full mock-ssh chain.
async fn process_spawn_impl(
    sink: Arc<dyn EventSink>,
    state: &ProcessState,
    program: &SpawnProgram,
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

    // 远程会话上下文：endpoint 供 kill 兜底，remote_pid 由 stderr reader 回填；
    // 本地分支用哑 Arc 占位以复用同一套 reader 装配代码。
    let remote = match program {
        SpawnProgram::Ssh(spec) => Some(RemoteSession {
            endpoint: spec.endpoint.clone(),
            remote_pid: Arc::new(Mutex::new(None)),
        }),
        SpawnProgram::LocalPi(_) => None,
    };
    let is_ssh = remote.is_some();
    let remote_pid = remote
        .as_ref()
        .map(|r| r.remote_pid.clone())
        .unwrap_or_else(|| Arc::new(Mutex::new(None)));
    // stderr 最近行缓冲：ssh 分支在子进程早退时把退出码归类为 coded error。
    let stderr_tail: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));

    let mut child = match program {
        SpawnProgram::LocalPi(pi) => {
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

            cmd.current_dir(project);
            // Consumed by the pix-workspace extension to render the
            // <pix_workspace> prompt section; plain sessions leave it unset.
            if let Some(manifest) = &workspace_manifest {
                cmd.env("PIX_WORKSPACE", manifest);
            }
            cmd.stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            // Error paths below (e.g. missing stdio pipes) drop the Child before
            // the readers are wired up; tokio does not kill on drop by default,
            // so make sure the pi process never leaks as an orphan.
            cmd.kill_on_drop(true);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            cmd.spawn().map_err(|e| format!("failed to spawn pi: {e}"))?
        }
        SpawnProgram::Ssh(spec) => {
            // 远程分支（契约 §3.1）：不设 current_dir；builtin extensions 不注入
            //（extra_args 为空），payload 经 base64 通道投递，本地不经任何 shell。
            // P1 远程 extra args 恒为空，接口预留 Vec<String>。
            let payload = crate::ssh::build_spawn_payload(
                &spec.remote_path,
                session_file.as_deref(),
                &extra_args,
            );
            crate::ssh::ssh_exec_stream(&spec.endpoint, &payload)
                .await
                .map_err(|e| crate::commands::ssh::ssh_error_coded(&e))?
        }
    };

    let session_label = session_file.clone().unwrap_or_else(|| "<new>".into());
    match program {
        SpawnProgram::LocalPi(_) => crate::logs::write(
            &state.runtime_id,
            &format!(
                "spawn pid={} project={} session={}",
                child
                    .id()
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "?".into()),
                project,
                session_label,
            ),
        ),
        SpawnProgram::Ssh(spec) => crate::logs::write(
            &state.runtime_id,
            &format!(
                "spawn (ssh) pid={} endpoint={}@{}:{} path={} session={}",
                child
                    .id()
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "?".into()),
                spec.endpoint.user.as_deref().unwrap_or(""),
                spec.endpoint.host,
                spec.endpoint.port,
                spec.remote_path,
                session_label,
            ),
        ),
    };

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
        let sink = sink.clone();
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
                        // 非 JSON 行（SSH banner/motd、远端 .bashrc echo）静默容忍；
                        // 记一条截断摘要日志便于诊断（契约 §3.8）。
                        crate::logs::write(
                            &runtime_id,
                            &format!(
                                "dropped non-JSON stdout line: {}",
                                String::from_utf8_lossy(&line[..line.len().min(200)])
                            ),
                        );
                        continue;
                    };
                    dispatch(&sink, &pending, &runtime_id, value).await;
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
                sink.emit(EXIT_EVENT, &runtime_id, json!({ "runtimeId": runtime_id }));
            }
        });
    }

    // stderr reader: forward raw lines for logging
    {
        let sink = sink.clone();
        let runtime_id = state.runtime_id.clone();
        let remote_pid = remote_pid.clone();
        let stderr_tail = stderr_tail.clone();
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
                    if text.is_empty() {
                        continue;
                    }
                    // 远程 payload 在 exec 前把 shell pid 写到 stderr（契约 §3.5）：
                    // 回填 remote_pid 供 kill 兜底，且不向 pi://stderr 转发该行。
                    if is_ssh && text.starts_with("PIX_PI_PID=") {
                        if let Ok(pid) = text["PIX_PI_PID=".len()..].trim().parse::<u32>() {
                            *remote_pid.lock().await = Some(pid);
                        }
                        crate::logs::write(&runtime_id, &format!("remote pi pid line: {text}"));
                        continue;
                    }
                    append_stderr_tail(&stderr_tail, &text).await;
                    crate::logs::write(&runtime_id, &format!("stderr: {text}"));
                    sink.emit(
                        STDERR_EVENT,
                        &runtime_id,
                        json!({ "line": text, "runtimeId": runtime_id }),
                    );
                }
                drop_oversized_record(&mut buf, &runtime_id, "stderr");
            }
        });
    }

    // ssh 分支就绪等待（契约 §3.9）：把连接失败、cd 失败(90)、远程缺 pi(92)
    // 归一化为 coded error 经 rpc_spawn 的 Err 返回给前端 toast。
    if let SpawnProgram::Ssh(_) = program {
        if let Err(message) = wait_ssh_ready(&state.runtime_id, &mut child, &remote_pid, &stderr_tail).await {
            // spawn 失败：再 bump generation，让已装配的 reader 不发 pi://exit
            //（该 runtime 从未进入进程池）。
            state.generation.fetch_add(1, Ordering::Relaxed);
            return Err(message);
        }
        // 路径别名回绑（契约 §3.8 / P2 §1.1）：所有远程 spawn（含新建）就绪后
        // 都执行回绑检查，一次 exec realpath 归一化远端路径，防 /home/dev 与
        // /dev 符号链接别名导致身份漂移；与 URI path 不同则发
        // pi://sshPathBound 供前端更新展示。失败不阻塞 spawn、不发事件。
        if let SpawnProgram::Ssh(spec) = program {
            let rebind_sink = sink.clone();
            let rebind_runtime_id = state.runtime_id.clone();
            let rebind_endpoint = spec.endpoint.clone();
            let rebind_project = project.to_string();
            let rebind_path = spec.remote_path.clone();
            tokio::spawn(async move {
                rebind_remote_path(
                    &*rebind_sink,
                    &rebind_runtime_id,
                    &rebind_endpoint,
                    &rebind_project,
                    &rebind_path,
                )
                .await;
            });
        }
    }

    *guard = Some(SessionInner {
        child,
        stdin_tx,
        pending,
        next_id,
        remote,
    });
    Ok(())
}

/// 重连回绑用的 realpath 脚本：路径按契约 §3.4 单引号包裹（`'\''` 转义）。
fn realpath_script(remote_path: &str) -> String {
    format!("realpath {}\n", crate::ssh::posix_quote(remote_path))
}

/// 解析 realpath 输出：取最后一个非空行（banner/motd 污染出现在输出之前，
/// 契约 §3.8），容忍尾部空行。
fn parse_realpath_output(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

/// realpath 回绑解析结果（契约 §3.8 / P2 §1.1）。独立于事件发射，
/// 供实机集成测试（S-R1）直接驱动。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PathRebind {
    /// realpath 与原路径一致，无需回绑。
    Unchanged,
    /// 路径有差异：`resolved` 为归一化后的远端物理路径，`rebound_project`
    /// 为用 `resolved` 回绑重建的 `ssh://` 展示 URI。
    Rebound {
        resolved: String,
        rebound_project: String,
    },
}

/// realpath 回绑解析（契约 §3.8）：一次 exec（10s 超时），解析失败或路径
/// 未变返回 `Unchanged`/`Err`（原因供日志），路径变化则重建展示 URI。
pub(crate) async fn resolve_path_rebind(
    endpoint: &SshEndpoint,
    project: &str,
    remote_path: &str,
) -> Result<PathRebind, String> {
    let output = crate::ssh::ssh_exec(
        endpoint,
        &realpath_script(remote_path),
        Duration::from_secs(10),
    )
    .await
    .map_err(|e| e.detail)?;
    let Some(resolved) = parse_realpath_output(&output.stdout) else {
        return Err("empty output".to_string());
    };
    if resolved == remote_path {
        return Ok(PathRebind::Unchanged);
    }
    // 重建展示 URI：host/port/user 沿用原 URI 解析结果，仅替换归一化后的 path。
    let rebound = crate::ssh::parse_ssh_uri(project).and_then(|mut target| {
        target.path = resolved.clone();
        crate::ssh::build_ssh_uri(&target).ok()
    });
    let Some(rebound_project) = rebound else {
        return Err(format!("cannot rebuild URI for {resolved}"));
    };
    Ok(PathRebind::Rebound {
        resolved,
        rebound_project,
    })
}

/// 远程 spawn（新建与重连）就绪后的 realpath 回绑（契约 §3.8 / P2 §1.1）：
/// 解析失败或路径未变只记日志；路径变化则发 `pi://sshPathBound`，
/// 供前端 `workspace.remember` 更新展示。
async fn rebind_remote_path(
    sink: &dyn EventSink,
    runtime_id: &str,
    endpoint: &SshEndpoint,
    project: &str,
    remote_path: &str,
) {
    let started = Instant::now();
    let rebind = match resolve_path_rebind(endpoint, project, remote_path).await {
        Ok(rebind) => rebind,
        Err(reason) => {
            crate::logs::write(
                runtime_id,
                &format!("realpath rebind skipped (ignored): {reason}"),
            );
            return;
        }
    };
    let PathRebind::Rebound {
        resolved,
        rebound_project,
    } = rebind
    else {
        crate::logs::write(
            runtime_id,
            &format!(
                "realpath rebind: path unchanged in {}ms",
                started.elapsed().as_millis()
            ),
        );
        return;
    };
    crate::logs::write(
        runtime_id,
        &format!("realpath rebind: {remote_path} -> {resolved}"),
    );
    sink.emit(
        SSH_PATH_BOUND_EVENT,
        runtime_id,
        json!({ "runtimeId": runtime_id, "project": rebound_project, "path": resolved }),
    );
}

/// stderr 最近行缓冲上限：仅用于早退归类，保留尾部 8KiB 足够容纳认证/网络错误。
const STDERR_TAIL_CAP: usize = 8 * 1024;

async fn append_stderr_tail(tail: &Mutex<String>, line: &str) {
    let mut tail = tail.lock().await;
    tail.push_str(line);
    tail.push('\n');
    if tail.len() > STDERR_TAIL_CAP {
        let cut = tail.len() - STDERR_TAIL_CAP;
        // 从行界裁剪，避免截断 UTF-8 多字节序列。
        let start = tail[cut..].find('\n').map(|i| cut + i + 1).unwrap_or(cut);
        tail.drain(..start);
    }
}

/// 远程 spawn 就绪等待：
/// - 子进程在 `PIX_PI_PID=` 之前退出 → 连接/auth/cd(90) 失败，归类为 coded error；
/// - 收到 PID 行后再等一小段宽限期，捕获 `command -v pi` 失败(92) 的立即退出
///   （PID 行与 exit 92 之间仅隔一次 command -v，毫秒级）；
/// - 超时仍存活 → 视为慢启动成功返回，后续失败由 stdout EOF 流程兜底。
async fn wait_ssh_ready(
    runtime_id: &str,
    child: &mut Child,
    remote_pid: &Mutex<Option<u32>>,
    stderr_tail: &Mutex<String>,
) -> Result<(), String> {
    const READY_TIMEOUT: Duration = Duration::from_secs(20);
    const PID_GRACE: Duration = Duration::from_secs(1);
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // 让 stderr reader 把最后的错误行写进缓冲再归类。
                tokio::time::sleep(Duration::from_millis(100)).await;
                let tail = stderr_tail.lock().await.clone();
                crate::logs::write(
                    runtime_id,
                    &format!("ssh relay exited before ready: {status} stderr={}", tail.trim()),
                );
                return Err(ssh_exit_error(status, &tail));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("failed to poll ssh relay: {e}")),
        }
        if remote_pid.lock().await.is_some() {
            // 远端 shell 已 cd 成功并拿到 pid；宽限窗口内立即退出视为 pi 缺失(92)。
            tokio::time::sleep(PID_GRACE).await;
            match child.try_wait() {
                Ok(Some(status)) => {
                    let tail = stderr_tail.lock().await.clone();
                    crate::logs::write(
                        runtime_id,
                        &format!("ssh relay exited right after pid line: {status}"),
                    );
                    return Err(ssh_exit_error(status, &tail));
                }
                Ok(None) => return Ok(()),
                Err(e) => return Err(format!("failed to poll ssh relay: {e}")),
            }
        }
        if Instant::now() >= deadline {
            crate::logs::write(runtime_id, "ssh relay not confirmed ready within 20s; assuming slow start");
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 把 ssh 中继子进程的退出码 + stderr 摘要归一化为 coded error。
fn ssh_exit_error(status: ExitStatus, stderr_tail: &str) -> String {
    let code = status.code().unwrap_or(-1);
    match code {
        // 契约 §3.5 约定退出码：90=cd 失败（目录不存在）、92=远程未装 pi。
        crate::ssh::EXIT_CODE_CHDIR_FAILED => pix_error("projectDirMissing", "项目目录不存在"),
        crate::ssh::EXIT_CODE_PI_MISSING => pix_error(
            "sshRemotePiMissing",
            "远程主机未安装 pi。请先在远程主机上安装 pi CLI（需要 Node.js）。",
        ),
        _ => {
            let stderr = stderr_tail.trim();
            match classify_failure(code, stderr) {
                // 契约 P2 §5.1：host key 两类场景从 auth 中细分，给可操作文案。
                SshErrorKind::HostKey => {
                    if stderr.to_lowercase().contains("remote host identification has changed") {
                        pix_error(
                            "sshHostKeyChanged",
                            "远程主机指纹与 known_hosts 记录不一致，可能是主机重装或中间人攻击。核实后在 ~/.ssh/known_hosts 中删除该主机条目再重试。",
                        )
                    } else {
                        pix_error(
                            "sshHostKeyUnverified",
                            "主机指纹尚未确认。请先在终端手动 ssh 一次该主机并确认指纹，然后重试。",
                        )
                    }
                }
                SshErrorKind::Auth => pix_error(
                    "sshAuthFailed",
                    "SSH 认证失败。请检查密钥或 agent。",
                ),
                SshErrorKind::Network => pix_error(
                    "sshConnectFailed",
                    "无法连接到远程主机，请检查主机、端口与网络。",
                ),
                _ => match stderr.is_empty() {
                    true => pix_error_detail(
                        "sshProbeFailed",
                        "远程启动失败: {detail}",
                        format!("远程 pi 进程退出码 {code}"),
                    ),
                    false => pix_error_detail("sshProbeFailed", "远程启动失败: {detail}", stderr),
                },
            }
        }
    }
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

async fn dispatch(sink: &Arc<dyn EventSink>, pending: &PendingMap, runtime_id: &str, value: Value) {
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
    sink.emit(EVENT, runtime_id, value);
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
    // 远程 pid 兜底（契约 §3.9）：本地 ssh 通道断开后远端 pi 可能残留，
    // 经一次独立 ssh exec 发 kill -TERM（5s 超时）；失败降级为日志，不阻塞本地 kill。
    if let Some(remote) = &inner.remote {
        let pid = remote.remote_pid.lock().await.take();
        if let Some(pid) = pid {
            let script = format!("kill -TERM {pid} 2>/dev/null\n");
            match crate::ssh::ssh_exec(&remote.endpoint, &script, Duration::from_secs(5)).await {
                Ok(_) => {
                    crate::logs::write(runtime_id, &format!("remote kill -TERM {pid} sent"));
                }
                Err(e) => {
                    crate::logs::write(
                        runtime_id,
                        &format!("remote kill -TERM {pid} failed (ignored): {}", e.detail),
                    );
                }
            }
        }
    }
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
mod ssh_exit_error_tests {
    use super::*;

    fn status_with_code(code: i32) -> ExitStatus {
        #[cfg(windows)]
        {
            std::os::windows::process::ExitStatusExt::from_raw(code as u32)
        }
        #[cfg(not(windows))]
        {
            std::os::unix::process::ExitStatusExt::from_raw(code << 8)
        }
    }

    #[test]
    fn contract_exit_codes_map_to_coded_errors() {
        // 契约 §3.5：90=cd 失败（复用 projectDirMissing）、92=远程缺 pi。
        assert!(ssh_exit_error(status_with_code(90), "").contains("projectDirMissing"));
        assert!(ssh_exit_error(status_with_code(92), "").contains("sshRemotePiMissing"));
    }

    #[test]
    fn ssh_client_failures_classify_by_stderr() {
        assert!(
            ssh_exit_error(status_with_code(255), "dev@host: Permission denied (publickey).")
                .contains("sshAuthFailed")
        );
        assert!(ssh_exit_error(status_with_code(255), "ssh: Could not resolve hostname host")
            .contains("sshConnectFailed"));
        // 其余退出码携带 stderr 摘要（含退出码语境）。
        let coded = ssh_exit_error(status_with_code(1), "sh: cd: no such directory");
        assert!(coded.contains("sshProbeFailed"), "{coded}");
        assert!(coded.contains("no such directory"));
        let coded = ssh_exit_error(status_with_code(1), "");
        assert!(coded.contains("sshProbeFailed"), "{coded}");
        assert!(coded.contains("1"));
    }

    #[test]
    fn host_key_failures_map_to_operable_coded_errors() {
        // 契约 P2 §5.1/§5.2：两段真实 stderr 文本（wsl-test-env.md 实机发现）。
        let coded = ssh_exit_error(status_with_code(255), "Host key verification failed.");
        assert!(coded.contains("sshHostKeyUnverified"), "{coded}");
        let changed = concat!(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n",
            "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n",
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n",
        );
        let coded = ssh_exit_error(status_with_code(255), changed);
        assert!(coded.contains("sshHostKeyChanged"), "{coded}");
    }
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

#[cfg(test)]
mod rebind_tests {
    use super::*;

    #[test]
    fn realpath_script_quotes_path_per_payload_contract() {
        // 契约 §3.4：脚本内嵌路径单引号包裹 + '\'' 转义。
        assert_eq!(realpath_script("/home/dev"), "realpath '/home/dev'\n");
        assert_eq!(realpath_script("/home/d'v"), "realpath '/home/d'\\''v'\n");
    }

    #[test]
    fn parse_realpath_output_tolerates_banner_and_requires_a_line() {
        assert_eq!(parse_realpath_output("/dev\n").as_deref(), Some("/dev"));
        // banner/motd 出现在真实输出之前，取最后一个非空行。
        assert_eq!(
            parse_realpath_output("Last login: Fri Oct  3 09:00:00 2026\n/dev\n").as_deref(),
            Some("/dev")
        );
        assert_eq!(parse_realpath_output("/dev\n\n").as_deref(), Some("/dev"));
        assert_eq!(parse_realpath_output("  \n"), None);
        assert_eq!(parse_realpath_output(""), None);
    }
}

#[cfg(test)]
mod mock_ssh_spawn_tests {
    use super::*;
    use crate::ssh::transport::{env_lock, find_test_program};

    /// 把桥接层发出的事件收进 channel，供断言全链路（契约 §7 验收第 2 条）。
    struct CollectingSink(tokio::sync::mpsc::UnboundedSender<(&'static str, Value)>);

    impl EventSink for CollectingSink {
        fn emit(&self, event: &'static str, _runtime_id: &str, payload: Value) {
            let _ = self.0.send((event, payload));
        }
    }

    #[tokio::test]
    async fn mock_ssh_spawn_bridges_jsonl_to_exit_event_without_real_ssh() {
        let Some(node) = find_test_program("node") else {
            eprintln!("跳过：开发环境未找到 node");
            return;
        };
        if node.to_string_lossy().contains(' ') {
            eprintln!("跳过：node 路径含空白，无法经 PIX_SSH_COMMAND 注入");
            return;
        }
        let _guard = env_lock();
        // mock ssh：向 stderr 打印 PIX_PI_PID=（契约 §3.5），向 stdout 打印
        // JSONL 事件与非 JSON banner 行（§3.8 容忍层），随后驻留到 stdin EOF
        //（模拟 ssh 连接关闭）。脚本不得含空白：PIX_SSH_COMMAND 按 ASCII 空白
        // 切分，首段为程序路径，其余逐段成为前置参数。
        let mock = "process.stderr.write('PIX_PI_PID=4242\\n');\
                    process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');\
                    process.stdout.write('banner(motd)\\n');\
                    process.stdout.write(JSON.stringify({type:'agent_end'})+'\\n');\
                    process.stdin.resume();process.stdin.on('end',()=>process.exit(0))";
        // 整个脚本是 PIX_SSH_COMMAND 的单个空白段（注入格式约束）。
        assert_eq!(mock.split_ascii_whitespace().count(), 1);
        std::env::set_var(
            "PIX_SSH_COMMAND",
            format!("{} -e {} --", node.display(), mock),
        );

        let state = ProcessState {
            runtime_id: "mock-ssh-runtime".to_string(),
            project: String::new(),
            inner: Mutex::new(None),
            navigation: Mutex::new(()),
            generation: Arc::new(AtomicU64::new(0)),
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(CollectingSink(tx));
        let result = process_spawn_impl(
            sink,
            &state,
            &SpawnProgram::Ssh(SshSpawnSpec {
                endpoint: SshEndpoint {
                    host: "mock.test".to_string(),
                    port: 2222,
                    user: Some("dev".to_string()),
                    key_path: None,
                },
                remote_path: "/home/dev/proj".to_string(),
            }),
            "ssh://dev@mock.test:2222/home/dev/proj",
            None,
            vec![],
            None,
        )
        .await;
        std::env::remove_var("PIX_SSH_COMMAND");
        result.expect("mock ssh spawn 应经 PIX_PI_PID 行 + 宽限期判定就绪");

        // stdout 桥接：两条 JSONL 事件被转发并盖上 runtimeId；非 JSON banner 行
        // 不得产生事件。
        let mut forwarded = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while forwarded.len() < 2 {
            let (event, payload) = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .expect("等待桥接事件超时")
                .expect("event channel closed");
            assert_eq!(event, EVENT, "仅 pi://event 应在 exit 前到达: {event}");
            forwarded.push(payload);
        }
        assert_eq!(forwarded[0]["type"], "agent_start");
        assert_eq!(forwarded[0]["runtimeId"], "mock-ssh-runtime");
        assert_eq!(forwarded[1]["type"], "agent_end");

        // stderr reader 把 PIX_PI_PID= 行回填进 remote_pid（kill 兜底依赖）。
        let remote_pid = loop {
            {
                let guard = state.inner.lock().await;
                if let Some(inner) = guard.as_ref() {
                    let pid = inner
                        .remote
                        .as_ref()
                        .unwrap()
                        .remote_pid
                        .lock()
                        .await
                        .clone();
                    if let Some(pid) = pid {
                        break pid;
                    }
                }
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "remote_pid 未被 stderr reader 回填"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        };
        assert_eq!(remote_pid, 4242);

        // 关闭会话（kill_on_drop 终止 mock ssh）→ stdout EOF → pi://exit。
        state.inner.lock().await.take();
        let (event, payload) = rx.recv().await.expect("event channel closed");
        assert_eq!(event, EXIT_EVENT);
        assert_eq!(payload["runtimeId"], "mock-ssh-runtime");
        // PIX_PI_PID= 行不得经 pi://stderr 外发（契约 §3.8）。
        while let Ok((event, _)) = rx.try_recv() {
            assert_ne!(event, STDERR_EVENT);
        }
    }
}
