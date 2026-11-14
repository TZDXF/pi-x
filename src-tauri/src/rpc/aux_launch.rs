//! aux 启动参数与能力探测（`docs/aux-chat-spec.md` §1）。
//!
//! 参数集是**代码常量**：settings、客户端 `extraArgs`、项目配置都不能放大它。
//! 探测用"同可执行文件 + 完整参数 + 短生命周期 RPC 握手"：`--version` 只解析版本，
//! 实测它会忽略未知选项，因此不能用来判断参数是否被支持。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::errors::{pix_error, pix_error_detail};

/// 探测结果的缓存有效期（规格 §1：TTL 10 分钟；远端 pi 也可能被升级）。
const PROBE_TTL: Duration = Duration::from_secs(600);
/// 握手响应等待上限。实测冷启动约 10s。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(25);
/// stdin EOF 后的退出等待上限。
const EXIT_TIMEOUT: Duration = Duration::from_secs(20);

/// 一次 aux 启动所需的全部信息。
#[derive(Clone, Debug)]
pub struct AuxLaunchSpec {
    pub provider: String,
    pub model: String,
    pub thinking: Option<String>,
    /// 物化后的 `pix-file-changes.js` 路径；远程分支为 `None`（不上传扩展）。
    pub file_changes_extension: Option<PathBuf>,
    /// 物化后的 `pix-workspace.js` 路径；仅当父会话有 workspace manifest。
    pub workspace_extension: Option<PathBuf>,
}

/// 组装 aux 的 `extra_args`。
///
/// `--no-session` 在这里、且**只在这里**加：本地 spawn 与远程 payload 都把这个
/// 返回值原样拼到 argv 尾部，所以两条路径不会各拼一遍、也不会漏。
/// `--mode rpc` 由 `probe_args()` 加；正式启动时它由 `build_spawn_args`
/// （本地）与 `build_spawn_payload`（远程）加。
///
/// 关键点：`--no-extensions` 关闭扩展自动发现（连带移除内置 MCP/codemode/
/// tool_search），随后用 `-e` 白名单加载审计过的扩展。工具集不设限
/// （不传 `--tools`/`--exclude-tools`），trust 也不覆盖（不传 `--approve`/
/// `--no-approve`），因此 aux 与主会话**唯一的不同权点就是扩展发现**。
pub fn aux_extra_args(spec: &AuxLaunchSpec) -> Vec<String> {
    let mut args = vec!["--no-session".to_string(), "--no-extensions".to_string()];
    if let Some(path) = &spec.file_changes_extension {
        args.push("--extension".into());
        args.push(path.to_string_lossy().into_owned());
    }
    if let Some(path) = &spec.workspace_extension {
        args.push("--extension".into());
        args.push(path.to_string_lossy().into_owned());
    }
    if spec.provider.trim() == crate::builtin_extensions::LLAMA_CPP_PROVIDER {
        // `--no-extensions` 同时移除注册 llama.cpp provider 的内置扩展，
        // 因此该 provider 必须显式回补。
        args.push("--extension".into());
        args.push(format!(
            "{}{}",
            crate::builtin_extensions::BUILTIN_PREFIX,
            crate::builtin_extensions::LLAMA_CPP_PROVIDER
        ));
    }
    args.push("--provider".into());
    args.push(spec.provider.clone());
    args.push("--model".into());
    args.push(spec.model.clone());
    if let Some(thinking) = spec.thinking.as_ref().filter(|t| !t.trim().is_empty()) {
        args.push("--thinking".into());
        args.push(thinking.clone());
    }
    args
}

/// 探测缓存键：可执行文件身份 + 参数集 + 版本。任一项变化都会重探。
pub fn probe_fingerprint(program_id: &str, args: &[String], version: &str) -> String {
    format!("{program_id}\u{0}{version}\u{0}{}", args.join("\u{1}"))
}

static PROBES: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn cache_get(key: &str) -> bool {
    let guard = match PROBES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    guard
        .as_ref()
        .and_then(|map| map.get(key))
        .is_some_and(|at| at.elapsed() < PROBE_TTL)
}

fn cache_put(key: &str) {
    let mut guard = match PROBES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    let map = guard.get_or_insert_with(HashMap::new);
    // 过期项一次性清理，避免长会话累积。
    map.retain(|_, at| at.elapsed() < PROBE_TTL);
    map.insert(key.to_string(), Instant::now());
}

