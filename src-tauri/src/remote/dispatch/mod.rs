//! Mapping of remote invoke commands to desktop backends, grouped by domain.
//!
//! Each domain module handles its own command set and returns
//! [`UNHANDLED`] for commands outside it, so [`dispatch`] keeps the original
//! single-match semantics: unknown commands fall through to the
//! `desktopOnlyAction` error.

mod app;
mod package;
mod schedule;
mod session;
mod skills;
mod terminal;
mod update;
mod workspace;

use crate::errors::pix_error;
use crate::rpc;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Sentinel error marking "this command does not belong to this domain".
pub(super) const UNHANDLED: &str = "\u{0}unhandled";

/// Convert a domain result into an optional one: the [`UNHANDLED`] sentinel
/// means the command belongs to another domain.
pub(super) fn handled(result: Result<Value, String>) -> Option<Result<Value, String>> {
    match result {
        Err(e) if e == UNHANDLED => None,
        other => Some(other),
    }
}

pub(super) async fn dispatch(app: &AppHandle, cmd: &str, a: Value) -> Result<Value, String> {
    let state = app.state::<rpc::RpcState>();
    if let Some(result) = session::handle(app, state, cmd, &a).await {
        return result;
    }
    if let Some(result) = workspace::handle(app, cmd, &a).await {
        return result;
    }
    if let Some(result) = app::handle(app, cmd, &a).await {
        return result;
    }
    if let Some(result) = package::handle(app, cmd, &a).await {
        return result;
    }
    if let Some(result) = skills::handle(cmd, &a).await {
        return result;
    }
    if let Some(result) = schedule::handle(app, cmd, &a).await {
        return result;
    }
    if let Some(result) = terminal::handle(app, cmd, &a).await {
        return result;
    }
    if let Some(result) = update::handle(app, cmd, &a).await {
        return result;
    }
    Err(pix_error("desktopOnlyAction", "此操作仅可在桌面端执行"))
}

/// Extract a required string argument.
pub(super) fn text(a: &Value, key: &str) -> Result<String, String> {
    a.get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("Missing {key}"))
}

/// Extract an optional list-of-strings argument.
pub(super) fn string_list(v: &Value) -> Option<Vec<String>> {
    v.as_array().map(|list| {
        list.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    })
}

/// Serialize a value with the shared error mapping (keeps the exact error
/// string the old inline `serde_json::to_value(..).map_err(|e| e.to_string())`
/// produced).
pub(super) fn to_json<T: Serialize>(value: T) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|e| e.to_string())
}
