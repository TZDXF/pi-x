//! 仅测试用的装配：往 [`RpcState`] 里塞一个"长命假进程"的 [`ProcessState`]。
//!
//! 为什么集中在这里：`ProcessState` 的内部字段（`inner`/`activity`/`policy`）只在
//! `rpc` 模块及其子模块可见，而回收器（`crate::aux_reap`）与探针（`rpc::aux_probe`）
//! 的测试都要装配同一个东西。放在 `rpc` 子模块里，两个调用方都能用，不必把
//! `RpcState` 的字段改成 `pub(crate)`（那会把"池只有 `rpc` 能改"的边界放开）。
//!
//! 假进程本身是长命的（`ping`/`sleep`）：`process_running` 的判据是"进程没退出"，
//! 用真进程才能让"探针不误报/回收器不误杀"的断言有意义。

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

use super::{child, ProcessState, RpcState, RuntimePolicy, SessionInner};

struct NullSink;
impl child::EventSink for NullSink {
    fn emit(&self, _: &'static str, _: &str, _: serde_json::Value) {}
}

fn long_lived_child() -> tokio::process::Child {
    let mut cmd = if cfg!(windows) {
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.args(["/C", "ping -n 120 127.0.0.1 >NUL"]);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new("sleep");
        cmd.arg("120");
        cmd
    };
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    cmd.spawn().expect("spawn long-lived dummy child")
}

/// 装一个进程并登记进池；返回该 `ProcessState`（stdin 队列接收端丢弃，
/// 需要断言"零写入"的用例自己拿 [`install_with_queue`]）。
pub(crate) async fn install(
    state: &RpcState,
    runtime_id: &str,
    policy: RuntimePolicy,
) -> Arc<ProcessState> {
    install_with_queue(state, runtime_id, policy).await.0
}

/// 同 [`install`]，额外返回 stdin 队列的接收端（断言"没写 stdin"用）。
pub(crate) async fn install_with_queue(
    state: &RpcState,
    runtime_id: &str,
    policy: RuntimePolicy,
) -> (Arc<ProcessState>, mpsc::Receiver<String>) {
    let process = Arc::new(ProcessState {
        runtime_id: runtime_id.into(),
        policy,
        ..Default::default()
    });
    process.activity.lock().await.reset(
        process.current_generation(),
        runtime_id,
        "project",
        None,
        Arc::new(NullSink),
    );
    let (stdin_tx, rx) = mpsc::channel::<String>(8);
    *process.inner.lock().await = Some(SessionInner {
        child: long_lived_child(),
        stdin_tx,
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: Arc::new(AtomicU64::new(1)),
        remote: None,
    });
    state
        .processes
        .lock()
        .await
        .insert(runtime_id.into(), process.clone());
    (process, rx)
}

/// 让该实例进入"跑一轮 agent"的状态（`busy` 判据）。
pub(crate) async fn start_agent_run(state: &RpcState, runtime_id: &str) {
    if let Some(process) = state.processes.lock().await.get(runtime_id).cloned() {
        process
            .activity
            .lock()
            .await
            .event(serde_json::json!({"type": "agent_start"}));
    }
}

/// 让该实例进入"有待答扩展询问"的状态（`pending_ui` 判据）。
pub(crate) async fn raise_ui_request(state: &RpcState, runtime_id: &str, id: &str) {
    if let Some(process) = state.processes.lock().await.get(runtime_id).cloned() {
        process.activity.lock().await.event(serde_json::json!({
            "type": "extension_ui_request", "id": id, "method": "confirm", "title": "ok?"
        }));
    }
}

/// 往该实例的 pending 表塞一条在途请求（`in_flight` 判据）。
pub(crate) async fn add_in_flight_request(state: &RpcState, runtime_id: &str) {
    if let Some(process) = state.processes.lock().await.get(runtime_id).cloned() {
        let (tx, keep) = tokio::sync::oneshot::channel();
        process
            .inner
            .lock()
            .await
            .as_ref()
            .expect("test harness installs a session")
            .pending
            .lock()
            .await
            .insert(7, tx);
        // 接收端必须活到断言结束，否则 sender 失效、pending 里的条目语义就变了。
        std::mem::forget(keep);
    }
}

/// 把某个 runtime 的用户活动时钟**回拨**成"`secs` 秒前活动过"（精确边界的构造器）。
pub(crate) async fn note_user_activity_at(state: &RpcState, runtime_id: &str, secs: u64) {
    if let Some(process) = state.processes.lock().await.get(runtime_id).cloned() {
        process
            .user_activity
            .lock()
            .await
            .note_at(std::time::Instant::now() - std::time::Duration::from_secs(secs));
    }
}

/// 某个 runtime 当前的空闲秒数（`user_activity` 的只读读取）。
pub(crate) async fn user_idle_secs(state: &RpcState, runtime_id: &str) -> u64 {
    let process = state.processes.lock().await.get(runtime_id).cloned();
    match process {
        Some(process) => process.user_idle(std::time::Instant::now()).await.as_secs(),
        None => 0,
    }
}

/// 池里当前的进程数（回收后核对用）。
pub(crate) async fn process_count(state: &RpcState) -> usize {
    state.processes.lock().await.len()
}

/// 把某个 runtime 从池里摘掉（模拟"进程已消失但租约残留"）。
pub(crate) async fn remove(state: &RpcState, runtime_id: &str) {
    state.processes.lock().await.remove(runtime_id);
}
