//! **可重跑的真实后端双客户端场景**（`docs/aux-chat-spec.md` §6 验收矩阵 f/g 的后端部分）。
//!
//! 为什么单独成文件：这两条验收要求"真进程 + 真租约表 + 两个客户端"，散在
//! `aux_leases`/`aux_reap` 的单元用例里既读不出完整时序、也不便重跑。这里把
//! 整条链路按一次真实会话走一遍，并在 `--nocapture` 下打印可直接贴进 PR 的步骤。
//!
//! 重跑方式：
//! ```text
//! cargo test --manifest-path src-tauri/Cargo.toml --lib aux_lifecycle_scenarios -- --nocapture
//! ```
//!
//! 覆盖：
//! 1. A 领取租约后**释放**、B 持续心跳 → 只有 A 的实例被回收，B 不被误杀（§6 g）；
//! 2. 两个客户端同时持有同一实例 → 只回收"一个持有者都没有"的实例（§6 f 的归属侧）；
//! 3. `aux_list` 的条目带 `parentRuntimeId`，本机重连只认"自己的 clientId + 父会话在
//!    本地注册表"（§6 f 的重连侧，后端提供判据、前端执行过滤）；
//! 4. 停心跳（客户端崩溃）→ TTL 过期 → 空闲超阈 → 回收（A 条阻塞项的端到端形态）。
//!
//! GUI 双窗口手工留成员验收：本脚本只证明**后端状态机**正确，不承诺界面层。

#[cfg(test)]
mod tests {
    use crate::aux_leases::{self, AUX_LEASE_TTL};
    use crate::aux_reap::{self, AUX_IDLE_LIMIT};
    use crate::rpc::{aux_probe, test_harness, RuntimePolicy, RpcState};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    /// 一条可读的步骤日志（只在 `--nocapture` 下显示，不影响常规测试输出）。
    fn step(index: usize, text: &str) {
        println!("[aux-lifecycle {index:02}] {text}");
    }

    fn idle_now(t0: Instant, secs: u64) -> Instant {
        t0 + Duration::from_secs(secs)
    }

    /// §6(g) 的"有租约不被回收" + §6(f) 的"A 释放、B 仍持有"。
    #[tokio::test]
    async fn two_clients_release_and_heartbeat_keep_their_own_instances() {
        let _guard = aux_leases::test_lock();
        aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        // 两个**真实**的长命子进程（不是替身）：它们不读 stdin、不会应答，
        // 因此"是否存活"完全由 `process_running` 判定，与生产同一判据。
        test_harness::install(&state, "aux:client-a", RuntimePolicy::Aux).await;
        test_harness::install(&state, "aux:client-b", RuntimePolicy::Aux).await;
        aux_probe::set_aux_parent(&state, "aux:client-a", Some("main-a".into())).await;
        aux_probe::set_aux_parent(&state, "aux:client-b", Some("main-b".into())).await;

        let t0 = Instant::now();
        step(1, "两个真实 aux 子进程已起来（aux:client-a / aux:client-b）");
        let token_a = aux_leases::claim_at(&state, "aux:client-a", "client-a", t0)
            .await
            .expect("A 领取租约");
        let token_b = aux_leases::claim_at(&state, "aux:client-b", "client-b", t0)
            .await
            .expect("B 领取租约");
        step(
            2,
            &format!("两个客户端各领一条租约（token 由服务端签发，长度 {} / {}）", token_a.len(), token_b.len()),
        );

        // A 关掉自己的 Tab：先 release 再（这里由测试直接）kill。
        aux_leases::release_at(&state, "aux:client-a", &token_a, t0)
            .await
            .expect("A 释放");
        step(3, "A 释放租约（对应 closeAux 的 release → rpc_kill 顺序的前半段）");
        aux_reap::reap_once(&state, t0, AUX_IDLE_LIMIT).await;

        // B 每 20s 心跳，一直走到 31 分钟（超过空闲阈值）。
        let mut now = t0;
        while now < idle_now(t0, 31 * 60) {
            now += Duration::from_secs(20);
            let renewed = aux_leases::claim_at(&state, "aux:client-b", "client-b", now)
                .await
                .expect("B 心跳");
            assert_eq!(renewed, token_b, "续期必须续用同一 token");
        }
        step(4, "B 每 20s 心跳续期到第 31 分钟（超过 30 分钟空闲阈值）");

        let reaped = aux_reap::reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert_eq!(reaped.len(), 1, "只有 A 该被回收：{reaped:?}");
        assert_eq!(reaped[0].runtime_id, "aux:client-a");
        assert_eq!(reaped[0].parent.as_deref(), Some("main-a"), "日志带归属父会话");
        assert_eq!(reaped[0].claims, 0, "回收时 claims 必须是真实值");
        step(
            5,
            &format!(
                "回收一轮：reaped={} parent={:?} claims={} idle={}s",
                reaped.len(),
                reaped[0].parent,
                reaped[0].claims,
                reaped[0].idle_secs
            ),
        );

        assert!(
            !crate::rpc::running(&state, Some("aux:client-a")).await,
            "A 的进程必须真的死了"
        );
        assert!(
            crate::rpc::running(&state, Some("aux:client-b")).await,
            "B 仍在心跳，**不得**被误杀（§6 g 的反例）"
        );
        assert_eq!(test_harness::process_count(&state).await, 1);
        step(6, "A 已 kill、B 存活：他客户端的实例未被误杀");
        aux_leases::reset_for_test();
    }

