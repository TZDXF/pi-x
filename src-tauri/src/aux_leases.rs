//! aux（辅助对话）的**租约**：`aux_claim` / `aux_release` / `aux_list` 的全部逻辑
//! （`docs/aux-chat-spec.md` §5、§11）。
//!
//! 三个命令只做三件事：**写 / 删 / 列**租约。它们
//! - **不**接收 `command`/`extraArgs`，不写 stdin，不改 `policy`，不起进程；
//! - **只**注册为宿主命令（桌面 `lib.rs` + 远程 `dispatch/session.rs`），
//!   **绝不**进 JSONL 白名单 —— `{type:"aux_claim"}` 发到 pi 会被 M0 网关当未知
//!   type 拒绝（`rpc/policy.rs` 的 `aux_rejects_unknown_type`）。
//!
//! ## 三条不变量（修订后的口径）
//!
//! 1. **租约带续租时间与过期**。每条租约是 `(clientId → { token, renewedAt })`，
//!    TTL = [`AUX_LEASE_TTL`]（90s = 4.5 个 20s 心跳）。心跳即续期；过期条目在
//!    `claim`/`list`/`reap` **任一入口惰性清理**。停跳（客户端崩溃、远程断连、
//!    App 被节流/系统睡眠）后租约最多 TTL 就失效 —— 这是"孤儿回收"能真正成立的
//!    前提：没有过期，`claims` 永远非空，回收器等于空转。
//! 2. **clientId 不是凭证**。`claim` 由服务端生成 lease token 并返回；`release`
//!    必须出示 token（只有持有它的那次 `claim` 调用拿到了它，`aux_list` 从不回
//!    token）。因此"抄 list 里的 clientId 去释放别人的租约"必然失败。
//!    `clientId` 只用于**标识**（`aux_list` 的重连过滤，规格 §5 第 4 条）。
//! 3. **判定与 kill 有仲裁**。回收器先在锁内复核 holders 为空、置 `reaping`
//!    墓碑，再放锁 kill。墓碑是**该 runtime 的永久标记**（runtimeId 是一实例一个
//!    UUID，永不复用），因此 `claim` 在回收开始后不可能再把租约写回去。
//!
//! ## 心跳漏拍（节流/睡眠）时的行为
//!
//! 过期只做一件事：让该条目从租约表消失，于是 `claims` 归零。**它不会直接判死
//! 实例** —— 回收仍要另外两个条件（`busy/pending_ui/in_flight` 全空，且
//! `last_user_activity` 距今 > 30 分钟）。所以：
//! - 系统睡眠 10 分钟再醒来：租约过期，但空闲门槛还差 20 分钟；前端心跳恢复后
//!   重新 `claim`（同一 clientId 若条目还在则续用原 token，否则新签发一个），
//!   `claims` 立刻回到 1，实例毫发无损。
//! - 真正睡过 30 分钟以上：即便租约过期，回收器也不会因为"过期"而误杀 —— 它按
//!   三条件判定，用户的 Tab 早已没有活动，回收是正确的（且下次打开是全新实例，
//!   符合"关闭即销毁、不保存历史"的规格）。

use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::errors::pix_error;
use crate::rpc::{self, aux_probe};

/// 租约 TTL（续租有效期）。心跳 20s → TTL 必须 ≥ 3 个心跳（60s），否则一次
/// 卡顿就把租约判死；取 **90s = 4.5 个心跳**，容忍连续漏 2–3 拍。
pub(crate) const AUX_LEASE_TTL: Duration = Duration::from_secs(90);

/// 一条租约：服务端生成的 token + 最后一次续租时刻。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Lease {
    token: String,
    renewed_at: Instant,
}

/// 租约表 + 回收墓碑。
///
/// `leases` 用 `BTreeMap`/`BTreeMap` 而不是 `HashMap`：`aux_list` 的输出必须有稳定
/// 顺序，否则前端"只恢复本机条目"的判据会在测试里变成随机顺序比较。
#[derive(Default)]
struct Book {
    leases: BTreeMap<String, BTreeMap<String, Lease>>,
    /// 已被回收器接管的 runtimeId（永久墓碑；见模块文档第 3 条）。
    reaping: BTreeSet<String>,
}

