//! Stdio initialize and paginated tools/list exchanges, with bounded waits and cleanup.
use super::process::{drain_stderr, kill_stdio_child, spawn_command, stderr_tail_detail};
use super::protocol::{
    initialize_request, initialized_notification, response_result, HandshakeFailure, CHECK_TIMEOUT,
};
use super::tools::{parse_tool_defs, tools_list_request, TOOLS_MAX_PAGES, TOOLS_TIMEOUT};
use crate::errors::{pix_error, pix_error_detail};
use serde_json::Value;
use tokio::io::BufReader;
use tokio::process::{ChildStdin, ChildStdout};

/// Write one JSON-RPC message as a newline-terminated line.
async fn write_line(stdin: &mut ChildStdin, line: &str) -> Result<(), HandshakeFailure> {
    use tokio::io::AsyncWriteExt;
    stdin
        .write_all(line.as_bytes())
        .await
        .map_err(HandshakeFailure::Write)?;
    stdin
        .write_all(b"\n")
        .await
        .map_err(HandshakeFailure::Write)?;
    stdin.flush().await.map_err(HandshakeFailure::Write)
}

/// Read JSON-RPC lines until the response to `id` arrives: Ok(result payload)
/// on success, the JSON-RPC error message on error, HandshakeFailure when the
/// process dies or the pipe breaks first.
async fn read_rpc_response(
    stdout: &mut BufReader<ChildStdout>,
    id: i64,
) -> Result<Value, HandshakeFailure> {
    use tokio::io::AsyncBufReadExt;
    let mut line = String::new();
    loop {
        line.clear();
        match stdout.read_line(&mut line).await {
            Ok(0) => return Err(HandshakeFailure::Exited),
            Ok(_) => {}
            Err(e) => return Err(HandshakeFailure::Read(e)),
        }
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            if let Some(result) = response_result(&value, id) {
                return result
                    .map(|result| result.clone())
                    .map_err(HandshakeFailure::Rpc);
            }
        }
    }
}

pub(super) async fn check_stdio(def: &Value) -> Result<u128, String> {
    let (mut cmd, wrapped) = spawn_command(def)?;
    let mut child = cmd
        .spawn()
        .map_err(|e| pix_error_detail("mcpCheckSpawnFailed", "无法启动服务器进程: {detail}", e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| pix_error("mcpCheckWriteFailed", "无法写入服务器标准输入"))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| pix_error("mcpCheckReadFailed", "无法读取服务器标准输出"))?,
    );
    let stderr_task = drain_stderr(&mut child);

    // Latency only covers the initialize handshake round trip, not the
    // process startup time (intentional).
    let started = std::time::Instant::now();
    let handshake = async {
        write_line(&mut stdin, &initialize_request()).await?;
        let read = read_rpc_response(&mut stdout, 1);
        match tokio::time::timeout(CHECK_TIMEOUT, read).await {
            Ok(result) => result.map(|_| started.elapsed().as_millis()),
            Err(_) => Err(HandshakeFailure::Timeout),
        }
    };
    let outcome = handshake.await;
    kill_stdio_child(&mut child, wrapped).await;
    match outcome {
        Ok(latency) => Ok(latency),
        Err(failure) => Err(failure.into_error(stderr_tail_detail(stderr_task).await)),
    }
}

