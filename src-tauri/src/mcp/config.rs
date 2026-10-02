//! Raw configuration I/O and server definition lookup; unknown fields are preserved.
use crate::errors::{pix_error, pix_error_detail};
use serde_json::Value;
use std::collections::HashMap;
use std::path::PathBuf;

/// Resolve the `mcp.json` path for a scope. `project` is required for the
/// project scope (`<project>/.pi/mcp.json`), which pi only reads for
/// trusted projects — the file itself can be edited either way.
pub fn config_path(scope: &str, project: Option<&str>) -> Result<PathBuf, String> {
    match scope {
        "global" => Ok(crate::trust::agent_dir().join("mcp.json")),
        "project" => {
            let project = project
                .ok_or_else(|| pix_error("projectDirRequired", "请选择要操作的项目文件夹"))?;
            crate::commands::validate_project_dir(project)?;
            Ok(PathBuf::from(project).join(".pi").join("mcp.json"))
        }
        other => Err(pix_error_detail(
            "mcpScopeInvalid",
            "未知的配置范围: {detail}",
            other,
        )),
    }
}

#[derive(serde::Serialize)]
pub struct McpConfigFile {
    pub path: String,
    pub exists: bool,
    pub content: String,
}

/// Read a `mcp.json` as raw text; missing files come back empty so the editor
/// can offer a fresh template without silently creating anything.
pub fn mcp_config_read(scope: String, project: Option<String>) -> Result<McpConfigFile, String> {
    let path = config_path(&scope, project.as_deref())?;
    match std::fs::read_to_string(&path) {
        Ok(raw) => Ok(McpConfigFile {
            path: path.to_string_lossy().to_string(),
            exists: true,
            content: raw.trim_start_matches('\u{feff}').to_string(),
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(McpConfigFile {
            path: path.to_string_lossy().to_string(),
            exists: false,
            content: String::new(),
        }),
        Err(e) => Err(pix_error_detail(
            "mcpReadFailed",
            "读取 mcp.json 失败: {detail}",
            e,
        )),
    }
}

/// Validate the edited document and write it back verbatim (plus a trailing
/// newline, matching pi's own file style). Validation is deliberately shallow
/// — pi itself skips and reports invalid server entries — but the document
/// must be a JSON object and `mcpServers` (when present) an object so the
/// file cannot become unreadable noise.
pub fn validate_config_text(content: &str) -> Result<Value, String> {
    if content.trim().is_empty() {
        return Err(pix_error("mcpJsonEmpty", "mcp.json 内容为空"));
    }
    let value: Value = serde_json::from_str(content)
        .map_err(|e| pix_error_detail("mcpJsonParseFailed", "mcp.json 解析失败: {detail}", e))?;
    if !value.is_object() {
        return Err(pix_error("mcpJsonInvalid", "mcp.json 顶层必须是 JSON 对象"));
    }
    if let Some(servers) = value.get("mcpServers") {
        if !servers.is_object() {
            return Err(pix_error(
                "mcpServersInvalid",
                "mcpServers 必须是对象（服务器名 -> 配置）",
            ));
        }
    }
    Ok(value)
}

/// Save a `mcp.json`. The text is written as typed (unknown top-level fields
/// preserved); only JSON validity is enforced.
pub fn mcp_config_save(
    scope: String,
    content: String,
    project: Option<String>,
) -> Result<(), String> {
    let path = config_path(&scope, project.as_deref())?;
    validate_config_text(&content)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            pix_error_detail("mcpDirCreateFailed", "无法创建 .pi 目录: {detail}", e)
        })?;
    }
    let body = content.trim_end();
    std::fs::write(&path, format!("{body}\n"))
        .map_err(|e| pix_error_detail("mcpWriteFailed", "无法写入 mcp.json: {detail}", e))
}

pub(super) fn server_def<'a>(doc: &'a Value, name: &str) -> Result<&'a Value, String> {
    doc.get("mcpServers")
        .and_then(|servers| servers.get(name))
        .filter(|def| def.is_object())
        .ok_or_else(|| {
            pix_error_detail(
                "mcpServerNotFound",
                "mcp.json 中不存在该服务器: {detail}",
                name,
            )
        })
}

pub(super) fn def_str<'a>(def: &'a Value, key: &str) -> Option<&'a str> {
    def.get(key).and_then(|v| v.as_str())
}

pub(super) fn def_string_record(def: &Value, key: &str) -> Vec<(String, String)> {
    def.get(key)
        .and_then(|v| v.as_object())
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// Parsed mcp.json documents per scope, for looking up server definitions.
pub(super) fn read_scope_docs(project: Option<&str>) -> HashMap<String, Value> {
    let mut docs = HashMap::new();
    for scope in ["global", "project"] {
        let Ok(path) = config_path(scope, project) else {
            continue;
        };
        let Ok(raw) = std::fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(doc) = validate_config_text(raw.trim_start_matches('\u{feff}')) {
            docs.insert(scope.to_string(), doc);
        }
    }
    docs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_scope_requires_project() {
        assert!(config_path("project", None).is_err());
        assert!(config_path("unknown", None).is_err());
    }

    #[test]
    fn global_scope_targets_agent_dir() {
        let path = config_path("global", None).unwrap();
        assert!(path.to_string_lossy().contains("mcp.json"));
    }

    #[test]
    fn validate_accepts_document_with_unknown_fields() {
        let v =
            validate_config_text("{\"mcpServers\":{\"a\":{\"command\":\"npx\"}},\"custom\":true}")
                .unwrap();
        assert_eq!(v["custom"], serde_json::json!(true));
    }

    #[test]
    fn validate_rejects_broken_or_misshapen_documents() {
        assert!(validate_config_text("").is_err());
        assert!(validate_config_text("{").is_err());
        assert!(validate_config_text("[]").is_err());
        assert!(validate_config_text("{\"mcpServers\":[]}").is_err());
    }

    #[test]
    fn server_def_resolves_from_mcp_servers() {
        let doc: Value =
            serde_json::from_str(r#"{"mcpServers":{"fs":{"command":"npx"}}}"#).unwrap();
        assert_eq!(server_def(&doc, "fs").unwrap()["command"], "npx");
        assert!(server_def(&doc, "missing").is_err());
        // Non-object defs are treated as absent.
        let broken: Value = serde_json::from_str(r#"{"mcpServers":{"bad":"text"}}"#).unwrap();
        assert!(server_def(&broken, "bad").is_err());
    }
}
