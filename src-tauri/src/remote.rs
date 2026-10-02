use crate::{
    commands,
    errors::{pix_error, pix_error_with},
    rpc,
};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{connect_info::ConnectInfo, ws::Message, Query, State, WebSocketUpgrade},
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use tokio::sync::{broadcast, watch, Semaphore};

include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

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
    password_hash: Option<String>,
    login_attempts: Arc<Mutex<HashMap<IpAddr, LoginAttempt>>>,
    login_slots: Arc<Semaphore>,
}

struct LoginAttempt {
    count: u8,
    since: Instant,
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
    let listener = if enabled && !same {
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
            password_hash: settings.password_hash.clone(),
            login_attempts: Arc::new(Mutex::new(HashMap::new())),
            login_slots: Arc::new(Semaphore::new(4)),
        };
        let router = Router::new()
            .route("/api/auth", get(auth_status))
            .route("/api/auth/login", post(password_login))
            .route("/api/invoke", post(invoke))
            .route("/api/events", get(events))
            // Built-in browser panel proxy. Auth rides on the per-boot proxy
            // secret embedded in the path (returned only through authorized
            // invoke calls); it is scoped to these routes and cannot be used
            // against /api/invoke.
            .route(
                "/api/preview/{*rest}",
                any(crate::preview_proxy::remote_handle),
            )
            .fallback(asset)
            .with_state(web);
        *state.server.lock().unwrap() = Some(Server {
            settings,
            token,
            stop,
        });
        tauri::async_runtime::spawn(async move {
            let _ = axum::serve(
                listener,
                router.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = stopped.changed().await;
            })
            .await;
        });
    }
    Ok(remote_status(app.clone()))
}

#[tauri::command]
pub async fn remote_password_set(
    app: AppHandle,
    password: Option<String>,
) -> Result<Value, String> {
    let state = app.state::<RemoteState>();
    let _operation = state.operation.lock().await;
    if state.server.lock().unwrap().is_some() {
        return Err(pix_error(
            "disableLanBeforePasswordChange",
            "请先关闭局域网访问，再修改密码",
        ));
    }
    let password_hash = match password {
        Some(password) => {
            if password.chars().count() < 8 || password.len() > 128 {
                return Err(pix_error(
                    "passwordLengthInvalid",
                    "密码至少 8 个字符，且不超过 128 字节",
                ));
            }
            Some(
                tokio::task::spawn_blocking(move || {
                    let salt = SaltString::generate(&mut OsRng);
                    Argon2::default()
                        .hash_password(password.as_bytes(), &salt)
                        .map(|hash| hash.to_string())
                        .map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())??,
            )
        }
        None => None,
    };
    let mut settings = load(&app);
    settings.password_hash = password_hash;
    let p = path(&app)?;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(p, serde_json::to_vec(&settings).unwrap()).map_err(|e| e.to_string())?;
    Ok(remote_status(app.clone()))
}

fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("")
}

async fn auth_status(State(web): State<WebState>, headers: HeaderMap) -> impl IntoResponse {
    (
        [("cache-control", "no-store")],
        Json(json!({
            "passwordEnabled": web.password_hash.is_some(),
            "authenticated": authorized(&web, bearer(&headers)),
        })),
    )
}

#[derive(Deserialize)]
struct LoginInput {
    password: String,
}

// Bound both the number of password guesses and the number of tracked clients.
fn login_allowed(attempts: &mut HashMap<IpAddr, LoginAttempt>, ip: IpAddr, now: Instant) -> bool {
    const WINDOW: Duration = Duration::from_secs(60);
    attempts.retain(|_, entry| now.duration_since(entry.since) < WINDOW);
    if !attempts.contains_key(&ip) && attempts.len() >= 256 {
        return false;
    }
    let entry = attempts.entry(ip).or_insert(LoginAttempt {
        count: 0,
        since: now,
    });
    if entry.count >= 5 {
        return false;
    }
    entry.count += 1;
    true
}

