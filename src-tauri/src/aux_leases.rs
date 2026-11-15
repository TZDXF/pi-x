//! aux（辅助对话）的**租约**：`aux_claim` / `aux_release` / `aux_list` 的全部逻辑
//! （`docs/aux-chat-spec.md` §5）。
//!
//! 三个命令只做三件事：**写 / 删 / 列**租约。它们
//! - **不**接收 `command`/`extraArgs`，不写 stdin，不改 `policy`，不起进程；
//! - **只**注册为宿主命令（桌面 `lib.rs` + 远程 `dispatch/session.rs`），
//!   **绝不**进 JSONL 白名单 —— `{type:"aux_claim"}` 发到 pi 会被 M0 网关当未知
//!   type 拒绝（`rpc/policy.rs` 的 `aux_rejects_unknown_type`）。
//!
//! 归属语义：租约按 `(runtimeId, clientId)` 记，一个 runtime 可被多个客户端同时持有
//! （分屏/双窗口）。`release` 只删**本客户端**那一条：拿别人的 clientId 来释放会失败
//! （`auxLeaseNotHeld`），因此"伪造归属"删除不了别人的租约。
//!
//! 回收判定（`aux_reap`）要求 `claims` 为空：只要还有任一客户端心跳，实例就不会被
//! 兜底回收 —— 这是"开着空闲 Tab >30 分钟不被回收"的唯一依据。

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;

use crate::errors::pix_error;
use crate::rpc::{self, aux_probe};

/// runtimeId → 持有租约的 clientId 集合。
///
/// 用 `BTreeMap`/`BTreeSet` 而不是 `HashMap`：`aux_list` 的输出必须有稳定顺序，
/// 否则前端"只恢复本机条目"的判据会在测试里变成随机顺序比较。
static LEASES: Mutex<BTreeMap<String, BTreeSet<String>>> = Mutex::new(BTreeMap::new());

fn lock_leases() -> std::sync::MutexGuard<'static, BTreeMap<String, BTreeSet<String>>> {
    LEASES
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 入口校验（两条，顺序固定）：
/// 1. `runtimeId` 必须 `aux:` 前缀（复用 `commands::pi_aux::validate_aux_runtime` 的语义）；
/// 2. 该 runtime 的策略必须是 [`rpc::RuntimePolicy::Aux`]（**Main 拒绝**），且进程存活。
///
/// 第二条不是冗余：单靠前缀无法挡住"把主会话的 runtimeId 手动改成 aux:xxx 再来领租约"，
/// 策略是唯一权威来源（它由 spawn 写入 `ProcessState`，客户端无法翻转）。
/// 校验走 [`aux_probe`] 的只读通道：**不**刷新 `RpcState::last_activity`，
/// 否则 20s 心跳会顺带把 runtime 的活动时钟永久推后。
pub(crate) async fn validate_target(state: &rpc::RpcState, runtime_id: &str) -> Result<(), String> {
    if !runtime_id.starts_with("aux:") {
        return Err(pix_error(
            "auxRuntimeIdInvalid",
            "辅助对话的 runtimeId 必须以 aux: 开头",
        ));
    }
    let policy = aux_probe::policy_of(state, runtime_id).await;
    if policy != Some(rpc::RuntimePolicy::Aux) {
        return Err(pix_error(
            "auxLeaseDenied",
            "该 runtime 不接受辅助对话租约（仅 aux: 前缀且策略为 Aux 的实例）",
        ));
    }
    if !aux_probe::running_quiet(state, runtime_id).await {
        return Err(pix_error("auxLeaseDenied", "该辅助对话进程已退出，无法登记租约"));
    }
    Ok(())
}

/// clientId 校验：只允许非空、有界的标识串（它来自前端模块级随机串，不接受空值）。
fn validate_client_id(client_id: &str) -> Result<(), String> {
    let trimmed = client_id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err(pix_error(
            "auxLeaseClientIdInvalid",
            "租约的 clientId 必须是 1..=128 个字符",
        ));
    }
    Ok(())
}

/// `aux_claim`：登记本客户端对该 runtime 的持有（幂等，心跳重复领取不会报错）。
pub(crate) async fn claim(
    state: &rpc::RpcState,
    runtime_id: &str,
    client_id: &str,
) -> Result<(), String> {
    validate_client_id(client_id)?;
    validate_target(state, runtime_id).await?;
    lock_leases()
        .entry(runtime_id.to_string())
        .or_default()
        .insert(client_id.trim().to_string());
    Ok(())
}

