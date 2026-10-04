//! Axum routes and handlers: authentication status, invoke dispatch,
//! WebSocket event stream (first-frame authentication) and the embedded SPA.

use super::{auth, dispatch, RemoteState, WebState};
use axum::{
    extract::{
        ws::{CloseFrame, Message},
        State, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::{any, get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::Manager;

include!(concat!(env!("OUT_DIR"), "/web_assets.rs"));

pub(super) fn router(web: WebState) -> Router {
    Router::new()
        .route("/api/auth", get(auth_status))
        .route("/api/auth/login", post(auth::password_login))
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
        .fallback(spa_fallback)
        .with_state(web)
}

async fn auth_status(State(web): State<WebState>, headers: HeaderMap) -> impl IntoResponse {
    (
        [("cache-control", "no-store")],
        Json(json!({
            "passwordEnabled": web.password_hash.is_some(),
            "authenticated": auth::authorized(&web, auth::bearer(&headers)),
        })),
    )
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
    let token = auth::bearer(&headers);
    if !auth::authorized(&web, token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let result = dispatch::dispatch(&web.app, &call.command, call.args).await;
    match result {
        Ok(v) => Json(json!({"data": v})).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
struct Auth {
    token: String,
}
/// How long the server waits for the authentication frame after the upgrade
/// before dropping the socket.
const WS_AUTH_GRACE: Duration = Duration::from_secs(10);

/// Extract the token from the client's first WebSocket frame. Authentication
/// rides on this frame instead of the URL query string, which would leak the
/// token into browser history and proxy logs (access_url deliberately puts
/// the token in the fragment for the same reason).
fn first_frame_token(frame: Option<Message>) -> Option<String> {
    match frame {
        Some(Message::Text(text)) => serde_json::from_str::<Auth>(&text).ok().map(|a| a.token),
        _ => None,
    }
}

async fn events(State(web): State<WebState>, ws: WebSocketUpgrade) -> Response {
    let mut rx = web.app.state::<RemoteState>().events.subscribe();
    let mut stop = web.stop.clone();
    ws.on_upgrade(move |mut socket| async move {
        // The upgrade itself is unauthenticated; the client must send
        // {"token": "..."} as its first frame before any events flow.
        let frame = tokio::time::timeout(WS_AUTH_GRACE, socket.recv())
            .await
            .ok()
            .and_then(|inner| inner.and_then(|result| result.ok()));
        let authorized = first_frame_token(frame)
            .is_some_and(|token| auth::valid_token(&web.token, &token, *web.stop.borrow()));
        if !authorized {
            let _ = socket
                .send(Message::Close(Some(CloseFrame {
                    code: 1008,
                    reason: "unauthorized".into(),
                })))
                .await;
            return;
        }
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
/// Fallback for unmatched paths: `/api/*` must not fall through to the SPA
/// index page (a failed API call would get 200 HTML), so those get a JSON
/// 404; everything else keeps serving the embedded SPA assets.
async fn spa_fallback(uri: Uri) -> Response {
    if uri.path().starts_with("/api/") {
        return (StatusCode::NOT_FOUND, Json(json!({"error": "notFound"}))).into_response();
    }
    asset(uri).await
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ws_first_frame_token_requires_json_payload() {
        let ok = Message::Text(json!({"token": "secret"}).to_string().into());
        assert_eq!(first_frame_token(Some(ok)), Some("secret".to_owned()));
        // 裸字符串、二进制帧与空帧都不通过认证。
        assert_eq!(first_frame_token(Some(Message::Text("secret".into()))), None);
        assert_eq!(first_frame_token(Some(Message::Binary(vec![1].into()))), None);
        assert_eq!(first_frame_token(None), None);
    }

    #[tokio::test]
    async fn api_fallback_returns_json_404_for_api_paths() {
        let resp = spa_fallback("/api/missing-endpoint".parse().unwrap()).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
        assert_eq!(resp.headers().get("content-type").unwrap(), "application/json");
        // 非 API 路径保持 SPA fallback 逻辑（缺失资源仍返回 404）。
        let resp = spa_fallback("/not-a-file.js".parse().unwrap()).await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
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
