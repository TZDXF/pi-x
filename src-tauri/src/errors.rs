use serde_json::{json, Value};

/// 编码错误前缀，与前端 `src/lib/backendError.ts` 约定一致。
pub const CODED_ERROR_PREFIX: &str = "PIXERR:";

/// 用户可见错误统一编码后返回：`PIXERR:` + JSON（code/fallback/params）。
/// 前端按当前语言翻译 `backendErrors.<code>`；fallback 为含 `{param}` 占位符的
/// 模板，供未知编码或解析失败时由前端插值展示。
pub fn pix_error(code: &str, fallback: impl Into<String>) -> String {
    pix_error_with(code, fallback, Value::Null)
}

/// 单个 `{detail}` 占位符的变体，覆盖「操作失败: 原因」类消息。
pub fn pix_error_detail(
    code: &str,
    fallback: impl Into<String>,
    detail: impl std::fmt::Display,
) -> String {
    pix_error_with(code, fallback, json!({ "detail": detail.to_string() }))
}

/// 多占位符变体，params 为命名参数对象（如 json!({"port": 8080})）。
pub fn pix_error_with(code: &str, fallback: impl Into<String>, params: Value) -> String {
    let mut payload = json!({ "code": code, "fallback": fallback.into() });
    if params.is_object() {
        payload["params"] = params;
    }
    format!("{CODED_ERROR_PREFIX}{payload}")
}

/// 日志用的错误码：编码错误取 `code`，普通文本统一归为 `uncoded`。
/// 诊断日志因此能定位失败类别而不写入原始错误文本（可能含路径或会话内容）。
pub fn error_code(message: &str) -> String {
    message
        .strip_prefix(CODED_ERROR_PREFIX)
        .and_then(|payload| serde_json::from_str::<Value>(payload).ok())
        .and_then(|value| value.get("code").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(|| "uncoded".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn error_code_extracts_codes_without_leaking_text() {
        assert_eq!(error_code(&pix_error("sessionPathInvalid", "无效的会话路径")), "sessionPathInvalid");
        assert_eq!(error_code("Pi SDK: boom /secret/path"), "uncoded");
        assert_eq!(error_code(&format!("{CODED_ERROR_PREFIX}broken")), "uncoded");
    }

    #[test]
    fn pix_error_encodes_code_and_fallback() {
        let encoded = pix_error("piNotFound", "未找到 pi");
        assert!(encoded.starts_with(CODED_ERROR_PREFIX));
        let payload: Value = serde_json::from_str(&encoded[CODED_ERROR_PREFIX.len()..]).unwrap();
        assert_eq!(payload["code"], "piNotFound");
        assert_eq!(payload["fallback"], "未找到 pi");
        assert!(payload.get("params").is_none());
    }

    #[test]
    fn pix_error_detail_carries_detail_param() {
        let encoded = pix_error_detail("startPiFailed", "启动 pi 失败: boom", "boom");
        let payload: Value = serde_json::from_str(&encoded[CODED_ERROR_PREFIX.len()..]).unwrap();
        assert_eq!(payload["params"]["detail"], "boom");
    }

    #[test]
    fn pix_error_with_keeps_named_params() {
        let encoded = pix_error_with(
            "portListenFailed",
            "无法监听端口 {port}: {detail}",
            json!({"port": 8080, "detail": "denied"}),
        );
        let payload: Value = serde_json::from_str(&encoded[CODED_ERROR_PREFIX.len()..]).unwrap();
        assert_eq!(payload["params"]["port"], 8080);
        assert_eq!(payload["params"]["detail"], "denied");
    }
}
