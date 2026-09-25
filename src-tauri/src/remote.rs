use crate::{commands, rpc};
use axum::{
    extract::{ws::Message, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, watch};

include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub enabled: bool,
    pub port: u16,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 1421,
        }
    }
}
struct Server {
    settings: Settings,
    token: String,
    stop: watch::Sender<bool>,
}
pub struct RemoteState {
    server: Mutex<Option<Server>>,
    pub events: broadcast::Sender<Value>,
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
#[derive(Clone)]
struct WebState {
    app: AppHandle,
    token: String,
    stop: watch::Receiver<bool>,
}
fn path(_app: &AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(crate::data_dir::root().join("remote.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    path(app)
        .ok()
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

#[tauri::command]
pub fn remote_status(app: AppHandle) -> Value {
    let state = app.state::<RemoteState>();
    let guard = state.server.lock().unwrap();
    match guard.as_ref() {
        None => json!({"enabled": false, "port": load(&app).port, "urls": []}),
        Some(s) => {
            let mut ips: Vec<String> = if_addrs::get_if_addrs()
                .unwrap_or_default()
                .into_iter()
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
                .map(|ip| format!("http://{}:{}/#token={}", ip, s.settings.port, s.token))
                .collect();
            json!({"enabled": true, "port": s.settings.port, "urls": urls})
        }
    }
}

#[tauri::command]
pub async fn remote_set(app: AppHandle, enabled: bool, port: u16) -> Result<Value, String> {
    let state = app.state::<RemoteState>();
    let _operation = state.operation.lock().await;
    if port == 0 {
        return Err("端口必须在 1–65535 之间".into());
    }
    let settings = Settings { enabled, port };
    let same = state
        .server
        .lock()
        .unwrap()
        .as_ref()
        .map(|s| s.settings.port == port)
        .unwrap_or(false);
    let listener = if enabled && !same {
        Some(
            tokio::net::TcpListener::bind(("0.0.0.0", port))
                .await
                .map_err(|e| format!("无法监听端口 {port}: {e}"))?,
        )
    } else {
        None
    };
    let p = path(&app)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_vec(&settings).unwrap()).map_err(|e| e.to_string())?;
    if enabled && same {
        return Ok(remote_status(app.clone()));
    }
    if let Some(old) = state.server.lock().unwrap().take() {
        let _ = old.stop.send(true);
    }
    if let Some(listener) = listener {
        // PIX_REMOTE_TOKEN overrides the random token (headless testing / automation).
        let token = std::env::var("PIX_REMOTE_TOKEN")
            .ok()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
        let (stop, mut stopped) = watch::channel(false);
        let web = WebState {
            app: app.clone(),
            token: token.clone(),
            stop: stop.subscribe(),
        };
        let router = Router::new()
            .route("/api/invoke", post(invoke))
            .route("/api/events", get(events))
            .fallback(asset)
            .with_state(web);
        *state.server.lock().unwrap() = Some(Server {
            settings,
            token,
            stop,
        });
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    let _ = stopped.changed().await;
                })
                .await;
        });
    }
    Ok(remote_status(app.clone()))
}

