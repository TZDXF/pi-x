//! aux 的租约宿主命令：`aux_claim` / `aux_release` / `aux_list`
//! （`docs/aux-chat-spec.md` §5、§11）。
//!
//! 三条命令**只做三件事**：写 / 删 / 列租约。
//!
//! - 入参只有 `runtimeId` + `clientId`（claim）/ `leaseToken`（release）：**不**接收
//!   `command`/`extraArgs`，不写 stdin，不改 `policy`，不起进程；
//! - **只**注册为宿主命令（桌面 `lib.rs` + 远程 `dispatch/session.rs`），复用两者既有的
//!   认证，**绝不**进 JSONL 白名单 —— 把 `{type:"aux_claim"}` 发给 pi 会被 M0 网关当
//!   未知 type 拒绝（`rpc/policy.rs::aux_rejects_unknown_type`）；
//! - 入口校验两条：`runtimeId` 必须 `aux:` 前缀，且该 runtime 的策略必须是 `Aux`
//!   （Main 拒绝）。校验走 `rpc::aux_probe` 的只读通道，不刷新 `last_activity`。
//!
//! **clientId 不是凭证**：`claim` 返回服务端签发的 lease token，`release` 只认 token。
//! `aux_list` 只回 `clientId` + `parentRuntimeId`（重连过滤用），从不回 token。
//!
//! 逻辑本体在 [`crate::aux_leases`]，这里只做 Tauri 参数搬运。

use serde_json::{json, Value};
use tauri::State;

use crate::aux_leases;
use crate::rpc;

/// 登记/续期本客户端对某 aux 实例的持有，返回**服务端签发的 lease token**。
///
/// `lease_token` 可选：首次领取不需要它（服务端签发）；**续租必须带上原 token**，
/// 否则 `auxLeaseConflict` —— 公开的 `clientId` 因此不能当凭证（复审第二轮 P1-2）。
#[tauri::command]
pub async fn aux_claim(
    state: State<'_, rpc::RpcState>,
    runtime_id: String,
    client_id: String,
    lease_token: Option<String>,
) -> Result<String, String> {
    aux_leases::claim(&state, &runtime_id, &client_id, lease_token.as_deref()).await
}

/// 释放租约（关闭实例时**先于** `rpc_kill` 调用）。只认 lease token；不持有即报错。
#[tauri::command]
pub async fn aux_release(
    state: State<'_, rpc::RpcState>,
    runtime_id: String,
    lease_token: String,
) -> Result<(), String> {
    aux_leases::release(&state, &runtime_id, &lease_token).await
}

/// 列出**未过期**的租约条目；每条带 `parentRuntimeId`（前端重连过滤要用）。
#[tauri::command]
pub async fn aux_list(state: State<'_, rpc::RpcState>) -> Result<Value, String> {
    let parents = rpc::aux_probe::aux_runtime_parents(&state).await;
    Ok(json!(aux_leases::entries(&parents, std::time::Instant::now())))
}