impl Book {
    const fn new() -> Self {
        Self {
            leases: BTreeMap::new(),
            reaping: BTreeSet::new(),
        }
    }
}

static BOOK: Mutex<Book> = Mutex::new(Book::new());

fn lock_book() -> std::sync::MutexGuard<'static, Book> {
    BOOK.lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn new_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// 惰性清理：删掉所有 `renewed_at` 已超过 TTL 的租约（连同变空的 runtime 条目）。
///
/// 三个入口（`claim` / `entries` / `reap`）都在锁内先调它，因此"停心跳 → 过期"
/// 不需要额外定时器。
fn expire_at(book: &mut Book, now: Instant) -> usize {
    let mut removed = 0;
    let ids: Vec<String> = book.leases.keys().cloned().collect();
    for id in ids {
        let Some(holders) = book.leases.get_mut(&id) else {
            continue;
        };
        let expired: Vec<String> = holders
            .iter()
            .filter(|(_, lease)| now.saturating_duration_since(lease.renewed_at) >= AUX_LEASE_TTL)
            .map(|(client_id, _)| client_id.clone())
            .collect();
        for client_id in expired {
            holders.remove(&client_id);
            removed += 1;
        }
        if holders.is_empty() {
            book.leases.remove(&id);
        }
    }
    removed
}

/// 入口校验（两条，顺序固定）：
/// 1. `runtimeId` 必须 `aux:` 前缀（复用 `commands::pi_aux::validate_aux_runtime` 的语义）；
/// 2. 该 runtime 的策略必须是 [`rpc::RuntimePolicy::Aux`]（**Main 拒绝**），且进程存活。
///
/// 第二条不是冗余：单靠前缀无法挡住"把主会话的 runtimeId 手动改成 aux:xxx 再来领租约"，
/// 策略是唯一权威来源（它由 spawn 写入 `ProcessState`，客户端无法翻转）。
/// 校验走 [`aux_probe`] 的只读通道：**不**刷新 `RpcState::last_activity`，
/// 否则 20s 心跳会顺带把 runtime 的活动时钟永久推后。
///
/// 注意：**不在持锁期间 `await`**。这三条校验在锁外完成，随后只在同步的临界区里
/// 读写租约表（`std::sync::Mutex` 的 guard 绝不跨 `.await`）。
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

/// `aux_claim`：登记/续期本客户端对该 runtime 的持有，返回**服务端签发的 lease token**。
///
/// 幂等：心跳重复调用不会新增条目；同一 clientId 在条目仍有效时**续用原 token**
/// （页面重载后心跳拿回同一个 token，关闭时仍能 `release`）。条目已过期或被回收后
/// 再领取会签发新 token（旧 token 自然失效，因为对应条目已不存在）。
pub(crate) async fn claim(
    state: &rpc::RpcState,
    runtime_id: &str,
    client_id: &str,
) -> Result<String, String> {
    claim_at(state, runtime_id, client_id, Instant::now()).await
}

/// 同 [`claim`]，可注入"现在"（过期/TTL 边界测试用，不必真等 90s）。
pub(crate) async fn claim_at(
    state: &rpc::RpcState,
    runtime_id: &str,
    client_id: &str,
    now: Instant,
) -> Result<String, String> {
    validate_client_id(client_id)?;
    validate_target(state, runtime_id).await?;
    let client_id = client_id.trim().to_string();
    let mut book = lock_book();
    // ① 惰性清理过期租约（停心跳的客户端在这里被摘掉，claims 随之为 0）。
    expire_at(&mut book, now);
    // ② 回收仲裁：已被回收器接管（墓碑命中）就不再接受新租约。
    //    这一步必须在锁内、且在"复核 holders 为空"之后 —— 与 `begin_reap` 互斥。
    if book.reaping.contains(runtime_id) {
        return Err(pix_error(
            "auxLeaseReaping",
            "该辅助对话实例正在被回收，暂不接受新租约",
        ));
    }
    let holders = book.leases.entry(runtime_id.to_string()).or_default();
    let lease = holders.entry(client_id).or_insert_with(|| Lease {
        token: new_token(),
        renewed_at: now,
    });
    lease.renewed_at = now;
    Ok(lease.token.clone())
}

