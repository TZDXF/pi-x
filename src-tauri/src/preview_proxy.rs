//! Loopback reverse proxy backing the built-in browser panel.
//!
//! The panel renders pages in a plain `<iframe>` pointed at this proxy. The
//! target URL is embedded in the proxy path (`{root}/{secret}/{scheme}/{host}/{path}`)
//! so relative URLs inside the page keep resolving against the proxy. That lets
//! us inject the capture bridge, strip framing blocks (X-Frame-Options/CSP) and
//! preview pages on any host, including dev servers reachable only from this
//! machine — which is also what makes the panel usable through remote access.
//!
//! Target cookies are kept in a server-side jar and never exposed to the
//! browser (Set-Cookie is stripped), so sites proxied through the same origin
//! cannot read or overwrite each other's state. Following kandev's ADR on
//! trusted HTML previews, the preview executes the target page's code and is
//! not a sandbox for hostile content.

use axum::{
    body::Body,
    extract::ws::{WebSocket, WebSocketUpgrade},
    extract::{FromRequestParts, Request},
    http::{header, HeaderName, StatusCode},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::OnceCell;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const BRIDGE_JS: &str = include_str!("preview_bridge.js");
/// Route root on the dedicated loopback server.
const DESKTOP_ROOT: &str = "/p";
/// Route root mounted by the remote access server.
const REMOTE_ROOT: &str = "/api/preview";

struct ProxyState {
    secret: String,
    client: reqwest::Client,
}
static PROXY: OnceLock<ProxyState> = OnceLock::new();
static SERVER_BASE: OnceCell<String> = OnceCell::const_new();

fn proxy() -> &'static ProxyState {
    init()
}

/// Eagerly creates the shared secret and HTTP client; safe to call repeatedly.
fn init() -> &'static ProxyState {
    PROXY.get_or_init(|| ProxyState {
        secret: uuid::Uuid::new_v4().simple().to_string(),
        client: reqwest::Client::builder()
            // Redirects are passed through with a rewritten Location header so
            // the browser keeps resolving relative URLs against the proxy.
            .redirect(reqwest::redirect::Policy::none())
            .cookie_store(true)
            .connect_timeout(Duration::from_secs(15))
            .build()
            .expect("preview proxy http client"),
    })
}

pub fn secret() -> &'static str {
    &proxy().secret
}

/// Starts (once) the loopback server and returns its base URL, e.g.
/// `http://127.0.0.1:PORT/p/SECRET`.
pub async fn desktop_base() -> Result<String, String> {
    init();
    SERVER_BASE
        .get_or_try_init(|| async {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let base = format!("http://127.0.0.1:{port}{DESKTOP_ROOT}/{}", secret());
            tauri::async_runtime::spawn(async move {
                let _ = axum::serve(listener, router()).await;
            });
            Ok::<String, String>(base)
        })
        .await
        .cloned()
}

fn router() -> Router {
    Router::new().route(&format!("{DESKTOP_ROOT}/{{*rest}}"), any(handle))
}

#[tauri::command]
pub async fn preview_proxy_info() -> Result<Value, String> {
    Ok(json!({ "base": desktop_base().await? }))
}

/// Same handler as the loopback server; mounted by remote access under
/// `/api/preview/...` so browsers on other devices can reach pages that only
/// this machine can see.
#[cfg_attr(not(feature = "remote-access"), allow(dead_code))]
pub async fn remote_handle(req: Request) -> Response {
    handle(req).await
}

struct Target {
    prefix: String,
    scheme: String,
    host: String,
    path: String,
}

/// Parses `{root}/{secret}/{scheme}/{host}[/{path}]` out of the raw request
/// path. Returns the prefix (everything up to the secret) used to build
/// absolute proxy URLs back into the page (bridge script, rewritten redirects).
fn parse_target(root: &str, raw_path: &str) -> Option<Target> {
    let rest = raw_path.strip_prefix(root)?.strip_prefix('/')?;
    let mut parts = rest.splitn(4, '/');
    if !constant_time_eq(parts.next()?, &proxy().secret) {
        return None;
    }
    let scheme = parts.next()?.to_ascii_lowercase();
    let host = parts.next()?.to_string();
    if host.is_empty() || (scheme != "http" && scheme != "https") {
        return None;
    }
    Some(Target {
        prefix: format!("{root}/{}", proxy().secret),
        path: parts.next().unwrap_or("").to_string(),
        scheme,
        host,
    })
}

