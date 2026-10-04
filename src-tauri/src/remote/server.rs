//! HTTP server lifecycle: start, same-port restart and graceful shutdown.

use super::{api, auth, load, persist_settings, RemoteState, Settings, WebState};
use crate::errors::{pix_error, pix_error_with};
use serde_json::{json, Value};
use std::{collections::HashMap, net::SocketAddr, sync::Arc, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::sync::{watch, Semaphore};

pub(super) struct Server {
    settings: Settings,
    token: String,
    stop: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
}
/// Grace period for an old server to finish graceful shutdown during a
/// restart before its task is aborted.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);

/// Stop a running server and wait until it has fully exited (listener
/// released). Callers must await this before rebinding the port, otherwise a
/// same-port restart fails with "Address already in use".
async fn shutdown_server(server: Server) {
    let Server { stop, task, .. } = server;
    let _ = stop.send(true);
    let mut task = Box::pin(task);
    tokio::select! {
        _ = &mut task => {}
        _ = tokio::time::sleep(SHUTDOWN_GRACE) => task.abort(),
    }
}

fn access_url(ip: &str, port: u16, token: &str, password_enabled: bool) -> String {
    let base = format!("http://{ip}:{port}/");
    if password_enabled {
        base
    } else {
        format!("{base}#token={token}")
    }
}

#[tauri::command]
pub fn remote_status(app: AppHandle) -> Value {
    let state = app.state::<RemoteState>();
    let guard = state.server.lock().unwrap();
    match guard.as_ref() {
        None => {
            let cfg = load(&app);
            json!({"enabled": false, "port": cfg.port, "urls": [], "passwordEnabled": cfg.password_hash.is_some()})
        }
        Some(s) => {
            let mut ips: Vec<String> = if_addrs::get_if_addrs()
                .unwrap_or_default()
                .into_iter()
                .filter(|i| !is_virtual_interface(&i.name))
                .filter_map(|i| match i.ip() {
                    std::net::IpAddr::V4(ip) if !ip.is_loopback() && ip.is_private() => {
                        Some(ip.to_string())
                    }
                    _ => None,
                })
                .collect();
            ips.sort();
            ips.dedup();
            let urls: Vec<String> = ips
                .iter()
                .map(|ip| {
                    access_url(
                        ip,
                        s.settings.port,
                        &s.token,
                        s.settings.password_hash.is_some(),
                    )
                })
                .collect();
            json!({"enabled": true, "port": s.settings.port, "urls": urls, "passwordEnabled": s.settings.password_hash.is_some()})
        }
    }
}

#[tauri::command]
pub async fn remote_set(app: AppHandle, enabled: bool, port: u16) -> Result<Value, String> {
    let state = app.state::<RemoteState>();
    let _operation = state.operation.lock().await;
    if port == 0 {
        return Err(pix_error("portOutOfRange", "端口必须在 1–65535 之间"));
    }
    let settings = Settings {
        enabled,
        port,
        password_hash: load(&app).password_hash,
    };
    let same = state
        .server
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.settings.port == port)
        .unwrap_or(false);
    if enabled && same {
        // 同端口继续运行的服务保持不动，仅持久化设置。
        persist_settings(&settings)?;
        return Ok(remote_status(app.clone()));
    }
    // 先停旧 server 并等待其真正退出（listener 释放），再绑定新端口；
    // 否则同端口先关后开时 bind 会报 "Address already in use"。
    let old = state.server.lock().unwrap().take();
    if let Some(old) = old {
        shutdown_server(old).await;
    }
    let listener = if enabled {
        Some(
            tokio::net::TcpListener::bind(("0.0.0.0", port))
                .await
                .map_err(|e| {
                    pix_error_with(
                        "portListenFailed",
                        format!("无法监听端口 {port}: {e}"),
                        serde_json::json!({"port": port.to_string(), "detail": e.to_string()}),
                    )
                })?,
        )
    } else {
        None
    };
    persist_settings(&settings)?;
    if let Some(listener) = listener {
        let token = auth::boot_token();
        let (stop, mut stopped) = watch::channel(false);
        let web = WebState {
            app: app.clone(),
            token: token.clone(),
            stop: stop.subscribe(),
            password_hash: settings.password_hash.clone(),
            login_attempts: Arc::new(std::sync::Mutex::new(HashMap::new())),
            login_slots: Arc::new(Semaphore::new(4)),
        };
        let router = api::router(web);
        let task = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = stopped.changed().await;
            })
            .await;
        });
        *state.server.lock().unwrap() = Some(Server {
            settings,
            token,
            stop,
            task,
        });
    }
    Ok(remote_status(app.clone()))
}

/// Hypervisors, container runtimes, and VPN clients create virtual adapters
/// whose addresses other LAN devices cannot reach; hide them from the
/// access-link list.
fn is_virtual_interface(name: &str) -> bool {
    let n = name.to_lowercase();
    const VIRTUAL: [&str; 20] = [
        "vethernet", // Hyper-V / WSL (Windows)
        "hyper-v",
        "wsl",
        "vmware",
        "vmnet",
        "virtualbox",
        "vboxnet",
        "docker",
        "veth",  // Linux containers
        "virbr", // libvirt
        "tap-",  // TAP-Windows / Linux TAP
        "openvpn",
        "wireguard",
        "tailscale",
        "zerotier",
        "utun", // macOS VPN tunnels
        "teredo",
        "isatap",
        "loopback",
        "bluetooth",
    ];
    VIRTUAL.iter().any(|v| n.contains(v))
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use tokio::sync::watch;

    #[test]
    fn password_links_do_not_include_bearer_tokens() {
        assert_eq!(
            access_url("192.168.1.5", 1421, "secret", true),
            "http://192.168.1.5:1421/"
        );
        assert_eq!(
            access_url("192.168.1.5", 1421, "secret", false),
            "http://192.168.1.5:1421/#token=secret"
        );
    }

    #[tokio::test]
    async fn restart_releases_port_before_rebinding() {
        let (stop, mut stopped) = watch::channel(false);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let task = tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, Router::new())
                .with_graceful_shutdown(async move {
                    let _ = stopped.changed().await;
                })
                .await;
        });
        let server = Server {
            settings: Settings::default(),
            token: "t".to_owned(),
            stop,
            task,
        };
        // 与 remote_set 相同的停机路径：等到旧 listener 真正释放后才能重绑端口。
        shutdown_server(server).await;
        let rebind = tokio::net::TcpListener::bind(("127.0.0.1", port)).await;
        assert!(
            rebind.is_ok(),
            "rebinding port {port} after shutdown failed: {rebind:?}"
        );
    }

    #[test]
    fn virtual_adapters_are_excluded() {
        assert!(is_virtual_interface("vEthernet (WSL (Hyper-V firewall))"));
        assert!(is_virtual_interface("vEthernet (Default Switch)"));
        assert!(is_virtual_interface("VMware Network Adapter VMnet8"));
        assert!(is_virtual_interface("VirtualBox Host-Only Network"));
        assert!(is_virtual_interface("docker0"));
        assert!(is_virtual_interface("Tailscale"));
        assert!(!is_virtual_interface("Ethernet"));
        assert!(!is_virtual_interface("WLAN"));
        assert!(!is_virtual_interface("en0"));
        assert!(!is_virtual_interface("Realtek PCIe GbE Family Controller"));
    }
}