/// `aux_release`：删除**本客户端**那一份租约。
///
/// 不持有就报错（`auxLeaseNotHeld`）而不是静默成功：否则任何客户端都能凭猜到的
/// clientId 把别人的租约删掉，回收器随后就会把一个仍在用的实例当成孤儿。
pub(crate) async fn release(
    state: &rpc::RpcState,
    runtime_id: &str,
    client_id: &str,
) -> Result<(), String> {
    validate_client_id(client_id)?;
    validate_target(state, runtime_id).await?;
    let mut leases = lock_leases();
    let Some(holders) = leases.get_mut(runtime_id) else {
        return Err(pix_error("auxLeaseNotHeld", "本客户端不持有该租约"));
    };
    if !holders.remove(client_id.trim()) {
        return Err(pix_error("auxLeaseNotHeld", "本客户端不持有该租约"));
    }
    if holders.is_empty() {
        leases.remove(runtime_id);
    }
    Ok(())
}

/// `aux_list`：列出所有租约条目。
///
/// 每条都带 `parentRuntimeId`（前端第 4 条重连过滤要用：只恢复
/// `clientId == 本机 && parentRuntimeId 在本地注册表` 的条目）。父会话未知的条目
/// 也返回（`null`），由前端丢弃 —— 后端不替前端决定"哪些父会话还算本地"。
///
/// 只列活着的 aux runtime：进程已退出但租约残留（客户端崩溃、没发 release）不该
/// 出现在列表里，那种残条由回收器连带清掉（`forget`）。
pub(crate) fn entries(state_data: &[(String, Option<String>)]) -> Vec<Value> {
    let leases = lock_leases();
    let mut result = Vec::new();
    for (runtime_id, parent_runtime) in state_data {
        let Some(holders) = leases.get(runtime_id) else {
            continue;
        };
        for client_id in holders {
            result.push(json!({
                "runtimeId": runtime_id,
                "parentRuntimeId": parent_runtime,
                "clientId": client_id,
            }));
        }
    }
    result
}

/// 持有该 runtime 的客户端数（回收判据"`claims` 为空"与日志用）。
pub(crate) fn holder_count(runtime_id: &str) -> usize {
    lock_leases()
        .get(runtime_id)
        .map_or(0, BTreeSet::len)
}

/// 当前仍有租约的 runtime id 快照（回收器清残条用）。
pub(crate) fn runtime_ids() -> Vec<String> {
    lock_leases().keys().cloned().collect()
}

/// 丢弃某个 runtime 的全部租约（进程退出/被 kill/被回收时调用）。
///
/// 单靠客户端 `release` 不可靠：关闭窗口、崩溃、远程断连都会漏发，残留租约会让
/// 列表一直显示一个早已不存在的实例。
pub(crate) fn forget(runtime_id: &str) {
    lock_leases().remove(runtime_id);
}

/// 清空全部租约（应用退出时 `rpc::kill_all` 一并清，避免下次启动读到残条）。
pub(crate) fn clear() {
    lock_leases().clear();
}

/// 测试隔离用。
#[cfg(test)]
pub(crate) fn reset_for_test() {
    clear();
}