async fn handle(req: Request) -> Response {
    let root = if req.uri().path().starts_with(REMOTE_ROOT) { REMOTE_ROOT } else { DESKTOP_ROOT };
    // The bridge script sits directly under the secret; parse it before the
    // scheme/host/path grammar (which would reject "bridge.js" as a scheme).
    if let Some(rest) = req.uri().path().strip_prefix(root).and_then(|r| r.strip_prefix('/')) {
        if let Some((secret, "bridge.js")) = rest.split_once('/') {
            if *req.method() == axum::http::Method::GET && constant_time_eq(secret, &proxy().secret) {
                return bridge_js();
            }
            return StatusCode::NOT_FOUND.into_response();
        }
    }
    let Some(target) = parse_target(root, req.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if is_websocket_upgrade(&req) {
        let (mut parts, _) = req.into_parts();
        return match WebSocketUpgrade::from_request_parts(&mut parts, &()).await {
            Ok(ws) => forward_ws(ws, &target).await,
            Err(err) => err.into_response(),
        };
    }
    forward_http(req, &target).await
}

fn bridge_js() -> Response {
    (
        [
            ("content-type", "application/javascript; charset=utf-8"),
            ("cache-control", "no-store"),
        ],
        BRIDGE_JS,
    )
        .into_response()
}

/// Constant-time byte comparison so the proxy secret cannot be probed via
/// timing side channels over the network.
fn constant_time_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.is_empty() || a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn is_websocket_upgrade(req: &Request) -> bool {
    req.headers()
        .get(header::CONNECTION)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("upgrade"))
        .unwrap_or(false)
        && req.headers().contains_key(header::UPGRADE)
}

// Hop-by-hop headers must not be forwarded; the rest is rewritten below.
const REQUEST_SKIP: [&str; 13] = [
    "host",
    "cookie",
    "connection",
    "keep-alive",
    "proxy-authorization",
    "proxy-authenticate",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "accept-encoding",
    "content-length",
];
const RESPONSE_SKIP: [&str; 14] = [
    "set-cookie",
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "te",
    "trailer",
    "transfer-encoding",
    "content-length",
    "x-frame-options",
    // Framing and isolation headers would block the iframe or the injected
    // bridge; the preview is a trusted-context surface by design.
    "content-security-policy",
    "content-security-policy-report-only",
    "cross-origin-resource-policy",
    "cross-origin-embedder-policy",
    "clear-site-data",
];

fn headers_to_reqwest(map: &axum::http::HeaderMap) -> reqwest::header::HeaderMap {
    let mut out = reqwest::header::HeaderMap::new();
    for (name, value) in map {
        let lower = name.as_str().to_ascii_lowercase();
        if REQUEST_SKIP.contains(&lower.as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(name.as_str().as_bytes()),
            reqwest::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            out.append(name, value);
        }
    }
    // Ask for identity content so HTML can be rewritten without decompressing.
    out.insert(
        reqwest::header::ACCEPT_ENCODING,
        reqwest::header::HeaderValue::from_static("identity"),
    );
    out
}

fn headers_to_axum(map: &reqwest::header::HeaderMap) -> axum::http::HeaderMap {
    let mut out = axum::http::HeaderMap::new();
    for (name, value) in map {
        let lower = name.as_str().to_ascii_lowercase();
        if RESPONSE_SKIP.contains(&lower.as_str()) {
            continue;
        }
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_str().as_bytes()),
            axum::http::header::HeaderValue::from_bytes(value.as_bytes()),
        ) {
            out.append(name, value);
        }
    }
    out
}

