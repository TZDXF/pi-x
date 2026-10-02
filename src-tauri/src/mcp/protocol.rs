//! Shared initialize messages, JSON-RPC matching and handshake failure reporting.
use crate::errors::pix_error_detail;
use serde_json::Value;
use std::time::Duration;
pub(super) const CHECK_TIMEOUT: Duration = Duration::from_secs(15);

/// JSON-RPC `initialize` request; id 1 is matched in responses.
pub(super) fn initialize_request() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "pix", "version": env!("CARGO_PKG_VERSION") }
        }
    })
    .to_string()
}

/// Match a parsed JSON-RPC response to `id`: Some(Ok(result)) = success
/// result, Some(Err(text)) = JSON-RPC error, None = a different message.
pub(super) fn response_result<'a>(value: &'a Value, id: i64) -> Option<Result<&'a Value, String>> {
    let object = value.as_object()?;
    if object.get("id").and_then(|v| v.as_i64()) != Some(id) {
        return None;
    }
    if let Some(result) = object.get("result") {
        return Some(Ok(result));
    }
    let error = object.get("error");
    let message = error
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .unwrap_or("request error");
    Some(Err(message.to_string()))
}

/// Match a parsed JSON-RPC response: Some(Ok(())) = initialize result,
/// Some(Err(text)) = JSON-RPC error, None = not a response to id 1.
pub(super) fn classify_response(value: &Value) -> Option<Result<(), String>> {
    response_result(value, 1).map(|result| result.map(|_| ()))
}

/// How the initialize handshake failed. Error strings are built only after
/// the child is gone so the stderr tail can be attached to the message.
pub(super) enum HandshakeFailure {
    Write(std::io::Error),
    Read(std::io::Error),
    /// stdout hit EOF: the process died before answering.
    Exited,
    Timeout,
    /// The server answered with a JSON-RPC error.
    Rpc(String),
}

impl std::fmt::Display for HandshakeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HandshakeFailure::Write(e) => write!(f, "{e}"),
            HandshakeFailure::Read(e) => write!(f, "{e}"),
            HandshakeFailure::Exited => write!(f, "服务器进程在返回结果前退出"),
            HandshakeFailure::Timeout => write!(f, "等待响应超时"),
            HandshakeFailure::Rpc(message) => write!(f, "{message}"),
        }
    }
}

impl HandshakeFailure {
    /// Build the coded error; `detail` is the pre-formatted stderr suffix
    /// (empty when the server printed nothing).
    pub(super) fn into_error(self, detail: String) -> String {
        match self {
            HandshakeFailure::Write(e) => pix_error_detail(
                "mcpCheckWriteFailed",
                "写入 initialize 请求失败: {detail}",
                e,
            ),
            HandshakeFailure::Read(e) => {
                pix_error_detail("mcpCheckReadFailed", "读取服务器输出失败: {detail}", e)
            }
            HandshakeFailure::Exited => {
                pix_error_detail("mcpCheckExited", "服务器进程在握手前退出{detail}", detail)
            }
            HandshakeFailure::Timeout => pix_error_detail(
                "mcpCheckTimeout",
                "连接检测超时（15 秒），服务器未响应 initialize{detail}",
                detail,
            ),
            HandshakeFailure::Rpc(message) => message,
        }
    }
}

/// JSON-RPC `notifications/initialized`, sent after the initialize result.
pub(super) fn initialized_notification() -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "method": "notifications/initialized"
    })
    .to_string()
}

/// Extract the JSON-RPC response with `id` from an HTTP body that is either
/// plain JSON or an SSE stream of `data:` lines. None = no matching response.
pub(super) fn extract_rpc_body(
    body: &str,
    content_type: &str,
    id: i64,
) -> Option<Result<Value, String>> {
    if content_type.contains("text/event-stream") {
        for line in body.lines() {
            let data = line.strip_prefix("data:").map(str::trim).unwrap_or("");
            if let Ok(value) = serde_json::from_str::<Value>(data) {
                if let Some(result) = response_result(&value, id) {
                    return Some(result.cloned());
                }
            }
        }
        None
    } else {
        let value: Value = serde_json::from_str(body.trim()).ok()?;
        response_result(&value, id).map(|result| result.cloned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_response_matches_id_one() {
        let ok: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}"#,
        )
        .unwrap();
        assert!(classify_response(&ok) == Some(Ok(())));
        let error: Value = serde_json::from_str(
            r#"{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"boom"}}"#,
        )
        .unwrap();
        assert_eq!(classify_response(&error), Some(Err("boom".into())));
        let other: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"notifications/x"}"#).unwrap();
        assert!(classify_response(&other).is_none());
        let other_id: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":2,"result":{}}"#).unwrap();
        assert!(classify_response(&other_id).is_none());
    }

    #[test]
    fn response_result_matches_requested_id() {
        let ok: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[]}}"#).unwrap();
        assert_eq!(
            response_result(&ok, 3).unwrap().unwrap()["tools"],
            serde_json::json!([])
        );
        let error: Value =
            serde_json::from_str(r#"{"jsonrpc":"2.0","id":3,"error":{"message":"nope"}}"#).unwrap();
        assert_eq!(response_result(&ok, 2), None);
        assert_eq!(response_result(&error, 3), Some(Err("nope".into())));
    }

    #[test]
    fn extract_rpc_body_reads_json_and_sse() {
        let json_body = r#"{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"a"}]}}"#;
        let extracted = extract_rpc_body(json_body, "application/json", 2)
            .unwrap()
            .unwrap();
        assert_eq!(extracted["tools"][0]["name"], "a");
        let sse_body =
            "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"tools\":[]}}\n\n";
        let extracted = extract_rpc_body(sse_body, "text/event-stream", 2)
            .unwrap()
            .unwrap();
        assert!(extracted["tools"].is_array());
        // Non-matching ids and JSON-RPC errors surface distinctly.
        assert!(extract_rpc_body(json_body, "application/json", 9).is_none());
        let error_body = r#"{"jsonrpc":"2.0","id":2,"error":{"message":"boom"}}"#;
        assert_eq!(
            extract_rpc_body(error_body, "application/json", 2).unwrap(),
            Err("boom".into())
        );
        // Notifications (202, empty body) yield no result.
        assert!(extract_rpc_body("", "application/json", 2).is_none());
    }
}
