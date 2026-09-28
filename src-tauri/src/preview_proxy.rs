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

/// FNV-1a 64-bit hash for per-host token derivation.
fn fnv1a(s: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in s.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// Derives a per-host token from the shared secret and the target host.
/// The proxy validates `token == fnv1a(secret + host)` so a page previewed on
/// one host cannot use the same token to reach arbitrary loopback services.
fn host_token(secret: &str, host: &str) -> String {
    format!("{:x}", fnv1a(&format!("{}{}", secret, host)))
}

const BRIDGE_JS: &str = include_str!("preview_bridge.js");
/// Route root on the dedicated loopback server.
const DESKTOP_ROOT: &str = "/p";
/// Route root mounted by the remote access server.
const REMOTE_ROOT: &str = "/api/preview";
/// Maximum size for HTML/CSS responses that are buffered for rewriting.
/// Larger responses are passed through without rewriting.
const REWRITE_MAX_BYTES: u64 = 16 * 1024 * 1024;

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

/// Parses `{root}/{token}/{scheme}/{host}[/{path}]` out of the raw request
/// path. The token is `fnv1a(secret + host)` — a per-host capability that
/// prevents a previewed page from using the same token to reach arbitrary
/// loopback services. Returns the prefix (root + token) used to build
/// absolute proxy URLs back into the page (bridge script, rewritten redirects).
fn parse_target(root: &str, raw_path: &str) -> Option<Target> {
    let rest = raw_path.strip_prefix(root)?.strip_prefix('/')?;
    let mut parts = rest.splitn(4, '/');
    let token = parts.next()?.to_string();
    let scheme = parts.next()?.to_ascii_lowercase();
    let host = parts.next()?.to_string();
    // The host is spliced back into injected markup and rewritten URLs; keep
    // it to hostname characters so it cannot break out of attribute context.
    let host_safe = !host.is_empty()
        && host
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':' | '[' | ']' | '%'));
    if !host_safe || (scheme != "http" && scheme != "https") {
        return None;
    }
    // Validate the per-host token: it must equal fnv1a(secret + host).
    let expected = host_token(&proxy().secret, &host);
    if !constant_time_eq(&token, &expected) {
        return None;
    }
    Some(Target {
        prefix: format!("{root}/{token}"),
        scheme,
        host,
        path: parts.next().unwrap_or("").to_string(),
    })
}

/// The proxied base for the document itself: `{prefix}/{scheme}/{host}`.
/// Root-relative URLs in the page (`/_astro/x.css`) are rewritten against it,
/// because `/…` URLs always resolve against the origin and would otherwise
/// escape the proxy prefix.
fn document_base(target: &Target) -> String {
    format!("{}/{}/{}", target.prefix, target.scheme, target.host)
}