fn target_url(target: &Target, query: Option<&str>) -> String {
    let mut url = format!("{}://{}/{}", target.scheme, target.host, target.path);
    if let Some(query) = query {
        if !query.is_empty() {
            url.push('?');
            url.push_str(query);
        }
    }
    url
}

/// Rewrites a redirect target so the browser stays on the proxy origin.
/// Absolute, scheme-relative and relative locations are all normalized
/// against the real target URL first.
fn rewrite_location(location: &str, target: &Target, query: Option<&str>) -> Option<String> {
    let base = url::Url::parse(&target_url(target, query)).ok()?;
    let next = base.join(location).ok()?;
    let host = match next.port() {
        Some(port) => format!("{}:{port}", next.host_str()?),
        None => next.host_str()?.to_string(),
    };
    Some(format!(
        "{}/{}/{}{}{}",
        target.prefix,
        next.scheme(),
        host,
        next.path(),
        next.query().map(|q| format!("?{q}")).unwrap_or_default(),
    ))
}

async fn forward_http(req: Request, target: &Target) -> Response {
    let (parts, body) = req.into_parts();
    let url = target_url(target, parts.uri.query());
    let method = match reqwest::Method::from_bytes(parts.method.as_str().as_bytes()) {
        Ok(method) => method,
        Err(_) => return StatusCode::METHOD_NOT_ALLOWED.into_response(),
    };
    let mut headers = headers_to_reqwest(&parts.headers);
    // Present the target's origin to it instead of the proxy origin so CSRF
    // checks inside the previewed page keep behaving. Only when the browser
    // actually sent one (GET navigations normally have no Origin).
    if parts.headers.contains_key(header::ORIGIN) {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&format!("{}://{}", target.scheme, target.host)) {
            headers.insert(reqwest::header::ORIGIN, value);
        }
    }
    if let Some(referer) = rewrite_referer(&parts, target) {
        if let Ok(value) = reqwest::header::HeaderValue::from_str(&referer) {
            headers.insert(reqwest::header::REFERER, value);
        }
    }
    let request = proxy()
        .client
        .request(method, url)
        .headers(headers)
        .body(reqwest::Body::wrap_stream(body.into_data_stream()));
    let response = match request.send().await {
        Ok(response) => response,
        Err(_) => {
            return (
                StatusCode::BAD_GATEWAY,
                "PiX preview proxy: failed to reach the target host",
            )
                .into_response()
        }
    };
    let status = StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let mut builder = Response::builder().status(status);
    let response_headers = headers_to_axum(response.headers());
    for (name, value) in response_headers.iter() {
        builder = builder.header(name, value);
    }
    if status.is_redirection() {
        if let Some(location) = response
            .headers()
            .get(header::LOCATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|location| rewrite_location(location, target, parts.uri.query()))
            .and_then(|rewritten| axum::http::header::HeaderValue::from_str(&rewritten).ok())
        {
            builder = builder.header(header::LOCATION, location);
        }
    }
    let is_html = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase().contains("text/html"))
        .unwrap_or(false);
    if is_html {
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        return builder
            .body(Body::from(inject_bridge(&bytes, &target.prefix)))
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    }
    builder
        .body(Body::from_stream(response.bytes_stream()))
        .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response())
}

/// Maps a proxy-origin referer back onto the target origin.
fn rewrite_referer(parts: &axum::http::request::Parts, target: &Target) -> Option<String> {
    let raw = parts.headers.get(header::REFERER)?.to_str().ok()?;
    let parsed = url::Url::parse(raw).ok()?;
    let rest = parsed.path().strip_prefix(&format!("{}/", target.prefix))?;
    let mut segments = rest.splitn(3, '/');
    let scheme = segments.next()?.to_ascii_lowercase();
    let host = segments.next()?.to_string();
    if (scheme != "http" && scheme != "https") || host.is_empty() {
        return None;
    }
    Some(format!(
        "{}://{}{}{}",
        scheme,
        host,
        segments.next().map(|path| format!("/{path}")).unwrap_or_else(|| "/".to_string()),
        parsed.query().map(|q| format!("?{q}")).unwrap_or_default(),
    ))
}

