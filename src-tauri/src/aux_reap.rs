//! aux 的**孤儿回收器**（`docs/aux-chat-spec.md` §5）。
//!
//! 纯兜底：正常路径是"关闭 Tab 即 `rpc_kill` + `aux_release`"。这里只处理漏掉的情况
//! （渲染进程崩溃、远程断连、迟到退出），避免这类实例白占内存（单实例空闲基线约
//! 138MB RSS）。
//!
//! 判定三条件**同时成立**才 kill：
//! 1. `busy == false && pending_ui == 0 && in_flight == 0`（不在流式、没有待答询问、
//!    没有在途请求）；
//! 2. `claims` 为空（没有任何客户端还在为它跳心跳）；
//! 3. `last_user_activity` 距今 > 30 分钟（**用户活动**，不是"最后一次 RPC"）。
//!
//! 第三个条件依赖 [`crate::rpc::aux_probe`] 的独立时钟：探针、`get_state`、
//! 租约心跳都不得推进它，否则开着但空闲的 Tab 永远不会被回收（这正是不能照搬
//! `schedules.rs` 那套 `last_activity` TTL 的原因）。
//!
//! 每次 tick 60s 扫一遍 `aux:` 前缀，判定成立时 `logs::write("aux-reap", …)`
//! 留痕（含 parent / claims / idle 秒数），随后 kill 并清掉该 runtime 的租约。

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::rpc::{self, aux_probe};
use crate::rpc::RpcState;
use tauri::Manager;

/// 回收扫描周期。
pub(crate) const REAP_TICK: Duration = Duration::from_secs(60);
/// 空闲阈值：`last_user_activity` 超过它才考虑回收。
pub(crate) const AUX_IDLE_LIMIT: Duration = Duration::from_secs(30 * 60);

/// 三条件判定（纯函数，便于逐条构造反例）。
///
/// 任何一条不成立都**不**回收：活跃流/待答询问/在途请求期间误杀会把用户正在看的回答
/// 掐断；有租约时误杀会让另一个窗口的 Tab 变成死壳。
pub(crate) fn is_reclaimable(
    busy: bool,
    pending_ui: usize,
    in_flight: usize,
    claims: usize,
    idle: Duration,
    idle_limit: Duration,
) -> bool {
    !busy && pending_ui == 0 && in_flight == 0 && claims == 0 && idle > idle_limit
}

/// 一次回收动作的留痕（日志与测试断言共用）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Reaped {
    pub(crate) runtime_id: String,
    pub(crate) parent: Option<String>,
    pub(crate) claims: usize,
    pub(crate) idle_secs: u64,
}

impl Reaped {
    /// 日志行（`logs::write("aux-reap", …)`）：含 parent / claims / idle 秒数，
    /// 外加探针的三个瞬时值，便于事后判断"当时到底空闲到什么程度"。
    fn to_json(&self) -> Value {
        json!({
            "runtimeId": self.runtime_id,
            "parent": self.parent,
            "claims": self.claims,
            "idleSecs": self.idle_secs,
        })
    }
}

/// 扫一遍并回收（返回本次真正 kill 掉的条目）。
///
/// `now`/`idle_limit` 由调用方给：生产路径用 `Instant::now()` + [`AUX_IDLE_LIMIT`]，
/// 单测可以注入"已经空闲 31 分钟"而不必真等半小时。
pub(crate) async fn reap_once(
    state: &RpcState,
    now: Instant,
    idle_limit: Duration,
) -> Vec<Reaped> {
    let mut reaped = Vec::new();
    let live = aux_probe::aux_runtime_ids(state).await;
    for runtime_id in &live {
        let Some(snapshot) = aux_probe::probe(state, runtime_id, now).await else {
            continue;
        };
        let claims = crate::aux_leases::holder_count(runtime_id);
        if !is_reclaimable(
            snapshot.busy,
            snapshot.pending_ui,
            snapshot.in_flight,
            claims,
            snapshot.idle,
            idle_limit,
        ) {
            continue;
        }
        let entry = Reaped {
            runtime_id: runtime_id.clone(),
            parent: snapshot.parent_runtime.clone(),
            claims,
            idle_secs: snapshot.idle.as_secs(),
        };
        // 日志留痕：parent / claims / idle 秒数（规格 §5 的判定三条件），再加探针
        // 的三个瞬时值，便于事后复盘"为什么这条被回收/没被回收"。
        let mut line = entry.to_json();
        line["probe"] = snapshot.to_json();
        crate::logs::write("aux-reap", &line.to_string());
        // kill 失败不阻断其它条目：单条异常不该让本轮扫描整体停摆。
        let _ = rpc::kill(state, Some(runtime_id)).await;
        crate::aux_leases::forget(runtime_id);
        reaped.push(entry);
    }
    // 进程已消失但租约还在（客户端崩溃没发 release）：残条同样清掉，
    // 否则 `aux_list` 会一直报一个不存在的实例。
    for stale in crate::aux_leases::runtime_ids()
        .into_iter()
        .filter(|id| !live.contains(id))
    {
        crate::logs::write(
            "aux-reap",
            &json!({"runtimeId": stale, "reason": "lease-without-process"}).to_string(),
        );
        crate::aux_leases::forget(&stale);
    }
    reaped
}