/// `aux_release`：按 **lease token** 删除本客户端的租约。
///
/// 只认 token、不认 clientId：`aux_list` 会公开所有 clientId，若拿它当凭证，
/// 任何能看到列表的客户端都能把别人正在用的实例变成"孤儿"（复审 P1-2）。
///
/// 不做 `validate_target`：进程可能已经退出（用户刚关了 Tab 或崩溃），此时仍需把
/// 残租约清掉。只校验 token 本身 —— 不存在/不匹配一律 `auxLeaseNotHeld`。
pub(crate) async fn release(
    state: &rpc::RpcState,
    runtime_id: &str,
    lease_token: &str,
) -> Result<(), String> {
    release_at(state, runtime_id, lease_token, Instant::now()).await
}

/// 同 [`release`]，可注入"现在"。
pub(crate) async fn release_at(
    _state: &rpc::RpcState,
    runtime_id: &str,
    lease_token: &str,
    now: Instant,
) -> Result<(), String> {
    let token = lease_token.trim();
    if token.is_empty() {
        return Err(pix_error("auxLeaseNotHeld", "本客户端不持有该租约"));
    }
    let mut book = lock_book();
    expire_at(&mut book, now);
    let Some(holders) = book.leases.get_mut(runtime_id) else {
        return Err(pix_error("auxLeaseNotHeld", "本客户端不持有该租约"));
    };
    let owner = holders
        .iter()
        .find(|(_, lease)| lease.token == token)
        .map(|(client_id, _)| client_id.clone());
    let Some(owner) = owner else {
        return Err(pix_error("auxLeaseNotHeld", "本客户端不持有该租约"));
    };
    holders.remove(&owner);
    if holders.is_empty() {
        book.leases.remove(runtime_id);
    }
    Ok(())
}

/// `aux_list`：列出**未过期**的租约条目。
///
/// 每条带 `parentRuntimeId`（前端第 4 条重连过滤要用：只恢复
/// `clientId == 本机 && parentRuntimeId 在本地注册表` 的条目）。父会话未知的条目
/// 也返回（`null`），由前端丢弃 —— 后端不替前端决定"哪些父会话还算本地"。
///
/// **不返回 token**：token 只能由那次 `claim` 的调用方持有。
pub(crate) fn entries(
    state_data: &[(String, Option<String>)],
    now: Instant,
) -> Vec<Value> {
    let mut book = lock_book();
    expire_at(&mut book, now);
    let mut result = Vec::new();
    for (runtime_id, parent_runtime) in state_data {
        let Some(holders) = book.leases.get(runtime_id) else {
            continue;
        };
        for client_id in holders.keys() {
            result.push(json!({
                "runtimeId": runtime_id,
                "parentRuntimeId": parent_runtime,
                "clientId": client_id,
            }));
        }
    }
    result
}

/// 持有该 runtime 的**未过期**租约数（回收判据"`claims` 为空"与日志用）。
pub(crate) fn holder_count(runtime_id: &str, now: Instant) -> usize {
    let mut book = lock_book();
    expire_at(&mut book, now);
    book.leases.get(runtime_id).map_or(0, BTreeMap::len)
}

/// 回收仲裁：锁内复核 holders 为空 → 置 `reaping` 墓碑。返回是否接管成功。
///
/// 与 [`claim`] 用**同一把锁**：因此"回收判定"和"客户端 claim"不会交错出一个
/// "刚判定为空、kill 前又被领走"的窗口（复审 P1-3）。返回 `false` 表示：
/// - 还有未过期的持有者（不要 kill），或
/// - 已经被上一次扫描接管（幂等，跳过）。
pub(crate) fn begin_reap(runtime_id: &str, now: Instant) -> bool {
    let mut book = lock_book();
    expire_at(&mut book, now);
    if book.reaping.contains(runtime_id) {
        return false;
    }
    if book
        .leases
        .get(runtime_id)
        .is_some_and(|holders| !holders.is_empty())
    {
        return false;
    }
    book.reaping.insert(runtime_id.to_string());
    true
}