/// stdio tools/list: connect, initialize, then page through `tools/list`.
pub(super) async fn fetch_stdio_tools(def: &Value) -> Result<Vec<Value>, String> {
    let (mut cmd, wrapped) = spawn_command(def)?;
    let mut child = cmd
        .spawn()
        .map_err(|e| pix_error_detail("mcpToolsSpawnFailed", "无法启动服务器进程: {detail}", e))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| pix_error("mcpCheckWriteFailed", "无法写入服务器标准输入"))?;
    let mut stdout = BufReader::new(
        child
            .stdout
            .take()
            .ok_or_else(|| pix_error("mcpCheckReadFailed", "无法读取服务器标准输出"))?,
    );
    let stderr_task = drain_stderr(&mut child);

    let exchange = async {
        write_line(&mut stdin, &initialize_request()).await?;
        read_rpc_response(&mut stdout, 1).await?;
        // The notification is fire-and-forget; servers answer only the requests.
        let _ = write_line(&mut stdin, &initialized_notification()).await;
        let mut tools: Vec<Value> = Vec::new();
        let mut cursor: Option<String> = None;
        for id in 2..(2 + TOOLS_MAX_PAGES as i64) {
            write_line(&mut stdin, &tools_list_request(id, cursor.as_deref())).await?;
            let result = read_rpc_response(&mut stdout, id).await?;
            tools.extend(parse_tool_defs(&result));
            cursor = result
                .get("nextCursor")
                .and_then(|v| v.as_str())
                .map(String::from);
            if cursor.is_none() {
                break;
            }
        }
        Ok::<Vec<Value>, HandshakeFailure>(tools)
    };
    let outcome = tokio::time::timeout(TOOLS_TIMEOUT, exchange).await;
    kill_stdio_child(&mut child, wrapped).await;
    let detail = stderr_tail_detail(stderr_task).await;
    match outcome {
        Ok(Ok(tools)) => Ok(tools),
        Ok(Err(failure)) => Err(pix_error_detail(
            "mcpToolsFailed",
            "获取工具定义失败: {detail}",
            format!("{failure}{detail}"),
        )),
        Err(_) => Err(pix_error_detail(
            "mcpToolsTimeout",
            "获取工具定义超时（30 秒）{detail}",
            detail,
        )),
    }
}

/// A mock stdio MCP server that answers initialize and tools/list with two
/// pages, exercising the whole fetch round trip. Needs `node` on PATH —
/// always true in a development environment — and skips otherwise.
#[cfg(test)]
mod fetch_stdio_tests {
    use super::*;

    const MOCK_SERVER: &str = r#"
import { createInterface } from "node:readline";
const page1 = { tools: [
  { name: "alpha", description: "Alpha tool", inputSchema: { type: "object", properties: { a: { type: "string" } } } },
  { name: "beta", title: "Beta titled", inputSchema: { type: "object" } },
], nextCursor: "page2" };
const page2 = { tools: [
  { name: "gamma", inputSchema: "not-an-object" },
  { description: "no name" },
] };
const rl = createInterface({ input: process.stdin });
for await (const line of rl) {
  let msg;
  try { msg = JSON.parse(line); } catch { continue; }
  if (msg.method === "initialize") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05" } }) + "\n");
  } else if (msg.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: msg.params?.cursor === "page2" ? page2 : page1 }) + "\n");
  }
}
"#;

    #[tokio::test]
    async fn fetch_stdio_tools_round_trip() {
        let Some(node) = which_node() else {
            return; // no node on PATH: nothing to run the mock server with
        };
        let mock = std::env::temp_dir().join(format!("pix-mock-mcp-{}.mjs", std::process::id()));
        std::fs::write(&mock, MOCK_SERVER).unwrap();
        let def = serde_json::json!({ "command": node, "args": [mock.to_string_lossy()] });
        let result = fetch_stdio_tools(&def).await;
        let _ = std::fs::remove_file(&mock);
        let tools = result.expect("fetch should succeed");
        // The nameless page-2 tool is dropped; the schema-less one is kept.
        assert_eq!(tools.len(), 3);
        assert_eq!(tools[0]["name"], "alpha");
        assert_eq!(tools[0]["description"], "Alpha tool");
        assert_eq!(tools[0]["inputSchema"]["properties"]["a"]["type"], "string");
        assert_eq!(tools[1]["name"], "beta");
        // Title fallback applied, like pi's tool definitions.
        assert_eq!(tools[1]["description"], "Beta titled");
        assert!(
            tools[2].get("inputSchema").is_none(),
            "non-object schema is dropped"
        );
    }

    /// Locate `node` via PATH, like the frontend toolchain always provides.
    fn which_node() -> Option<String> {
        let names: &[&str] = if cfg!(windows) {
            &["node.exe", "node.cmd", "node"]
        } else {
            &["node"]
        };
        for dir in std::env::split_paths(&std::env::var_os("PATH")?) {
            for name in names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate.to_string_lossy().into_owned());
                }
            }
        }
        None
    }
}