async fn password_login(
    State(web): State<WebState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(input): Json<LoginInput>,
) -> Response {
    let Some(hash) = &web.password_hash else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if input.password.len() > 128 {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    {
        let mut attempts = web.login_attempts.lock().unwrap();
        if !login_allowed(&mut attempts, addr.ip(), Instant::now()) {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    }
    let Ok(_slot) = web.login_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let hash = hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).ok().is_some_and(|parsed| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &parsed)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !valid || *web.stop.borrow() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    web.login_attempts.lock().unwrap().remove(&addr.ip());
    (
        [("cache-control", "no-store")],
        Json(json!({"token": web.token})),
    )
        .into_response()
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
    let token = bearer(&headers);
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
            // 远程端只能改工作区偏好和内置插件开关，其余应用配置（如 piPath）保持主机现状。
            cfg.projectless_dir = a["config"]["projectlessDir"].as_str().map(str::to_owned);
            cfg.worktree_dir = a["config"]["worktreeDir"].as_str().map(str::to_owned);
            if let Some(enabled) = a["config"]["builtinFileChanges"].as_bool() {
                cfg.builtin_file_changes = Some(enabled);
            }
            commands::app_config_save(app.clone(), cfg)?;
            Ok(Value::Null)
        }
        "projectless_dir_resolve" => Ok(serde_json::to_value(commands::projectless_dir_resolve(
            app.clone(),
        )?)
        .map_err(|e| e.to_string())?),
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
        "pix_log" => {
            crate::logs::write(
                a["runtimeId"].as_str().unwrap_or("ui"),
                a["message"].as_str().unwrap_or(""),
            );
            Ok(Value::Null)
        }
        "rpc_request" => rpc::request(&state, a["command"].clone(), a["runtimeId"].as_str()).await,
        // A remote browser cannot open host files. Export either the requested
        // saved session directly or the active runtime, then return its HTML.
        "session_export_html" => {
            let (path, temporary) = if let Some(file) = a["file"].as_str() {
                (
                    commands::session_export_file(file.to_owned(), None).await?,
                    true,
                )
            } else {
                let response = rpc::request(
                    &state,
                    json!({"type": "export_html"}),
                    a["runtimeId"].as_str(),
                )
                .await?;
                if response["success"] != true {
                    return Err(response["error"]
                        .as_str()
                        .unwrap_or("Export failed")
                        .to_owned());
                }
                (
                    response["data"]["path"]
                        .as_str()
                        .ok_or("Export returned no path")?
                        .to_owned(),
                    false,
                )
            };
            let html = std::fs::read_to_string(&path)
                .map_err(|e| format!("Cannot read exported HTML: {e}"));
            if temporary {
                let _ = std::fs::remove_file(&path);
            }
            let download_name = if temporary {
                let file = a["file"].as_str().ok_or("Missing session file")?;
                let stem = std::path::Path::new(file)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .ok_or("Invalid session name")?;
                format!("pi-session-{stem}.html")
            } else {
                path
            };
            Ok(json!({"path": download_name, "html": html?}))
        }
        "rpc_notify" => {
            rpc::notify(&state, a["command"].clone(), a["runtimeId"].as_str()).await?;
            Ok(Value::Null)
        }
        "session_generate_title" => {
            let title = crate::title_generation::session_generate_title(
                app.clone(),
                text("file")?,
                text("message")?,
            )
            .await?;
            Ok(serde_json::to_value(title).map_err(|e| e.to_string())?)
        }
        "session_update" => {
            crate::sessions::session_update(
                app.clone(),
                text("file")?,
                a["title"].as_str().map(String::from),
                a["archived"]
                    .as_bool()
                    .ok_or_else(|| pix_error("missingArchived", "缺少 archived 参数"))?,
            )
            .await?;
            Ok(Value::Null)
        }
        "session_delete" => {
            crate::sessions::session_delete(text("file")?).await?;
            Ok(Value::Null)
        }
        "session_duplicate" => Ok(Value::String(
            crate::sessions::session_duplicate(text("file")?).await?,
        )),
        "session_last_error" => Ok(serde_json::to_value(
            crate::sessions::session_last_error(text("file")?).await?,
        )
        .map_err(|e| e.to_string())?),
        "session_history" => Ok(Value::Array(
            crate::sessions::session_history(text("file")?).await?,
        )),
        "workspace_git_info" => Ok(serde_json::to_value(
            crate::workspace_git::workspace_git_info(text("project")?).await?,
        )
        .map_err(|e| e.to_string())?),
        "workspace_git_create" => Ok(Value::String(
            crate::workspace_git::workspace_git_create(
                app.clone(),
                text("project")?,
                text("branch")?,
                a["worktree"]
                    .as_bool()
                    .ok_or_else(|| pix_error("missingWorktree", "缺少 worktree 参数"))?,
            )
            .await?,
        )),
        "workspace_git_prepare" => Ok(Value::String(
            crate::workspace_git::workspace_git_prepare(
                app.clone(),
                text("project")?,
                text("branch")?,
                a["worktree"]
                    .as_bool()
                    .ok_or_else(|| pix_error("missingWorktree", "缺少 worktree 参数"))?,
            )
            .await?,
        )),
        "session_revert_changes" => {
            let files: Vec<crate::session_revert::RevertFile> =
                serde_json::from_value(a["files"].clone()).map_err(|e| {
                    pix_error_with(
                        "missingFiles",
                        format!("缺少 files 参数: {e}"),
                        serde_json::json!({ "detail": e.to_string() }),
                    )
                })?;
            Ok(serde_json::to_value(
                crate::session_revert::session_revert_changes(text("project")?, files).await?,
            )
            .map_err(|e| e.to_string())?)
        }
        "session_file_rewind_preview" => {
            let artifacts: Vec<crate::session_file_rewind::FileRewindArtifact> =
                serde_json::from_value(a["artifacts"].clone()).map_err(|e| {
                    pix_error_with(
                        "missingArtifacts",
                        format!("缺少 artifacts 参数: {e}"),
                        serde_json::json!({ "detail": e.to_string() }),
                    )
                })?;
            Ok(serde_json::to_value(
                crate::session_file_rewind::session_file_rewind_preview(
                    text("project")?,
                    artifacts,
                )
                .await?,
            )
            .map_err(|e| e.to_string())?)
        }
        "session_file_rewind_apply" => {
            let artifacts: Vec<crate::session_file_rewind::FileRewindArtifact> =
                serde_json::from_value(a["artifacts"].clone()).map_err(|e| {
                    pix_error_with(
                        "missingArtifacts",
                        format!("缺少 artifacts 参数: {e}"),
                        serde_json::json!({ "detail": e.to_string() }),
                    )
                })?;
            Ok(serde_json::to_value(
                crate::session_file_rewind::session_file_rewind_apply(text("project")?, artifacts)
                    .await?,
            )
            .map_err(|e| e.to_string())?)
        }
        "session_file_rewind_state_get" => Ok(serde_json::to_value(
            crate::session_file_rewind::session_file_rewind_state_get(text("file")?).await?,
        )
        .map_err(|e| e.to_string())?),
        "session_file_rewind_state_mark" => {
            let ids = a["toolCallIds"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            Ok(serde_json::to_value(
                crate::session_file_rewind::session_file_rewind_state_mark(text("file")?, ids)
                    .await?,
            )
            .map_err(|e| e.to_string())?)
        }
        "session_checkpoint_create" => Ok(serde_json::to_value(
            crate::session_checkpoint::session_checkpoint_create(
                text("project")?,
                text("checkpointId")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string())?),
        "session_checkpoint_diff" => Ok(serde_json::to_value(
            crate::session_checkpoint::session_checkpoint_diff(
                text("project")?,
                text("from")?,
                text("to")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string())?),
        "session_checkpoint_restore" => {
            let paths = a["paths"].as_array().map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            });
            let tool_files = a["toolTouchedFiles"].as_array().map(|list| {
                list.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            });
            Ok(serde_json::to_value(
                crate::session_checkpoint::session_checkpoint_restore(
                    text("project")?,
                    text("from")?,
                    text("to")?,
                    paths,
                    tool_files,
                )
                .await?,
            )
            .map_err(|e| e.to_string())?)
        }
        "session_checkpoint_manifest_get" => Ok(serde_json::to_value(
            crate::session_checkpoint::session_checkpoint_manifest_get(text("file")?).await?,
        )
        .map_err(|e| e.to_string())?),
        "session_checkpoint_manifest_set" => {
            crate::session_checkpoint::session_checkpoint_manifest_set(
                text("file")?,
                a["manifest"].clone(),
            )
            .await?;
            Ok(Value::Null)
        }
        "session_checkpoint_manifest_delete" => {
            crate::session_checkpoint::session_checkpoint_manifest_delete(text("file")?).await?;
            Ok(Value::Null)
        }
        "session_checkpoint_content" => Ok(serde_json::to_value(
            crate::session_checkpoint::session_checkpoint_content(
                text("project")?,
                text("oid")?,
                text("path")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string())?),
        "session_list" => {
            Ok(serde_json::to_value(commands::session_list(text("project")?).await?).unwrap())
        }
        "session_list_archived" => {
            Ok(serde_json::to_value(crate::sessions::session_list_archived().await?).unwrap())
        }
        "list_project_directory" => Ok(serde_json::to_value(
            commands::list_project_directory(text("project")?, text("path")?).await?,
        )
        .map_err(|e| e.to_string())?),
        "read_file_preview" => Ok(serde_json::to_value(
            commands::read_file_preview(text("project")?, text("path")?).await?,
        )
        .map_err(|e| e.to_string())?),
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
        "editor_icons" => {
            Ok(serde_json::to_value(crate::editor_icon::editor_icons().await?).unwrap())
        }
        "preview_proxy_info" => {
            Ok(json!({ "base": format!("/api/preview/{}", crate::preview_proxy::secret()) }))
        }
        _ => Err(pix_error("desktopOnlyAction", "此操作仅可在桌面端执行")),
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
    #[test]
    fn login_rate_limit_is_per_address() {
        let mut attempts = HashMap::new();
        let now = Instant::now();
        let first = "192.168.1.5".parse().unwrap();
        let second = "192.168.1.6".parse().unwrap();
        for _ in 0..5 {
            assert!(login_allowed(&mut attempts, first, now));
        }
        assert!(!login_allowed(&mut attempts, first, now));
        assert!(login_allowed(&mut attempts, second, now));
        assert!(login_allowed(
            &mut attempts,
            first,
            now + Duration::from_secs(61)
        ));
    }
    #[test]
    fn password_hash_verifies_only_the_original_password() {
        let salt = SaltString::generate(&mut OsRng);
        let hash = Argon2::default()
            .hash_password(b"test-password", &salt)
            .unwrap()
            .to_string();
        let parsed = PasswordHash::new(&hash).unwrap();
        assert!(Argon2::default()
            .verify_password(b"test-password", &parsed)
            .is_ok());
        assert!(Argon2::default()
            .verify_password(b"wrong-password", &parsed)
            .is_err());
        assert!(!hash.contains("test-password"));
    }
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