/// 清空探测缓存（pi 部署/更新后由调用方触发，规格 §1"部署后失效"）。
pub fn reset_probe_cache() {
    let mut guard = match PROBES.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    *guard = None;
}

fn unsupported(detail: impl std::fmt::Display) -> String {
    pix_error_detail(
        "auxPiUnsupported",
        "当前 pi 版本不支持辅助对话所需的隔离参数",
        detail,
    )
}

/// 本地探测：用与真实 spawn **同一**可执行文件、**同一** cwd 与
/// `PIX_WORKSPACE`、**同一**完整参数起短生命周期 RPC。
///
/// 探测环境必须与正式启动一致：不同 cwd/workspace 会让项目设置、trust 命中和
/// 扩展加载路径都不同，"探测通过"就不代表"正式启动能跑"。
pub async fn probe_local(
    info: &crate::pi_locate::PiInfo,
    args: &[String],
    fingerprint: &str,
    project: &str,
    workspace_manifest: Option<&str>,
) -> Result<(), String> {
    probe_local_with_timeouts(
        info,
        args,
        fingerprint,
        project,
        workspace_manifest,
        HANDSHAKE_TIMEOUT,
        EXIT_TIMEOUT,
    )
    .await
}

/// 同 [`probe_local`]，但可注入超时。行为测试用它把 25s/20s 压到可测的短值，
/// 从而能真正断言"缺 `--mode rpc` 会超时失败"而不用等两分钟。
#[allow(clippy::too_many_arguments)]
pub(crate) async fn probe_local_with_timeouts(
    info: &crate::pi_locate::PiInfo,
    args: &[String],
    fingerprint: &str,
    project: &str,
    workspace_manifest: Option<&str>,
    handshake_timeout: Duration,
    exit_timeout: Duration,
) -> Result<(), String> {
    if cache_get(fingerprint) {
        return Ok(());
    }
    use std::process::Stdio;
    let mut cmd = crate::pi_locate::command_for(info)?;
    cmd.args(args);
    cmd.current_dir(project);
    if let Some(manifest) = workspace_manifest {
        // 与正式 spawn 同一条环境变量（`rpc/child.rs` 本地分支）。
        cmd.env("PIX_WORKSPACE", manifest);
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd
        .spawn()
        .map_err(|e| unsupported(format!("spawn failed: {e}")))?;
    let Some(mut stdin) = child.stdin.take() else {
        let _ = child.kill().await;
        return Err(unsupported("no stdin"));
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill().await;
        return Err(unsupported("no stdout"));
    };

    use tokio::io::AsyncWriteExt;
    if let Err(e) = stdin
        .write_all(b"{\"id\":\"aux-probe\",\"type\":\"get_state\"}\n")
        .await
    {
        let _ = child.kill().await;
        return Err(unsupported(format!("write failed: {e}")));
    }
    let mut lines = tokio::io::BufReader::new(stdout);
    let handshake = tokio::time::timeout(handshake_timeout, async {
        use tokio::io::AsyncBufReadExt;
        loop {
            let mut line = String::new();
            let read = match lines.read_line(&mut line).await {
                Ok(read) => read,
                Err(_) => return Err("stdout read failed".to_string()),
            };
            if read == 0 {
                return Err("pi exited before answering the probe".to_string());
            }
            let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
                continue;
            };
            if value["type"] != "response" || value["id"] != "aux-probe" {
                continue;
            }
            if value["success"] != true {
                return Err(format!(
                    "probe rejected: {}",
                    value["error"].as_str().unwrap_or("unknown")
                ));
            }
            if response_has_session_file(&value) {
                return Err("probe reported a session file".to_string());
            }
            return Ok(());
        }
    })
    .await;
    // EOF 让 pi 正常退出；无论探测结果如何都要回收进程。
    let _ = stdin.write_all(b"").await;
    drop(stdin);
    match handshake {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            let _ = child.kill().await;
            return Err(unsupported(error));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err(unsupported("probe timed out"));
        }
    }
    match tokio::time::timeout(exit_timeout, child.wait()).await {
        Ok(Ok(status)) if status.success() => {
            cache_put(fingerprint);
            Ok(())
        }
        Ok(Ok(status)) => Err(unsupported(format!("probe exit status: {status}"))),
        Ok(Err(e)) => Err(unsupported(format!("probe wait failed: {e}"))),
        Err(_) => {
            let _ = child.kill().await;
            Err(unsupported("probe did not exit after stdin EOF"))
        }
    }
}

