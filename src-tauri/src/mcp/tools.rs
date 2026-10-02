//! tools/list requests, pagination limits and model-facing tool definition projection.
use serde_json::{json, Value};
use std::time::Duration;

/// JSON-RPC `tools/list` request; ids are assigned by the caller for matching.
pub(super) fn tools_list_request(id: i64, cursor: Option<&str>) -> String {
    let mut params = serde_json::Map::new();
    if let Some(cursor) = cursor {
        params.insert("cursor".to_string(), json!(cursor));
    }
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "tools/list",
        "params": params
    })
    .to_string()
}

// ---- per-server tool definitions (load-cost estimate) ----
// The model-facing cost of a loaded MCP server is dominated by its tool
// definitions (name, description, input schema), which `pi mcp list --json`
// does not expose. After the `pi mcp list` report, the settings backend
// connects once more to every enabled connected server and runs `tools/list`
// itself; the frontend turns the definitions into a token estimate.

/// Cap on the whole stdio tools/list exchange.
pub(super) const TOOLS_TIMEOUT: Duration = Duration::from_secs(30);
/// Cap on `tools/list` pagination rounds.
pub(super) const TOOLS_MAX_PAGES: usize = 10;

/// Model-facing fields of one `tools/list` entry: name, description (falling
/// back to the title, like pi's tool definitions) and the input schema. The
/// estimate only needs these; annotations and output schema stay out.
pub(super) fn parse_tool_defs(result: &Value) -> Vec<Value> {
    let Some(tools) = result.get("tools").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    tools
        .iter()
        .filter_map(|tool| {
            let name = tool.get("name").and_then(|v| v.as_str())?;
            let mut entry = serde_json::Map::new();
            entry.insert("name".to_string(), Value::String(name.to_string()));
            let description = tool
                .get("description")
                .and_then(|v| v.as_str())
                .filter(|d| !d.trim().is_empty())
                .or_else(|| {
                    tool.get("title")
                        .and_then(|v| v.as_str())
                        .filter(|d| !d.trim().is_empty())
                });
            if let Some(description) = description {
                entry.insert(
                    "description".to_string(),
                    Value::String(description.to_string()),
                );
            }
            if let Some(schema) = tool.get("inputSchema").filter(|s| s.is_object()) {
                entry.insert("inputSchema".to_string(), schema.clone());
            }
            Some(Value::Object(entry))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_tool_defs_keeps_model_facing_fields() {
        let result: Value = serde_json::from_str(
            r#"{"tools":[
                {"name":"read","description":"Read a file","inputSchema":{"type":"object","properties":{}}},
                {"name":"titled","title":"Titled tool","inputSchema":"not-an-object"},
                {"name":"bare"},
                {"description":"no name"}
            ]}"#,
        )
        .unwrap();
        let tools = parse_tool_defs(&result);
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], "read");
        assert_eq!(tools[0]["description"], "Read a file");
        assert_eq!(tools[0]["inputSchema"]["type"], "object");
        // Title falls in when the description is missing; a non-object schema
        // and tools without a name are dropped.
        assert_eq!(tools[1]["description"], "Titled tool");
        assert!(tools[1].get("inputSchema").is_none());
        assert!(tools[2].get("description").is_none());
    }

    #[test]
    fn parse_tool_defs_ignores_whitespace_descriptions() {
        let result: Value = serde_json::from_str(
            r#"{"tools":[{"name":"a","description":"   "},{"name":"b","title":"T"}]}"#,
        )
        .unwrap();
        let tools = parse_tool_defs(&result);
        assert!(tools[0].get("description").is_none());
        assert_eq!(tools[1]["description"], "T");
    }

    #[test]
    fn tools_list_request_carries_cursor() {
        let first: Value = serde_json::from_str(&tools_list_request(2, None)).unwrap();
        assert_eq!(first["method"], "tools/list");
        assert!(first["params"].as_object().unwrap().is_empty());
        let paged: Value = serde_json::from_str(&tools_list_request(3, Some("cur"))).unwrap();
        assert_eq!(paged["params"]["cursor"], "cur");
    }
}