/// 测试串行锁：`LEASES` 是进程级全局状态，而 `cargo test` 默认并行跑用例。
/// 凡是动租约的用例（本模块与 `aux_reap`）都要先拿这把锁，否则一个用例的
/// `clear()` 会把另一个用例刚领的租约抹掉（表现为随机失败）。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    TEST_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::rpc::test_harness;
    use crate::rpc::RuntimePolicy;

    #[tokio::test]
    async fn claim_rejects_non_aux_prefix_main_policy_and_dead_runtimes() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:live", RuntimePolicy::Aux).await;
        test_harness::install(&state, "main", RuntimePolicy::Main).await;

        // ① runtimeId 前缀：复用 `commands::pi_aux::validate_aux_runtime` 的语义。
        let err = claim(&state, "main", "c1").await.expect_err("前缀不对");
        assert!(err.contains("auxRuntimeIdInvalid"), "{err}");
        // ② 策略必须是 Aux：`aux:` 前缀但策略为 Main 也拒绝（前缀不是权威来源）。
        test_harness::install(&state, "aux:main-policy", RuntimePolicy::Main).await;
        let err = claim(&state, "aux:main-policy", "c1")
            .await
            .expect_err("Main 策略");
        assert!(err.contains("auxLeaseDenied"), "{err}");
        // 不存在的 runtime 同样拒绝（不能凭一个字符串就登记租约）。
        let err = claim(&state, "aux:missing", "c1")
            .await
            .expect_err("runtime 不存在");
        assert!(err.contains("auxLeaseDenied"), "{err}");
        // 合法调用成功。
        claim(&state, "aux:live", "c1").await.expect("aux + 存活即合法");
        assert_eq!(holder_count("aux:live"), 1);
        reset_for_test();
    }

    #[tokio::test]
    async fn a_forged_client_id_cannot_release_someone_elses_lease() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:shared", RuntimePolicy::Aux).await;
        claim(&state, "aux:shared", "owner").await.unwrap();
        // 猜到的 clientId（别人）来释放：必须失败，且原租约完好。
        let err = release(&state, "aux:shared", "intruder")
            .await
            .expect_err("伪造归属必须失败");
        assert!(err.contains("auxLeaseNotHeld"), "{err}");
        assert_eq!(holder_count("aux:shared"), 1);
        // 真正持有者释放：成功；重复释放：失败（不再持有）。
        release(&state, "aux:shared", "owner").await.unwrap();
        assert_eq!(holder_count("aux:shared"), 0);
        let err = release(&state, "aux:shared", "owner")
            .await
            .expect_err("已不持有");
        assert!(err.contains("auxLeaseNotHeld"), "{err}");
        reset_for_test();
    }

    #[tokio::test]
    async fn claim_is_idempotent_and_never_writes_stdin_or_activity_clock() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        let (_process, mut rx) =
            test_harness::install_with_queue(&state, "aux:idem", RuntimePolicy::Aux).await;
        for _ in 0..3 {
            claim(&state, "aux:idem", "c1").await.unwrap();
        }
        assert_eq!(holder_count("aux:idem"), 1, "心跳重复领取只算一份");
        // 三件事之外什么都没发生：不写 stdin、不刷新池级活动时钟。
        assert!(rx.try_recv().is_err(), "租约命令不得向 pi 写入任何命令");
        assert!(
            state.last_activity.lock().await.is_empty(),
            "租约命令不得刷新 RpcState::last_activity（否则回收永远不成立）"
        );
        reset_for_test();
    }

    #[tokio::test]
    async fn entries_reuse_the_live_processes_but_only_for_leased_runtimes() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:one", RuntimePolicy::Aux).await;
        test_harness::install(&state, "aux:two", RuntimePolicy::Aux).await;
        crate::rpc::aux_probe::set_aux_parent(&state, "aux:one", Some("main".into())).await;
        claim(&state, "aux:one", "c1").await.unwrap();
        let parents = crate::rpc::aux_probe::aux_runtime_parents(&state).await;
        let list = entries(&parents);
        assert_eq!(list.len(), 1, "没有租约的 aux:two 不出现");
        assert_eq!(list[0]["runtimeId"], "aux:one");
        assert_eq!(
            list[0]["parentRuntimeId"], "main",
            "重连过滤要用 parentRuntimeId"
        );
        assert_eq!(list[0]["clientId"], "c1");
        // `aux_list` 的只读性质：列出不刷新池级活动时钟、不写 stdin。
        assert!(state.last_activity.lock().await.is_empty());
        // 前面调用的 `install_with_queue` 已丢弃 rx；这里只要断言"没有写到 pipe"，
        // 用 `aux_runtime_parents` 的只读路径本身（它不碰 stdin）即可。
        reset_for_test();
    }

    #[test]
    fn client_id_must_be_non_empty_and_bounded() {
        assert!(validate_client_id("abc").is_ok());
        for bad in ["", "   ", &"x".repeat(129)] {
            let err = validate_client_id(bad).expect_err("must reject");
            assert!(err.contains("auxLeaseClientIdInvalid"), "{err}");
        }
    }

    #[test]
    fn holder_count_and_entries_follow_the_book() {
        let _guard = test_lock();
        reset_for_test();
        lock_leases()
            .entry("aux:a".into())
            .or_default()
            .extend(["c1".to_string(), "c2".to_string()]);
        assert_eq!(holder_count("aux:a"), 2);
        assert_eq!(holder_count("aux:b"), 0);
        let list = entries(&[("aux:a".to_string(), Some("main".into()))]);
        assert_eq!(list.len(), 2);
        // 稳定顺序：clientId 升序，便于断言与前端去重。
        assert_eq!(list[0]["clientId"], "c1");
        assert_eq!(list[1]["clientId"], "c2");
        assert_eq!(list[0]["parentRuntimeId"], "main");
        // 没有租约的 runtime 不出现在列表里。
        assert!(entries(&[("aux:b".to_string(), Some("main".into()))]).is_empty());
        forget("aux:a");
        assert_eq!(holder_count("aux:a"), 0);
        reset_for_test();
    }

    #[test]
    fn entries_carry_a_null_parent_when_the_child_has_no_recorded_parent() {
        let _guard = test_lock();
        reset_for_test();
        lock_leases()
            .entry("aux:a".into())
            .or_default()
            .insert("c1".into());
        let list = entries(&[("aux:a".to_string(), None)]);
        assert_eq!(list[0]["parentRuntimeId"], Value::Null);
        reset_for_test();
    }
}
