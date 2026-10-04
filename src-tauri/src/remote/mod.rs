//! Remote (LAN) access: embedded HTTP server exposing the desktop API to
//! browsers on the same network.
//!
//! - [`server`]: HTTP server lifecycle (boot/rebind/shutdown).
//! - [`auth`]: password hashing, login rate limiting and token validation.
//! - [`api`]: axum handlers and embedded SPA assets.
//! - [`dispatch`]: mapping of remote invoke commands to desktop backends.

mod api;
mod auth;
mod dispatch;
mod server;

pub use auth::remote_password_set;
pub use server::{remote_set, remote_status};

// 命令实现位于子模块，tauri 的 generate_handler 以 `remote::<cmd>` 路径解析
// 命令名与其包装宏；这里把生成的隐藏宏一并重导出，保证 `remote::remote_set`
// 等对外路径与拆分前完全一致。
#[doc(hidden)]
pub use auth::__cmd__remote_password_set;
#[doc(hidden)]
pub use auth::__tauri_command_name_remote_password_set;
#[doc(hidden)]
pub use server::__cmd__remote_set;
#[doc(hidden)]
pub use server::__cmd__remote_status;
#[doc(hidden)]
pub use server::__tauri_command_name_remote_set;
#[doc(hidden)]
pub use server::__tauri_command_name_remote_status;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::IpAddr,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, watch, Semaphore};

use server::Server;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub port: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password_hash: Option<String>,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 1421,
            password_hash: None,
        }
    }
}

pub struct RemoteState {
    server: Mutex<Option<Server>>,
    events: broadcast::Sender<Value>,
    operation: tokio::sync::Mutex<()>,
}
impl Default for RemoteState {
    fn default() -> Self {
        Self {
            server: Mutex::new(None),
            events: broadcast::channel(2048).0,
            operation: tokio::sync::Mutex::new(()),
        }
    }
}

/// Per-server web-facing state shared by the axum handlers.
#[derive(Clone)]
struct WebState {
    app: AppHandle,
    token: String,
    stop: watch::Receiver<bool>,
    password_hash: Option<String>,
    login_attempts: Arc<Mutex<HashMap<IpAddr, auth::LoginAttempt>>>,
    login_slots: Arc<Semaphore>,
}

fn path() -> Result<std::path::PathBuf, String> {
    Ok(crate::data_dir::root().join("remote.json"))
}

fn persist_settings(settings: &Settings) -> Result<(), String> {
    let p = path()?;
    std::fs::create_dir_all(p.parent().ok_or("Missing remote settings directory")?)
        .map_err(|e| e.to_string())?;
    std::fs::write(&p, serde_json::to_vec(settings).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}

pub fn load(_app: &AppHandle) -> Settings {
    path()
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn emit(app: &AppHandle, name: &str, payload: Value) {
    use tauri::Emitter;
    let _ = app.emit(name, &payload);
    let _ = app
        .state::<RemoteState>()
        .events
        .send(json!({"event": name, "payload": payload}));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_is_private() {
        let cfg = Settings::default();
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, 1421);
    }
}