    /// §6(f) 的归属侧：两个客户端同时持有同一实例 → 谁都没释放时不得回收。
    #[tokio::test]
    async fn a_shared_instance_survives_while_any_client_still_holds_it() {
        let _guard = aux_leases::test_lock();
        aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:shared", RuntimePolicy::Aux).await;
        aux_probe::set_aux_parent(&state, "aux:shared", Some("main".into())).await;
        let t0 = Instant::now();
        let token_a = aux_leases::claim_at(&state, "aux:shared", "client-a", t0)
            .await
            .unwrap();
        let _token_b = aux_leases::claim_at(&state, "aux:shared", "client-b", t0)
            .await
            .unwrap();
        step(1, "同一实例被两个客户端同时持有（分屏/双窗口）");

        aux_leases::release_at(&state, "aux:shared", &token_a, t0)
            .await
            .unwrap();
        // A 释放后 B **继续心跳**到 31 分钟：它的租约一直有效，因此不得回收。
        let mut now = t0;
        while now < idle_now(t0, 31 * 60) {
            now += Duration::from_secs(20);
            aux_leases::claim_at(&state, "aux:shared", "client-b", now)
                .await
                .expect("B 心跳");
        }
        let reaped = aux_reap::reap_once(&state, now, AUX_IDLE_LIMIT).await;
        assert!(reaped.is_empty(), "B 仍持有，不得回收：{reaped:?}");
        assert!(crate::rpc::running(&state, Some("aux:shared")).await);
        step(2, "A 释放、B 持续心跳到 31 分钟 → 扫描一轮 reaped=0，进程存活");

        // 反向：B 也停跳（两个客户端都走了）→ 过期 + 空闲超阈 → 回收。
        let after = now + AUX_LEASE_TTL + Duration::from_secs(60);
        let reaped = aux_reap::reap_once(&state, after, AUX_IDLE_LIMIT).await;
        assert_eq!(reaped.len(), 1, "两个客户端都停跳后应可回收：{reaped:?}");
        assert!(!crate::rpc::running(&state, Some("aux:shared")).await);
        step(3, "B 也停跳 → 租约过期 + 空闲超阈 → reaped=1，进程被 kill");
        aux_leases::reset_for_test();
    }

