//! Streamable HTTP initialize and paginated tools/list, including SSE and session headers.
use super::config::{def_str, def_string_record};
use super::protocol::{
    classify_response, extract_rpc_body, initialize_request, initialized_notification,
    CHECK_TIMEOUT,
};
use super::tools::{parse_tool_defs, tools_list_request, TOOLS_MAX_PAGES};
use crate::errors::{pix_error, pix_error_detail};
use serde_json::Value;

fn check_http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(CHECK_TIMEOUT)
        // 握手请求携带配置中的自定义头；跟随 30x 会把它们原样带往重定向
        // 目标（重定向型 SSRF），与预览代理保持同一立场：拒绝跟随。被
        // 重定向的服务器会以「服务器返回 HTTP 3xx」报错，改用最终 URL 即可。
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| pix_error_detail("mcpCheckClientFailed", "无法创建 HTTP 客户端: {detail}", e))
}

/// 配置里的 `url` 只允许 http/https。reqwest 在发送时也会拒绝其他 scheme，
/// 这里提前拦下并给出明确的 mcpServerInvalid 错误，而不是笼统的连接失败。
fn validate_http_url(url: &str) -> Result<(), String> {
    let parsed =
        url::Url::parse(url).map_err(|_| pix_error("mcpServerInvalid", "该服务器的 url 不是合法地址"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(pix_error(
            "mcpServerInvalid",
            "该服务器的 url 只支持 http/https",
        ));
    }
    Ok(())
}

/// Streamable HTTP check: POST an `initialize` request; the response body may
/// be JSON or an SSE stream (scan `data:` lines for the id-1 response).
pub(super) async fn check_http(def: &Value) -> Result<u128, String> {
    let url = def_str(def, "url")
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            pix_error(
                "mcpServerInvalid",
                "该服务器缺少 command（stdio）或 url（HTTP）",
            )
        })?;
    validate_http_url(&url)?;
    let client = check_http_client()?;
    let started = std::time::Instant::now();
    let mut request = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .json(&serde_json::from_str::<Value>(&initialize_request()).unwrap_or_default());
    for (name, value) in def_string_record(def, "headers") {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|e| pix_error_detail("mcpCheckConnectFailed", "无法连接到服务器: {detail}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(pix_error_detail(
            "mcpCheckHttp",
            "服务器返回 HTTP {detail}",
            status.as_u16(),
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let body = response
        .text()
        .await
        .map_err(|e| pix_error_detail("mcpCheckBodyFailed", "读取服务器响应失败: {detail}", e))?;
    if content_type.contains("text/event-stream") {
        for line in body.lines() {
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                match classify_response(&value) {
                    Some(Ok(())) => return Ok(started.elapsed().as_millis()),
                    Some(Err(message)) => return Err(message),
                    None => {}
                }
            }
        }
        return Err(pix_error(
            "mcpCheckNoInitialize",
            "服务器响应流中没有 initialize 结果",
        ));
    }
    let value: Value = serde_json::from_str(body.trim())
        .map_err(|_| pix_error("mcpCheckNotJsonRpc", "服务器响应不是合法的 JSON-RPC 消息"))?;
    match classify_response(&value) {
        Some(Ok(())) => Ok(started.elapsed().as_millis()),
        Some(Err(message)) => Err(message),
        None => Err(pix_error(
            "mcpCheckNotInitialize",
            "服务器响应不是 initialize 结果",
        )),
    }
}

/// POST one JSON-RPC message to a Streamable HTTP endpoint; returns the
/// lowercase content type, the `Mcp-Session-Id` response header and the body.
async fn post_rpc(
    client: &reqwest::Client,
    url: &str,
    headers: &[(String, String)],
    body: &str,
) -> Result<(String, Option<String>, String), String> {
    let mut request = client
        .post(url)
        .header("Accept", "application/json, text/event-stream")
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(body.to_owned());
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|e| pix_error_detail("mcpCheckConnectFailed", "无法连接到服务器: {detail}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(pix_error_detail(
            "mcpCheckHttp",
            "服务器返回 HTTP {detail}",
            status.as_u16(),
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|v| v.to_str().ok())
        .map(String::from);
    let text = response
        .text()
        .await
        .map_err(|e| pix_error_detail("mcpCheckBodyFailed", "读取服务器响应失败: {detail}", e))?;
    Ok((content_type, session, text))
}