/// 远程探测：同一条 payload 通道、同一 PATH 规则（`command -v pi` 优先，
/// 回退部署版），一次 exec 完成握手。
pub async fn probe_remote(
    endpoint: &crate::ssh::RemoteEndpoint,
    project_path: &str,
    args: &[String],
    fingerprint: &str,
) -> Result<(), String> {
    if cache_get(fingerprint) {
        return Ok(());
    }
    use crate::ssh::payload::posix_quote;
    let mut script = format!(
        "cd {} || exit 90\nPI_BIN=$(command -v pi 2>/dev/null)\n\
         if [ -z \"$PI_BIN\" ]; then PI_BIN=\"$HOME/.pix/pi/bin/pi\"; [ -x \"$PI_BIN\" ] || exit 92; fi\n\
         printf '%s\\n' '{{\"id\":\"aux-probe\",\"type\":\"get_state\"}}' | \"$PI_BIN\" --mode rpc",
        posix_quote(project_path)
    );
    for arg in args {
        script.push(' ');
        script.push_str(&posix_quote(arg));
    }
    script.push('\n');
    let output = crate::ssh::remote_exec(endpoint, &script, HANDSHAKE_TIMEOUT + EXIT_TIMEOUT)
        .await
        .map_err(|e| unsupported(format!("probe failed: {:?}", e.kind)))?;
    if output.exit_code != 0 {
        return Err(unsupported(format!("probe exit {}", output.exit_code)));
    }
    let mut answered = false;
    for line in output.stdout.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if value["type"] != "response" || value["id"] != "aux-probe" {
            continue;
        }
        if value["success"] != true {
            return Err(unsupported(format!(
                "probe rejected: {}",
                value["error"].as_str().unwrap_or("unknown")
            )));
        }
        if response_has_session_file(&value) {
            return Err(unsupported("probe reported a session file"));
        }
        answered = true;
    }
    if !answered {
        return Err(unsupported("probe produced no handshake response"));
    }
    cache_put(fingerprint);
    Ok(())
}

/// aux 的 spawn 前置校验：`--session` 与 `--no-session` 互斥。
pub fn ensure_ephemeral(session_file: Option<&str>) -> Result<(), String> {
    if session_file.is_some() {
        return Err(pix_error("auxSessionForbidden", "辅助对话不接受会话文件"));
    }
    Ok(())
}

/// 探测用的完整参数：`--mode rpc` 必须显式给出。
///
/// 缺了它 pi 会落到 print 模式（读 stdin 收尾才输出），探测只能等到超时；
/// 这里与正式 argv 保持同一前缀顺序，便于 `probe_args_starts_in_rpc_mode` 钉住。
pub fn probe_args(spec: &AuxLaunchSpec) -> Vec<String> {
    let mut args = vec!["--mode".to_string(), "rpc".to_string()];
    args.extend(aux_extra_args(spec));
    args
}

/// `get_state` 响应里出现 `sessionFile` 即视为探测失败（该进程会落盘）。
pub fn response_has_session_file(value: &Value) -> bool {
    value["data"].get("sessionFile").is_some() || value.get("sessionFile").is_some()
}