/// 回收收尾（kill 之后调用）：忘掉该 runtime 的全部租约。墓碑保留（见模块文档）。
pub(crate) fn forget(runtime_id: &str) {
    lock_book().leases.remove(runtime_id);
}

/// 当前仍有**未过期**租约的 runtime id（回收器清残条用）。
///
/// 残条清理不能再用"上一轮 live 快照的差集"（复审 P1-3 第二条）：那会把扫描期间
/// 新建并 claim 的实例误删。调用方必须**逐条对当前实例复核**后才 [`forget`]。
pub(crate) fn lease_runtime_ids(now: Instant) -> Vec<String> {
    let mut book = lock_book();
    expire_at(&mut book, now);
    book.leases.keys().cloned().collect()
}

/// 该 runtime 是否已被回收器接管（回收器用它决定"这是重试还是首轮"）。
pub(crate) fn is_reaping(runtime_id: &str) -> bool {
    lock_book().reaping.contains(runtime_id)
}

/// 清空全部租约与墓碑（应用退出时 `rpc::kill_all` 一并清；测试隔离同用）。
pub(crate) fn clear() {
    let mut book = lock_book();
    book.leases.clear();
    book.reaping.clear();
}

/// 测试隔离用。
#[cfg(test)]
pub(crate) fn reset_for_test() {
    clear();
}

