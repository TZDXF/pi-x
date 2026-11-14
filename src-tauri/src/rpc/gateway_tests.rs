//! M0 网关测试：策略在 `request`/`notify` 单一入口生效，被拒绝的命令绝不写进 pi 的 stdin。
use super::*;
use std::process::Stdio;
use tokio::process::Command;

struct NullSink;
impl child::EventSink for NullSink {
    fn emit(&self, _: &'static str, _: &str, _: Value) {}
}

/// 一个装着 aux/Main 进程的 `RpcState`，外加 stdin 队列的接收端：`rx` 用来断言
/// "命令是否真的写进了 pi 的 stdin"（M0 的硬判据）。
struct Harness {
    state: RpcState,
    rx: mpsc::Receiver<String>,
}

const RUNTIME: &str = "test-aux";

async fn harness(policy: RuntimePolicy) -> Harness {
    let process = Arc::new(ProcessState {
        runtime_id: RUNTIME.into(),
        policy,
        ..Default::default()
    });
    let mut cmd = Command::new(if cfg!(windows) { "cmd" } else { "true" });
    if cfg!(windows) {
        cmd.args(["/C", "exit 0"]);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let child = cmd.spawn().expect("spawn dummy child");
    let (stdin_tx, rx) = mpsc::channel::<String>(8);
    process
        .activity
        .lock()
        .await
        .reset(process.current_generation(), RUNTIME, "project", None, Arc::new(NullSink));
    *process.inner.lock().await = Some(SessionInner {
        child,
        stdin_tx,
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: Arc::new(AtomicU64::new(1)),
        remote: None,
    });
    let state = RpcState::default();
    state.processes.lock().await.insert(RUNTIME.into(), process);
    Harness { state, rx }
}

impl Harness {
    /// 断言本次调用被拒绝、写了 `auxRpcDenied`，且 stdin 一个字节都没收到。
    async fn expect_denied(&mut self, command: Value, via_notify: bool, label: &str) {
        let result = if via_notify {
            notify(&self.state, command, Some(RUNTIME)).await.map(|_| Value::Null)
        } else {
            request(&self.state, command, Some(RUNTIME)).await
        };
        let err = result.expect_err(label);
        assert!(err.contains("auxRpcDenied"), "{label}: {err}");
        assert!(
            self.rx.try_recv().is_err(),
            "{label} 被拒绝时不得写入 stdin"
        );
    }
}

/// 结构类（建会话/导航/导出/改名/回滚/fork 消息）在 aux 下一律拒绝。
#[tokio::test]
async fn aux_rejects_structural_commands_without_touching_stdin() {
    let blocked = [
        "fork",
        "clone",
        "new_session",
        "switch_session",
        "export_html",
        "set_session_name",
        "rewind_prompt",
        "get_fork_messages",
    ];
    for ty in blocked {
        let mut h = harness(RuntimePolicy::Aux).await;
        h.expect_denied(json!({ "type": ty }), false, ty).await;
    }
}

/// 写 agent `settings.json` 的四条 + `abort_retry`：实测有跨会话副作用，拒绝。
#[tokio::test]
async fn aux_rejects_agent_settings_writes_without_touching_stdin() {
    let blocked = [
        "set_steering_mode",
        "set_follow_up_mode",
        "set_auto_compaction",
        "set_auto_retry",
        "abort_retry",
    ];
    for ty in blocked {
        let mut h = harness(RuntimePolicy::Aux).await;
        h.expect_denied(json!({ "type": ty }), false, ty).await;
    }
}

/// 未知 type 默认拒绝：客户端无法夹带 pi 以后新增的命令。
#[tokio::test]
async fn aux_rejects_unknown_type_without_touching_stdin() {
    let mut h = harness(RuntimePolicy::Aux).await;
    h.expect_denied(json!({ "type": "aux_claim" }), false, "unknown")
        .await;
}

/// `rpc_notify` 在 aux 下只放行 `extension_ui_response`。
#[tokio::test]
async fn aux_notify_only_allows_extension_ui_response() {
    for ty in ["bash", "prompt", "unknown_type"] {
        let mut h = harness(RuntimePolicy::Aux).await;
        h.expect_denied(json!({ "type": ty }), true, ty).await;
    }
}

/// 执行类放行且**真有** stdin 写入（防"假放行"）：网关判定 + 写入路径两件事一起断言。
#[tokio::test]
async fn aux_allows_bash_and_really_writes_stdin() {
    let command = json!({ "type": "bash", "command": "echo hi" });
    assert!(
        RuntimePolicy::Aux.guard_request(&command).is_ok(),
        "aux 必须放行执行类"
    );
    let mut h = harness(RuntimePolicy::Aux).await;
    process_notify(&h.state.process(Some(RUNTIME)).await.unwrap(), command)
        .await
        .expect("bash 必须能写进 stdin");
    let written = h.rx.try_recv().expect("aux bash 必须到达 pi 的 stdin");
    assert_eq!(
        serde_json::from_str::<Value>(&written).unwrap()["type"],
        "bash"
    );
}

/// Main 不受影响：aux 拒绝的同一批命令在 Main 下仍被接受并写入 stdin。
///
/// 用 `notify`（fire-and-forget）而不是 `request`，因为后者会等待子进程的响应，
/// 而测试用的是一个立即退出的哑进程。
#[tokio::test]
async fn main_policy_keeps_rejected_commands_working() {
    for ty in [
        "fork",
        "set_steering_mode",
        "set_auto_retry",
        "export_html",
    ] {
        let mut h = harness(RuntimePolicy::Main).await;
        assert!(
            RuntimePolicy::Main.guard_request(&json!({ "type": ty })).is_ok(),
            "Main 必须放行 {ty}"
        );
        let process = h.state.process(Some(RUNTIME)).await.unwrap();
        process_notify(&process, json!({ "type": ty }))
            .await
            .unwrap_or_else(|e| panic!("Main 必须能写 {ty}: {e}"));
        let written = h.rx.try_recv().expect("Main 必须写入 stdin");
        assert_eq!(serde_json::from_str::<Value>(&written).unwrap()["type"], ty);
    }
}

/// 会话文件入口（复制/导出用）对 aux 关闭。
#[tokio::test]
async fn aux_session_endpoint_is_closed() {
    let h = harness(RuntimePolicy::Aux).await;
    let err = session_endpoint(&h.state, RUNTIME)
        .await
        .expect_err("aux 不得有 session endpoint");
    assert!(err.contains("auxRpcDenied"));
}

/// 内部 rename 绕过 `request`，因此在 `set_session_name` 的循环里显式跳过 aux。
#[tokio::test]
async fn internal_rename_never_reaches_aux() {
    let mut h = harness(RuntimePolicy::Aux).await;
    let path = Path::new("C:/tmp/aux-session.jsonl");
    let _ = set_session_name(&h.state, path, "aux".into(), false).await;
    assert!(h.rx.try_recv().is_err(), "aux 不应收到 rename 的任何探测");
}
