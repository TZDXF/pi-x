//! aux 的**不续期探针**（`docs/aux-chat-spec.md` §5）。
//!
//! 与 [`super::RpcState::process`] 的关键区别：后者每次都会
//! `last_activity.insert(now)`，那个时钟是给 schedule runtime 判"前端是否已 attach"
//! 用的（`schedules.rs` 的 `SCHEDULE_RUNTIME_TTL`）。辅助对话的回收判据必须是**用户
//! 活动**：探针自身、`get_state`/`get_messages`、租约心跳都不得把它推后，否则一个开了
//! 30 分钟没人说话的空闲 Tab 永远不会被回收。
//!
//! 因此本模块：
//! - 直接拿 `processes` 里的 `Arc<ProcessState>`，**不**经 `RpcState::process()`；
//! - 只读本地状态（活动、待答询问、在途请求、用户活动时钟），**不写 stdin**；
//! - 独立时钟 [`UserActivityClock`]，只在 `prompt`/`steer`/`follow_up` 时前进。
//!
//! 用户活动时钟挂在 `ProcessState` 上而不是 `RpcState.last_activity`：后者是
//! runtime → 时间的池级表，任何一次 `process()` 调用都会刷新它，复用会把"探针不续期"
//! 这条规格直接作废。

use serde_json::{json, Value};

use super::child;
use std::sync::Arc;
use super::{ProcessState, RpcState};
use std::time::{Duration, Instant};

/// 会**推进用户活动时钟**的命令（规格 §5：`last_user_activity` 只在
/// `prompt`/`steer`/`follow_up` 更新）。只读查询与心跳一律不在此列。
const USER_ACTIVITY_COMMANDS: &[&str] = &["prompt", "steer", "follow_up"];

/// 用户活动时钟。`last` 在 `ProcessState` 创建时初始化（≈ spawn 时刻），因此
/// "从没被 prompt 过"的实例按 spawn 起算空闲，而不是永远判为活跃或永远判为空闲。
#[derive(Debug)]
pub(crate) struct UserActivityClock {
    last: Instant,
}

impl Default for UserActivityClock {
    fn default() -> Self {
        Self {
            last: Instant::now(),
        }
    }
}

impl UserActivityClock {
    fn note(&mut self) {
        self.last = Instant::now();
    }

    pub(crate) fn idle(&self, now: Instant) -> Duration {
        now.saturating_duration_since(self.last)
    }
}

impl ProcessState {
    /// 记录一次**用户**活动。调用点在 [`super::accept_command`]（request 与 notify 的
    /// 唯一写入点），且只对 `prompt`/`steer`/`follow_up` 生效。
    pub(crate) async fn note_user_activity(&self, command: &Value) {
        let Some(command_type) = command["type"].as_str() else {
            return;
        };
        if !USER_ACTIVITY_COMMANDS.contains(&command_type) {
            return;
        }
        self.user_activity.lock().await.note();
    }

    pub(crate) async fn user_idle(&self, now: Instant) -> Duration {
        self.user_activity.lock().await.idle(now)
    }

    /// aux 的归属父会话（spawn 后由 `rpc::set_aux_parent` 写入；主会话恒为 `None`）。
    pub(crate) async fn parent_runtime(&self) -> Option<String> {
        self.parent_runtime.lock().await.clone()
    }
}

/// 一次探针结果（回收判定与测试共用；`claims` 由 `aux_reap` 补上，见那里）。
#[derive(Clone, Debug)]
pub(crate) struct AuxRuntimeSnapshot {
    pub(crate) parent_runtime: Option<String>,
    pub(crate) busy: bool,
    pub(crate) pending_ui: usize,
    pub(crate) in_flight: usize,
    /// 距最后一次用户活动的时长（`now` 由调用方给，便于测试注入）。
    pub(crate) idle: Duration,
}

