//! aux 的**孤儿回收器**（`docs/aux-chat-spec.md` §5、§11）。
//!
//! 纯兜底：正常路径是"关闭 Tab 即 `rpc_kill` + `aux_release`"。这里只处理漏掉的情况
//! （渲染进程崩溃、远程断连、迟到退出），避免这类实例白占内存（单实例空闲基线约
//! 138MB RSS）。
//!
//! 判定三条件**同时成立**才 kill：
//! 1. `busy == false && pending_ui == 0 && in_flight == 0`（不在流式、没有待答询问、
//!    没有在途请求）；
//! 2. `claims == 0`（没有**未过期**的租约 —— 心跳漏拍后租约过期，claims 归零；
//!    但仅凭过期不会判死，见第 3 条）；
//! 3. `last_user_activity` 距今 > 30 分钟（**用户活动**，不是"最后一次 RPC"）。
//!
//! ## 仲裁（复审 P1-3）
//!
//! 判定与 kill 之间有并发窗口（另一客户端可能刚好 `claim`）。因此 kill 必须先经
//! [`crate::aux_leases::begin_reap`]：在**租约表同一把锁内**复核 holders 为空并置
//! `reaping` 墓碑，之后才放锁 kill。`claim` 在锁内见 `reaping` 即拒绝
//! （`auxLeaseReaping`），所以"日志里 claims=0 但 kill 前被领走"不可能发生。
//!
//! ## 残条清理（复审 P1-3 第二条）
//!
//! 旧实现拿"上一轮 live 快照的差集"当残条，会把扫描期间**新建并 claim** 的实例误删。
//! 现在逐个对**当前实例**复核：只有"当前已不存在该 runtime，或它已退出"才清租约。

use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::rpc::RpcState;
use crate::rpc::{self, aux_probe};
use tauri::Manager;

/// 回收扫描周期。
pub(crate) const REAP_TICK: Duration = Duration::from_secs(60);
/// 空闲阈值：`last_user_activity` 超过它才考虑回收。
pub(crate) const AUX_IDLE_LIMIT: Duration = Duration::from_secs(30 * 60);