    /// §6(f) 的重连侧判据：`aux_list` 只给 `clientId` + `parentRuntimeId`（**不给 token**），
    /// 前端据此只恢复"本机 clientId + 父会话在本地注册表"的条目。
    #[tokio::test]
    async fn aux_list_exposes_ownership_for_reconnect_filtering_but_no_token() {
        let _guard = aux_leases::test_lock();
        aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:mine", RuntimePolicy::Aux).await;
        test_harness::install(&state, "aux:theirs", RuntimePolicy::Aux).await;
        aux_probe::set_aux_parent(&state, "aux:mine", Some("main".into())).await;
        aux_probe::set_aux_parent(&state, "aux:theirs", Some("other-window-parent".into())).await;
        let t0 = Instant::now();
        let token = aux_leases::claim_at(&state, "aux:mine", "my-client", t0)
            .await
            .unwrap();
        aux_leases::claim_at(&state, "aux:theirs", "their-client", t0)
            .await
            .unwrap();
        step(1, "两个客户端（本机 / 他窗口）各持有一个实例");

        let parents = aux_probe::aux_runtime_parents(&state).await;
        let list = aux_leases::entries(&parents, t0);
        assert_eq!(list.len(), 2);
        for row in &list {
            assert_eq!(row["clientId"].as_str().is_some(), true);
            assert!(row.get("leaseToken").is_none(), "list 绝不回 token");
        }
        step(2, "aux_list 返回 2 条，均带 parentRuntimeId、均不含 leaseToken");

        // 模拟前端过滤（与 `src/lib/auxLease.ts` 的 `ownAuxLeases` 同判据）：
        // 只恢复 clientId == "my-client" 且 parentRuntimeId ∈ 本地注册表 {main} 的条目。
        let local_parents = ["main"];
        let own: Vec<_> = list
            .iter()
            .filter(|row| row["clientId"] == "my-client")
            .filter(|row| {
                row["parentRuntimeId"]
                    .as_str()
                    .is_some_and(|parent| local_parents.contains(&parent))
            })
            .collect();
        assert_eq!(own.len(), 1, "本机重连只恢复自己那一条：{own:?}");
        assert_eq!(own[0]["runtimeId"], "aux:mine");
        step(3, "本机重连过滤后只剩 aux:mine（他窗口的条目原样不动）");

        // 本机能出示 token → 可立即释放；他客户端没有 token → 只能等 TTL。
        aux_leases::release_at(&state, "aux:mine", &token, t0)
            .await
            .unwrap();
        let err = aux_leases::release_at(&state, "aux:theirs", "their-client", t0)
            .await
            .expect_err("clientId 不是凭证");
        assert!(err.contains("auxLeaseNotHeld"), "{err}");
        step(4, "本机按 token 释放成功；拿他客户端的 clientId 释放被拒（auxLeaseNotHeld）");
        aux_leases::reset_for_test();
    }

    /// 停心跳（客户端崩溃）→ TTL 过期 → 空闲超阈 → 回收。这是 A 条阻塞项的端到端形态。
    #[tokio::test]
    async fn a_crashed_client_instance_is_eventually_reaped_after_the_ttl() {
        let _guard = aux_leases::test_lock();
        aux_leases::reset_for_test();
        let state = Arc::new(RpcState::default());
        test_harness::install(&state, "aux:crashed", RuntimePolicy::Aux).await;
        let t0 = Instant::now();
        aux_leases::claim_at(&state, "aux:crashed", "crashed-client", t0)
            .await
            .unwrap();
        step(1, "客户端领取租约后崩溃（不再 claim/release）");

        // 崩溃后 5 分钟：租约已过期，但空闲还没到 30 分钟 → 不回收。
        let early = idle_now(t0, 5 * 60);
        assert!(!aux_reap::reap_once(&state, early, AUX_IDLE_LIMIT)
            .await
            .iter()
            .any(|entry| entry.runtime_id == "aux:crashed"));
        assert!(crate::rpc::running(&state, Some("aux:crashed")).await);
        step(2, "崩溃后 5 分钟：租约过期但空闲未到 30 分钟 → 不回收（只 claims 归零）");

        // 崩溃后 31 分钟：两个条件都成立 → 回收。
        let late = idle_now(t0, 31 * 60);
        let reaped = aux_reap::reap_once(&state, late, AUX_IDLE_LIMIT).await;
        assert_eq!(reaped.len(), 1, "{reaped:?}");
        assert_eq!(reaped[0].claims, 0);
        assert!(!crate::rpc::running(&state, Some("aux:crashed")).await);
        step(3, "崩溃后 31 分钟（> TTL 且 > 空闲阈值）→ reaped=1，进程被 kill");
        assert!(
            AUX_LEASE_TTL >= Duration::from_secs(60),
            "TTL 必须 ≥ 3 个心跳，容忍漏拍"
        );
        aux_leases::reset_for_test();
    }
}
