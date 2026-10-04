//! pi `models.json` management (custom providers/models) and the provider
//! `/models` fetcher used for model discovery in the settings page.

use serde::Serialize;
use serde_json::{json, Value};

use crate::errors::{pix_error, pix_error_detail, pix_error_with};
use crate::trust::agent_dir;

fn models_config_path() -> std::path::PathBuf {
    agent_dir().join("models.json")
}

/// Read pi's `~/.pi/agent/models.json`. Returns `{ "providers": {} }` when the
/// file does not exist. The whole document is passed through as `Value` so
/// unknown fields (cost, compat, headers, samplingParams, modelOverrides, …)
/// survive a read/edit/save round trip untouched.
#[tauri::command]
pub fn models_config_get() -> Result<Value, String> {
    let path = models_config_path();
    if !path.exists() {
        return Ok(serde_json::json!({ "providers": {} }));
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut v: Value = serde_json::from_str(&raw).map_err(|e| {
        pix_error_detail(
            "modelsJsonParseFailed",
            format!("models.json 解析失败: {e}"),
            e,
        )
    })?;
    if v.get("providers").is_none() {
        v["providers"] = serde_json::json!({});
    }
    Ok(v)
}

/// Write pi's `~/.pi/agent/models.json` (2-space pretty JSON + trailing newline,
/// matching pi's own file style). pi re-reads this file whenever the model
/// picker opens, so changes take effect without a restart.
#[tauri::command]
pub fn models_config_save(config: Value) -> Result<(), String> {
    let path = models_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            pix_error_detail("modelsDirCreateFailed", "无法创建 models 目录: {detail}", e)
        })?;
    }
    let body = serde_json::to_string_pretty(&config).map_err(|e| {
        pix_error_detail(
            "modelsSerializeFailed",
            "models.json 序列化失败: {detail}",
            e,
        )
    })?;
    // 原子写：中途崩溃不会留下截断的 models.json。
    crate::atomic_write::write(&path, format!("{body}\n").as_bytes())
        .map_err(|e| pix_error_detail("modelsWriteFailed", "无法写入 models.json: {detail}", e))
}