/// 三条件判定（纯函数，便于逐条构造反例）。
///
/// 任何一条不成立都**不**回收：活跃流/待答询问/在途请求期间误杀会把用户正在看的回答
/// 掐断；有未过期租约时误杀会让另一个窗口的 Tab 变成死壳。
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
    for runtime_id in aux_probe::aux_runtime_ids(state).await {
        let Some(snapshot) = aux_probe::probe(state, &runtime_id, now).await else {
            continue;
        };
        let claims = crate::aux_leases::holder_count(&runtime_id, now);
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
        // 仲裁：锁内复核 holders 为空 + 置墓碑。返回 false 表示"这一轮不该我杀"。
        if !crate::aux_leases::begin_reap(&runtime_id, now) {
            // 例外：上一轮**已**接管但 kill 没成功（进程仍在）。此时不再记一条回收
            // 日志（避免重复计账），但必须重试 kill，否则那个实例会既无租约又永不被收。
            if crate::aux_leases::is_reaping(&runtime_id) {
                crate::logs::write(
                    "aux-reap",
                    &json!({"runtimeId": runtime_id, "reason": "kill-retry"}).to_string(),
                );
                let _ = rpc::kill(state, Some(&runtime_id)).await;
                crate::aux_leases::forget(&runtime_id);
            }
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
        let _ = rpc::kill(state, Some(&runtime_id)).await;
        crate::aux_leases::forget(&runtime_id);
        reaped.push(entry);
    }
    // 残条：**逐条对当前实例复核**，不用旧快照差集（复审 P1-3 第二条）。
    for runtime_id in crate::aux_leases::lease_runtime_ids(now) {
        if aux_probe::probe(state, &runtime_id, now).await.is_some() {
            // 当前实例仍活着：租约合法（哪怕它刚在本轮扫描之后才建立）。
            continue;
        }
        crate::logs::write(
            "aux-reap",
            &json!({"runtimeId": runtime_id, "reason": "lease-without-process"}).to_string(),
        );
        crate::aux_leases::forget(&runtime_id);
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
    use crate::aux_leases::{AUX_LEASE_TTL, claim_at, holder_count, release_at};
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
        // ② 有未过期租约（任一客户端还在心跳）：不回收。
        assert!(!is_reclaimable(false, 0, 0, 1, idle, AUX_IDLE_LIMIT));
        // ③ 空闲必须**严格**超过 30 分钟（边界值不回收）。
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

    /// **回归 1（复审 P1-1）**：停心跳 → 租约过期 → 空闲超阈 → 回收成功。
    /// 旧实现里租约永不过期，`claims` 恒为 1，这条用例会得到 `reaped=0`。
    #[tokio::test]
    async fn a_crashed_client_lease_expires_and_the_instance_is_reaped() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:crash", RuntimePolicy::Aux).await;
        crate::rpc::aux_probe::set_aux_parent(&state, "aux:crash", Some("main".into())).await;

        // 客户端领取一次租约后就崩溃（不再 claim/release）。
        let t0 = Instant::now();
        claim_at(&state, "aux:crash", "crashed", t0).await.unwrap();
        assert_eq!(holder_count("aux:crash", t0), 1);

        // 注入"空闲一天 + 租约早已过期"。
        let later = t0 + Duration::from_secs(24 * 60 * 60);
        let reaped = reap_once(&state, later, AUX_IDLE_LIMIT).await;
        assert_eq!(reaped.len(), 1, "过期租约不得继续挡住回收：{reaped:?}");
        assert_eq!(reaped[0].runtime_id, "aux:crash");
        assert_eq!(reaped[0].claims, 0, "日志里的 claims 必须是过期后的真实值");
        assert_eq!(reaped[0].parent.as_deref(), Some("main"));
        assert!(reaped[0].idle_secs >= 24 * 60 * 60);
        assert!(!crate::rpc::running(&state, Some("aux:crash")).await);
        assert_eq!(test_harness::process_count(&state).await, 0);
        assert_eq!(holder_count("aux:crash", later), 0);
        crate::aux_leases::reset_for_test();
    }

    /// **回归 2**：持续心跳 → 不过期、不回收（心跳确实续期，而不是"领取一次就永久"）。
    #[tokio::test]
    async fn a_renewing_client_keeps_the_instance_alive_beyond_the_idle_limit() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:beat", RuntimePolicy::Aux).await;
        let t0 = Instant::now();
        let token = claim_at(&state, "aux:beat", "client-1", t0).await.unwrap();
        // 跨过 31 分钟（空闲超阈），每 20s 一次心跳。
        let mut now = t0;
        while now < t0 + Duration::from_secs(31 * 60) {
            now += Duration::from_secs(20);
            let renewed = claim_at(&state, "aux:beat", "client-1", now).await.unwrap();
            assert_eq!(renewed, token, "续期续用同一 token");
        }
        let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(reaped.is_empty(), "持续心跳的实例不得被回收：{reaped:?}");
        assert!(crate::rpc::running(&state, Some("aux:beat")).await);
        crate::aux_leases::reset_for_test();
    }

    /// **回归 4（复审 P1-3）**：两个方向都钉住。
    ///
    /// (a) 判定之后、kill 之前有人 claim：`begin_reap` 在锁内复核 holders，必须拒绝接管，
    ///     因此实例**不会被杀**（这就是旧实现最危险的窗口）。
    /// (b) 接管之后 claim：`auxLeaseReaping` 拒绝，不会出现"日志 claims=0 却带着租约被杀"。
    #[tokio::test]
    async fn the_reap_arbitration_closes_the_claim_window_in_both_directions() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:race", RuntimePolicy::Aux).await;
        let now = Instant::now() + Duration::from_secs(24 * 60 * 60);

        // (a) 探针读到 claims=0 之后，另一客户端 claim 成功 → 仲裁必须放弃接管。
        assert_eq!(holder_count("aux:race", now), 0, "判定时刻确实无租约");
        let _winner = claim_at(&state, "aux:race", "late-client", now)
            .await
            .expect("判定与接管之间仍可领取");
        assert!(
            !crate::aux_leases::begin_reap("aux:race", now),
            "有人刚领了租约，仲裁必须放弃"
        );
        assert!(crate::rpc::running(&state, Some("aux:race")).await, "实例不得被杀");
        // 完整跑一轮扫描：B 的租约未过期 → 不回收（日志与行为一致）。
        let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(reaped.is_empty(), "有未过期租约时不得回收：{reaped:?}");

        // (b) 反过来：先接管，再 claim → 必须被拒。
        crate::aux_leases::reset_for_test();
        let state2 = Arc::new(RpcState::default());
        test_harness::install(&state2, "aux:race2", RuntimePolicy::Aux).await;
        assert!(crate::aux_leases::begin_reap("aux:race2", now), "无租约时可接管");
        let err = claim_at(&state2, "aux:race2", "late-client", now)
            .await
            .expect_err("回收开始后不得再领租约");
        assert!(err.contains("auxLeaseReaping"), "{err}");
        assert_eq!(holder_count("aux:race2", now), 0, "拒绝时不得留下半条租约");
        // 接管的收尾（reap_once 里的同一段）：kill → forget。墓碑保留。
        crate::rpc::kill(&state2, Some("aux:race2")).await.unwrap();
        crate::aux_leases::forget("aux:race2");
        assert!(!crate::rpc::running(&state2, Some("aux:race2")).await);
        // 被回收的 runtime 不得被 claim 复活（墓碑是永久的）。
        let err = claim_at(&state2, "aux:race2", "late-client", now)
            .await
            .expect_err("已回收");
        assert!(err.contains("auxLeaseReaping") || err.contains("auxLeaseDenied"), "{err}");
        crate::aux_leases::reset_for_test();
    }

    /// 多客户端：A 释放、B 仍持有 → 只回收 A 的；B 的实例不被误杀。
    #[tokio::test]
    async fn only_the_instance_without_a_live_lease_is_reaped() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:a", RuntimePolicy::Aux).await;
        test_harness::install(&state, "aux:b", RuntimePolicy::Aux).await;
        crate::rpc::aux_probe::set_aux_parent(&state, "aux:a", Some("main".into())).await;
        crate::rpc::aux_probe::set_aux_parent(&state, "aux:b", Some("main".into())).await;
        let t0 = Instant::now();
        let token_a = claim_at(&state, "aux:a", "client-1", t0).await.unwrap();
        let token_b = claim_at(&state, "aux:b", "client-2", t0).await.unwrap();
        release_at(&state, "aux:a", &token_a, t0).await.unwrap();
        // B 持续心跳到扫描时刻。
        let now = t0 + Duration::from_secs(31 * 60);
        claim_at(&state, "aux:b", "client-2", now).await.unwrap();
        assert_eq!(holder_count("aux:b", now), 1);

        let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert_eq!(reaped.len(), 1, "只回收 A：{reaped:?}");
        assert_eq!(reaped[0].runtime_id, "aux:a");
        assert_eq!(reaped[0].claims, 0);
        assert!(!crate::rpc::running(&state, Some("aux:a")).await);
        assert!(
            crate::rpc::running(&state, Some("aux:b")).await,
            "B 的租约未过期，不得被回收"
        );
        assert_eq!(test_harness::process_count(&state).await, 1);
        let _ = token_b;
        crate::aux_leases::reset_for_test();
    }

    #[tokio::test]
    async fn in_flight_requests_also_block_reclaiming() {
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:inflight", RuntimePolicy::Aux).await;
        test_harness::add_in_flight_request(&state, "aux:inflight").await;
        let now = Instant::now() + Duration::from_secs(31 * 60);
        let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(reaped.is_empty(), "在途请求期间不得回收：{reaped:?}");
        assert_eq!(test_harness::process_count(&state).await, 1);
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

    /// **回归 5（复审 P1-3 第二条）**：扫描开始后新建并 claim 的实例，其租约不得被
    /// "旧 live 快照差集"误删。这里用一个"扫描期间新增"的实例模拟那个窗口。
    #[tokio::test]
    async fn a_newly_claimed_instance_survives_the_stale_lease_sweep() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:old", RuntimePolicy::Aux).await;
        let now = Instant::now();
        claim_at(&state, "aux:old", "c1", now).await.unwrap();

        // 扫描期间：旧实例消失（进程退出、release 没发），同时**新建并 claim** 了一个实例。
        test_harness::remove(&state, "aux:old").await;
        test_harness::install(&state, "aux:new", RuntimePolicy::Aux).await;
        claim_at(&state, "aux:new", "c2", now).await.unwrap();

        reap_once(&state, now, AUX_IDLE_LIMIT).await;
        // 旧残条被清掉；新实例的租约必须完好（它不是"旧快照里没有"的残条）。
        assert_eq!(holder_count("aux:old", now), 0);
        assert_eq!(
            holder_count("aux:new", now),
            1,
            "扫描期间新建并 claim 的实例不得被当成残条"
        );
        assert!(crate::rpc::running(&state, Some("aux:new")).await);
        crate::aux_leases::reset_for_test();
    }

    #[tokio::test]
    async fn leases_without_a_process_are_dropped() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:a", RuntimePolicy::Aux).await;
        let now = Instant::now();
        claim_at(&state, "aux:a", "client-1", now)
            .await
            .expect("进程存活时可领取租约");
        // 模拟"客户端崩溃 + 进程已消失、release 没发"。
        test_harness::remove(&state, "aux:a").await;
        reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert_eq!(holder_count("aux:a", now), 0);
        crate::aux_leases::reset_for_test();
    }

    /// TTL 常量必须 ≥ 3 个心跳（60s），否则一次卡顿就把租约判死。
    #[test]
    fn the_lease_ttl_tolerates_at_least_three_missed_heartbeats() {
        const HEARTBEAT: Duration = Duration::from_secs(20);
        assert!(
            AUX_LEASE_TTL >= HEARTBEAT * 3,
            "TTL {AUX_LEASE_TTL:?} 至少要是 3 个心跳"
        );
    }
}
