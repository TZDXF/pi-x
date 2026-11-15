//! aux 的租约宿主命令：`aux_claim` / `aux_release` / `aux_list`
//! （`docs/aux-chat-spec.md` §5）。
//!
//! 三条命令**只做三件事**：写 / 删 / 列租约。
//!
//! - 入参只有 `{ runtimeId, clientId }`：**不**接收 `command`/`extraArgs`，不写 stdin，
//!   不改 `policy`，不起进程；
//! - **只**注册为宿主命令（桌面 `lib.rs` + 远程 `dispatch/session.rs`），复用两者既有的
//!   认证，**绝不**进 JSONL 白名单 —— 把 `{type:"aux_claim"}` 发给 pi 会被 M0 网关当
//!   未知 type 拒绝（`rpc/policy.rs::aux_rejects_unknown_type`）；
//! - 入口校验两条：`runtimeId` 必须 `aux:` 前缀，且该 runtime 的策略必须是 `Aux`
//!   （Main 拒绝）。校验走 `rpc::aux_probe` 的只读通道，不刷新 `last_activity`。
//!
//! 逻辑本体在 [`crate::aux_leases`]，这里只做 Tauri 参数搬运。

use serde_json::{json, Value};
use tauri::State;

use crate::aux_leases;
use crate::rpc;

/// 登记本客户端对某 aux 实例的持有（心跳每 20s 重复调用，必须幂等）。
#[tauri::command]
pub async fn aux_claim(
    state: State<'_, rpc::RpcState>,
    runtime_id: String,
    client_id: String,
) -> Result<(), String> {
    aux_leases::claim(&state, &runtime_id, &client_id).await
}

/// 释放本客户端的租约（关闭实例时先于 `rpc_kill` 调用）。不持有即报错。
#[tauri::command]
pub async fn aux_release(
    state: State<'_, rpc::RpcState>,
    runtime_id: String,
    client_id: String,
) -> Result<(), String> {
    aux_leases::release(&state, &runtime_id, &client_id).await
}

/// 列出全部租约条目；每条都带 `parentRuntimeId`（前端重连过滤要用）。
#[tauri::command]
pub async fn aux_list(state: State<'_, rpc::RpcState>) -> Result<Value, String> {
    let parents = rpc::aux_probe::aux_runtime_parents(&state).await;
    Ok(json!(aux_leases::entries(&parents)))
}
