//! Child-process wiring: spawn `pi --mode rpc`, wire up the stdio bridge
//! (stdin writer plus LF-framed stdout/stderr readers) and kill the process
//! tree. Pool management stays in the parent [`super`] module.

use super::activity::{schedule_timeout, RuntimeActivity};
#[cfg(test)]
use super::EVENT;
use super::{
    emit_process_event, write_line, ProcessState, EXIT_EVENT, SSH_PATH_BOUND_EVENT, STDERR_EVENT,
};
use crate::errors::pix_error;
use crate::pi_locate::{self, PiInfo};
use crate::process::CREATE_NO_WINDOW;
use crate::ssh::backend::RemoteEndpoint;
use crate::ssh::transport::{classify_failure, AuthMethod, SshError, SshErrorKind};
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

/// spawn 程序的两个分支（契约 §3.7 与多后端契约 §5.1）：本地 pi 直连，或经
/// 本地传输客户端（ssh / wsl.exe / docker）中继远端 `pi --mode rpc`
/// （stdout 同样是 JSONL，桥接层零改动）。
pub enum SpawnProgram {
    LocalPi(PiInfo),
    Remote(RemoteSpawnSpec),
}

/// 远程分支的 spawn 规格：endpoint 即连接配置展开后的权威来源，
/// `remote_path` 为项目 URI 解析出的远端绝对 POSIX 路径。
#[derive(Clone, Debug)]
pub struct RemoteSpawnSpec {
    pub endpoint: RemoteEndpoint,
    pub remote_path: String,
}

/// 一次远程会话的 kill 兜底信息：本地传输子进程被杀后，远端 pi 可能
/// 因 stdin EOF 语义未实测而残留，保存 endpoint 与远端 pid 以便补刀。
pub(super) struct RemoteSession {
    pub(super) endpoint: RemoteEndpoint,
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

/// 正式启动的 argv 前缀。`--no-session` **不**在这里加：aux 的
/// `--no-session` 由 `rpc::aux_launch::aux_extra_args()` 唯一产出，本地与远程
/// 两条路径都把它拼进 `extra_args`，避免两处各拼一遍（TZD-94 M0 修复）。
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
    {
        let mut activity = state.activity.lock().await;
        let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
        activity.reset(
            generation,
            &state.runtime_id,
            project,
            session_file.clone(),
            sink.clone(),
        );
        // 真 spawn 发生在这里：之后 `process_kill` 的 `inner == None` 早退分支才知道
        // "这个对象确实有一个可报告的终止"（从未启动的对象不发 exit）。
        activity.mark_spawned();
    }
    if let Some(mut old) = guard.take() {
        // respawn 是"旧句柄直接丢弃"，不做退出确认（避免重启路径多等最多 5s）。
        let _ = kill_inner(&state.runtime_id, &mut old, "respawn", None).await;
    }