async fn handle(req: Request) -> Response {
    let root = if req.uri().path().starts_with(REMOTE_ROOT) { REMOTE_ROOT } else { DESKTOP_ROOT };
    let Some(target) = parse_target(root, req.uri().path()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Serve the bridge through the same per-host capability as the document.
    // Publishing the shared secret here would let a previewed page forge
    // tokens for every other target host.
    if target.path == "__pix-preview-bridge.js" {
        return if *req.method() == axum::http::Method::GET {
            bridge_js()
        } else {
            StatusCode::METHOD_NOT_ALLOWED.into_response()
        };
    }
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
    let root = target.prefix.rsplit_once('/').map(|(root, _)| root).unwrap_or_default();
    let token = host_token(&proxy().secret, &host);
    Some(format!(
        "{root}/{token}/{}/{}{}{}",
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
        Err(e) => {
            eprintln!("preview proxy: failed to reach target: {}", e);
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
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    if content_type.contains("text/html") {
        // Check Content-Length before buffering to avoid unbounded memory usage.
        let content_length = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        if content_length.unwrap_or(0) > REWRITE_MAX_BYTES {
            // Too large to rewrite; pass through without rewriting.
            return builder
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
        }
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        // Double-check actual size after reading.
        if bytes.len() as u64 > REWRITE_MAX_BYTES {
            return builder
                .body(Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
        }
        return builder
            .body(Body::from(rewrite_document(&bytes, target)))
            .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
    }
    if content_type.contains("text/css") {
        let content_length = response
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok());
        if content_length.unwrap_or(0) > REWRITE_MAX_BYTES {
            return builder
                .body(Body::from_stream(response.bytes_stream()))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
        }
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        };
        if bytes.len() as u64 > REWRITE_MAX_BYTES {
            return builder
                .body(Body::from(bytes))
                .unwrap_or_else(|_| StatusCode::BAD_GATEWAY.into_response());
        }
        let base = document_base(target);
        let rewritten = match std::str::from_utf8(&bytes) {
            Ok(text) => rewrite_css_urls(text, &base).into_bytes(),
            Err(_) => bytes.to_vec(),
        };
        return builder
            .body(Body::from(rewritten))
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

/// Rewrites the document for the proxy and injects the bridge. Root-relative
/// URLs (`/_astro/x.css`) resolve against the proxy origin and would 404, so
/// HTML attributes and CSS `url()` references are prefixed, and the document
/// base is published for the bridge to patch runtime requests (fetch/XHR/…).
fn rewrite_document(html: &[u8], target: &Target) -> Vec<u8> {
    let base = document_base(target);
    // The bridge is addressed through the document's per-host prefix so the
    // page never learns the shared secret used to derive host capabilities.
    // The reserved filename avoids shadowing a common target "/bridge.js".
    let script = format!(r#"<script>window.__pixPreviewBase="{base}";</script><script src="{base}/__pix-preview-bridge.js"></script>"#);
    // Non-UTF-8 documents (legacy charsets) are served unrewritten but still
    // get the bridge appended.
    let Ok(text) = std::str::from_utf8(html) else {
        return append_before_close(html, script.as_bytes());
    };
    let rewritten = rewrite_html_attributes(text, &base);
    let rewritten = rewrite_css_urls(&rewritten, &base);
    append_before_close(rewritten.as_bytes(), script.as_bytes())
}

fn append_before_close(html: &[u8], script: &[u8]) -> Vec<u8> {
    for marker in [b"</body>".as_slice(), b"</html>".as_slice()] {
        if let Some(pos) = find_case_insensitive(html, marker) {
            let mut out = Vec::with_capacity(html.len() + script.len());
            out.extend_from_slice(&html[..pos]);
            out.extend_from_slice(script);
            out.extend_from_slice(&html[pos..]);
            return out;
        }
    }
    let mut out = Vec::with_capacity(html.len() + script.len() + 1);
    out.extend_from_slice(html);
    out.extend_from_slice(b"\n");
    out.extend_from_slice(script);
    out
}

/// URL-carrying HTML attributes that must stay inside the proxy prefix.
fn attribute_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        // The regex crate has no backreferences, so the closing quote may be
        // either kind; real-world attributes are well-formed anyway.
        regex::Regex::new(r#"(?i)(\s(?:src|href|action|poster|data-src|data-srcset|srcset|imagesrcset)\s*=\s*)(["'])([^"']*)(["'])"#)
            .expect("attribute regex")
    })
}

fn css_url_regex() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r#"url\(\s*(["']?)(/[^)"']*)(["']?)\s*\)"#).expect("css url regex"))
}

/// Prefixes root-relative URLs; protocol-relative (`//cdn`), absolute
/// (`https://…`), fragment and already-prefixed URLs pass through untouched.
fn rewrite_single_url(url: &str, base: &str) -> String {
    if url.starts_with('/') && !url.starts_with("//") && !url.starts_with(base) {
        format!("{base}{url}")
    } else {
        url.to_string()
    }
}

fn rewrite_html_attributes(text: &str, base: &str) -> String {
    attribute_regex()
        .replace_all(text, |caps: &regex::Captures| {
            let lead = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let open = caps.get(2).map(|m| m.as_str()).unwrap_or("\"");
            let value = caps.get(3).map(|m| m.as_str()).unwrap_or("");
            let close = caps.get(4).map(|m| m.as_str()).unwrap_or("\"");
            // srcset/imagesrcset carry "url descriptor" candidates per comma.
            let rewritten = value
                .split(',')
                .map(|candidate| {
                    let trimmed = candidate.trim_start();
                    let leading = &candidate[..candidate.len() - trimmed.len()];
                    let mut tokens = trimmed.splitn(2, char::is_whitespace);
                    let url = tokens.next().unwrap_or("");
                    match tokens.next() {
                        Some(rest) => format!("{leading}{} {rest}", rewrite_single_url(url, base)),
                        None => format!("{leading}{}", rewrite_single_url(url, base)),
                    }
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{lead}{open}{rewritten}{close}")
        })
        .into_owned()
}

fn rewrite_css_urls(text: &str, base: &str) -> String {
    css_url_regex()
        .replace_all(text, |caps: &regex::Captures| {
            let open = caps.get(1).map(|m| m.as_str()).unwrap_or("");
            let url = caps.get(2).map(|m| m.as_str()).unwrap_or("");
            let close = caps.get(3).map(|m| m.as_str()).unwrap_or(open);
            format!("url({open}{}{close})", rewrite_single_url(url, base))
        })
        .into_owned()
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
        // path is like "/http/127.0.0.1:5173/app/page.html"
        // Extract host and compute per-host token.
        let parts: Vec<&str> = path.trim_start_matches('/').splitn(3, '/').collect();
        let host = parts.get(1).copied().unwrap_or("");
        let token = host_token(&secret(), host);
        format!("{DESKTOP_ROOT}/{token}{path}")
    }

    #[test]
    fn parses_scheme_host_and_path_from_raw_proxy_path() {
        let target = target_for(&proxied("/http/127.0.0.1:5173/app/page.html"));
        assert_eq!(target.scheme, "http");
        assert_eq!(target.host, "127.0.0.1:5173");
        assert_eq!(target.path, "app/page.html");
        let token = host_token(&secret(), "127.0.0.1:5173");
        assert_eq!(target.prefix, format!("{DESKTOP_ROOT}/{token}"));
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
        let token = host_token(&secret(), "localhost:3000");
        assert_eq!(
            rewrite_location("/login?next=/app", &target, None).unwrap(),
            format!("/p/{token}/http/localhost:3000/login?next=/app")
        );
        assert_eq!(
            rewrite_location("https://other.example.org/a/b", &target, None).unwrap(),
            format!("/p/{}/https/other.example.org/a/b", host_token(&secret(), "other.example.org"))
        );
        assert_eq!(
            rewrite_location("section", &target, None).unwrap(),
            format!("/p/{token}/http/localhost:3000/section")
        );
        // Default ports are already omitted by the url crate, and redirects
        // get a fresh token bound to the redirect target host.
        assert_eq!(
            rewrite_location("https://example.com/", &target, None).unwrap(),
            format!("/p/{}/https/example.com/", host_token(&secret(), "example.com"))
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
    fn rewrites_the_document_and_injects_the_bridge() {
        let target = target_for(&proxied("/https/example.com"));
        let base = document_base(&target);
        let html = r#"<html><body><link rel="stylesheet" href="/_astro/a.css"><img src="/logo.png" srcset="/a.png 1x, /b.png 2x"></body></html>"#;
        let out = String::from_utf8(rewrite_document(html.as_bytes(), &target)).unwrap();
        assert!(out.contains(&format!(r#"href="{base}/_astro/a.css""#)));
        assert!(out.contains(&format!(r#"src="{base}/logo.png""#)));
        assert!(out.contains(&format!(r#"srcset="{base}/a.png 1x, {base}/b.png 2x""#)));
        assert!(out.contains(&format!(r#"window.__pixPreviewBase="{base}""#)));
        assert!(out.contains(&format!(r#"<script src="{base}/__pix-preview-bridge.js"></script>"#)));
        // Case-insensitive fallback.
        let out = String::from_utf8(rewrite_document(b"<html><BODY></BODY></HTML>", &target)).unwrap();
        assert!(out.contains(&format!(r#"window.__pixPreviewBase="{base}""#)));
        assert!(out.contains(r#"<script src="/p/"#));
        // Pages without closing tags still receive the bridge.
        let out = String::from_utf8(rewrite_document(b"<html><body><p>truncated", &target)).unwrap();
        assert!(out.contains(r#"<script src="/p/"#));
    }

    #[test]
    fn leaves_escaping_urls_and_already_prefixed_ones_alone() {
        let target = target_for(&proxied("/https/example.com"));
        let base = document_base(&target);
        let html = format!(
            r##"<a href="//cdn.example.org/x">cdn</a><a href="https://other.org/y">abs</a><a href="#anchor">frag</a><a href="mailto:a@b.c">mail</a><img src="{base}/prefixed.png">"##
        );
        let out = String::from_utf8(rewrite_document(html.as_bytes(), &target)).unwrap();
        assert!(out.contains(r##"href="//cdn.example.org/x""##));
        assert!(out.contains(r##"href="https://other.org/y""##));
        assert!(out.contains(r##"href="#anchor""##));
        assert!(out.contains(r##"href="mailto:a@b.c""##));
        // Already prefixed: exactly one occurrence in the img, none added by the rewrite.
        assert_eq!(out.matches(&format!(r##"src="{base}/prefixed.png""##)).count(), 1);
    }

    #[test]
    fn rewrites_root_relative_css_urls() {
        let target = target_for(&proxied("/https/example.com"));
        let base = document_base(&target);
        let css = r#"body { background: url(/img/bg.png) } .a { background-image: url('/i/a.png'); mask: url("//cdn/m.png") }"#;
        let out = rewrite_css_urls(css, &base);
        assert!(out.contains(&format!("url({base}/img/bg.png)")));
        assert!(out.contains(&format!("url('{base}/i/a.png')")));
        // Protocol-relative stays untouched.
        assert!(out.contains(r#"url("//cdn/m.png")"#));
    }

    #[test]
    fn rejects_hosts_with_markup_characters() {
        init();
        // Percent-encoded quotes stay encoded through the whole pipeline and
        // cannot break out of injected markup, so they are allowed.
        assert!(parse_target(DESKTOP_ROOT, &proxied("/http/a%22b/")).is_some());
        assert!(parse_target(DESKTOP_ROOT, &proxied("/http/a\"b/")).is_none());
        assert!(parse_target(DESKTOP_ROOT, &proxied("/http/a<b/")).is_none());
        assert!(parse_target(DESKTOP_ROOT, &proxied("/http/127.0.0.1:5173/")).is_some());
        assert!(parse_target(DESKTOP_ROOT, &proxied("/http/[::1]:8080/")).is_some());
    }

    #[test]
    fn maps_proxy_referer_back_to_the_target_origin() {
        let target = target_for(&proxied("/http/localhost:5173/app"));
        let token = host_token(&secret(), "localhost:5173");
        let request = HttpRequest::builder()
            .method("GET")
            .uri(format!("http://127.0.0.1:9/p/{token}/http/localhost:5173/app"))
            .header(
                header::REFERER,
                format!("http://127.0.0.1:9/p/{token}/http/localhost:5173/app/page"),
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
        let app = Router::new()
            .route(
                "/",
                get(|| async {
                    axum::response::Html(r#"<html><body><link rel="stylesheet" href="/style.css"><h1>dev</h1></body></html>"#)
                }),
            )
            .route(
                "/style.css",
                get(|| async { ([(header::CONTENT_TYPE, "text/css")], "body { background: url(/bg.png) }") }),
            );
        tokio::spawn(async move { axum::serve(target, app).await.unwrap() });

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let proxy_port = listener.local_addr().unwrap().port();
        tokio::spawn(async move { axum::serve(listener, router()).await.unwrap() });

        let target_host = format!("127.0.0.1:{target_port}");
        let token = host_token(&secret(), &target_host);
        let page = reqwest::get(format!(
            "http://127.0.0.1:{proxy_port}/p/{token}/http/{target_host}/",
        ))
        .await
        .unwrap();
        assert_eq!(page.status(), 200);
        let body = page.text().await.unwrap();
        assert!(body.contains("<h1>dev</h1>"));
        let base = format!("/p/{token}/http/{target_host}");
        assert!(body.contains(&format!(r#"href="{base}/style.css""#)));
        assert!(body.contains(&format!(r#"window.__pixPreviewBase="{base}""#)));
        assert!(body.contains(&format!("<script src=\"{base}/__pix-preview-bridge.js\"></script>")));

        let css = reqwest::get(format!("http://127.0.0.1:{proxy_port}{base}/style.css")).await.unwrap();
        assert_eq!(css.status(), 200);
        assert!(css.text().await.unwrap().contains(&format!("url({base}/bg.png)")));

        let bridge = reqwest::get(format!("http://127.0.0.1:{proxy_port}{base}/__pix-preview-bridge.js"))
            .await
            .unwrap();
        assert_eq!(bridge.status(), 200);
        assert!(bridge.text().await.unwrap().contains("pix-preview"));

        let stranger = reqwest::get(format!(
            "http://127.0.0.1:{proxy_port}/p/not-the-secret/http/{target_host}/"
        ))
        .await
        .unwrap();
        assert_eq!(stranger.status(), 404);
        let stranger_bridge =
            reqwest::get(format!("http://127.0.0.1:{proxy_port}/p/not-the-secret/http/{target_host}/__pix-preview-bridge.js")).await.unwrap();
        assert_eq!(stranger_bridge.status(), 404);
    }
}