/// Streamable HTTP tools/list: initialize (capturing the session id), send
/// the initialized notification, then page through `tools/list`.
pub(super) async fn fetch_http_tools(def: &Value) -> Result<Vec<Value>, String> {
    let url = def_str(def, "url")
        .filter(|u| !u.trim().is_empty())
        .ok_or_else(|| {
            pix_error(
                "mcpServerInvalid",
                "该服务器缺少 command（stdio）或 url（HTTP）",
            )
        })?;
    validate_http_url(&url)?;
    let client = check_http_client()?;
    let headers = def_string_record(def, "headers");

    let (content_type, session, body) =
        post_rpc(&client, &url, &headers, &initialize_request()).await?;
    let initialize = extract_rpc_body(&body, &content_type, 1)
        .ok_or_else(|| pix_error("mcpCheckNoInitialize", "服务器响应流中没有 initialize 结果"))?
        .map_err(|message| pix_error_detail("mcpCheckRpc", "{detail}", message))?;
    if initialize.is_null() {
        return Err(pix_error(
            "mcpCheckNotInitialize",
            "服务器响应不是 initialize 结果",
        ));
    }
    let headers = match &session {
        Some(session) => {
            let mut with_session = headers;
            with_session.push(("Mcp-Session-Id".to_string(), session.clone()));
            with_session
        }
        None => headers,
    };
    // Notifications usually answer 202 with an empty body; the result is ignored.
    let _ = post_rpc(&client, &url, &headers, &initialized_notification()).await;

    let mut tools: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for id in 2..(2 + TOOLS_MAX_PAGES as i64) {
        let request = tools_list_request(id, cursor.as_deref());
        let (content_type, _, body) = post_rpc(&client, &url, &headers, &request).await?;
        let result = extract_rpc_body(&body, &content_type, id)
            .ok_or_else(|| pix_error("mcpToolsNoResponse", "服务器响应中没有 tools/list 结果"))?
            .map_err(|message| pix_error_detail("mcpCheckRpc", "{detail}", message))?;
        tools.extend(parse_tool_defs(&result));
        cursor = result
            .get("nextCursor")
            .and_then(|v| v.as_str())
            .map(String::from);
        if cursor.is_none() {
            break;
        }
    }
    Ok(tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn http_def(url: &str) -> Value {
        serde_json::json!({ "url": url })
    }

    #[test]
    fn http_url_validation_accepts_http_and_https_only() {
        assert!(validate_http_url("http://127.0.0.1:3000/mcp").is_ok());
        assert!(validate_http_url("https://example.com/mcp").is_ok());
        // Other schemes fail with the explicit code before any request is made.
        let file_err = validate_http_url("file:///etc/passwd").unwrap_err();
        assert!(file_err.contains("mcpServerInvalid"), "unexpected: {file_err}");
        assert!(validate_http_url("ftp://example.com/mcp").is_err());
        assert!(validate_http_url("not a url").is_err());
    }

    /// Serve one canned HTTP response on 127.0.0.1 and return the base URL.
    async fn serve_once(response: String) -> String {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut buf = [0u8; 4096];
            let _ = socket.read(&mut buf).await;
            let _ = socket.write_all(response.as_bytes()).await;
        });
        format!("http://127.0.0.1:{}", addr.port())
    }

    #[tokio::test]
    async fn check_http_does_not_follow_redirects() {
        // The redirect target is a closed port: a client that followed the
        // redirect would report a connect failure instead of the 302 itself.
        let url = serve_once(
            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/mcp\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_string(),
        )
        .await;
        let err = check_http(&http_def(&url)).await.unwrap_err();
        assert!(err.contains("mcpCheckHttp"), "unexpected error: {err}");
        assert!(err.contains("302"), "unexpected error: {err}");
    }

    #[tokio::test]
    async fn check_http_accepts_plain_initialize_response() {
        // The no-redirect policy must not affect servers that answer directly.
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}"#;
        let url = serve_once(format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ))
        .await;
        let latency = check_http(&http_def(&url)).await.expect("check should pass");
        assert!(latency < 15_000);
    }
}