/// aux 规格的 JSON 形态（远程 `rpc_spawn` 参数）。
pub fn spec_from_json(value: &Value) -> Result<AuxLaunchSpec, String> {
    let provider = value["provider"].as_str().unwrap_or("").trim().to_string();
    let model = value["model"].as_str().unwrap_or("").trim().to_string();
    if provider.is_empty() || model.is_empty() {
        return Err(pix_error(
            "auxModelMissing",
            "辅助对话需要显式指定模型",
        ));
    }
    Ok(AuxLaunchSpec {
        provider,
        model,
        thinking: value["thinking"].as_str().map(str::to_owned),
        file_changes_extension: None,
        workspace_extension: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 假 pi 可执行文件：只有收到 `--mode rpc` 才在 stdin 读到请求后回 `get_state`；
    /// 否则一直读 stdin 到 EOF、什么都不输出 —— 与真实 pi 的 print 模式行为一致。
    fn fake_pi_script() -> &'static str {
        // 单文件 node 脚本：参数检查 + JSONL 应答 + EOF 退出。
        const SCRIPT: &str = r#"
let rpc = process.argv.includes('--mode') && process.argv.includes('rpc');
process.stdin.resume();
process.stdin.on('data', (chunk) => {
  if (!rpc) return;
  for (const line of String(chunk).split('\n')) {
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    process.stdout.write(JSON.stringify({ id: req.id, type: 'response', command: req.type, success: true, data: {} }) + '\n');
  }
});
process.stdin.on('end', () => process.exit(0));
"#;
        SCRIPT
    }

    fn fake_pi_info(script_path: &std::path::Path) -> crate::pi_locate::PiInfo {
        crate::pi_locate::PiInfo {
            found: true,
            path: Some(script_path.to_string_lossy().into_owned()),
            version: Some("1.5.2".into()),
            source: Some("config".into()),
            hint: String::new(),
            launcher: Some(crate::pi_locate::Launcher::Node {
                node: std::env::var("PIX_TEST_NODE").unwrap_or_else(|_| "node".into()),
                script: script_path.to_string_lossy().into_owned(),
            }),
        }
    }

    fn write_fake_pi(dir: &std::path::Path) -> Option<std::path::PathBuf> {
        if crate::ssh::transport::find_test_program("node").is_none() {
            return None;
        }
        let path = dir.join("fake-pi.js");
        std::fs::write(&path, fake_pi_script()).ok()?;
        Some(path)
    }

    fn spec_local() -> AuxLaunchSpec {
        AuxLaunchSpec {
            provider: "home".into(),
            model: "m".into(),
            thinking: Some("off".into()),
            file_changes_extension: None,
            workspace_extension: None,
        }
    }

    /// **行为回归**（替代纯字符串断言）：真起进程。
    /// - 带 `--mode rpc`：握手通过（假 pi 才应答）；
    /// - 去掉它：假 pi 不出声，探测必须在压短的超时内失败。
    #[tokio::test]
    async fn probe_local_requires_rpc_mode_at_runtime_not_just_in_argv() {
        let dir = std::env::temp_dir().join(format!("pix-aux-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let Some(script) = write_fake_pi(&dir) else {
            eprintln!("跳过：开发环境未找到 node");
            std::fs::remove_dir_all(&dir).ok();
            return;
        };
        let info = fake_pi_info(&script);
        let project = dir.to_string_lossy().to_string();
        let spec = spec_local();

        // 正例：完整参数（含 --mode rpc）。
        let ok_args = probe_args(&spec);
        assert_eq!(ok_args[0], "--mode");
        let ok = probe_local_with_timeouts(
            &info,
            &ok_args,
            "fp-ok",
            &project,
            None,
            Duration::from_secs(10),
            Duration::from_secs(10),
        )
        .await;
        assert!(ok.is_ok(), "带 --mode rpc 时必须握手成功：{ok:?}");

        // 反例：去掉 --mode rpc —— 假 pi 落到 print 行为，不应答，必须超时失败。
        let mut bad_args = probe_args(&spec);
        bad_args.drain(0..2);
        let start = std::time::Instant::now();
        let bad = probe_local_with_timeouts(
            &info,
            &bad_args,
            "fp-bad",
            &project,
            None,
            Duration::from_millis(800),
            Duration::from_secs(5),
        )
        .await;
        let err = bad.expect_err("去掉 --mode rpc 必须失败（否则这条测试没有保护力）");
        assert!(
            err.contains("auxPiUnsupported") && err.contains("probe timed out"),
            "必须是超时失败而不是别的错误：{err}"
        );
        assert!(
            start.elapsed() < Duration::from_secs(4),
            "注入超时应当立即生效，实际耗时 {:?}",
            start.elapsed()
        );

        // 探测缓存只记录成功；失败不得写入缓存（下次仍会重探）。
        assert!(!cache_get("fp-bad"), "失败结果不能被缓存");
        reset_probe_cache();
        std::fs::remove_dir_all(&dir).ok();
    }

    fn spec(provider: &str) -> AuxLaunchSpec {
        AuxLaunchSpec {
            provider: provider.into(),
            model: "m".into(),
            thinking: Some("off".into()),
            file_changes_extension: Some(PathBuf::from("/x/pix-file-changes.js")),
            workspace_extension: Some(PathBuf::from("/x/pix-workspace.js")),
        }
    }

    #[test]
    fn extra_args_start_with_no_session_then_no_extensions_and_never_restrict_tools() {
        // `--no-session` 的唯一产出点就是这个函数：本地 spawn 与远程 payload
        // 都原样拼它，因此这里钉住位置与唯一性。
        let args = aux_extra_args(&spec("home"));
        assert_eq!(args[0], "--no-session");
        assert_eq!(args[1], "--no-extensions");
        assert_eq!(
            args.iter().filter(|a| **a == "--no-session").count(),
            1,
            "aux argv 只能有一个 --no-session"
        );
        for forbidden in [
            "--tools",
            "--exclude-tools",
            "--no-mcp",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-context-files",
            "--approve",
            "--no-approve",
            "--session",
        ] {
            assert!(
                !args.iter().any(|a| a == forbidden),
                "{forbidden} must not be part of the aux argv"
            );
        }
    }

    #[test]
    fn whitelist_is_exactly_the_audited_extensions() {
        let args = aux_extra_args(&spec("home"));
        let extensions: Vec<&String> = args
            .iter()
            .enumerate()
            .filter(|(index, _)| *index > 0 && args[index - 1] == "--extension")
            .map(|(_, arg)| arg)
            .collect();
        assert_eq!(
            extensions,
            vec![
                &"/x/pix-file-changes.js".to_string(),
                &"/x/pix-workspace.js".to_string()
            ]
        );
    }

    #[test]
    fn llama_provider_backfills_the_builtin_extension() {
        let args = aux_extra_args(&spec("llama.cpp"));
        assert_eq!(
            args,
            vec![
                "--no-session",
                "--no-extensions",
                "--extension",
                "/x/pix-file-changes.js",
                "--extension",
                "/x/pix-workspace.js",
                "--extension",
                "builtin:llama.cpp",
                "--provider",
                "llama.cpp",
                "--model",
                "m",
                "--thinking",
                "off",
            ]
        );
    }

    #[test]
    fn thinking_is_optional() {
        let mut launch = spec("home");
        launch.thinking = None;
        let args = aux_extra_args(&launch);
        assert!(!args.iter().any(|arg| arg == "--thinking"));
    }

    /// 探测必须以 `--mode rpc` 起进程：缺了它 pi 落到 print 模式、只等 stdin
    /// 收尾，探测只能超时（这正是本次被漏掉的阻塞缺陷）。
    #[test]
    fn probe_args_start_in_rpc_mode() {
        let args = probe_args(&spec("home"));
        assert_eq!(args[0], "--mode");
        assert_eq!(args[1], "rpc");
        // 顺序与正式 argv 一致：mode rpc → no-session → no-extensions → -e… → provider/model
        assert_eq!(args[2], "--no-session");
        assert_eq!(args[3], "--no-extensions");
        assert!(args.contains(&"--provider".to_string()));
        assert!(!args.contains(&"--session".to_string()));
    }

    /// 可失败性：把 `--mode rpc` 去掉必须能被断言发现（否则下次被改回去无人发现）。
    #[test]
    fn dropping_mode_rpc_is_detected_by_the_assertion() {
        let mut args = probe_args(&spec("home"));
        args.drain(0..2);
        assert_ne!(args[0], "--mode", "去掉 --mode rpc 后首项不再是 --mode");
        assert!(
            !args.windows(2).any(|pair| pair[0] == "--mode" && pair[1] == "rpc"),
            "缺 --mode rpc 时不应再出现该组合"
        );
    }

    #[test]
    fn fingerprint_changes_with_any_input() {
        let base = probe_args(&spec("home"));
        assert_ne!(
            probe_fingerprint("a", &base, "1.5.2"),
            probe_fingerprint("b", &base, "1.5.2")
        );
        assert_ne!(
            probe_fingerprint("a", &base, "1.5.2"),
            probe_fingerprint("a", &base, "1.5.3")
        );
    }

    #[test]
    fn session_file_is_rejected_for_aux() {
        assert!(ensure_ephemeral(None).is_ok());
        let err = ensure_ephemeral(Some("C:/tmp/s.jsonl")).expect_err("must reject");
        assert!(err.contains("auxSessionForbidden"));
    }

    #[test]
    fn response_session_file_is_detected() {
        assert!(response_has_session_file(
            &json!({"data": {"sessionFile": "x"}})
        ));
        assert!(!response_has_session_file(&json!({"data": {}})));
    }

    #[test]
    fn spec_from_json_requires_provider_and_model() {
        assert!(spec_from_json(&json!({"provider": "home"})).is_err());
        let spec = spec_from_json(&json!({"provider": "home", "model": "m"})).unwrap();
        assert_eq!(spec.provider, "home");
        assert!(spec.file_changes_extension.is_none());
    }
}
