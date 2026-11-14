//! M0 网关测试：策略在 `request`/`notify` 单一入口生效，被拒绝的命令绝不写进 pi 的 stdin。
//!
//! 三条硬判据：
//! 1. 断言走**真实入口**（`request` / `notify` 包装层），而不是直呼底层的 `process_*`；
//! 2. 拒绝时 stdin **零写入**；
//! 3. 放行时 stdin **真有写入**（否则"放行"可能是被包装层挡掉后的假阳性）。
//!
//! 进程用一个**长命**的假子进程（否则"进程已退出"分支会把真实缺陷掩盖掉），
//! 并由 `Responder` 在收到写入后回一条合成 response，让 `request` 能返回。
use super::*;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use tokio::process::Command;

struct NullSink;
impl child::EventSink for NullSink {
    fn emit(&self, _: &'static str, _: &str, _: Value) {}
}

const RUNTIME: &str = "test-aux";

/// 一个装着 aux/Main 进程的 `RpcState`，外加 stdin 队列接收端。
struct Harness {
    state: Arc<RpcState>,
    rx: mpsc::Receiver<String>,
    stop: Arc<AtomicBool>,
}

impl Harness {
    fn process(&self) -> Arc<ProcessState> {
        // 只有本测试线程会写这个表，测试是单线程的，直接取即可。
        let state = &self.state;
        futures_block(state)
    }
}

fn futures_block(state: &RpcState) -> Arc<ProcessState> {
    for _ in 0..1000 {
        if let Ok(guard) = state.processes.try_lock() {
            if let Some(process) = guard.get(RUNTIME) {
                return process.clone();
            }
        }
        std::thread::yield_now();
    }
    panic!("process missing from registry")
}

/// 长命假子进程：读 stdin 但从不回应（回应由 `Responder` 直接注入 pending 表）。
fn long_lived_child() -> tokio::process::Child {
    let mut cmd = if cfg!(windows) {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "ping -n 120 127.0.0.1 >NUL"]);
        cmd
    } else {
        let mut cmd = Command::new("sleep");
        cmd.arg("120");
        cmd
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().expect("spawn long-lived dummy child")
}

/// 收到请求写入后向 `pending` 表投一条合成 response，让 `request` 返回而不是挂住。
fn spawn_responder(state: Arc<RpcState>, stop: Arc<AtomicBool>) {
    tokio::spawn(async move {
        while !stop.load(AtomicOrdering::Relaxed) {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
            let process = match state.processes.lock().await.get(RUNTIME).cloned() {
                Some(process) => process,
                None => return,
            };
            let inner = process.inner.lock().await;
            let Some(inner) = inner.as_ref() else { return };
            let mut pending = inner.pending.lock().await;
            let ids: Vec<u64> = pending.keys().copied().collect();
            for id in ids {
                if let Some(tx) = pending.remove(&id) {
                    let _ = tx.send(json!({"id": id, "type": "response", "success": true, "data": {}}));
                }
            }
        }
    });
}

async fn harness(policy: RuntimePolicy) -> Harness {
    let process = Arc::new(ProcessState {
        runtime_id: RUNTIME.into(),
        policy,
        ..Default::default()
    });
    process.activity.lock().await.reset(
        process.current_generation(),
        RUNTIME,
        "project",
        None,
        Arc::new(NullSink),
    );
    let child = long_lived_child();
    let (stdin_tx, rx) = mpsc::channel::<String>(8);
    *process.inner.lock().await = Some(SessionInner {
        child,
        stdin_tx,
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: Arc::new(AtomicU64::new(1)),
        remote: None,
    });
    let state = Arc::new(RpcState::default());
    state.processes.lock().await.insert(RUNTIME.into(), process);
    let stop = Arc::new(AtomicBool::new(false));
    spawn_responder(state.clone(), stop.clone());
    Harness { state, rx, stop }
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.stop.store(true, AtomicOrdering::Relaxed);
    }
}

impl Harness {
    /// 被拒绝的命令：`auxRpcDenied` + stdin 零写入。
    async fn expect_denied(&mut self, command: Value, via_notify: bool, label: &str) {
        let result = if via_notify {
            notify(&self.state, command, Some(RUNTIME)).await.map(|_| json!(null))
        } else {
            request(&self.state, command, Some(RUNTIME)).await
        };
        let err = result.expect_err(label);
        assert!(err.contains("auxRpcDenied"), "{label}: {err}");
        assert!(self.rx.try_recv().is_err(), "{label} 被拒绝时不得写入 stdin");
    }
}

// ---- 结构类：拒绝且零写入 ----

#[tokio::test]
async fn aux_rejects_structural_commands_without_touching_stdin() {
    for ty in [
        "fork",
        "clone",
        "new_session",
        "switch_session",
        "export_html",
        "set_session_name",
        "rewind_prompt",
        "get_fork_messages",
    ] {
        let mut h = harness(RuntimePolicy::Aux).await;
        h.expect_denied(json!({ "type": ty }), false, ty).await;
    }
}

// ---- 写 agent settings 的四条 + abort_retry：拒绝且零写入 ----

#[tokio::test]
async fn aux_rejects_agent_settings_writes_without_touching_stdin() {
    for ty in [
        "set_steering_mode",
        "set_follow_up_mode",
        "set_auto_compaction",
        "set_auto_retry",
        "abort_retry",
    ] {
        let mut h = harness(RuntimePolicy::Aux).await;
        h.expect_denied(json!({ "type": ty }), false, ty).await;
    }
}