    // 远程会话上下文：endpoint 供 kill 兜底，remote_pid 由 stderr reader 回填；
    // 本地分支用哑 Arc 占位以复用同一套 reader 装配代码。
    let remote = match program {
        SpawnProgram::Remote(spec) => Some(RemoteSession {
            endpoint: spec.endpoint.clone(),
            remote_pid: Arc::new(Mutex::new(None)),
        }),
        SpawnProgram::LocalPi(_) => None,
    };
    let is_remote = remote.is_some();
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
            let mut cmd = pi_locate::command_for(pi)?;
            cmd.args(&args);

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
            cmd.spawn()
                .map_err(|e| format!("failed to spawn pi: {e}"))?
        }
        SpawnProgram::Remote(spec) => {
            // 远程分支（契约 §3.1 与多后端契约 §5.1）：不设 current_dir；builtin
            // extensions 不注入（extra_args 为空），payload 经 base64 通道投递，
            // 本地不经任何 shell（argv 分流见 ssh::backend）。P1 远程 extra args
            // 恒为空，接口预留 Vec<String>。
            let payload = crate::ssh::build_spawn_payload(
                &spec.remote_path,
                session_file.as_deref(),
                &extra_args,
            );
            crate::ssh::remote_exec_stream(&spec.endpoint, &payload)
                .await
                .map_err(|e| crate::commands::ssh::remote_error_coded(&spec.endpoint, &e))?
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
        SpawnProgram::Remote(spec) => crate::logs::write(
            &state.runtime_id,
            &format!(
                "spawn (remote) pid={} endpoint={} path={} session={}",
                child
                    .id()
                    .map(|p| p.to_string())
                    .unwrap_or_else(|| "?".into()),
                spec.endpoint.describe(),
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
        let activity = state.activity.clone();
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
                            &format!(
                                "[perf] pi first output after {}ms",
                                spawned_at.elapsed().as_millis()
                            ),
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
                    dispatch(&pending, &activity, own_gen, &runtime_id, value).await;
                }
                drop_oversized_record(&mut buf, &runtime_id, "stdout");
            }
            // stdout closed => process exited (or is gone).
            // Only surface it if this reader still belongs to the current session.
            let mut activity = activity.lock().await;
            if activity.is_current(own_gen) && generation.load(Ordering::Relaxed) == own_gen {
                // 主动 kill 期间读到的 EOF 是**预期内**的退出（`idle`），不是崩溃（`error`）。
                // kill 的意图位在真正动手之前就置上了，因此这里不会把 kill 报成 error。
                let unexpected = !activity.expects_stop();
                crate::logs::write(
                    &runtime_id,
                    if unexpected {
                        "unexpected exit: stdout closed (pi process exited)"
                    } else {
                        "exit: stdout closed after an explicit kill"
                    },
                );
                pending.lock().await.clear();
                let next_gen = generation.fetch_add(1, Ordering::Relaxed) + 1;
                let exit = activity.stop(next_gen, unexpected);
                sink.emit(EXIT_EVENT, &runtime_id, exit);
            }
        });
    }

    // stderr reader: forward raw lines for logging
    {
        let sink = sink.clone();
        let activity = state.activity.clone();
        let own_gen = state.current_generation();
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
                    if is_remote && text.starts_with("PIX_PI_PID=") {
                        if let Ok(pid) = text["PIX_PI_PID=".len()..].trim().parse::<u32>() {
                            *remote_pid.lock().await = Some(pid);
                        }
                        crate::logs::write(&runtime_id, &format!("remote pi pid line: {text}"));
                        continue;
                    }
                    append_stderr_tail(&stderr_tail, &text).await;
                    crate::logs::write(&runtime_id, &format!("stderr: {text}"));
                    let current = activity.lock().await;
                    if current.is_current(own_gen) {
                        let mut payload = json!({ "line": text, "runtimeId": runtime_id });
                        current.stamp(&mut payload);
                        sink.emit(STDERR_EVENT, &runtime_id, payload);
                    }
                }
                drop_oversized_record(&mut buf, &runtime_id, "stderr");
            }
        });
    }

    // 远程分支就绪等待（契约 §3.9 与多后端契约 §1.4）：把连接失败、cd 失败(90)、
    // 远程缺 pi(92) 归一化为 coded error 经 rpc_spawn 的 Err 返回给前端 toast。
    if let SpawnProgram::Remote(_) = program {
        if let Err(message) = wait_ssh_ready(
            &state.runtime_id,
            &mut child,
            &remote_pid,
            &stderr_tail,
            remote.as_ref().map(|r| &r.endpoint),
        )
        .await
        {
            // spawn 失败：再 bump generation，让已装配的 reader 不发 pi://exit
            //（该 runtime 从未进入进程池）。
            let mut activity = state.activity.lock().await;
            let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
            activity.stop(generation, true);
            return Err(message);
        }
        // 路径别名回绑（契约 §3.8 / P2 §1.1 / 多后端契约 §5.1）：所有远程 spawn
        //（含新建）就绪后都执行回绑检查，一次 exec realpath 归一化远端路径，
        // 防 /home/dev 与 /dev 符号链接别名导致身份漂移；与 URI path 不同则发
        // pi://sshPathBound 供前端更新展示。失败不阻塞 spawn、不发事件。
        if let SpawnProgram::Remote(spec) = program {
            let rebind_sink = sink.clone();
            let rebind_runtime_id = state.runtime_id.clone();
            let rebind_state_project = state.project.clone();
            let rebind_activity = state.activity.clone();
            let rebind_endpoint = spec.endpoint.clone();
            let rebind_project = project.to_string();
            let rebind_path = spec.remote_path.clone();
            tokio::spawn(async move {
                rebind_remote_path(
                    &*rebind_sink,
                    &rebind_runtime_id,
                    &rebind_state_project,
                    &rebind_activity,
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

/// realpath 回绑解析结果（契约 §3.8 / P2 §1.1 / 多后端契约 §5.1）。独立于事件
/// 发射，供实机集成测试（S-R1）直接驱动。
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum PathRebind {
    /// realpath 与原路径一致，无需回绑。
    Unchanged,
    /// 路径有差异：`resolved` 为归一化后的远端物理路径，`rebound_project`
    /// 为用 `resolved` 回绑重建的远程展示 URI。
    Rebound {
        resolved: String,
        rebound_project: String,
    },
}

/// realpath 回绑解析（契约 §3.8，多后端统一）：一次 exec（10s 超时），解析
/// 失败或路径未变返回 `Unchanged`/`Err`（原因供日志），路径变化则重建展示 URI。
pub(crate) async fn resolve_path_rebind(
    endpoint: &RemoteEndpoint,
    project: &str,
    remote_path: &str,
) -> Result<PathRebind, String> {
    let output = crate::ssh::remote_exec(
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
    // 重建展示 URI：host/port/user（或 distro/container）沿用原 URI 解析结果，
    // 仅替换归一化后的 path。
    let rebound = crate::ssh::parse_remote_uri(project)
        .map(|target| target.with_path(resolved.clone()))
        .and_then(|target| crate::ssh::build_remote_uri(&target).ok());
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
    state_project: &Arc<Mutex<String>>,
    activity: &Arc<Mutex<RuntimeActivity>>,
    endpoint: &RemoteEndpoint,
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
    let mut activity = activity.lock().await;
    let Some(payload) = activity.rebind_project(&rebound_project, &resolved) else {
        return;
    };
    *state_project.lock().await = rebound_project;
    sink.emit(SSH_PATH_BOUND_EVENT, runtime_id, payload);
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
    endpoint: Option<&RemoteEndpoint>,
) -> Result<(), String> {
    const READY_TIMEOUT: Duration = Duration::from_secs(20);
    const PID_GRACE: Duration = Duration::from_secs(1);
    // 理论上 remote 分支恒有 endpoint；防御性缺省仅影响错误文案归类。
    let ssh_default = crate::ssh::SshEndpoint {
        host: String::new(),
        port: 0,
        user: None,
        key_path: None,
        auth_method: AuthMethod::Key,
        key_passphrase: None,
        password: None,
    };
    let endpoint = endpoint
        .cloned()
        .unwrap_or(RemoteEndpoint::Ssh(ssh_default));
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                // 让 stderr reader 把最后的错误行写进缓冲再归类。
                tokio::time::sleep(Duration::from_millis(100)).await;
                let tail = stderr_tail.lock().await.clone();
                crate::logs::write(
                    runtime_id,
                    &format!(
                        "ssh relay exited before ready: {status} stderr={}",
                        tail.trim()
                    ),
                );
                return Err(ssh_exit_error(&endpoint, status, &tail));
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
                    return Err(ssh_exit_error(&endpoint, status, &tail));
                }
                Ok(None) => return Ok(()),
                Err(e) => return Err(format!("failed to poll ssh relay: {e}")),
            }
        }
        if Instant::now() >= deadline {
            crate::logs::write(
                runtime_id,
                "ssh relay not confirmed ready within 20s; assuming slow start",
            );
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// 把远程中继子进程的退出码 + stderr 摘要归一化为 coded error，
/// 按端点 kind 分发归类（多后端契约 §4.4：wsl/docker 的混合编码 stderr
/// 在对应归类函数内先做 NUL 剥除再匹配 ASCII 关键词）。
fn ssh_exit_error(endpoint: &RemoteEndpoint, status: ExitStatus, stderr_tail: &str) -> String {
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
            let kind = classify_failure(code, stderr);
            // host key / auth / network 是 ssh 客户端专属场景，其余按端点 kind
            // 归类（多后端契约 §4.4 的 wsl/docker 错误族）。
            if matches!(endpoint, RemoteEndpoint::Ssh(_))
                && matches!(
                    kind,
                    SshErrorKind::HostKey | SshErrorKind::Auth | SshErrorKind::Network
                )
            {
                let e = SshError {
                    kind,
                    exit_code: Some(code),
                    detail: stderr.to_string(),
                };
                return crate::commands::ssh::ssh_error_coded(&e);
            }
            let e = SshError {
                kind: if matches!(
                    kind,
                    SshErrorKind::HostKey | SshErrorKind::Auth | SshErrorKind::Network
                ) {
                    SshErrorKind::Remote
                } else {
                    kind
                },
                exit_code: Some(code),
                detail: match stderr.is_empty() {
                    true => format!("远程 pi 进程退出码 {code}"),
                    false => stderr.to_string(),
                },
            };
            crate::commands::ssh::remote_error_coded(endpoint, &e)
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

async fn dispatch(
    pending: &PendingMap,
    activity: &Arc<Mutex<RuntimeActivity>>,
    generation: u64,
    runtime_id: &str,
    value: Value,
) {
    let mut current = activity.lock().await;
    if !current.is_current(generation) {
        return;
    }
    if value.get("type").and_then(|t| t.as_str()) == Some("response") {
        current.response(&value);
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
    if let Some((token, deadline)) = current.event(value) {
        schedule_timeout(Arc::downgrade(activity), generation, token, deadline);
    }
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

/// 一次 kill 的**总 deadline**（不是分段超时）——默认路径 5s、退出路径 500ms。
///
/// 为什么必须是总 deadline：分段超时（远程 5s + taskkill 无超时 + wait 500ms）会让
/// "命令不返回"时最后那段 500ms 根本不会开始 —— 复审第五轮实测 N=2 的退出耗时
/// 3644ms，远大于 N×500ms。现在**所有阶段**（远程 `kill -TERM`、OS 终止命令、
/// `child.wait()` 确认退出）都从同一个 budget 里扣，耗尽即判失败。
const KILL_BUDGET_DEFAULT: Duration = Duration::from_secs(5);

/// 应用退出路径（`kill_all` 在 `RunEvent::Exit` 里 `block_on`）的总 budget：500ms/实例。
const KILL_BUDGET_EXIT: Duration = Duration::from_millis(500);

/// 测试用：覆盖总 budget（0 = 用路径默认值）。
#[cfg(test)]
pub(super) static KILL_BUDGET_MS: AtomicU64 = AtomicU64::new(0);

/// 测试用：跳过真正的 OS 终止调用（模拟"kill 没把进程杀掉"）。
#[cfg(test)]
pub(super) static SKIP_OS_KILL: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

/// 测试用：把 OS 终止命令换成"先睡 D 毫秒、再返回非零"的等价物。
///
/// 这是复审第五轮要求的可重跑注入：不需要造真实 OS 权限拒绝，就能证明总 deadline
/// 覆盖到 OS 命令那一段（旧实现里这一段完全没有超时）。
#[cfg(test)]
pub(super) static OS_KILL_DELAY_MS: AtomicU64 = AtomicU64::new(0);

fn kill_budget(fallback: Duration) -> Duration {
    #[cfg(test)]
    {
        let ms = KILL_BUDGET_MS.load(Ordering::Relaxed);
        if ms > 0 {
            return Duration::from_millis(ms);
        }
    }
    fallback
}

/// 从总 budget 里"借"一段时间给某个阶段：返回剩余时长，或 `None`（不做确认的路径）。
fn remaining(deadline: Option<Instant>) -> Option<Duration> {
    deadline.map(|d| d.saturating_duration_since(Instant::now()))
}

/// 在总 budget 内跑一个阶段：超时即返回 `Err(说明)`（不让任一阶段单独卡住整次 kill）。
async fn within_budget<F: std::future::Future>(
    deadline: Option<Instant>,
    stage: &str,
    future: F,
) -> Result<F::Output, String> {
    match remaining(deadline) {
        Some(left) => tokio::time::timeout(left, future)
            .await
            .map_err(|_| format!("kill budget exhausted during {stage}")),
        None => Ok(future.await),
    }
}

/// 杀进程树并**确认退出**。
///
/// `confirm`: `Some(timeout)` 表示必须等 `child.wait()` 在超时内返回才成功；
/// `None` 保留旧语义（不发 OS 请求之外的确认，供 respawn 这类"旧句柄直接丢弃"的
/// 路径使用，不引入额外延迟）。
///
/// 失败语义（复审第四轮 P1-2）：**taskkill 非零退出、taskkill 启动失败、
/// 非 Windows 的 `start_kill` 失败、确认超时** 全部返回 `Err`，不再吞掉。
/// 调用方（`process_kill`）负责把失败时的 `SessionInner` 放回状态。
async fn kill_inner(
    runtime_id: &str,
    inner: &mut SessionInner,
    reason: &str,
    deadline: Option<Instant>,
) -> Result<(), String> {
    crate::logs::write(
        runtime_id,
        &format!("kill pid={:?} reason={reason}", inner.child.id()),
    );
    // 远端 pid 兜底（契约 §3.9 与多后端契约 §1.4）：本地通道断开后远端 pi 可能
    // 残留，经一次独立 exec 发 kill -TERM（wsl 在发行版内、docker 在容器 PID 命名
    // 空间内执行，语义相同）；失败降级为日志，不阻塞本地 kill。绝不调用
    // wsl --terminate / docker stop：后端只杀自己 spawn 的本地子进程与远端 pid。
    //
    // **这一段也吃同一个 budget**：旧实现固定 5s，退出路径的 500ms 根本管不到它。
    if let Some(remote) = &inner.remote {
        let pid = remote.remote_pid.lock().await.take();
        if let Some(pid) = pid {
            let script = format!("kill -TERM {pid} 2>/dev/null\n");
            let exec = crate::ssh::remote_exec(&remote.endpoint, &script, Duration::from_secs(5));
            match within_budget(deadline, "remote kill -TERM", exec).await {
                Ok(Ok(_)) => {
                    crate::logs::write(runtime_id, &format!("remote kill -TERM {pid} sent"));
                }
                Ok(Err(e)) => {
                    crate::logs::write(
                        runtime_id,
                        &format!("remote kill -TERM {pid} failed (ignored): {}", e.detail),
                    );
                }
                Err(message) => {
                    // 预算耗尽：这一段不值得再等，直接按"终止未确认"失败。
                    crate::logs::write(runtime_id, &message);
                    return Err(format!("{message} (remote kill -TERM {pid})"));
                }
            }
        }
    }
    // OS 终止阶段。失败原因（含 taskkill 的非零退出）**不立刻**判失败：`taskkill`
    // 对"已经自己退出的进程"本来就会报非零（找不到进程），那不是错误。最终成败由
    // 后面的"确认退出"决定 —— `inner == None` 或 `Ok(())` 都不算数，**看到子进程真的
    // 退出**才算数（复审第四轮 P1-2）。
    let mut os_error: Option<String> = None;
    #[cfg(test)]
    let skip_os_kill = SKIP_OS_KILL.load(Ordering::Relaxed);
    #[cfg(not(test))]
    let skip_os_kill = false;
    #[cfg(test)]
    let injected_delay = OS_KILL_DELAY_MS.load(Ordering::Relaxed);
    #[cfg(not(test))]
    let injected_delay = 0u64;
    if !skip_os_kill {
        #[cfg(windows)]
        {
            if let Some(pid) = inner.child.id() {
                // 注入优先：模拟"OS 命令延迟 D 后返回非零"，它同样受总 budget 约束。
                let attempt = async {
                    if injected_delay > 0 {
                        tokio::time::sleep(Duration::from_millis(injected_delay)).await;
                        return Err(format!("injected os kill delay {injected_delay}ms"));
                    }
                    // pi.cmd runs under cmd.exe: kill the whole tree.
                    let mut tk = Command::new("taskkill");
                    tk.args(["/PID", &pid.to_string(), "/T", "/F"]);
                    tk.creation_flags(CREATE_NO_WINDOW);
                    tk.stdin(Stdio::null())
                        .stdout(Stdio::piped())
                        .stderr(Stdio::piped());
                    // helper 自己也可能卡住：超时后由 kill_on_drop 终止它，不让它变成
                    // 新的孤儿（这正是"清理本次起的 helper"的落点）。
                    tk.kill_on_drop(true);
                    match tk.output().await {
                        Ok(output) if !output.status.success() => Err(format!(
                            "taskkill /PID {pid} failed: {} stdout={} stderr={}",
                            output.status,
                            String::from_utf8_lossy(&output.stdout).trim_end(),
                            String::from_utf8_lossy(&output.stderr).trim_end(),
                        )),
                        Ok(_) => Ok(()),
                        Err(e) => Err(format!("taskkill /PID {pid} failed to run: {e}")),
                    }
                };
                match within_budget(deadline, "taskkill", attempt).await {
                    Ok(Ok(())) => {}
                    Ok(Err(message)) => {
                        crate::logs::write(runtime_id, &message);
                        os_error = Some(message);
                    }
                    Err(message) => {
                        // 超时：helper 已被 kill_on_drop 收掉，记为失败继续走确认。
                        crate::logs::write(runtime_id, &message);
                        os_error = Some(message);
                    }
                }
            }
        }
        #[cfg(not(windows))]
        {
            if inner.child.id().is_some() {
                // `start_kill` 不阻塞；注入延迟在别的平台上也用 sleep 表达。
                let attempt = async {
                    if injected_delay > 0 {
                        tokio::time::sleep(Duration::from_millis(injected_delay)).await;
                        return Err(format!("injected os kill delay {injected_delay}ms"));
                    }
                    inner
                        .child
                        .start_kill()
                        .map_err(|e| format!("start_kill failed: {e}"))
                };
                match within_budget(deadline, "start_kill", attempt).await {
                    Ok(Ok(())) => {}
                    Ok(Err(message)) => {
                        crate::logs::write(runtime_id, &message);
                        os_error = Some(message);
                    }
                    Err(message) => {
                        crate::logs::write(runtime_id, &message);
                        os_error = Some(message);
                    }
                }
            }
        }
    }
    match deadline {
        Some(_) => match remaining(deadline) {
            Some(left) if !left.is_zero() => {
                match tokio::time::timeout(left, inner.child.wait()).await {
                    // 确认退出：即使 OS 命令报了非零（例如进程已自行退出），也算成功。
                    Ok(Ok(_status)) => {}
                    Ok(Err(e)) => {
                        let message = match os_error {
                            Some(os) => {
                                format!("kill could not be confirmed: {os}; wait failed: {e}")
                            }
                            None => format!("kill could not be confirmed (wait failed): {e}"),
                        };
                        crate::logs::write(runtime_id, &message);
                        return Err(message);
                    }
                    Err(_) => {
                        let message = match os_error {
                            Some(os) => format!(
                                "kill budget exhausted before exit was confirmed: {os}"
                            ),
                            None => "kill budget exhausted before exit was confirmed".to_string(),
                        };
                        crate::logs::write(runtime_id, &message);
                        return Err(message);
                    }
                }
            }
            // 预算已在前面几段用光：不再等 wait，直接判失败。
            _ => {
                let message = match os_error {
                    Some(os) => format!("kill budget exhausted (process may still run): {os}"),
                    None => "kill budget exhausted (process may still run)".to_string(),
                };
                crate::logs::write(runtime_id, &message);
                return Err(message);
            }
        },
        None => {
            // 不做确认的路径（respawn 丢弃旧句柄）：仍要把 OS 失败如实告诉调用方。
            if let Some(message) = os_error {
                return Err(message);
            }
        }
    }
    // 确认退出后才清空 pending：失败的 kill 必须让在途请求继续可用（否则旧 reader
    // 的 response 回来时已经没有接收端，等于把活进程的 pending 孤立掉）。
    inner.pending.lock().await.clear();
    Ok(())
}

/// 测试用故障注入：接下来的 `count` 次 `process_kill` 直接返回错误。
///
/// 为什么需要它：`kill_inner` 的失败分支在本地生产路径上很难自然触发（Windows
/// taskkill 的非零退出只记日志、`kill_on_drop` 尽力兜底），而"kill 失败必须可重试"
/// 是回收器的硬要求（复审第二轮 P1-1）。没有注入就只能靠打磨真实 OS 权限错误。
#[cfg(test)]
pub(super) static FAIL_NEXT_KILLS: AtomicU64 = AtomicU64::new(0);

pub(super) async fn process_kill(state: &ProcessState, reason: &str) -> Result<(), String> {
    let budget = kill_budget(KILL_BUDGET_DEFAULT);
    process_kill_confirming(state, reason, Instant::now() + budget).await
}

/// 应用退出路径专用：总 budget 压到 500ms/实例，N 个进程最坏约 N×500ms（**所有阶段**
/// 共享这一份预算），不会像旧实现那样"远程 5s + taskkill 无超时"把退出拖住。
/// `kill_all` 在 `RunEvent::Exit` 里 `block_on`，宁可放弃确认也不能让退出挂起。
pub(super) async fn process_kill_fast(state: &ProcessState, reason: &str) -> Result<(), String> {
    let budget = kill_budget(KILL_BUDGET_EXIT);
    process_kill_confirming(state, reason, Instant::now() + budget).await
}

/// 终止状态（`pi://exit` + 代际递增）**只在确认退出后提交**，且只提交一次。
///
/// 上一版在 `kill_inner` 之前就 `stop_and_emit` 并递增代际：kill 失败时前端已经
/// 收到一次假 exit、旧 reader 的代际被作废、pending 被孤立，重试还会再发一次
/// （复审第四轮 P1-1）。
async fn commit_exit(state: &ProcessState, unexpected: bool) {
    let mut activity = state.activity.lock().await;
    if activity.has_exited() {
        // 已由 stdout reader（EOF）或更早的一次成功 kill 提交过：不重复发。
        return;
    }
    let generation = state.generation.fetch_add(1, Ordering::Relaxed) + 1;
    activity.stop_and_emit(generation, unexpected);
}

async fn process_kill_confirming(
    state: &ProcessState,
    reason: &str,
    deadline: Instant,
) -> Result<(), String> {
    #[cfg(test)]
    if FAIL_NEXT_KILLS.load(Ordering::Relaxed) > 0 {
        FAIL_NEXT_KILLS.fetch_sub(1, Ordering::Relaxed);
        // 与真实失败一致：**不**动 inner、**不**动活动表/代际 —— 进程仍被追踪，
        // 前端也不该收到 exit（这正是本轮的回归判据）。
        crate::logs::write(&state.runtime_id, "kill injected failure (test seam)");
        return Err(format!("injected kill failure: {reason}"));
    }

    // 先置"这是主动 kill"的意图位（不发事件、不动代际）：stdout reader 若在这次 kill
    // 期间读到 EOF，会把退出记成 `idle` 而不是 `error`。
    state.activity.lock().await.mark_expected_stop();

    let mut guard = state.inner.lock().await;
    let Some(mut inner) = guard.take() else {
        // 没有内层会话：要么已确认退出过（reader 收了尾 / 更早的一次成功 kill），要么
        // **从未 spawn**。两者都不该在这里凭空发一条 `pi://exit`：
        // - 已退出：`commit_exit` 按 `has_exited` 幂等跳过；
        // - 从未启动：没有可报告的终止，且必须撤掉刚置上的意图位（否则那个
        //   `expected_stop = true` 会留在一个从未 spawn 的对象上）。
        drop(guard);
        state.activity.lock().await.clear_expected_stop();
        if state.has_spawned_once().await {
            commit_exit(state, false).await;
        }
        return Ok(());
    };
    match kill_inner(&state.runtime_id, &mut inner, reason, Some(deadline)).await {
        Ok(()) => {
            drop(inner);
            // **确认退出之后**才提交终止状态（递增代际 + 发 exit，且只发一次）。
            commit_exit(state, false).await;
            drop(guard);
            Ok(())
        }
        Err(error) => {
            // 失败：把会话放回，代际不变、pending 与旧 reader 仍然可用，也不发 exit；
            // 同时撤销意图位，让后续真正的崩溃仍能报成 `error`。
            state.activity.lock().await.clear_expected_stop();
            if guard.is_none() {
                *guard = Some(inner);
            }
            Err(error)
        }
    }
}

#[cfg(test)]
mod kill_confirmation_tests {
    use super::*;
    use crate::rpc::{test_harness, RpcState, RuntimePolicy};

    /// 故障注入与确认超时都是**进程级静态**，`cargo test` 默认并行：动它们的用例
    /// 必须串行（与 `aux_reap` 的回收用例共用同一把锁，避免交叉污染）。
    fn lock() -> std::sync::MutexGuard<'static, ()> {
        crate::aux_leases::test_lock()
    }

    /// **复审第五轮 P1 的回归（默认路径）**：非退出路径（5s 总 budget）也必须覆盖
    /// **OS 终止阶段**。注入"OS 命令延迟 3s"，budget 压到 1.2s：必须在 budget 内失败，
    /// 而不是先等 3s（旧实现这一段完全没有超时）。
    #[tokio::test]
    async fn the_default_kill_budget_covers_the_os_stage_not_just_the_wait() {
        let _guard = lock();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = RpcState::default();
        let (process, sink) =
            test_harness::install_recording(&state, "aux:osbudget", RuntimePolicy::Aux).await;
        crate::rpc::aux_probe::set_kill_budget_ms(1200);
        crate::rpc::aux_probe::set_os_kill_delay_ms(3000);
        let started = std::time::Instant::now();
        let err = process_kill(&process, "reap").await.expect_err("超预算必失败");
        let elapsed = started.elapsed();
        assert!(
            err.contains("budget") || err.contains("not confirmed"),
            "错误必须指向 budget/未确认：{err}"
        );
        assert!(
            elapsed < std::time::Duration::from_millis(1800),
            "总 budget 必须切断 OS 阶段（旧实现会等满 3000ms），实测 {elapsed:?}"
        );
        // 失败：不发 exit、进程仍被追踪。
        assert_eq!(sink.exits().len(), 0);
        assert!(process_running(&process).await);
        crate::rpc::aux_probe::clear_kill_failures();
    }

    /// **复审第五轮 P1 的回归（退出路径，N=2）**：`kill_all` 用 500ms/实例的总 budget，
    /// OS 阶段延迟 1200ms 时两个实例都失败，且**总耗时 < 1500ms**（不是质量实测的
    /// 3644ms）。
    #[tokio::test]
    async fn the_exit_path_total_budget_bounds_n_instances() {
        let _guard = lock();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = RpcState::default();
        let (_a, sink_a) =
            test_harness::install_recording(&state, "aux:e1", RuntimePolicy::Aux).await;
        let (_b, sink_b) =
            test_harness::install_recording(&state, "aux:e2", RuntimePolicy::Aux).await;
        crate::rpc::aux_probe::set_os_kill_delay_ms(1200);
        let started = std::time::Instant::now();
        crate::rpc::kill_all(&state).await.expect("kill_all 返回 Ok");
        let elapsed = started.elapsed();
        assert!(
            elapsed < std::time::Duration::from_millis(1500),
            "N=2 的总耗时必须 < 1500ms（N×500ms + 上界），实测 {elapsed:?}"
        );
        assert_eq!(sink_a.exits().len(), 0, "未确认退出不得发 exit");
        assert_eq!(sink_b.exits().len(), 0, "未确认退出不得发 exit");
        assert_eq!(test_harness::process_count(&state).await, 0, "退出路径 take 整个池");
        crate::rpc::aux_probe::clear_kill_failures();
    }

    /// **复审第四轮 P1-1 的回归**：一次注入失败 → 不发 exit、不递增代际、pending 保留；
    /// 重试成功后 `pi://exit` **恰好发 1 次**。
    ///
    /// 质量实测的 `generation=0→1, exits_before_confirm=1, pending=1, 累计 2 次` 必须翻成
    /// 这里这条。
    #[tokio::test]
    async fn a_failed_kill_emits_no_exit_and_keeps_the_generation_usable() {
        let _guard = lock();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = RpcState::default();
        let (_process, sink) =
            test_harness::install_recording(&state, "aux:exit", RuntimePolicy::Aux).await;
        let generation_before = test_harness::generation_of(&state, "aux:exit").await;
        test_harness::add_in_flight_request(&state, "aux:exit").await;
        test_harness::start_agent_run(&state, "aux:exit").await;
        assert_eq!(test_harness::pending_count(&state, "aux:exit").await, 1);

        // 注入 1 次 kill 失败。
        crate::rpc::aux_probe::fail_next_kills(1);
        let err = process_kill(&_process, "reap").await.expect_err("注入失败");
        // ① 不发 exit（假退出正是本轮缺陷）。
        assert_eq!(sink.exits().len(), 0, "kill 未确认时不得发 pi://exit");
        // ② 代际不变：旧 reader 的 response 仍能进 dispatch。
        assert_eq!(
            test_harness::generation_of(&state, "aux:exit").await,
            generation_before,
            "失败的 kill 不得作废代际"
        );
        // ③ pending 未被孤立（还在表里，response 回来时有接收端）。
        assert_eq!(
            test_harness::pending_count(&state, "aux:exit").await,
            1,
            "失败的 kill 不得清掉 pending"
        );
        assert!(process_running(&_process).await, "进程仍在跑");
        assert!(err.contains("injected kill failure"), "{err}");

        // 重试（注入已耗尽）：确认退出后才提交终止状态，且只发一次 exit。
        crate::rpc::aux_probe::clear_kill_failures();
        process_kill(&_process, "reap").await.expect("重试成功");
        crate::rpc::aux_probe::clear_kill_failures();
        let exits = sink.exits();
        assert_eq!(exits.len(), 1, "重试成功后 pi://exit 必须恰好 1 次：{exits:?}");
        assert_eq!(exits[0]["pixRunStatus"], "idle", "主动 kill 的退出记 idle");
        assert!(
            test_harness::generation_of(&state, "aux:exit").await > generation_before,
            "确认退出后才递增代际"
        );
        assert_eq!(test_harness::pending_count(&state, "aux:exit").await, 0);
        assert!(!process_running(&_process).await);
    }

    /// 连续两次成功 kill（第二层防御）：`pi://exit` 仍只发一次（幂等）。
    #[tokio::test]
    async fn a_repeated_kill_never_emits_a_second_exit() {
        let _guard = lock();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = RpcState::default();
        let (process, sink) =
            test_harness::install_recording(&state, "aux:twice", RuntimePolicy::Aux).await;
        process_kill(&process, "reap").await.expect("第一次");
        assert_eq!(sink.exits().len(), 1);
        // 内层会话已被摘掉；再杀一次只会幂等提交（`has_exited` 去重）。
        process_kill(&process, "reap").await.expect("第二次");
        assert_eq!(sink.exits().len(), 1, "不得重复发 exit");
    }

    /// **复审第四轮 P1-2 的回归**：OS 终止调用"返回成功但进程没死"时必须报失败
    /// （不能像上一版那样因为 `inner == None` 就"确认退出"）。
    #[tokio::test]
    async fn an_unconfirmed_os_kill_is_reported_as_failure_and_keeps_the_session() {
        let _guard = lock();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = RpcState::default();
        let (process, _sink) =
            test_harness::install_recording(&state, "aux:os", RuntimePolicy::Aux).await;
        // seam：跳过真实 taskkill + 极短确认超时 → 走"确认超时"分支。
        crate::rpc::aux_probe::simulate_unconfirmed_kill(50);
        let err = process_kill(&process, "reap").await.expect_err("未确认退出必须失败");
        assert!(
            err.contains("not confirmed") || err.contains("budget exhausted"),
            "{err}"
        );
        assert!(process_running(&process).await, "会话必须被放回（进程仍被追踪）");
        assert_eq!(
            test_harness::pending_count(&state, "aux:os").await,
            0,
            "本用例没有在途请求"
        );
        // 恢复真实终止路径后，下一次 kill 才能"确认退出"。
        crate::rpc::aux_probe::clear_kill_failures();
        process_kill(&process, "reap").await.expect("恢复后应成功");
        crate::rpc::aux_probe::clear_kill_failures();
        assert!(!process_running(&process).await);
    }

    /// **复审第五轮（非阻塞项 1）**：`inner == None` 的早退分支**不得**给"从未 spawn"
    /// 的对象发 exit，也不得留下 `expected_stop = true`。
    #[tokio::test]
    async fn a_never_spawned_state_emits_no_exit_and_leaves_no_stop_intent() {
        let _guard = lock();
        crate::rpc::aux_probe::clear_kill_failures();
        let (_process, sink) =
            test_harness::install_recording(&RpcState::default(), "aux:never", RuntimePolicy::Aux)
                .await;
        // 造一个"从未 spawn"的对象：没有 inner，活动表也没 mark_spawned。
        let fresh = std::sync::Arc::new(ProcessState {
            runtime_id: "aux:never".into(),
            ..Default::default()
        });
        fresh
            .activity
            .lock()
            .await
            .reset(0, "aux:never", "project", None, std::sync::Arc::new(sink.clone()));
        assert!(!fresh.has_spawned_once().await);
        process_kill(&fresh, "reap").await.expect("从未启动的终止是 no-op");
        assert_eq!(sink.exits().len(), 0, "从未 spawn 的对象不得发 exit");
        assert!(
            !fresh.activity.lock().await.expects_stop(),
            "早退分支必须撤掉刚置上的意图位"
        );
    }

    /// 终止意图位：主动 kill 期间的 EOF 记 `idle`，撤销意图后崩溃仍记 `error`。
    #[tokio::test]
    async fn the_stop_intent_decides_idle_versus_error() {
        let _guard = lock();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = RpcState::default();
        let (process, sink) =
            test_harness::install_recording(&state, "aux:intent", RuntimePolicy::Aux).await;
        // 有一轮进行中的 agent 运行，exit 的 payload 才会带 `pixRunStatus`。
        test_harness::start_agent_run(&state, "aux:intent").await;
        {
            let mut activity = process.activity.lock().await;
            activity.mark_expected_stop();
            assert!(activity.expects_stop());
            activity.clear_expected_stop();
            assert!(!activity.expects_stop());
        }
        // 正常（非 kill）路径的 exit 是 error。
        process_kill(&process, "reap").await.expect("kill");
        crate::rpc::aux_probe::clear_kill_failures();
        let exits = sink.exits();
        assert_eq!(exits.len(), 1);
        assert_eq!(
            exits[0]["pixRunStatus"], "idle",
            "主动 kill 的结果必须是 idle（意图位在 kill 前置上）: {exits:?}"
        );
    }
}

#[cfg(test)]
mod activity_dispatch_tests {
    use super::*;
    use std::future::Future;
    use std::sync::Mutex as StdMutex;

    #[derive(Default)]
    struct Sink(StdMutex<Vec<Value>>);

    impl EventSink for Sink {
        fn emit(&self, _: &'static str, _: &str, payload: Value) {
            self.0.lock().unwrap().push(payload);
        }
    }

    struct ChannelSink(mpsc::UnboundedSender<(&'static str, Value)>);

    impl EventSink for ChannelSink {
        fn emit(&self, event: &'static str, _: &str, payload: Value) {
            let _ = self.0.send((event, payload));
        }
    }

    #[tokio::test]
    async fn real_stdio_backpressure_keeps_stdout_draining_and_explicit_exit_stamped() {
        // kill 的注入（budget / OS 延迟）是**进程级静态**：与它并行跑的用例会互相污染
        // （表现为随机超时）。所有会走到 `process_kill` 的用例都取同一把锁。
        crate::rpc::aux_probe::clear_kill_failures();
        let _guard = crate::aux_leases::test_lock();
        let node = crate::ssh::transport::find_test_program("node")
            .expect("Node.js is required for the local RPC mock");
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("backpressure.cjs");
        // Do not read stdin until two stdout records have flushed. Dispatch of
        // the first record must not stop the reader from draining the second.
        std::fs::write(&script, r#"
    const fs = require('fs');
    const path = require('path');
    process.stdout.write(JSON.stringify({type:'agent_start'}) + '\n');
    const timer = setInterval(() => {
      if (!fs.existsSync(path.join(__dirname, 'release'))) return;
      clearInterval(timer);
      process.stdout.write(JSON.stringify({type:'backpressure_probe'}) + '\n');
      process.stdout.write(JSON.stringify({type:'backpressure_payload', text:'x'.repeat(4*1024*1024)}) + '\n', () => {
        process.stdin.resume();
      });
    }, 5);
    process.stdin.on('end', () => process.exit(0));
    "#).unwrap();
        let state = ProcessState {
            runtime_id: "backpressure-test".into(),
            ..Default::default()
        };
        let (tx, mut events) = mpsc::unbounded_channel();
        let program = SpawnProgram::LocalPi(PiInfo {
            launcher: Some(pi_locate::Launcher::Node {
                node: node.to_string_lossy().into_owned(),
                script: script.to_string_lossy().into_owned(),
            }),
            ..Default::default()
        });
        process_spawn_impl(
            Arc::new(ChannelSink(tx)),
            &state,
            &program,
            dir.path().to_str().unwrap(),
            Some("session.jsonl".into()),
            vec![],
            None,
        )
        .await
        .unwrap();
        let (_, started) = tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(started["type"], "agent_start");
        let stdin_tx = state.inner.lock().await.as_ref().unwrap().stdin_tx.clone();
        // A real OS pipe write stalls because the child has not started reading.
        stdin_tx
            .send(json!({"type":"test", "data":"x".repeat(8*1024*1024)}).to_string())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(5), async {
            while stdin_tx.capacity() != 256 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("stdin writer must dequeue the oversized record");
        for _ in 0..256 {
            stdin_tx.try_send("{}".into()).unwrap();
        }
        let notify = super::super::process_notify(&state, json!({"type":"abort"}));
        tokio::pin!(notify);
        std::future::poll_fn(|cx| {
            assert!(
                notify.as_mut().poll(cx).is_pending(),
                "full queue must block acceptance"
            );
            std::task::Poll::Ready(())
        })
        .await;
        assert!(state.inner.try_lock().is_ok());
        assert!(state.activity.try_lock().is_ok());
        std::fs::write(dir.path().join("release"), b"").unwrap();
        tokio::time::timeout(Duration::from_secs(10), async {
            let drain_stdout = async {
                loop {
                    let (event, value) = events.recv().await.unwrap();
                    assert_eq!(event, EVENT);
                    if value["type"] == "backpressure_payload" {
                        break;
                    }
                }
            };
            let (accepted, ()) = tokio::join!(notify.as_mut(), drain_stdout);
            accepted.unwrap();
        })
        .await
        .expect("stdout must drain so the child can resume reading stdin");
        process_kill(&state, "backpressure test complete")
            .await
            .unwrap();
        let (event, exit) = tokio::time::timeout(Duration::from_secs(5), events.recv())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(event, EXIT_EVENT);
        assert_eq!(exit["runtimeId"], "backpressure-test");
        assert_eq!(exit["pixProject"], dir.path().to_str().unwrap());
        assert_eq!(exit["pixSessionFile"], "session.jsonl");
        assert_eq!(exit["pixRunId"], started["pixRunId"]);
        assert_eq!(exit["pixRunStatus"], "idle");
        assert!(exit["pixRunUpdatedAt"].as_u64() > started["pixRunUpdatedAt"].as_u64());
    }
    #[tokio::test]
    async fn stale_stdout_cannot_update_activity_emit_or_consume_new_response() {
        let sink = Arc::new(Sink::default());
        let activity = Arc::new(Mutex::new(RuntimeActivity::default()));
        activity
            .lock()
            .await
            .reset(2, "test", "project", None, sink.clone());
        let pending: PendingMap = Default::default();
        let (tx, mut rx) = oneshot::channel();
        pending.lock().await.insert(1, tx);
        for value in [
            json!({"type":"agent_start"}),
            json!({"type":"extension_ui_request", "id":"stale", "method":"input"}),
            json!({"type":"response", "id":1, "success":true, "data":{"sessionFile":"stale.jsonl"}}),
        ] {
            dispatch(&pending, &activity, 1, "test", value).await;
        }
        assert!(sink.0.lock().unwrap().is_empty());
        assert!(rx.try_recv().is_err());
        assert!(pending.lock().await.contains_key(&1));
        let mut snapshot = json!({"state":{}});
        activity.lock().await.snapshot(&mut snapshot);
        assert!(snapshot.get("activity").is_none());
        assert!(snapshot["pendingUiRequests"].as_array().unwrap().is_empty());
        assert!(snapshot["state"].get("sessionFile").is_none());

        dispatch(&pending, &activity, 2, "test", json!({"type":"agent_start", "pixRunId":"untrusted", "pixRunUpdatedAt":0, "pixProject":"untrusted"})).await;
        dispatch(&pending, &activity, 2, "test", json!({"type":"response", "id":1, "success":true, "data":{"sessionFile":"current.jsonl"}})).await;
        assert_eq!(rx.await.unwrap()["success"], true);
        activity.lock().await.snapshot(&mut snapshot);
        assert_eq!(snapshot["state"]["sessionFile"], "current.jsonl");
        assert_ne!(snapshot["activity"]["runId"], "untrusted");
        assert_eq!(
            sink.0.lock().unwrap()[0]["pixRunId"],
            snapshot["activity"]["runId"]
        );
        assert_eq!(sink.0.lock().unwrap()[0]["pixProject"], "project");
    }
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
        assert!(
            ssh_exit_error(&ssh_endpoint(), status_with_code(90), "").contains("projectDirMissing")
        );
        assert!(ssh_exit_error(&ssh_endpoint(), status_with_code(92), "")
            .contains("sshRemotePiMissing"));
    }

    #[test]
    fn ssh_client_failures_classify_by_stderr() {
        assert!(ssh_exit_error(
            &ssh_endpoint(),
            status_with_code(255),
            "dev@host: Permission denied (publickey)."
        )
        .contains("sshAuthFailed"));
        assert!(ssh_exit_error(
            &ssh_endpoint(),
            status_with_code(255),
            "ssh: Could not resolve hostname host"
        )
        .contains("sshConnectFailed"));
        // 其余退出码携带 stderr 摘要（含退出码语境）。
        let coded = ssh_exit_error(
            &ssh_endpoint(),
            status_with_code(1),
            "sh: cd: no such directory",
        );
        assert!(coded.contains("sshProbeFailed"), "{coded}");
        assert!(coded.contains("no such directory"));
        let coded = ssh_exit_error(&ssh_endpoint(), status_with_code(1), "");
        assert!(coded.contains("sshProbeFailed"), "{coded}");
        assert!(coded.contains("1"));
    }

    #[test]
    fn host_key_failures_map_to_operable_coded_errors() {
        // 契约 P2 §5.1/§5.2：两段真实 stderr 文本（wsl-test-env.md 实机发现）。
        let coded = ssh_exit_error(
            &ssh_endpoint(),
            status_with_code(255),
            "Host key verification failed.",
        );
        assert!(coded.contains("sshHostKeyUnverified"), "{coded}");
        let changed = concat!(
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n",
            "@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n",
            "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\r\n",
        );
        let coded = ssh_exit_error(&ssh_endpoint(), status_with_code(255), changed);
        assert!(coded.contains("sshHostKeyChanged"), "{coded}");
    }

    /// 多后端契约 §4.4：wsl/docker 中继子进程的非零退出按端点 kind 归类
    ///（exit 127 → wslDistroNotFound；stderr 含 is not running →
    /// dockerContainerNotRunning），ssh 专属关键词不再吞掉 wsl/docker 场景。
    #[test]
    fn wsl_docker_relay_exits_classify_per_backend() {
        let wsl = crate::ssh::backend::RemoteEndpoint::Wsl(crate::ssh::WslEndpoint {
            distro: "NoSuchDistro".into(),
            user: None,
        });
        // V8：wsl.exe 对不存在发行版报 exit 127，stderr 混合编码。
        let mixed = "找不到 wsl\r\0W\0s\0l\0/\0S\0e\0r\0v\0i\0c\0e\0/\0W\0S\0L\0_\0E\0_\0D\0I\0S\0T\0R\0O\0_\0N\0O\0T\0_\0F\0O\0U\0N\0D\0";
        let coded = ssh_exit_error(&wsl, status_with_code(127), mixed);
        assert!(coded.contains("wslDistroNotFound"), "{coded}");

        let docker = crate::ssh::backend::RemoteEndpoint::Docker(crate::ssh::DockerEndpoint {
            container: "stopped".into(),
        });
        let coded = ssh_exit_error(
            &docker,
            status_with_code(1),
            "Error response from daemon: Container stopped is not running",
        );
        assert!(coded.contains("dockerContainerNotRunning"), "{coded}");
        // ssh 专属归类（auth/network/hostkey）不适用于 wsl/docker。
        let coded = ssh_exit_error(
            &docker,
            status_with_code(255),
            "Permission denied (publickey).",
        );
        assert!(coded.contains("dockerExecFailed"), "{coded}");
    }

    fn ssh_endpoint() -> crate::ssh::backend::RemoteEndpoint {
        crate::ssh::backend::RemoteEndpoint::Ssh(crate::ssh::SshEndpoint {
            host: "host".to_string(),
            port: 22,
            user: None,
            key_path: None,
            auth_method: AuthMethod::Key,
            key_passphrase: None,
            password: None,
        })
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

    /// `--no-session` 只由 `aux_extra_args()` 产出；`build_spawn_args` 原样保留它。
    #[test]
    fn no_session_comes_only_from_extra_args() {
        let args = build_spawn_args(
            None,
            vec![
                "--no-session".into(),
                "--no-extensions".into(),
                "--provider".into(),
                "home".into(),
            ],
        );
        assert_eq!(
            args,
            vec![
                "--mode",
                "rpc",
                "--no-session",
                "--no-extensions",
                "--provider",
                "home",
            ]
        );
        // 不允许出现两个 `--no-session`（重复即为两处拼接）。
        assert_eq!(
            args.iter().filter(|arg| *arg == "--no-session").count(),
            1
        );
    }

    /// 远程 payload 必须带上 `--no-session`（本次漏检的根因：远程分支绕过了
    /// `build_spawn_args(..., ephemeral)`，只测本地就漏掉了）。
    #[test]
    fn remote_payload_carries_no_session_and_never_session() {
        let args = crate::rpc::aux_launch::aux_extra_args(&crate::rpc::aux_launch::AuxLaunchSpec {
            provider: "home".into(),
            model: "m".into(),
            thinking: Some("off".into()),
            file_changes_extension: None,
            workspace_extension: None,
        });
        let payload = crate::ssh::build_spawn_payload(
            "/home/dev/proj",
            None,
            &args,
        );
        assert!(payload.contains("--no-session"), "{payload}");
        assert!(!payload.contains("--session "), "{payload}");
        assert_eq!(
            payload.matches("--no-session").count(),
            1,
            "远程 payload 不允许重复 --no-session"
        );
    }
}

#[cfg(test)]
mod dispatch_tests {
    use super::*;

    #[test]
    fn non_object_stdout_records_are_skipped_without_panicking() {
        // serde_json's IndexMut panics on these; pi may emit legal JSONL
        // lines like these, and the reader task must survive them.
        for raw in [
            "42",
            "-1",
            "3.14",
            "\"hello\"",
            "[]",
            "[1,2]",
            "true",
            "null",
        ] {
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
            project: Arc::new(Mutex::new(String::new())),
            inner: Mutex::new(None),
            navigation: Mutex::new(()),
            generation: Arc::new(AtomicU64::new(0)),
            activity: Default::default(),
            policy: Default::default(),
            parent_runtime: Default::default(),
            user_activity: Default::default(),
        };
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let sink: Arc<dyn EventSink> = Arc::new(CollectingSink(tx));
        let result = process_spawn_impl(
            sink,
            &state,
            &SpawnProgram::Remote(RemoteSpawnSpec {
                endpoint: RemoteEndpoint::Ssh(crate::ssh::SshEndpoint {
                    host: "mock.test".to_string(),
                    port: 2222,
                    user: Some("dev".to_string()),
                    key_path: None,
                    auth_method: AuthMethod::Key,
                    key_passphrase: None,
                    password: None,
                }),
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

    /// 多后端契约验收第 2 条：`PIX_WSL_COMMAND` / `PIX_DOCKER_COMMAND` 注入
    /// mock 后，spawn → JSONL → `pi://exit` 全链路对 WSL / Docker 均可无网络
    /// 跑通（SSH 分支已有上方同型用例）。
    #[tokio::test]
    async fn mock_wsl_and_docker_spawn_bridge_jsonl_to_exit_without_network() {
        let Some(node) = find_test_program("node") else {
            eprintln!("跳过：开发环境未找到 node");
            return;
        };
        if node.to_string_lossy().contains(' ') {
            eprintln!("跳过：node 路径含空白，无法经注入钩子 mock");
            return;
        }
        let _guard = env_lock();
        let mock = "process.stderr.write('PIX_PI_PID=4242\\n');\
                    process.stdout.write(JSON.stringify({type:'agent_start'})+'\\n');\
                    process.stdin.resume();process.stdin.on('end',()=>process.exit(0))";
        let cases: Vec<(&str, RemoteEndpoint, &str, Vec<&str>)> = vec![
            (
                "PIX_WSL_COMMAND",
                RemoteEndpoint::Wsl(crate::ssh::WslEndpoint {
                    distro: "Ubuntu".to_string(),
                    user: None,
                }),
                "wsl://Ubuntu/home/dev/proj",
                vec!["-d", "Ubuntu", "--exec", "/bin/sh", "-c"],
            ),
            (
                "PIX_DOCKER_COMMAND",
                RemoteEndpoint::Docker(crate::ssh::DockerEndpoint {
                    container: "mock-container".to_string(),
                }),
                "docker://mock-container/home/dev/proj",
                vec!["exec", "-i", "mock-container", "/bin/sh", "-c"],
            ),
        ];
        for (env_name, endpoint, project, expected_argv) in cases {
            std::env::set_var(env_name, format!("{} -e {} --", node.display(), mock));
            // 断言该后端的 argv 形态确实走了分流（注入变量仍在时构造）。
            let (program, args) = crate::ssh::build_remote_command(&endpoint, "WRAPPED");
            assert_eq!(program, node.display().to_string(), "{env_name}");
            let expected: Vec<String> = expected_argv.iter().map(|s| s.to_string()).collect();
            let position = args
                .windows(expected.len())
                .position(|window| window == &expected[..])
                .unwrap_or_else(|| panic!("{env_name} argv 应含 {expected_argv:?}: {args:?}"));
            assert_eq!(args[position + expected.len()], "WRAPPED");

            let state = ProcessState {
                runtime_id: "mock-remote-runtime".to_string(),
                project: Arc::new(Mutex::new(String::new())),
                inner: Mutex::new(None),
                navigation: Mutex::new(()),
                generation: Arc::new(AtomicU64::new(0)),
                activity: Default::default(),
                policy: Default::default(),
                parent_runtime: Default::default(),
                user_activity: Default::default(),
            };
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            let sink: Arc<dyn EventSink> = Arc::new(CollectingSink(tx));
            let result = process_spawn_impl(
                sink,
                &state,
                &SpawnProgram::Remote(RemoteSpawnSpec {
                    endpoint,
                    remote_path: "/home/dev/proj".to_string(),
                }),
                project,
                None,
                vec![],
                None,
            )
            .await;
            // spawn 读 env 后才能移除注入变量。
            std::env::remove_var(env_name);
            result.unwrap_or_else(|e| panic!("{env_name} mock spawn 应就绪: {e}"));

            // 第一条事件（agent_start）到达即证明 JSONL 桥接接通。
            let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
            let (event, payload) = tokio::time::timeout_at(deadline, rx.recv())
                .await
                .expect("等待桥接事件超时")
                .expect("event channel closed");
            assert_eq!(event, EVENT);
            assert_eq!(payload["type"], "agent_start");

            state.inner.lock().await.take();
            let (event, _) = rx.recv().await.expect("event channel closed");
            assert_eq!(event, EXIT_EVENT);
        }
    }
}