fn authorized(state: &WebState, token: &str) -> bool {
    valid_token(&state.token, token, *state.stop.borrow())
}
#[derive(Deserialize)]
struct Call {
    command: String,
    #[serde(default)]
    args: Value,
}
async fn invoke(
    State(web): State<WebState>,
    headers: HeaderMap,
    Json(call): Json<Call>,
) -> Response {
    let token = headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("");
    if !authorized(&web, token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let result = dispatch(&web.app, &call.command, call.args).await;
    match result {
        Ok(v) => Json(json!({"data": v})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}
async fn dispatch(app: &AppHandle, cmd: &str, a: Value) -> Result<Value, String> {
    let text = |key: &str| {
        a.get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("Missing {key}"))
    };
    let state = app.state::<rpc::RpcState>();
    match cmd {
        "pi_settings_get" => commands::pi_settings_get().await,
        "pi_settings_save" => {
            commands::pi_settings_save(a["settings"].clone()).await?;
            Ok(Value::Null)
        }
        "app_config_get" => {
            serde_json::to_value(commands::app_config_get(app.clone())?).map_err(|e| e.to_string())
        }
        "app_config_save" => {
            let mut cfg = commands::app_config_get(app.clone())?;
            cfg.last_project = a["config"]["lastProject"].as_str().map(str::to_owned);
            commands::app_config_save(app.clone(), cfg)?;
            Ok(Value::Null)
        }
        "pi_detect" => Ok(serde_json::to_value(
            commands::pi_detect(commands::app_config_get(app.clone())?.pi_path).await,
        )
        .unwrap()),
        "trust_status" => commands::trust_status(text("project")?).await,
        "trust_save" => {
            commands::trust_save(
                text("project")?,
                a["trusted"].as_bool().ok_or("Missing trusted")?,
                a["trustParent"].as_bool().unwrap_or(false),
            )
            .await
        }
        "rpc_spawn" => {
            commands::rpc_spawn(
                app.clone(),
                state,
                text("project")?,
                a["sessionFile"].as_str().map(str::to_owned),
                a["runtimeId"].as_str().map(str::to_owned),
                serde_json::from_value(a["workspace"].clone()).map_err(|e| e.to_string())?,
            )
            .await?;
            Ok(Value::Null)
        }
        "rpc_sessions" => Ok(json!(rpc::list(&state).await)),
        "rpc_running" => Ok(json!(rpc::running(&state, a["runtimeId"].as_str()).await)),
        "rpc_kill" => {
            rpc::kill(&state, a["runtimeId"].as_str()).await?;
            Ok(Value::Null)
        }
        "rpc_request" => rpc::request(&state, a["command"].clone(), a["runtimeId"].as_str()).await,
        // A remote browser cannot open host files. Export either the requested
        // saved session directly or the active runtime, then return its HTML.
        "session_export_html" => {
            let (path, temporary) = if let Some(file) = a["file"].as_str() {
                (commands::session_export_file(file.to_owned(), None).await?, true)
            } else {
                let response = rpc::request(&state, json!({"type": "export_html"}), a["runtimeId"].as_str()).await?;
                if response["success"] != true {
                    return Err(response["error"].as_str().unwrap_or("Export failed").to_owned());
                }
                (response["data"]["path"].as_str().ok_or("Export returned no path")?.to_owned(), false)
            };
            let html = std::fs::read_to_string(&path).map_err(|e| format!("Cannot read exported HTML: {e}"));
            if temporary { let _ = std::fs::remove_file(&path); }
            let download_name = if temporary {
                let file = a["file"].as_str().ok_or("Missing session file")?;
                let stem = std::path::Path::new(file).file_stem().and_then(|s| s.to_str()).ok_or("Invalid session name")?;
                format!("pi-session-{stem}.html")
            } else { path };
            Ok(json!({"path": download_name, "html": html?}))
        }
        "rpc_notify" => {
            rpc::notify(&state, a["command"].clone(), a["runtimeId"].as_str()).await?;
            Ok(Value::Null)
        }
        "session_generate_title" => {
            let title = crate::title_generation::session_generate_title(app.clone(), text("file")?, text("message")?).await?;
            Ok(serde_json::to_value(title).map_err(|e| e.to_string())?)
        }
        "session_update" => {
            crate::sessions::session_update(app.clone(), text("file")?, a["title"].as_str().map(String::from), a["archived"].as_bool().ok_or("缺少 archived")?).await?;
            Ok(Value::Null)
        }
        "workspace_git_info" => Ok(serde_json::to_value(crate::workspace_git::workspace_git_info(text("project")?).await?).map_err(|e| e.to_string())?),
        "workspace_git_create" => Ok(Value::String(crate::workspace_git::workspace_git_create(text("project")?, text("branch")?, a["worktree"].as_bool().ok_or("缺少 worktree")?).await?)),
        "session_list" => {
            Ok(serde_json::to_value(commands::session_list(text("project")?).await?).unwrap())
        }
        "search_files" => Ok(serde_json::to_value(
            commands::search_files(text("project")?, text("query")?).await?,
        )
        .unwrap()),
        "package_catalog" => Ok(serde_json::to_value(
            crate::packages::package_catalog(
                a["query"].as_str().map(str::to_owned),
                a["sort"].as_str().map(str::to_owned),
                a["packageType"].as_str().map(str::to_owned),
                a["page"].as_u64().and_then(|page| u32::try_from(page).ok()),
            )
            .await?,
        )
        .map_err(|e| e.to_string())?),
        "package_list" => Ok(serde_json::to_value(crate::packages::package_list(
            a["project"].as_str().map(str::to_owned),
        ))
        .map_err(|e| e.to_string())?),
        "package_install" => Ok(Value::String(
            crate::packages::package_install(
                app.clone(),
                text("source")?,
                a["scope"].as_str().map(str::to_owned),
                a["project"].as_str().map(str::to_owned),
            )
            .await?,
        )),
        "package_remove" => Ok(Value::String(
            crate::packages::package_remove(
                app.clone(),
                text("source")?,
                a["scope"].as_str().map(str::to_owned),
                a["project"].as_str().map(str::to_owned),
            )
            .await?,
        )),
        "package_update" => Ok(Value::String(
            crate::packages::package_update(app.clone(), a["source"].as_str().map(str::to_owned))
                .await?,
        )),
        "detect_editors" => Ok(serde_json::to_value(crate::editor::detect_editors()).unwrap()),
        "editor_icons" => Ok(serde_json::to_value(crate::editor_icon::editor_icons().await?).unwrap()),
        _ => Err("此操作仅可在桌面端执行".into()),
    }
}
#[derive(Deserialize)]
struct Auth {
    token: String,
}
async fn events(
    State(web): State<WebState>,
    Query(auth): Query<Auth>,
    ws: WebSocketUpgrade,
) -> Response {
    if !authorized(&web, &auth.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let mut rx = web.app.state::<RemoteState>().events.subscribe();
    let mut stop = web.stop.clone();
    ws.on_upgrade(move |mut socket| async move {
        loop { tokio::select! {
            _ = stop.changed() => break,
            msg = socket.recv() => if !matches!(msg, Some(Ok(_))) { break; },
            event = rx.recv() => match event {
                Ok(v) => if socket.send(Message::Text(v.to_string().into())).await.is_err() { break; },
                Err(_) => break,
            }
        } }
        let _ = socket.send(Message::Close(None)).await;
    })
}
async fn asset(uri: Uri) -> Response {
    let p = uri.path().trim_start_matches('/');
    let p = if p.is_empty() { "index.html" } else { p };
    match embedded_asset(p) {
        Some(file) => (
            [
                (
                    "content-type",
                    mime_guess::from_path(p).first_or_octet_stream().to_string(),
                ),
                ("cache-control", "no-store".into()),
                ("referrer-policy", "no-referrer".into()),
            ],
            file,
        )
            .into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    }
}
pub fn emit(app: &AppHandle, name: &str, payload: Value) {
    use tauri::Emitter;
    let _ = app.emit(name, &payload);
    let _ = app
        .state::<RemoteState>()
        .events
        .send(json!({"event": name, "payload": payload}));
}

/// Constant-time byte comparison so token validity cannot be probed via
/// timing side channels over the network.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn valid_token(expected: &str, supplied: &str, stopped: bool) -> bool {
    !stopped && !expected.is_empty() && constant_time_eq(expected, supplied)
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
    #[test]
    fn token_compare_is_constant_time_and_correct() {
        assert!(constant_time_eq("secret", "secret"));
        assert!(!constant_time_eq("secret", "secreT"));
        assert!(!constant_time_eq("secret", "secret "));
        assert!(!constant_time_eq("", ""));
    }
    #[test]
    fn token_required_and_revoked_on_shutdown() {
        assert!(valid_token("secret", "secret", false));
        assert!(!valid_token("secret", "", false));
        assert!(!valid_token("secret", "wrong", false));
        assert!(!valid_token("secret", "secret", true));
        assert!(!valid_token("", "", false));
    }
    #[tokio::test]
    async fn embedded_page_and_missing_assets() {
        assert_eq!(asset("/".parse().unwrap()).await.status(), StatusCode::OK);
        assert_eq!(
            asset("/not-a-file.js".parse().unwrap()).await.status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            asset("/../Cargo.toml".parse().unwrap()).await.status(),
            StatusCode::NOT_FOUND
        );
    }
}
