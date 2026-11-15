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

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::rpc::aux_probe;
use crate::rpc::ProcessState;
use crate::rpc::RpcState;
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

/// 回收器自持的"待重试 kill 句柄"（`runtimeId → Arc<ProcessState>`）。
///
/// 为什么需要它：`rpc::kill` 先摘池条目再杀，杀失败也回 `Ok`；上一版回收器因此
/// 直接把失败当成功（`forget` + `Reaped` + 一轮日志），第二轮再也找不到该 runtime
/// （复审第二轮 P1-1）。现在：**失败保留句柄、下一轮继续尝试、不 push `Reaped`**，
/// 只有"kill 成功 且 `running()` 为假"才 `retire_entry` + 记 `Reaped`。
///
/// 代价：句柄是 `Arc<ProcessState>`，句柄在手时进程即使被判"已退出"也不会被
/// 池回收 —— 但待重试表只增不减的话会泄漏，因此确认退出后必须移除。
/// 待重试的一条：句柄 + **判定当时的日志字段**。
///
/// 为什么要带字段：确认退出后进程已消失，`probe` 再也取不到 parent/idle，若这时才
/// 读，回收日志会退化成 `parent=null, idleSecs=0` —— 与首轮日志不一致，复盘时就
/// 看不出"它当时到底空闲多久"。
struct PendingKill {
    handle: Arc<ProcessState>,
    parent: Option<String>,
    idle_secs: u64,
    /// 已经尝试过几次 kill（首轮 1，重试递增）。日志带出来，避免"无 result 的判定行"
    /// 被读成已回收（复审第三轮的观感问题）。
    attempts: u32,
}

static PENDING_KILLS: Mutex<BTreeMap<String, PendingKill>> = Mutex::new(BTreeMap::new());

fn lock_pending() -> std::sync::MutexGuard<'static, BTreeMap<String, PendingKill>> {
    PENDING_KILLS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 清空待重试登记表（应用退出/测试隔离）。句柄清掉后由 `kill_on_drop` 兜底。
pub(crate) fn clear_pending_kills() {
    lock_pending().clear();
}

/// 该 runtime 是否在待重试登记表里（回归用例与诊断用；生产路径不需要）。
#[cfg(test)]
pub(crate) fn pending_kill_ids() -> Vec<String> {
    lock_pending().keys().cloned().collect()
}

/// 一次 kill 尝试的结果（回归用例按它断言"没算作已回收"）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub enum KillOutcome {
    /// 已确认退出：可以 `retire_entry` + 记 `Reaped`。
    Exited,
    /// kill 失败或退出未确认：保留句柄，下一轮重试。
    RetryPending,
}

/// 对一个自持句柄做一次 kill，并判定是否**确认退出**。
///
/// 判据是"`process_kill` 成功（或进程已被别的路径杀掉）**且** `running()` 为假"。
/// 只用 `process_kill` 的 `Ok` 不够：Windows 上 taskkill 非零退出会被底层记日志后
/// 转成 `Ok`（见 `child::kill_inner`），因此必须再验一次存活。
async fn try_kill(handle: &Arc<ProcessState>) -> KillOutcome {
    match aux_probe::kill_handle(handle, "aux-reap").await {
        Ok(()) => {
            if aux_probe::running_handle(handle).await {
                KillOutcome::RetryPending
            } else {
                KillOutcome::Exited
            }
        }
        Err(_) => KillOutcome::RetryPending,
    }
}