#[tokio::test]
async fn aux_rejects_unknown_type_without_touching_stdin() {
    let mut h = harness(RuntimePolicy::Aux).await;
    h.expect_denied(json!({ "type": "aux_claim" }), false, "unknown")
        .await;
}

// ---- 执行类：走真实 `request` 入口，且 stdin 真有写入 ----

#[tokio::test]
async fn aux_allows_bash_through_the_real_request_entry() {
    let mut h = harness(RuntimePolicy::Aux).await;
    // 走 `request`（不是 process_request），因此包装层若错误拒绝也会被这里抓到。
    let response = request(
        &h.state,
        json!({ "type": "bash", "command": "echo hi" }),
        Some(RUNTIME),
    )
    .await
    .expect("aux 必须放行执行类");
    assert_eq!(response["success"], true);
    let written = h.rx.try_recv().expect("aux bash 必须真的到达 pi 的 stdin");
    let parsed: Value = serde_json::from_str(&written).unwrap();
    assert_eq!(parsed["type"], "bash");
    assert_eq!(parsed["command"], "echo hi");
}

#[tokio::test]
async fn main_keeps_settings_and_structure_writes_through_the_real_request_entry() {
    for ty in ["set_steering_mode", "fork"] {
        let mut h = harness(RuntimePolicy::Main).await;
        let response = request(&h.state, json!({ "type": ty }), Some(RUNTIME))
            .await
            .unwrap_or_else(|e| panic!("Main 必须放行 {ty}: {e}"));
        assert_eq!(response["success"], true);
        let written = h.rx.try_recv().expect("Main 必须真的写入 stdin");
        assert_eq!(serde_json::from_str::<Value>(&written).unwrap()["type"], ty);
    }
}

// ---- notify：拒绝分支 + 合法 pending UI 的放行正断言 ----

#[tokio::test]
async fn aux_notify_rejects_execution_and_non_ui_types() {
    for ty in ["bash", "prompt", "unknown_type"] {
        let mut h = harness(RuntimePolicy::Aux).await;
        h.expect_denied(json!({ "type": ty }), true, ty).await;
    }
}

#[tokio::test]
async fn aux_notify_allows_extension_ui_response_for_a_pending_request() {
    let mut h = harness(RuntimePolicy::Aux).await;
    let process = h.process();
    // 先登记一条待答的扩展询问（与真实事件路径一致），否则响应会被"已不再待答"拒绝。
    process
        .activity
        .lock()
        .await
        .event(json!({
            "type": "extension_ui_request", "id": "ui-1", "method": "confirm", "title": "ok?"
        }));
    notify(
        &h.state,
        json!({ "type": "extension_ui_response", "id": "ui-1", "confirmed": true }),
        Some(RUNTIME),
    )
    .await
    .expect("aux 必须放行合法的扩展询问应答");
    let written = h.rx.try_recv().expect("应答必须真的写入 stdin");
    let parsed: Value = serde_json::from_str(&written).unwrap();
    assert_eq!(parsed["type"], "extension_ui_response");
    assert_eq!(parsed["id"], "ui-1");
    assert_eq!(parsed["confirmed"], true);
}

// ---- 会话文件入口与内部 rename：aux 关闭 ----

#[tokio::test]
async fn aux_session_endpoint_is_closed() {
    let h = harness(RuntimePolicy::Aux).await;
    let err = session_endpoint(&h.state, RUNTIME)
        .await
        .expect_err("aux 不得有 session endpoint");
    assert!(err.contains("auxRpcDenied"));
}

#[tokio::test]
async fn internal_rename_never_reaches_a_live_aux_process() {
    let mut h = harness(RuntimePolicy::Aux).await;
    // 子进程是长命的：因此"被跳过"不是由"进程已退出"分支造成的副作用。
    assert!(
        child::process_running(&h.process()).await,
        "假进程必须存活，否则本用例会被退出分支掩盖"
    );
    let path = Path::new("C:/tmp/aux-session.jsonl");
    let _ = set_session_name(&h.state, path, "aux".into(), false).await;
    assert!(h.rx.try_recv().is_err(), "aux 不应收到 rename 的任何探测");
}

// ---- 远程：aux argv 经 payload 通道带 --no-session；Web dispatch 委托同一函数 ----

#[tokio::test]
async fn remote_aux_argv_carries_no_session_through_the_payload_builder() {
    let spec = aux_launch::AuxLaunchSpec {
        provider: "home".into(),
        model: "m".into(),
        thinking: Some("off".into()),
        file_changes_extension: None,
        workspace_extension: None,
    };
    let args = aux_launch::aux_extra_args(&spec);
    let payload = crate::ssh::build_spawn_payload("/home/dev/proj", None, &args);
    assert!(payload.contains("--no-session"), "{payload}");
    assert!(!payload.contains("--session "), "{payload}");
    assert_eq!(payload.matches("--no-session").count(), 1);
}

/// Web 端 `aux_spawn` 必须委托同一个命令实现，否则远程会拿到"没有 --no-session"的另一种拼法。
#[test]
fn web_dispatch_delegates_aux_spawn_to_the_same_command() {
    let source = include_str!("../remote/dispatch/session.rs");
    assert!(
        source.contains("\"aux_spawn\" =>") && source.contains("pi_aux::aux_spawn"),
        "remote dispatch 必须委托 commands::pi_aux::aux_spawn"
    );
}