/// 启动后台回收器（`lib.rs` 的 setup 调用；与 `schedules::start` 同级）。
pub fn start(app: tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(REAP_TICK).await;
            let state = app.state::<RpcState>();
            reap_once(&state, Instant::now(), AUX_IDLE_LIMIT).await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rpc::{test_harness, RuntimePolicy, RpcState};
    use std::sync::Arc;

    #[test]
    fn all_three_conditions_must_hold() {
        let idle = AUX_IDLE_LIMIT + Duration::from_secs(1);
        assert!(is_reclaimable(false, 0, 0, 0, idle, AUX_IDLE_LIMIT));
        // ① 活跃流 / 待答询问 / 在途请求：任一项成立即不回收。
        assert!(!is_reclaimable(true, 0, 0, 0, idle, AUX_IDLE_LIMIT));
        assert!(!is_reclaimable(false, 1, 0, 0, idle, AUX_IDLE_LIMIT));
        assert!(!is_reclaimable(false, 0, 1, 0, idle, AUX_IDLE_LIMIT));
        // ② 有租约（任一客户端还在心跳）：不回收。
        assert!(!is_reclaimable(false, 0, 0, 1, idle, AUX_IDLE_LIMIT));
        // ③ 空闲必须严格超过 30 分钟（边界值不回收）。
        assert!(!is_reclaimable(
            false,
            0,
            0,
            0,
            AUX_IDLE_LIMIT,
            AUX_IDLE_LIMIT
        ));
        assert!(!is_reclaimable(
            false,
            0,
            0,
            0,
            Duration::from_secs(60),
            AUX_IDLE_LIMIT
        ));
    }

    #[tokio::test]
    async fn reap_kills_only_the_instance_whose_lease_is_gone() {
        let _guard = crate::aux_leases::test_lock();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:a", RuntimePolicy::Aux).await;
        test_harness::install(&state, "aux:b", RuntimePolicy::Aux).await;
        crate::rpc::aux_probe::set_aux_parent(&state, "aux:a", Some("main".into())).await;
        crate::rpc::aux_probe::set_aux_parent(&state, "aux:b", Some("main".into())).await;
        crate::aux_leases::claim(&state, "aux:a", "client-1")
            .await
            .unwrap();
        crate::aux_leases::claim(&state, "aux:b", "client-2")
            .await
            .unwrap();
        // A 释放（关掉自己的 Tab），B 仍在心跳。
        crate::aux_leases::release(&state, "aux:a", "client-1")
            .await
            .unwrap();

        // 注入"两者都已空闲 31 分钟"（不真等半小时：用户活动时钟由 spawn 起算）。
        let now = Instant::now() + AUX_IDLE_LIMIT + Duration::from_secs(60);
        let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert_eq!(reaped.len(), 1, "只有 A 的租约已释放：{reaped:?}");
        assert_eq!(reaped[0].runtime_id, "aux:a");
        assert_eq!(reaped[0].parent.as_deref(), Some("main"));
        assert_eq!(reaped[0].claims, 0);
        assert!(reaped[0].idle_secs > 30 * 60, "日志必须带空闲秒数");
        assert!(!crate::rpc::running(&state, Some("aux:a")).await, "A 必须被 kill");
        assert!(
            crate::rpc::running(&state, Some("aux:b")).await,
            "B 仍持有租约，不得被回收"
        );
        assert_eq!(test_harness::process_count(&state).await, 1);
        crate::aux_leases::reset_for_test();
    }

    #[tokio::test]
    async fn in_flight_requests_also_block_reclaiming() {
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:inflight", RuntimePolicy::Aux).await;
        test_harness::add_in_flight_request(&state, "aux:inflight").await;
        // 空闲 31 分钟 + 无租约，但在途请求还没回来：不回收。
        let now = Instant::now() + Duration::from_secs(31 * 60);
        let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(reaped.is_empty(), "在途请求期间不得回收：{reaped:?}");
        assert_eq!(test_harness::process_count(&state).await, 1);
    }

    #[tokio::test]
    async fn idle_instance_with_a_heartbeat_survives_beyond_thirty_minutes() {
        let _guard = crate::aux_leases::test_lock();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:idle", RuntimePolicy::Aux).await;
        crate::aux_leases::claim(&state, "aux:idle", "client-1")
            .await
            .unwrap();
        // 31 分钟没有用户输入，但只要心跳还在（claims 非空）就不回收。
        let now = Instant::now() + Duration::from_secs(31 * 60);
        assert!(reap_once(&state, now, AUX_IDLE_LIMIT).await.is_empty());
        assert!(crate::rpc::running(&state, Some("aux:idle")).await);
        crate::aux_leases::reset_for_test();
    }

    #[tokio::test]
    async fn busy_or_pending_instances_are_never_reaped() {
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:busy", RuntimePolicy::Aux).await;
        test_harness::install(&state, "aux:ask", RuntimePolicy::Aux).await;
        test_harness::start_agent_run(&state, "aux:busy").await;
        test_harness::raise_ui_request(&state, "aux:ask", "q").await;
        let now = Instant::now() + Duration::from_secs(31 * 60);
        let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(reaped.is_empty(), "活跃流/待答询问期间不得回收：{reaped:?}");
        assert_eq!(test_harness::process_count(&state).await, 2);
    }

    #[tokio::test]
    async fn main_runtimes_are_never_scanned() {
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "main", RuntimePolicy::Main).await;
        let now = Instant::now() + Duration::from_secs(31 * 60);
        assert!(reap_once(&state, now, AUX_IDLE_LIMIT).await.is_empty());
        assert_eq!(test_harness::process_count(&state).await, 1);
    }

    #[tokio::test]
    async fn leases_without_a_process_are_dropped() {
        let _guard = crate::aux_leases::test_lock();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:a", RuntimePolicy::Aux).await;
        crate::aux_leases::claim(&state, "aux:a", "client-1")
            .await
            .expect("进程存活时可领取租约");
        // 模拟"客户端崩溃：进程已消失、release 没发"。
        test_harness::remove(&state, "aux:a").await;
        reap_once(&state, Instant::now(), AUX_IDLE_LIMIT).await;
        assert_eq!(crate::aux_leases::holder_count("aux:a"), 0);
        crate::aux_leases::reset_for_test();
    }
}