/// 扫一遍并回收（返回本次**确认回收**的条目；失败重试不计入）。
///
/// `now`/`idle_limit` 由调用方给：生产路径用 `Instant::now()` + [`AUX_IDLE_LIMIT`]，
/// 单测可以注入"已经空闲 31 分钟"而不必真等半小时。
pub(crate) async fn reap_once(
    state: &RpcState,
    now: Instant,
    idle_limit: Duration,
) -> Vec<Reaped> {
    let mut reaped = Vec::new();

    // ---- 0) 先处理上一轮失败的待重试句柄 ----
    //
    // 这一步必须在"扫池"之前：上一轮已经 `begin_reap` 接管，池里可能已被
    // `rpc::kill` 摘掉（旧路径），只有这张表还留着句柄。
    let retries: Vec<(String, PendingKill)> = {
        let pending = lock_pending();
        pending
            .iter()
            .map(|(id, entry)| {
                (
                    id.clone(),
                    PendingKill {
                        handle: Arc::clone(&entry.handle),
                        parent: entry.parent.clone(),
                        idle_secs: entry.idle_secs,
                        attempts: entry.attempts + 1,
                    },
                )
            })
            .collect()
    };
    for (runtime_id, entry) in retries {
        let outcome = try_kill(&entry.handle).await;
        match outcome {
            KillOutcome::Exited => {
                let reaped_entry = Reaped {
                    runtime_id: runtime_id.clone(),
                    parent: entry.parent.clone(),
                    claims: 0,
                    idle_secs: entry.idle_secs,
                };
                aux_probe::retire_entry(state, &runtime_id).await;
                lock_pending().remove(&runtime_id);
                let mut line = reaped_entry.to_json();
                line["reason"] = json!("kill-retry");
                line["result"] = json!("exited");
                line["attempts"] = json!(entry.attempts + 1);
                crate::logs::write("aux-reap", &line.to_string());
                reaped.push(reaped_entry);
            }
            KillOutcome::RetryPending => {
                crate::logs::write(
                    "aux-reap",
                    &json!({
                        "runtimeId": runtime_id,
                        "reason": "kill-retry",
                        "result": "pending",
                        "attempts": entry.attempts + 1,
                    })
                    .to_string(),
                );
            }
        }
    }

    // ---- 1) 常规扫描 ----
    for runtime_id in aux_probe::aux_runtime_ids(state).await {
        // 已在待重试表里的不重复走判定（上一轮已接管，本轮已在第 0 步重试过）。
        if lock_pending().contains_key(&runtime_id) {
            continue;
        }
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
        // 仲裁：锁内复核 holders 为空 + 置墓碑。返回 false 表示"这一轮不该我杀"
        // （别人刚续上，或已被上一次扫描接管 —— 后者由第 0 步处理）。
        if !crate::aux_leases::begin_reap(&runtime_id, now) {
            continue;
        }
        let Some(handle) = aux_probe::process_handle(state, &runtime_id).await else {
            continue;
        };
        let entry = Reaped {
            runtime_id: runtime_id.clone(),
            parent: snapshot.parent_runtime.clone(),
            claims,
            idle_secs: snapshot.idle.as_secs(),
        };
        // 日志留痕：parent / claims / idle 秒数（规格 §5 的判定三条件），再加探针
        // 的三个瞬时值，便于事后复盘"为什么这条被回收/没被回收"。
        // 判定快照：显式标 `eligible: true` / `attempt: 1` / `result: "pending"`，
        // 免得"没有 result 的判定行"被审计读成"已经回收了"（复审第三轮第 4 条）。
        let mut line = entry.to_json();
        line["probe"] = snapshot.to_json();
        line["eligible"] = json!(true);
        line["attempt"] = json!(1);
        line["result"] = json!("pending");
        crate::logs::write("aux-reap", &line.to_string());
        match try_kill(&handle).await {
            KillOutcome::Exited => {
                aux_probe::retire_entry(state, &runtime_id).await;
                lock_pending().remove(&runtime_id);
                reaped.push(entry);
            }
            KillOutcome::RetryPending => {
                // **不算已回收**：句柄留在登记表，下一轮继续尝试。
                lock_pending().insert(
                    runtime_id.clone(),
                    PendingKill {
                        handle: Arc::clone(&handle),
                        parent: entry.parent.clone(),
                        idle_secs: entry.idle_secs,
                        attempts: 1,
                    },
                );
                crate::logs::write(
                    "aux-reap",
                    &json!({"runtimeId": runtime_id, "reason": "kill-retry", "result": "pending"})
                        .to_string(),
                );
            }
        }
    }

    // ---- 2) 残条：逐条对当前实例复核（不用旧快照差集） ----
    for runtime_id in crate::aux_leases::lease_runtime_ids(now) {
        if lock_pending().contains_key(&runtime_id) {
            // 待重试的实例仍有租约残条：由第 0 步收尾，这里不动。
            continue;
        }
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
        claim_at(&state, "aux:crash", "crashed", None, t0).await.unwrap();
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
        let token = claim_at(&state, "aux:beat", "client-1", None, t0).await.unwrap();
        // 跨过 31 分钟（空闲超阈），每 20s 一次心跳（带 token 续租）。
        let mut now = t0;
        while now < t0 + Duration::from_secs(31 * 60) {
            now += Duration::from_secs(20);
            let renewed = claim_at(&state, "aux:beat", "client-1", Some(&token), now)
                .await
                .unwrap();
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
        let _winner = claim_at(&state, "aux:race", "late-client", None, now)
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
        let err = claim_at(&state2, "aux:race2", "late-client", None, now)
            .await
            .expect_err("回收开始后不得再领租约");
        assert!(err.contains("auxLeaseReaping"), "{err}");
        assert_eq!(holder_count("aux:race2", now), 0, "拒绝时不得留下半条租约");
        // 接管的收尾（reap_once 里的同一段）：kill → 确认退出 → retire。
        let handle = aux_probe::process_handle(&state2, "aux:race2").await.unwrap();
        assert_eq!(try_kill(&handle).await, KillOutcome::Exited);
        aux_probe::retire_entry(&state2, "aux:race2").await;
        assert!(!crate::rpc::running(&state2, Some("aux:race2")).await);
        // 被回收的 runtime 不得被 claim 复活（墓碑是永久的）。
        let err = claim_at(&state2, "aux:race2", "late-client", None, now)
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
        let token_a = claim_at(&state, "aux:a", "client-1", None, t0).await.unwrap();
        let token_b = claim_at(&state, "aux:b", "client-2", None, t0).await.unwrap();
        release_at(&state, "aux:a", &token_a, t0).await.unwrap();
        // B 持续心跳到扫描时刻（带自己的 token）。
        let now = t0 + Duration::from_secs(31 * 60);
        claim_at(&state, "aux:b", "client-2", Some(&token_b), now).await.unwrap();
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

    /// **复审第二轮 P1-1 的故障注入回归**：一次 kill 失败 → 连扫两轮必须
    /// `attempts≥2`、`reaped=0`、实例仍在待重试登记表；恢复注入后下一轮才 `reaped=1`。
    ///
    /// 质量工程师上一轮用同一注入得到 `attempts=1, alive=true, pool=0, reaping=true,
    /// first_reported=1, next_reported=0` —— 本用例正对着它。
    #[tokio::test]
    async fn a_failed_kill_is_retried_and_only_counted_once_the_process_is_gone() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:stuck", RuntimePolicy::Aux).await;
        crate::rpc::aux_probe::set_aux_parent(&state, "aux:stuck", Some("main".into())).await;
        let now = Instant::now() + Duration::from_secs(31 * 60);

        // 第一次 kill 注入失败：判定通过，但收尾不算数。
        crate::rpc::aux_probe::fail_next_kills(1);
        let first = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(first.is_empty(), "kill 失败不得计入回收：{first:?}");
        assert!(
            test_harness::process_count(&state).await >= 1,
            "失败后实例必须留在池/句柄里（旧实现这里 pool=0，重试就再也找不到）"
        );
        assert!(
            crate::rpc::running(&state, Some("aux:stuck")).await,
            "进程仍活着（注入不是真杀）"
        );
        assert_eq!(
            pending_kill_ids(),
            vec!["aux:stuck".to_string()],
            "失败实例必须进待重试登记表"
        );

        // 第二次扫描：注入已耗尽，应真的杀掉并计入回收。
        let second = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert_eq!(second.len(), 1, "第二轮确认退出后才算回收：{second:?}");
        assert_eq!(second[0].runtime_id, "aux:stuck");
        assert!(
            !crate::rpc::running(&state, Some("aux:stuck")).await,
            "确认退出后进程必须消失"
        );
        assert!(pending_kill_ids().is_empty(), "确认退出后必须移出待重试表");
        assert_eq!(test_harness::process_count(&state).await, 0);

        // 两轮合计：attempts ≥ 2、reaped 合计 1（不是"第一次就记 1"）。
        let reaped_total = first.len() + second.len();
        assert_eq!(reaped_total, 1);
        crate::rpc::aux_probe::clear_kill_failures();
        crate::aux_leases::reset_for_test();
    }

    /// **复审第四轮 P1-2 的回归**：OS 终止调用"返回成功但进程没死"（确认超时）时
    /// 回收器必须 `reported=0, pending=1, pool=1`；恢复后下一轮 `reported=1, pending=0`。
    ///
    /// 质量实测的 `os_alive=true, inner_none=true, reported=1, pending=0, pool=0` 必须翻转。
    #[tokio::test]
    async fn an_unconfirmed_os_kill_is_not_counted_as_reaped() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:os", RuntimePolicy::Aux).await;
        let now = Instant::now() + Duration::from_secs(31 * 60);

        // seam：跳过真实 taskkill + 极短确认超时 → kill_inner 走"确认超时"分支。
        crate::rpc::aux_probe::simulate_unconfirmed_kill(50);
        let first = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(first.is_empty(), "未确认退出不得计入回收：{first:?}");
        assert_eq!(pending_kill_ids(), vec!["aux:os".to_string()], "必须进待重试表");
        assert!(
            test_harness::process_count(&state).await >= 1,
            "进程仍在池里/句柄里（旧实现这里是 pool=0）"
        );
        assert!(
            crate::rpc::aux_probe::running_handle(
                &aux_probe::process_handle(&state, "aux:os").await.unwrap()
            )
            .await,
            "OS 层进程仍然活着"
        );

        // 恢复真实终止路径：下一轮才能确认退出并计入回收。
        crate::rpc::aux_probe::clear_kill_failures();
        let second = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert_eq!(second.len(), 1, "恢复后才算回收：{second:?}");
        assert!(pending_kill_ids().is_empty(), "确认退出后移出待重试表");
        assert_eq!(test_harness::process_count(&state).await, 0);
        crate::aux_leases::reset_for_test();
    }

    /// 连续多轮失败：始终不 push `Reaped`、始终保留句柄，直到某轮成功。
    #[tokio::test]
    async fn repeated_kill_failures_never_report_a_reap() {
        let _guard = crate::aux_leases::test_lock();
        crate::aux_leases::reset_for_test();
        crate::rpc::aux_probe::clear_kill_failures();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:stuck2", RuntimePolicy::Aux).await;
        let now = Instant::now() + Duration::from_secs(31 * 60);
        crate::rpc::aux_probe::fail_next_kills(3);
        for round in 1..=3 {
            let reaped = reap_once(&state, now, AUX_IDLE_LIMIT).await;
            assert!(reaped.is_empty(), "第 {round} 轮失败不得计入回收：{reaped:?}");
            assert_eq!(pending_kill_ids(), vec!["aux:stuck2".to_string()]);
        }
        let last = reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert_eq!(last.len(), 1, "第 4 轮成功才计入：{last:?}");
        assert!(pending_kill_ids().is_empty());
        crate::rpc::aux_probe::clear_kill_failures();
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
        claim_at(&state, "aux:old", "c1", None, now).await.unwrap();

        // 扫描期间：旧实例消失（进程退出、release 没发），同时**新建并 claim** 了一个实例。
        test_harness::remove(&state, "aux:old").await;
        test_harness::install(&state, "aux:new", RuntimePolicy::Aux).await;
        claim_at(&state, "aux:new", "c2", None, now).await.unwrap();

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
        claim_at(&state, "aux:a", "client-1", None, now)
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