impl AuxRuntimeSnapshot {
    /// 探针的 JSON 形态（诊断日志与单测共用；前端不消费）。
    pub(crate) fn to_json(&self) -> Value {
        json!({
            "parentRuntime": self.parent_runtime,
            "busy": self.busy,
            "pendingUi": self.pending_ui,
            "inFlight": self.in_flight,
            "lastUserActivityIdleSecs": self.idle.as_secs(),
        })
    }
}

/// 探针：只读、不续期、不写 stdin。runtime 不存在/不是 aux/已退出时返回 `None`。
///
/// 锁序与 [`super::accept_command`] 一致（`inner` → `activity` → `pending`），
/// 避免与命令写入路径形成 AB/BA 死锁。
pub(crate) async fn probe(
    state: &RpcState,
    runtime_id: &str,
    now: Instant,
) -> Option<AuxRuntimeSnapshot> {
    let process = state
        .processes
        .lock()
        .await
        .get(runtime_id)
        .cloned()?;
    if !process.policy.is_aux() {
        return None;
    }
    if !child::process_running(&process).await {
        return None;
    }
    let generation = process.current_generation();
    let in_flight = {
        let inner = process.inner.lock().await;
        match inner.as_ref() {
            Some(inner) => inner.pending.lock().await.len(),
            None => 0,
        }
    };
    let (busy, pending_ui) = {
        let mut activity = process.activity.lock().await;
        // generation 变了说明进程已被替换：旧活动表不属于这个辅助对话。
        if !activity.is_current(generation) {
            return None;
        }
        (activity.busy(), activity.pending_ui_count())
    };
    Some(AuxRuntimeSnapshot {
        parent_runtime: process.parent_runtime().await,
        busy,
        pending_ui,
        in_flight,
        idle: process.user_idle(now).await,
    })
}

/// 当前存活的 aux runtime id 快照（回收器扫描用；**不**刷新任何时钟）。
pub(crate) async fn aux_runtime_ids(state: &RpcState) -> Vec<String> {
    state
        .processes
        .lock()
        .await
        .values()
        .filter(|process| process.policy.is_aux())
        .map(|process| process.runtime_id.clone())
        .collect()
}

/// 当前存活的 aux runtime 及其归属父会话（`aux_list` 用）。
///
/// 只读：不刷新 `last_activity`、不写 stdin，也不把 `parent_runtime` 的
/// "未知"当成"没有归属"——未知照样返回 `None`，由前端按第 4 条过滤规则丢弃。
pub(crate) async fn aux_runtime_parents(state: &RpcState) -> Vec<(String, Option<String>)> {
    let processes: Vec<_> = state
        .processes
        .lock()
        .await
        .values()
        .filter(|process| process.policy.is_aux())
        .map(Arc::clone)
        .collect();
    let mut result = Vec::new();
    for process in processes {
        if !child::process_running(&process).await {
            continue;
        }
        result.push((process.runtime_id.clone(), process.parent_runtime().await));
    }
    result
}

/// 写入 aux 的归属父会话（spawn 成功后由 `commands::pi_aux` 调用）。
///
/// 为什么不加进 `rpc::spawn` 的参数表：那条路径同时服务主会话与 schedule runtime，
/// 只有 aux 需要这个字段；在 spawn 之后补一次比给公共签名再加一个 `Option<String>`
/// 的改动半径小得多（进程一旦被替换，`ProcessState` 是新实例，父子归属本就该重写）。
pub(crate) async fn set_aux_parent(state: &RpcState, runtime_id: &str, parent: Option<String>) {
    let process = state.processes.lock().await.get(runtime_id).cloned();
    if let Some(process) = process {
        *process.parent_runtime.lock().await = parent;
    }
}

/// 只读的策略快照（不刷新 `last_activity`、不写 stdin）。
pub(crate) async fn policy_of(state: &RpcState, runtime_id: &str) -> Option<super::RuntimePolicy> {
    state
        .processes
        .lock()
        .await
        .get(runtime_id)
        .map(|process| process.policy)
}