/// Injects the bridge script into the first closing body/html tag; pages
/// without either still get it appended so the panel keeps working.
fn inject_bridge(html: &[u8], prefix: &str) -> Vec<u8> {
    let script = format!(r#"<script src="{prefix}/bridge.js"></script>"#);
    for marker in [b"</body>".as_slice(), b"</html>".as_slice()] {
        if let Some(pos) = find_case_insensitive(html, marker) {
            let mut out = Vec::with_capacity(html.len() + script.len());
            out.extend_from_slice(&html[..pos]);
            out.extend_from_slice(script.as_bytes());
            out.extend_from_slice(&html[pos..]);
            return out;
        }
    }
    let mut out = Vec::with_capacity(html.len() + script.len() + 1);
    out.extend_from_slice(html);
    out.extend_from_slice(b"\n");
    out.extend_from_slice(script.as_bytes());
    out
}

fn find_case_insensitive(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    haystack
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

async fn forward_ws(ws: WebSocketUpgrade, target: &Target) -> Response {
    let scheme = if target.scheme == "https" { "wss" } else { "ws" };
    let url = format!("{}://{}/{}", scheme, target.host, target.path);
    // A None connector lets tokio-tungstenite pick its rustls config with
    // webpki roots (enabled by the feature), covering both ws:// and wss://.
    ws.on_upgrade(move |socket| async move {
        let remote = match tokio_tungstenite::connect_async_tls_with_config(&url, None, false, None).await {
            Ok((stream, _)) => stream,
            Err(_) => return,
        };
        pump(socket, remote).await;
    })
}

/// Pumps frames both ways until either side closes; only Vite-style dev
/// servers are expected on this path, so minimal conversion suffices.
async fn pump(socket: WebSocket, remote: tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>) {
    let (mut client_sink, mut client_stream) = socket.split();
    let (mut remote_sink, mut remote_stream) = remote.split();
    let to_remote = async move {
        while let Some(Ok(message)) = client_stream.next().await {
            let close = matches!(message, axum::extract::ws::Message::Close(_));
            match to_tungstenite(message) {
                Some(message) => {
                    if remote_sink.send(message).await.is_err() {
                        break;
                    }
                }
                None => break,
            }
            if close {
                break;
            }
        }
        let _ = remote_sink.close().await;
    };
    let to_client = async move {
        while let Some(Ok(message)) = remote_stream.next().await {
            let close = message.is_close();
            match to_axum(message) {
                Some(message) => {
                    if client_sink.send(message).await.is_err() {
                        break;
                    }
                }
                None => break,
            }
            if close {
                break;
            }
        }
        let _ = client_sink.close().await;
    };
    tokio::join!(to_remote, to_client);
}

fn to_tungstenite(message: axum::extract::ws::Message) -> Option<WsMessage> {
    match message {
        axum::extract::ws::Message::Text(text) => Some(WsMessage::Text(text.to_string().into())),
        axum::extract::ws::Message::Binary(bytes) => Some(WsMessage::Binary(bytes.to_vec().into())),
        axum::extract::ws::Message::Ping(bytes) => Some(WsMessage::Ping(bytes.to_vec().into())),
        axum::extract::ws::Message::Pong(bytes) => Some(WsMessage::Pong(bytes.to_vec().into())),
        axum::extract::ws::Message::Close(_) => None,
    }
}

fn to_axum(message: WsMessage) -> Option<axum::extract::ws::Message> {
    match message {
        WsMessage::Text(text) => Some(axum::extract::ws::Message::Text(text.to_string().into())),
        WsMessage::Binary(bytes) => Some(axum::extract::ws::Message::Binary(bytes.to_vec().into())),
        WsMessage::Ping(bytes) => Some(axum::extract::ws::Message::Ping(bytes.to_vec().into())),
        WsMessage::Pong(bytes) => Some(axum::extract::ws::Message::Pong(bytes.to_vec().into())),
        WsMessage::Close(frame) => Some(axum::extract::ws::Message::Close(frame.map(|frame| {
            axum::extract::ws::CloseFrame {
                code: frame.code.into(),
                reason: frame.reason.to_string().into(),
            }
        }))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request as HttpRequest;

    fn target_for(path: &str) -> Target {
        init();
        parse_target(DESKTOP_ROOT, path).expect("valid target")
    }

    fn proxied(path: &str) -> String {
        init();
        format!("{DESKTOP_ROOT}/{}", secret())
            + path
    }

    #[test]
    fn parses_scheme_host_and_path_from_raw_proxy_path() {
        let target = target_for(&proxied("/http/127.0.0.1:5173/app/page.html"));
        assert_eq!(target.scheme, "http");
        assert_eq!(target.host, "127.0.0.1:5173");
        assert_eq!(target.path, "app/page.html");
        assert_eq!(target.prefix, format!("{DESKTOP_ROOT}/{}", secret()));
    }

    #[test]
    fn missing_page_path_defaults_to_root() {
        let target = target_for(&proxied("/https/example.com"));
        assert_eq!(target.path, "");
        assert_eq!(target.host, "example.com");
    }

    #[test]
    fn rejects_wrong_secret_and_bad_schemes() {
        init();
        assert!(parse_target(DESKTOP_ROOT, "/p/wrong-secret/http/localhost/").is_none());
        assert!(parse_target(DESKTOP_ROOT, &proxied("/ftp/localhost/")).is_none());
        assert!(parse_target(DESKTOP_ROOT, &proxied("/http/")).is_none());
        assert!(parse_target(DESKTOP_ROOT, "/unrelated").is_none());
    }

    #[test]
    fn builds_target_url_with_query() {
        let target = target_for(&proxied("/http/localhost:3000"));
        assert_eq!(target_url(&target, Some("a=1&b=%2F")), "http://localhost:3000/?a=1&b=%2F");
        assert_eq!(target_url(&target, None), "http://localhost:3000/");
    }

    #[test]
    fn rewrites_redirect_locations_back_into_the_proxy() {
        let target = target_for(&proxied("/http/localhost:3000/app"));
        let secret = secret().to_string();
        assert_eq!(
            rewrite_location("/login?next=/app", &target, None).unwrap(),
            format!("/p/{secret}/http/localhost:3000/login?next=/app")
        );
        assert_eq!(
            rewrite_location("https://other.example.org/a/b", &target, None).unwrap(),
            format!("/p/{secret}/https/other.example.org/a/b")
        );
        assert_eq!(
            rewrite_location("section", &target, None).unwrap(),
            format!("/p/{secret}/http/localhost:3000/section")
        );
        // Default ports are already omitted by the url crate.
        assert_eq!(
            rewrite_location("https://example.com/", &target, None).unwrap(),
            format!("/p/{secret}/https/example.com/")
        );
    }

    #[test]
    fn strips_framing_blocks_and_cookies_from_responses() {
        let mut source = reqwest::header::HeaderMap::new();
        source.insert("x-frame-options", "DENY".parse().unwrap());
        source.insert("content-security-policy", "default-src 'none'".parse().unwrap());
        source.insert("set-cookie", "sid=1".parse().unwrap());
        source.insert("content-type", "text/html".parse().unwrap());
        let out = headers_to_axum(&source);
        assert!(out.get("x-frame-options").is_none());
        assert!(out.get("content-security-policy").is_none());
        assert!(out.get("set-cookie").is_none());
        assert_eq!(out.get("content-type").unwrap(), "text/html");
    }

    #[test]
    fn never_forwards_browser_cookies_or_host() {
        let mut source = axum::http::HeaderMap::new();
        source.insert("host", "127.0.0.1:1".parse().unwrap());
        source.insert("cookie", "sid=app".parse().unwrap());
        source.insert("accept-encoding", "gzip".parse().unwrap());
        let out = headers_to_reqwest(&source);
        assert!(out.get("host").is_none());
        assert!(out.get("cookie").is_none());
        assert_eq!(out.get("accept-encoding").unwrap(), "identity");
    }

    #[test]
    fn injects_the_bridge_before_the_closing_body_tag() {
        let injected = inject_bridge(b"<html><body><p>hi</p></body></html>", "/p/secret");
        assert_eq!(
            String::from_utf8(injected).unwrap(),
            r#"<html><body><p>hi</p><script src="/p/secret/bridge.js"></script></body></html>"#
        );
        // Case-insensitive fallback.
        let injected = inject_bridge(b"<html><BODY></BODY></HTML>", "/p/secret");
        assert!(String::from_utf8(injected).unwrap().contains(r#"<script src="/p/secret/bridge.js"></script>"#));
        // Pages without closing tags still receive the bridge.
        let injected = inject_bridge(b"<html><body><p>truncated", "/p/secret");
        assert!(String::from_utf8(injected).unwrap().ends_with(r#"<script src="/p/secret/bridge.js"></script>"#));
    }

    #[test]
    fn maps_proxy_referer_back_to_the_target_origin() {
        let target = target_for(&proxied("/http/localhost:5173/app"));
        let secret = secret().to_string();
        let request = HttpRequest::builder()
            .method("GET")
            .uri(format!("http://127.0.0.1:9/p/{secret}/http/localhost:5173/app"))
            .header(
                header::REFERER,
                format!("http://127.0.0.1:9/p/{secret}/http/localhost:5173/app/page"),
            )
            .body(Body::empty())
            .unwrap();
        let (parts, _) = request.into_parts();
        assert_eq!(rewrite_referer(&parts, &target).unwrap(), "http://localhost:5173/app/page");
        let request = HttpRequest::builder()
            .method("GET")
            .uri("http://127.0.0.1:9/")
            .body(Body::empty())
            .unwrap();
        let (parts, _) = request.into_parts();
        assert!(rewrite_referer(&parts, &target).is_none());
    }

    #[test]
    fn websocket_upgrade_detection() {
        let request = HttpRequest::builder()
            .method("GET")
            .uri("http://127.0.0.1:9/")
            .header(header::CONNECTION, "Upgrade")
            .header(header::UPGRADE, "websocket")
            .body(Body::empty())
            .unwrap();
        assert!(is_websocket_upgrade(&request));
        let request = HttpRequest::builder()
            .method("GET")
            .uri("http://127.0.0.1:9/")
            .body(Body::empty())
            .unwrap();
        assert!(!is_websocket_upgrade(&request));
    }

    // End-to-end: loopback server forwards to a stub target, injects the
    // bridge into the HTML and rejects unknown secrets.
    #[tokio::test]
    async fn proxies_pages_and_injects_the_bridge_end_to_end() {
        use axum::routing::get;

        let target = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let target_port = target.local_addr().unwrap().port();
        let app = Router::new().route(
            "/",
            get(|| async { axum::response::Html("<html><body><h1>dev</h1></body></html>") }),
        );
        tokio::spawn(async move { axum::serve(target, app).await.unwrap() });

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router()).await.unwrap() });

        let page = reqwest::get(format!(
            "http://127.0.0.1:{proxy_port}/p/{}/http/127.0.0.1:{target_port}/",
            secret()
        ))
        .await
        .unwrap();
        assert_eq!(page.status(), 200);
        let body = page.text().await.unwrap();
        assert!(body.contains("<h1>dev</h1>"));
        assert!(body.contains(&format!("<script src=\"/p/{}/bridge.js\"></script>", secret())));

        let bridge = reqwest::get(format!("http://127.0.0.1:{proxy_port}/p/{}/bridge.js", secret()))
            .await
            .unwrap();
        assert_eq!(bridge.status(), 200);
        assert!(bridge.text().await.unwrap().contains("pix-preview"));

        let stranger = reqwest::get(format!(
            "http://127.0.0.1:{proxy_port}/p/not-the-secret/http/127.0.0.1:{target_port}/"
        ))
        .await
        .unwrap();
        assert_eq!(stranger.status(), 404);
        let stranger_bridge =
            reqwest::get(format!("http://127.0.0.1:{proxy_port}/p/not-the-secret/bridge.js")).await.unwrap();
        assert_eq!(stranger_bridge.status(), 404);
    }
}