/// One model discovered from a provider's `/models` endpoint.
#[derive(Serialize)]
pub struct FetchedModel {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Fetch the model list advertised by a provider's `/models` endpoint, so the
/// settings UI can offer discovered models instead of typing ids by hand.
/// Supports the OpenAI (`Authorization: Bearer`), Anthropic (`x-api-key`) and
/// Google (`x-goog-api-key` header) listing styles; unknown api types fall
/// back to OpenAI.
#[tauri::command]
pub async fn models_fetch(provider: Value) -> Result<Vec<FetchedModel>, String> {
    tauri::async_runtime::spawn_blocking(move || models_fetch_blocking(&provider))
        .await
        .map_err(|e| e.to_string())?
}

fn models_fetch_blocking(provider: &Value) -> Result<Vec<FetchedModel>, String> {
    let base = provider
        .get("baseUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .trim_end_matches('/');
    if base.is_empty() {
        return Err(pix_error(
            "providerBaseUrlMissing",
            "该供应商未配置 Base URL，无法获取模型列表",
        ));
    }
    let api = provider
        .get("api")
        .and_then(Value::as_str)
        .unwrap_or("openai-completions");
    // pi allows "$ENV_VAR" references in models.json; resolve them here.
    let mut key = provider
        .get("apiKey")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if let Some(var) = key.strip_prefix('$') {
        key = std::env::var(var).unwrap_or_default();
    }

    let url = format!("{base}/models");
    let mut req = ureq::get(&url)
        .header("User-Agent", "pi-x desktop")
        .config()
        .timeout_global(Some(std::time::Duration::from_secs(20)))
        .build();
    if api == "anthropic-messages" {
        if !key.is_empty() {
            req = req.header("x-api-key", &key);
        }
        req = req.header("anthropic-version", "2023-06-01");
        req = req.query("limit", "1000");
    } else if api == "google-generative-ai" {
        // key 走请求头而非 URL query，避免 URL 进日志/代理时泄露密钥。
        if !key.is_empty() {
            req = req.header("x-goog-api-key", &key);
        }
    } else if !key.is_empty() {
        req = req.header("Authorization", &format!("Bearer {key}"));
    }
    // Provider-level custom headers (models.json `headers`) apply to every style.
    if let Some(headers) = provider.get("headers").and_then(Value::as_object) {
        for (k, v) in headers {
            if let Some(v) = v.as_str() {
                req = req.header(k, v);
            }
        }
    }

    // ureq 3 默认把 4xx/5xx 直接变成错误并丢弃响应体；这里需要读出
    // 错误响应的详情，因此关闭该行为并手动检查状态码。
    let mut resp = req
        .config()
        .http_status_as_error(false)
        .build()
        .call()
        .map_err(|e| {
            pix_error_detail("fetchModelsFailed", format!("获取模型列表失败: {e}"), e)
        })?;
    let status = resp.status().as_u16();
    let body = resp
        .body_mut()
        .read_to_string()
        .map_err(|e| {
            pix_error_detail(
                "modelsResponseReadFailed",
                format!("读取模型列表响应失败: {e}"),
                e,
            )
        })?;
    if !(200..300).contains(&status) {
        let detail: String = body.chars().take(300).collect();
        return Err(pix_error_with(
            "fetchModelsHttpFailed",
            format!("获取模型列表失败 (HTTP {status}): {detail}"),
            json!({"status": status.to_string(), "detail": detail}),
        ));
    }
    let v: Value = serde_json::from_str(&body).map_err(|e| {
        pix_error_detail(
            "modelsResponseParseFailed",
            format!("解析模型列表响应失败: {e}"),
            e,
        )
    })?;

    let mut out: Vec<FetchedModel> = Vec::new();
    if let Some(data) = v.get("data").and_then(Value::as_array) {
        // OpenAI / Anthropic shape: { "data": [{ "id": ..., "display_name": ... }] }
        for m in data {
            if let Some(id) = m.get("id").and_then(Value::as_str) {
                let name = m
                    .get("display_name")
                    .and_then(Value::as_str)
                    .or_else(|| m.get("displayName").and_then(Value::as_str))
                    .map(String::from);
                out.push(FetchedModel {
                    id: id.into(),
                    name,
                });
            }
        }
    } else if let Some(models) = v.get("models").and_then(Value::as_array) {
        // Google shape: { "models": [{ "name": "models/gemini-...", ... }] }
        for m in models {
            if let Some(name) = m.get("name").and_then(Value::as_str) {
                let id = name.strip_prefix("models/").unwrap_or(name);
                let disp = m
                    .get("displayName")
                    .and_then(Value::as_str)
                    .map(String::from);
                out.push(FetchedModel {
                    id: id.into(),
                    name: disp,
                });
            }
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn models_config_provider_order_survives_json_round_trip() {
        let raw = r#"{"providers":{"zeta":{"models":[]},"alpha":{"models":[]}}}"#;
        let config: Value = serde_json::from_str(raw).unwrap();
        let saved = serde_json::to_string(&config).unwrap();
        assert!(saved.find("zeta").unwrap() < saved.find("alpha").unwrap());
    }

    /// 本机起一次性 HTTP 服务，抓取 models_fetch_blocking 发出的请求行与请求头。
    /// `provider` 用实际监听端口构造 baseUrl。
    fn capture_models_request(
        provider: impl FnOnce(u16) -> Value,
    ) -> (String, String, Result<Vec<FetchedModel>, String>) {
        use std::io::{BufRead, BufReader, Write};
        if std::env::var("HTTP_PROXY").is_ok() || std::env::var("http_proxy").is_ok() {
            // 代理环境可能劫持 localhost 请求，跳过本机回环测试。
            return (String::new(), String::new(), Ok(Vec::new()));
        }
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let provider = provider(port);
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(stream);
            let mut request_line = String::new();
            reader.read_line(&mut request_line).unwrap();
            let mut headers = String::new();
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" || line.is_empty() {
                    break;
                }
                headers.push_str(&line);
            }
            let body = r#"{"models":[{"name":"models/gemini-pro","displayName":"Gemini Pro"}]}"#;
            write!(
                reader.get_mut(),
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .unwrap();
            (request_line, headers)
        });
        let models = models_fetch_blocking(&provider);
        let (request_line, headers) = server.join().unwrap();
        (request_line, headers, models)
    }

    #[test]
    fn google_model_fetch_sends_key_in_header_not_url() {
        let (request_line, headers, models) = capture_models_request(|port| {
            json!({
                "baseUrl": format!("http://127.0.0.1:{port}/v1beta"),
                "api": "google-generative-ai",
                "apiKey": "secret-key",
            })
        });
        if request_line.is_empty() {
            return; // 代理环境跳过
        }
        // URL 不携带 key，密钥只出现在 x-goog-api-key 请求头。
        assert!(request_line.starts_with("GET /v1beta/models "), "{request_line}");
        assert!(!request_line.contains("key="), "{request_line}");
        assert!(
            headers.to_ascii_lowercase().contains("x-goog-api-key: secret-key"),
            "{headers}"
        );
        let models = models.unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "gemini-pro");
        assert_eq!(models[0].name.as_deref(), Some("Gemini Pro"));
    }

    #[test]
    fn openai_model_fetch_keeps_bearer_auth_and_leaves_url_clean() {
        let (request_line, headers, _) = capture_models_request(|port| {
            json!({
                "baseUrl": format!("http://127.0.0.1:{port}/v1"),
                "api": "openai-completions",
                "apiKey": "sk-test",
            })
        });
        if request_line.is_empty() {
            return; // 代理环境跳过
        }
        assert!(request_line.starts_with("GET /v1/models "), "{request_line}");
        assert!(headers.to_ascii_lowercase().contains("authorization: bearer sk-test"));
    }
}