/// 只读的存活判定（不刷新 `last_activity`：`rpc::running` 会经 `process()` 续期，
/// 租约入口不能用它）。
pub(crate) async fn running_quiet(state: &RpcState, runtime_id: &str) -> bool {
    let process = state.processes.lock().await.get(runtime_id).cloned();
    match process {
        Some(process) => child::process_running(&process).await,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{test_harness, RuntimePolicy};

    #[tokio::test]
    async fn probe_never_touches_the_pool_activity_clock() {
        let state = RpcState::default();
        let (_process, mut rx) =
            test_harness::install_with_queue(&state, "aux:probe", RuntimePolicy::Aux).await;
        let snapshot = probe(&state, "aux:probe", Instant::now())
            .await
            .expect("aux 探针");
        assert!(!snapshot.busy);
        assert_eq!(snapshot.pending_ui, 0);
        assert_eq!(snapshot.in_flight, 0);
        // 关键判据：探针**不得**往 `last_activity` 里写任何东西
        // （`RpcState::process()` 每次都会 insert，这正是不能复用它做探针的原因）。
        assert!(
            state.last_activity.lock().await.is_empty(),
            "探针不得刷新 RpcState::last_activity"
        );
        // 也不许写 stdin（否则等于向 pi 发了一条命令）。
        assert!(rx.try_recv().is_err(), "探针不得向 pi 写入任何命令");
    }

    #[tokio::test]
    async fn probe_only_counts_still_pending_ui_requests() {
        let state = RpcState::default();
        let (process, _rx) =
            test_harness::install_with_queue(&state, "aux:ui", RuntimePolicy::Aux).await;
        process.activity.lock().await.event(json!({
            "type":"extension_ui_request","id":"ui-1","method":"confirm"
        }));
        let snapshot = probe(&state, "aux:ui", Instant::now()).await.unwrap();
        assert_eq!(snapshot.pending_ui, 1, "待答询问必须计入回收判据");
        assert!(!snapshot.busy);
        // 有 timeout 的询问按 deadline 过期（与 get_state 的快照同一规则；
        // 注意 `timeout: 0` 在活动表里被判为"无 timeout"，所以这里必须给正数）。
        process.activity.lock().await.event(json!({
            "type":"extension_ui_request","id":"ui-2","method":"confirm","timeout":1
        }));
        tokio::time::sleep(Duration::from_millis(30)).await;
        let snapshot = probe(&state, "aux:ui", Instant::now()).await.unwrap();
        assert_eq!(snapshot.pending_ui, 1, "过期的 ui-2 被排除，ui-1 仍待答");
        // 反向对照：不是"忽略所有询问"。
        process.activity.lock().await.resolve("ui-1");
        let snapshot = probe(&state, "aux:ui", Instant::now()).await.unwrap();
        assert_eq!(snapshot.pending_ui, 0);
    }

    #[tokio::test]
    async fn probe_reports_busy_while_the_agent_run_is_running() {
        let state = RpcState::default();
        let (process, _rx) =
            test_harness::install_with_queue(&state, "aux:busy", RuntimePolicy::Aux).await;
        process
            .activity
            .lock()
            .await
            .event(json!({"type":"agent_start"}));
        let snapshot = probe(&state, "aux:busy", Instant::now()).await.unwrap();
        assert!(snapshot.busy, "流式中的实例必须判为 busy");
        process
            .activity
            .lock()
            .await
            .event(json!({"type":"agent_settled","messages":[]}));
        let snapshot = probe(&state, "aux:busy", Instant::now()).await.unwrap();
        assert!(!snapshot.busy, "agent_settled 之后必须判为空闲");
    }

    #[tokio::test]
    async fn probe_counts_in_flight_requests() {
        let state = RpcState::default();
        let (process, _rx) =
            test_harness::install_with_queue(&state, "aux:inflight", RuntimePolicy::Aux).await;
        let (tx, _keep) = tokio::sync::oneshot::channel();
        process
            .inner
            .lock()
            .await
            .as_ref()
            .unwrap()
            .pending
            .lock()
            .await
            .insert(7, tx);
        let snapshot = probe(&state, "aux:inflight", Instant::now()).await.unwrap();
        assert_eq!(snapshot.in_flight, 1, "在途请求必须计入回收判据");
    }

    #[tokio::test]
    async fn probe_ignores_non_aux_and_dead_runtimes() {
        let state = RpcState::default();
        test_harness::install(&state, "main", RuntimePolicy::Main).await;
        assert!(probe(&state, "main", Instant::now()).await.is_none());
        assert!(probe(&state, "aux:missing", Instant::now()).await.is_none());
    }

    #[tokio::test]
    async fn only_prompt_steer_and_follow_up_advance_the_user_clock() {
        let state = RpcState::default();
        let (process, _rx) =
            test_harness::install_with_queue(&state, "aux:clock", RuntimePolicy::Aux).await;
        // 只读查询、心跳、未知类型都不推进时钟。
        for command in [
            json!({"type":"get_state"}),
            json!({"type":"get_messages"}),
            json!({"type":"get_session_stats"}),
            json!({"type":"abort"}),
            json!({"type":"extension_ui_response","id":"x"}),
            json!({"type":"aux_claim"}),
        ] {
            process.note_user_activity(&command).await;
        }
        let read_only = probe(&state, "aux:clock", Instant::now()).await.unwrap().idle;
        assert!(
            read_only < Duration::from_millis(500),
            "只读命令不得改动用户活动时钟：{read_only:?}"
        );
        // prompt/steer/follow_up 必须能把时钟推到现在（清零空闲）。
        for command in [
            json!({"type":"prompt","message":"hi"}),
            json!({"type":"steer","message":"go"}),
            json!({"type":"follow_up","message":"more"}),
        ] {
            process.note_user_activity(&command).await;
            let idle = probe(&state, "aux:clock", Instant::now()).await.unwrap().idle;
            assert!(
                idle < Duration::from_millis(500),
                "{} 必须推进用户活动时钟：{idle:?}",
                command["type"]
            );
        }
    }

    #[tokio::test]
    async fn probes_are_side_effect_free_so_idle_keeps_growing() {
        let state = RpcState::default();
        test_harness::install(&state, "aux:stable", RuntimePolicy::Aux).await;
        // 同一个 `now` 连探两次：结果必须完全一致（探针本身不改时钟）。
        let now = Instant::now() + Duration::from_secs(42);
        let first = probe(&state, "aux:stable", now).await.unwrap();
        let second = probe(&state, "aux:stable", now).await.unwrap();
        assert_eq!(first.idle, second.idle);
        assert!(first.idle >= Duration::from_secs(42), "{:?}", first.idle);
        // 时间前进 20 分钟（模拟 20s 心跳 × N），空闲时长必须跟着涨。
        let later = probe(&state, "aux:stable", now + Duration::from_secs(1200))
            .await
            .unwrap();
        assert!(later.idle >= first.idle + Duration::from_secs(1100));
    }

    #[tokio::test]
    async fn set_aux_parent_is_visible_to_the_probe_and_aux_listing() {
        let state = RpcState::default();
        test_harness::install(&state, "aux:child", RuntimePolicy::Aux).await;
        set_aux_parent(&state, "aux:child", Some("main".into())).await;
        let snapshot = probe(&state, "aux:child", Instant::now()).await.unwrap();
        assert_eq!(snapshot.parent_runtime.as_deref(), Some("main"));
        assert_eq!(aux_runtime_ids(&state).await, vec!["aux:child".to_string()]);
        // `policy_of` / `running_quiet` 都不得刷新池级时钟。
        assert_eq!(
            policy_of(&state, "aux:child").await,
            Some(RuntimePolicy::Aux)
        );
        assert!(running_quiet(&state, "aux:child").await);
        assert!(state.last_activity.lock().await.is_empty());
    }
}