/// 测试串行锁：`BOOK` 是进程级全局状态，而 `cargo test` 默认并行跑用例。
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
        // 合法调用成功并返回 token。
        let token = claim(&state, "aux:live", "c1").await.expect("aux + 存活即合法");
        assert_eq!(token.len(), 36, "token 是服务端签发的 UUID");
        assert_eq!(holder_count("aux:live", Instant::now()), 1);
        reset_for_test();
    }

    /// **复审 P1-2 的正例**：拿**真实 owner 的 clientId**（从 `aux_list` 抄来的）
    /// 当凭证去释放，必须失败。旧实现只测了不存在的 `intruder`，掩盖了这个缺口。
    #[tokio::test]
    async fn the_real_owners_client_id_is_not_a_credential() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:shared", RuntimePolicy::Aux).await;
        let owner_token = claim(&state, "aux:shared", "victim").await.unwrap();

        // 攻击者先执行一次合法 list：拿到 victim 的 clientId（公开信息）。
        let parents = vec![("aux:shared".to_string(), Some("main".to_string()))];
        let list = entries(&parents, Instant::now());
        assert_eq!(list[0]["clientId"], "victim");
        assert!(list[0].get("leaseToken").is_none(), "list 不得回 token");

        // 用真实 owner 的 clientId 当 token 释放：必须失败，租约完好。
        let err = release(&state, "aux:shared", "victim")
            .await
            .expect_err("clientId 不是凭证");
        assert!(err.contains("auxLeaseNotHeld"), "{err}");
        assert_eq!(holder_count("aux:shared", Instant::now()), 1);

        // 只有真 token 能释放。
        release(&state, "aux:shared", &owner_token).await.unwrap();
        assert_eq!(holder_count("aux:shared", Instant::now()), 0);
        // 重复释放（token 已失效）：失败。
        let err = release(&state, "aux:shared", &owner_token)
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
        let _process = test_harness::install_with_queue(&state, "aux:idem", RuntimePolicy::Aux).await.0;
        let mut tokens = Vec::new();
        for _ in 0..3 {
            tokens.push(claim(&state, "aux:idem", "c1").await.unwrap());
        }
        assert_eq!(holder_count("aux:idem", Instant::now()), 1, "心跳重复领取只算一份");
        // 条目仍有效时续用同一个 token（页面重载后仍能 release）。
        assert!(tokens.iter().all(|token| token == &tokens[0]));
        // 三件事之外什么都没发生：不写 stdin、不刷新池级活动时钟。
        let mut rx = test_harness::install_with_queue(&state, "aux:idem2", RuntimePolicy::Aux)
            .await
            .1;
        assert!(rx.try_recv().is_err(), "租约命令不得向 pi 写入任何命令");
        assert!(
            state.last_activity.lock().await.is_empty(),
            "租约命令不得刷新 RpcState::last_activity（否则回收永远不成立）"
        );
        // 用户活动时钟也不许动：只读命令不是用户活动。
        test_harness::note_user_activity_at(&state, "aux:idem", 7).await;
        claim_at(&state, "aux:idem", "c1", Instant::now()).await.unwrap();
        assert!(
            test_harness::user_idle_secs(&state, "aux:idem").await >= 7,
            "claim 不得推进用户活动时钟"
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
        let list = entries(&parents, Instant::now());
        assert_eq!(list.len(), 1, "没有租约的 aux:two 不出现");
        assert_eq!(list[0]["runtimeId"], "aux:one");
        assert_eq!(
            list[0]["parentRuntimeId"], "main",
            "重连过滤要用 parentRuntimeId"
        );
        assert_eq!(list[0]["clientId"], "c1");
        // `aux_list` 的只读性质：列出不刷新池级活动时钟。
        assert!(state.last_activity.lock().await.is_empty());
        reset_for_test();
    }

    /// **复审 P1-1 的回归**：停心跳后租约必须过期，`claims` 归零（否则回收永远空转）。
    #[tokio::test]
    async fn a_lease_expires_when_the_client_stops_renewing_it() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:crash", RuntimePolicy::Aux).await;
        let t0 = Instant::now();
        claim_at(&state, "aux:crash", "crashed-client", t0).await.unwrap();
        assert_eq!(holder_count("aux:crash", t0), 1);

        // TTL 未到：仍然有效。
        assert_eq!(
            holder_count("aux:crash", t0 + AUX_LEASE_TTL - Duration::from_secs(1)),
            1
        );
        // TTL 到点：惰性清理把它摘掉（任何入口都会做这件事）。
        assert_eq!(holder_count("aux:crash", t0 + AUX_LEASE_TTL), 0);
        // 换个入口验证同一件事：list 里也不再出现。
        let parents = vec![("aux:crash".to_string(), Some("main".to_string()))];
        assert!(entries(&parents, t0 + AUX_LEASE_TTL).is_empty());
        reset_for_test();
    }

    /// 持续心跳 → 续期 → 永不过期。
    #[tokio::test]
    async fn a_heartbeat_keeps_renewing_the_same_lease() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:beat", RuntimePolicy::Aux).await;
        let t0 = Instant::now();
        let token = claim_at(&state, "aux:beat", "c1", t0).await.unwrap();
        // 每 20s 续一次，跨过 5 个 TTL 周期。
        for step in 1..=20 {
            let now = t0 + Duration::from_secs(20 * step);
            let renewed = claim_at(&state, "aux:beat", "c1", now).await.unwrap();
            assert_eq!(renewed, token, "续期必须续用同一个 token");
            assert_eq!(holder_count("aux:beat", now), 1);
        }
        assert_eq!(
            holder_count("aux:beat", t0 + Duration::from_secs(400)),
            1,
            "持续心跳的租约不得过期"
        );
        reset_for_test();
    }

    /// **复审 P1-3 的第一条**：回收开始后 claim 必须被拒（否则 kill 前又有人把
    /// 租约写回去，日志里的 `claims=0` 就是假账）。
    #[tokio::test]
    async fn a_claim_is_rejected_once_reaping_has_begun() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:arb", RuntimePolicy::Aux).await;
        let now = Instant::now();
        assert!(begin_reap("aux:arb", now), "无持有者时回收可以接管");
        assert!(is_reaping("aux:arb"));
        let err = claim_at(&state, "aux:arb", "late-client", now)
            .await
            .expect_err("回收期间不得再领租约");
        assert!(err.contains("auxLeaseReaping"), "{err}");
        assert_eq!(holder_count("aux:arb", now), 0, "拒绝时不得留下半条租约");
        // 幂等：再次仲裁返回 false（同一轮/下一轮扫描都不重复 kill）。
        assert!(!begin_reap("aux:arb", now));
        // 墓碑在 forget 之后依然生效（kill 已完成，claim 仍不得复活它）。
        forget("aux:arb");
        let err = claim_at(&state, "aux:arb", "late-client", now)
            .await
            .expect_err("已回收的 runtime 不得复活");
        assert!(err.contains("auxLeaseReaping"), "{err}");
        reset_for_test();
    }

    /// 有未过期持有者时，`begin_reap` 不得接管（避免误杀别客户端的实例）。
    #[tokio::test]
    async fn a_live_holder_blocks_the_reap_arbitration() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:held", RuntimePolicy::Aux).await;
        let now = Instant::now();
        claim_at(&state, "aux:held", "c1", now).await.unwrap();
        assert!(!begin_reap("aux:held", now), "有持有者时不得接管");
        assert!(!is_reaping("aux:held"));
        // 持有者过期之后才允许接管 —— 这是"停心跳才可回收"的唯一入口。
        assert!(begin_reap("aux:held", now + AUX_LEASE_TTL));
        reset_for_test();
    }

    /// 多个客户端同时持有：只有各自 token 能删各自那条。
    #[tokio::test]
    async fn each_client_releases_only_its_own_lease() {
        let _guard = test_lock();
        reset_for_test();
        let state = rpc::RpcState::default();
        test_harness::install(&state, "aux:multi", RuntimePolicy::Aux).await;
        let now = Instant::now();
        let a = claim_at(&state, "aux:multi", "client-a", now).await.unwrap();
        let b = claim_at(&state, "aux:multi", "client-b", now).await.unwrap();
        assert_ne!(a, b, "不同客户端拿到不同 token");
        assert_eq!(holder_count("aux:multi", now), 2);
        release_at(&state, "aux:multi", &a, now).await.unwrap();
        assert_eq!(holder_count("aux:multi", now), 1, "只删自己那条");
        assert!(!begin_reap("aux:multi", now), "B 还在，不得接管");
        release_at(&state, "aux:multi", &b, now).await.unwrap();
        assert_eq!(holder_count("aux:multi", now), 0);
        assert!(begin_reap("aux:multi", now));
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
        let now = Instant::now();
        {
            let mut book = lock_book();
            for client_id in ["c1", "c2"] {
                book.leases
                    .entry("aux:a".into())
                    .or_default()
                    .insert(
                        client_id.to_string(),
                        Lease {
                            token: format!("tok-{client_id}"),
                            renewed_at: now,
                        },
                    );
            }
        }
        assert_eq!(holder_count("aux:a", now), 2);
        assert_eq!(holder_count("aux:b", now), 0);
        let list = entries(&[("aux:a".to_string(), Some("main".into()))], now);
        assert_eq!(list.len(), 2);
        // 稳定顺序：clientId 升序，便于断言与前端去重。
        assert_eq!(list[0]["clientId"], "c1");
        assert_eq!(list[1]["clientId"], "c2");
        assert_eq!(list[0]["parentRuntimeId"], "main");
        // 没有租约的 runtime 不出现在列表里。
        assert!(entries(&[("aux:b".to_string(), Some("main".into()))], now).is_empty());
        forget("aux:a");
        assert_eq!(holder_count("aux:a", now), 0);
        reset_for_test();
    }

    #[test]
    fn entries_carry_a_null_parent_when_the_child_has_no_recorded_parent() {
        let _guard = test_lock();
        reset_for_test();
        let now = Instant::now();
        lock_book()
            .leases
            .entry("aux:a".into())
            .or_default()
            .insert(
                "c1".into(),
                Lease {
                    token: "tok".into(),
                    renewed_at: now,
                },
            );
        let list = entries(&[("aux:a".to_string(), None)], now);
        assert_eq!(list[0]["parentRuntimeId"], Value::Null);
        // 过期边界：TTL 到点后整条消失（两个入口语义一致）。
        assert!(entries(&[("aux:a".to_string(), None)], now + AUX_LEASE_TTL).is_empty());
        reset_for_test();
    }
}
