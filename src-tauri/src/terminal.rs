//! Built-in interactive terminal backed by a real PTY (ConPTY on Windows).
//!
//! Each terminal gets an id; output is streamed to the frontend through the
//! `term://output` event (base64-encoded so multi-byte UTF-8 split across
//! reads survives). Emitting via `remote::emit` reaches both the desktop
//! webview and remote browser clients over their respective channels. Input
//! and resize travel through regular commands.
//!
//! `cwd` 为唯一分流判据（P2 契约 `docs/plans/ssh-remote-p2-contracts.md` §3.2）：
//! 本地路径 spawn 本地 shell；`ssh://` 展示 URI 时 spawn 本机 `ssh -tt`
//! （本地 tty 让 ssh 把 SIGWINCH 转发为远端 PTY 尺寸变更，resize 只需
//! resize 本地 master），输出帧协议与 term_write/term_resize/term_kill
//! 生命周期完全复用。

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;

use crate::errors::{pix_error, pix_error_detail};
use crate::ssh::{self, SshEndpoint, SshTarget};
use std::io::{Read, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, State};

pub struct TerminalSession {
    writer: Box<dyn Write + Send>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
}

#[derive(Default)]
pub struct TerminalState {
    next_id: AtomicU32,
    sessions: Mutex<HashMap<u32, TerminalSession>>,
}

/// 终端事件出口抽象（对齐 `rpc::EventSink` 模式）：生产侧走 `AppHandle`
/// （`remote::emit` 同时送达桌面 webview 与远程浏览器），测试侧用收集
/// sink 断言 `term://output` / `term://exit` 帧协议。
trait TermSink: Send + Sync {
    fn emit(&self, event: &'static str, payload: serde_json::Value);
}

struct AppSink(AppHandle);

impl TermSink for AppSink {
    fn emit(&self, event: &'static str, payload: serde_json::Value) {
        crate::remote::emit(&self.0, event, payload);
    }
}

/// Pick a sensible login shell for the current platform.
fn default_shell() -> String {
    #[cfg(windows)]
    {
        // Prefer pwsh, fall back to the always-available Windows PowerShell.
        if std::path::Path::new(r"C:\Program Files\PowerShell\7\pwsh.exe").exists() {
            return r"C:\Program Files\PowerShell\7\pwsh.exe".to_string();
        }
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}

#[tauri::command]
pub fn term_create(
    app: AppHandle,
    state: State<'_, TerminalState>,
    cwd: String,
    cols: u16,
    rows: u16,
    owner: Option<String>,
    ssh_connection_id: Option<String>,
) -> Result<u32, String> {
    let sink: Arc<dyn TermSink> = Arc::new(AppSink(app));
    // 分流判据与 rpc_spawn 一致：parse 成功即远程分支；本地路径（即使误传
    // ssh_connection_id）行为与原来逐字节一致。
    match ssh::parse_ssh_uri(&cwd) {
        Some(target) => {
            let endpoint = resolve_remote_endpoint(&target, ssh_connection_id.as_deref())?;
            let cmd = build_remote_command(&target, &endpoint);
            spawn_terminal(&sink, &state, cmd, owner, cols, rows)
        }
        None => {
            let cmd = build_local_command(&cwd);
            spawn_terminal(&sink, &state, cmd, owner, cols, rows)
        }
    }
}

/// 本地分支命令构造（与原 term_create 主体逐行一致）。
fn build_local_command(cwd: &str) -> CommandBuilder {
    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    if cfg!(windows) {
        cmd.arg("-NoLogo");
    }
    if !cwd.is_empty() {
        cmd.cwd(cwd);
    }
    if cfg!(not(windows)) && std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }
    cmd
}

/// 远程分支命令构造（契约 §3.3）：本机 `ssh -tt`，远端命令经 base64 通道
/// 作为最后一个 argv 单元素投递；TERM 恒为 xterm-256color，ssh 会把本地
/// TERM 转发给远端，保证 xterm.js 渲染语义一致。
fn build_remote_command(target: &SshTarget, endpoint: &SshEndpoint) -> CommandBuilder {
    let remote_command = ssh::wrap_payload(&build_remote_shell_payload(&target.path));
    let (program, args) = build_remote_command_parts(endpoint, &remote_command);
    let mut cmd = CommandBuilder::new(&program);
    cmd.args(&args);
    cmd.env("TERM", "xterm-256color");
    cmd
}

/// 终端交互 payload（契约 §3.3 第 2 条）：cd 失败不退码（区别于 spawn
/// payload 的 `|| exit 90`），仍进入 shell 让用户看到错误并自行修复。
/// echo 文案路径同样经 posix_quote 注入，防路径中的引号/`$` 破坏脚本。
fn build_remote_shell_payload(project_path: &str) -> String {
    format!(
        "cd {} 2>/dev/null || echo {} >&2\nexec \"${{SHELL:-/bin/sh}}\" -l\n",
        ssh::posix_quote(project_path),
        ssh::posix_quote(&format!("cd: cannot enter {project_path}")),
    )
}

/// 完整本地命令 `(程序, 参数数组)`（契约 §3.3 第 3 条）：消费
/// `ssh_program_parts()` 使 `PIX_SSH_COMMAND` 测试钩子对终端同样生效，
/// 远端命令恒为最后一个 argv 单元素；ssh 参数消费会话与信任 agent 交付的
/// `ssh::build_ssh_args_interactive`（契约 §3.3 第 1 条，`-tt` 位于目的地
/// 之前，其后参数才会被 ssh 视为远端命令）。
fn build_remote_command_parts(
    endpoint: &SshEndpoint,
    remote_command: &str,
) -> (String, Vec<String>) {
    let parts = ssh::ssh_program_parts();
    let mut args: Vec<String> = parts[1..].to_vec();
    args.extend(ssh::build_ssh_args_interactive(endpoint));
    args.push(remote_command.to_string());
    (parts[0].clone(), args)
}

/// 远程终端分支的连接校验（契约 §3.2，对齐 spawn_remote `commands/pi.rs:111-129`；
/// 校验逻辑按契约在 terminal.rs 内私有实现）：连接 id 缺失 →
/// `sshConnectionMissing`；不存在 → `sshConnectionNotFound`；host/port/user
/// 与 URI 不一致 → `sshConnectionMismatch`。
fn resolve_remote_endpoint(
    target: &SshTarget,
    ssh_connection_id: Option<&str>,
) -> Result<SshEndpoint, String> {
    resolve_remote_endpoint_in(&ssh::config::config_path(), target, ssh_connection_id)
}

fn resolve_remote_endpoint_in(
    config_path: &Path,
    target: &SshTarget,
    ssh_connection_id: Option<&str>,
) -> Result<SshEndpoint, String> {
    let Some(connection_id) = ssh_connection_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .map(str::to_string)
    else {
        return Err(pix_error("sshConnectionMissing", "远程项目没有匹配的 SSH 连接"));
    };
    let connection = ssh::config::find_connection_in(config_path, &connection_id)?.ok_or_else(
        || pix_error("sshConnectionNotFound", "SSH 连接不存在，可能已被删除"),
    )?;
    // 连接的 host/port/user 与 project URI 解析结果完全一致（port 缺省 22
    // 在保存时已归一化，直接参与 == 比较），两层冗余防止前端错配。
    if connection.host != target.host
        || connection.port != target.port
        || connection.user != target.user
    {
        return Err(pix_error("sshConnectionMismatch", "SSH 连接配置与项目地址不一致"));
    }
    Ok(connection.to_endpoint())
}

/// 共享 spawn 核心：PTY 装配、输出 base64 帧线程、exit 通知与会话登记，
/// 本地与远程分支完全复用。
fn spawn_terminal(
    sink: &Arc<dyn TermSink>,
    state: &TerminalState,
    cmd: CommandBuilder,
    owner: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<u32, String> {
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    let pair = native_pty_system()
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| pix_error_detail("terminalOpenFailed", format!("打开终端失败: {e}"), e))?;

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| pix_error_detail("shellSpawnFailed", format!("启动 shell 失败: {e}"), e))?;
    let killer = child.clone_killer();
    let writer = pair.master.take_writer().map_err(|e| format!("{e}"))?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("{e}"))?;

    // Stream PTY output to the frontend. The PTY read is blocking, so it runs
    // on a dedicated blocking thread instead of pinning an async worker.
    let sink_out = sink.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            let sink = sink_out;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        sink.emit(
                            "term://output",
                            json!({ "id": id, "owner": owner, "data": encoded }),
                        );
                    }
                }
            }
        })
        .await;
    });

    // Notify the webview when the shell exits.
    let sink_exit = sink.clone();
    tauri::async_runtime::spawn(async move {
        let status = tokio::task::spawn_blocking(move || child.wait()).await;
        let code = match status {
            Ok(Ok(c)) => c.exit_code(),
            _ => 1,
        };
        sink_exit.emit("term://exit", json!({ "id": id, "code": code }));
    });

    state.sessions.lock().unwrap().insert(
        id,
        TerminalSession {
            writer,
            master: pair.master,
            killer,
        },
    );

    Ok(id)
}

#[tauri::command]
pub fn term_write(state: State<'_, TerminalState>, id: u32, data: String) -> Result<(), String> {
    write_session(&state, id, &data)
}

fn write_session(state: &TerminalState, id: u32, data: &str) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| pix_error("terminalClosed", "终端已关闭"))?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_resize(
    state: State<'_, TerminalState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions
        .get(&id)
        .ok_or_else(|| pix_error("terminalClosed", "终端已关闭"))?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn term_kill(state: State<'_, TerminalState>, id: u32) -> Result<(), String> {
    kill_session(&state, id);
    Ok(())
}

/// 杀掉本地子进程（本地 shell 或本机 ssh；`ssh -tt` 的会话随本地 ssh
/// 退出而终止，`ChildKiller` 即杀本地 ssh）。
fn kill_session(state: &TerminalState, id: u32) {
    if let Some(session) = state.sessions.lock().unwrap().remove(&id) {
        let mut killer = session.killer;
        let _ = killer.kill();
    }
}

/// Kill every live terminal (called on app exit).
pub fn kill_all(state: &TerminalState) {
    let mut sessions = state.sessions.lock().unwrap();
    for (_, session) in sessions.drain() {
        let mut killer = session.killer;
        let _ = killer.kill();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::transport::{env_lock, find_test_program};
    use crate::ssh::SshConnection;
    use std::time::Duration;

    /// 把终端事件收进 channel，供断言帧协议（对齐 child.rs 的 CollectingSink）。
    struct ChannelSink(std::sync::mpsc::Sender<(&'static str, serde_json::Value)>);

    impl TermSink for ChannelSink {
        fn emit(&self, event: &'static str, payload: serde_json::Value) {
            let _ = self.0.send((event, payload));
        }
    }

    fn endpoint() -> SshEndpoint {
        SshEndpoint {
            host: "host.example.com".to_string(),
            port: 2222,
            user: Some("dev".to_string()),
            key_path: None,
        }
    }

    fn target() -> SshTarget {
        SshTarget {
            host: "host.example.com".to_string(),
            port: 2222,
            user: Some("dev".to_string()),
            path: "/home/dev/proj".to_string(),
        }
    }

    fn temp_config_path(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "pix-terminal-{tag}-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    fn connection_with(id: &str, host: &str, port: u16, user: Option<&str>) -> SshConnection {
        SshConnection {
            id: id.to_string(),
            name: "n".to_string(),
            host: host.to_string(),
            port,
            user: user.map(str::to_string),
            key_path: None,
            created_at: String::new(),
            last_used_at: None,
            last_probe: None,
        }
    }

    fn write_connections(path: &Path, list: &[SshConnection]) {
        // ConfigView 是 struct + flatten，不接受顶层数组。
        std::fs::write(
            path,
            serde_json::to_string(&serde_json::json!({ "sshConnections": list })).unwrap(),
        )
        .unwrap();
    }

    /// 新版 Windows 的 ConPTY 在向终端发送 `ESC[6n`（光标位置请求）后暂停
    /// 渲染，直到收到 CPR 应答——生产环境由 xterm.js 自动应答；测试里没有
    /// xterm.js，需要模拟该应答（写到 master 输入端，ConPTY 自行消费，
    /// 不会进入子进程）。
    const CONPTY_DSR: &[u8] = b"\x1b[6n";
    const CONPTY_CPR_REPLY: &[u8] = b"\x1b[1;1R";

    /// 收集输出帧并处理 ConPTY CPR 握手；返回累计解码输出。在 deadline 内
    /// 持续等待，直到 `done` 判定成立。
    fn collect_frames(
        state: &TerminalState,
        id: u32,
        rx: &std::sync::mpsc::Receiver<(&'static str, serde_json::Value)>,
        deadline: std::time::Instant,
        done: &dyn Fn(&str) -> bool,
    ) -> String {
        let mut decoded = String::new();
        let mut handshook = false;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(("term://output", payload)) => {
                    let data = payload["data"].as_str().unwrap_or_default();
                    decoded.push_str(&String::from_utf8_lossy(
                        &base64::engine::general_purpose::STANDARD
                            .decode(data)
                            .unwrap_or_default(),
                    ));
                    if !handshook && decoded.as_bytes().windows(4).any(|w| w == CONPTY_DSR) {
                        let reply = std::str::from_utf8(CONPTY_CPR_REPLY).unwrap();
                        let _ = write_session(state, id, reply);
                        handshook = true;
                    }
                    if done(&decoded) {
                        break;
                    }
                }
                Ok((event, payload)) => {
                    panic!("意外事件 {event}: {payload}; 已收输出: {decoded:?}")
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(e) => panic!("事件通道断开: {e}"),
            }
        }
        decoded
    }

    #[test]
    fn build_remote_command_uses_shared_interactive_args() {
        // ssh_program_parts 读进程级环境变量，与其它 PIX_SSH_COMMAND 测试串行。
        let _guard = env_lock();
        // 消费侧契约检查：ssh::build_ssh_args_interactive 的序列去掉
        // BatchMode、-tt 位于目的地之前；本分支只负责前置参数 + 单元素远端命令。
        let mut ep = endpoint();
        ep.key_path = Some("/home/dev/id_ed25519".to_string());
        let (program, args) = build_remote_command_parts(&ep, "remote-cmd");
        assert_eq!(program, "ssh");
        assert_eq!(
            args,
            vec![
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ConnectTimeout=10",
                "-tt",
                "-p",
                "2222",
                "-i",
                "/home/dev/id_ed25519",
                "dev@host.example.com",
                // 远端命令恒为最后一个 argv 单元素。
                "remote-cmd",
            ]
        );
        assert!(!args.contains(&"BatchMode=yes".to_string()));
    }

    #[test]
    fn remote_shell_payload_matches_contract_shape() {
        let payload = build_remote_shell_payload("/home/dev/proj");
        assert_eq!(
            payload,
            "cd '/home/dev/proj' 2>/dev/null || \
             echo 'cd: cannot enter /home/dev/proj' >&2\n\
             exec \"${SHELL:-/bin/sh}\" -l\n"
        );
        // cd 失败不退码：payload 不含 spawn 分支的 `|| exit 90`。
        assert!(!payload.contains("exit 90"));
        // 含单引号与 `$` 的路径经 posix_quote 注入后不会破坏脚本。
        let tricky = build_remote_shell_payload("/home/d'$v");
        assert!(tricky.starts_with("cd '/home/d'\\''$v' "));
        assert!(tricky.contains("echo 'cd: cannot enter /home/d'\\''$v' >&2"));
    }

    #[test]
    fn build_remote_command_parts_injects_pix_ssh_command() {
        let _guard = env_lock();
        std::env::set_var("PIX_SSH_COMMAND", "mock-ssh -F /tmp/ssh-config");
        let (program, args) =
            build_remote_command_parts(&endpoint(), "/bin/sh -c 'echo AB | base64 -d | /bin/sh'");
        std::env::remove_var("PIX_SSH_COMMAND");
        assert_eq!(program, "mock-ssh");
        assert_eq!(args.first().map(String::as_str), Some("-F"));
        // 远端命令恒为最后一个 argv 单元素；-tt 在目的地之前。
        assert_eq!(
            args.last().map(String::as_str),
            Some("/bin/sh -c 'echo AB | base64 -d | /bin/sh'")
        );
        let tt = args.iter().position(|a| a == "-tt").unwrap();
        let dest = args.iter().position(|a| a == "dev@host.example.com").unwrap();
        assert!(tt < dest);
    }

    #[test]
    fn resolve_remote_endpoint_requires_connection_id_for_ssh_uri() {
        let path = temp_config_path("missing-id");
        let err = resolve_remote_endpoint_in(&path, &target(), None).unwrap_err();
        assert!(err.starts_with("PIXERR:"), "应为 coded error: {err}");
        let payload: serde_json::Value =
            serde_json::from_str(&err["PIXERR:".len()..]).unwrap();
        assert_eq!(payload["code"], "sshConnectionMissing");
        // 空白 id 同样视为缺失。
        let err = resolve_remote_endpoint_in(&path, &target(), Some("   ")).unwrap_err();
        assert!(err.contains("sshConnectionMissing"));
    }

    #[test]
    fn resolve_remote_endpoint_maps_not_found_and_mismatch() {
        let path = temp_config_path("notfound");
        write_connections(&path, &[]);

        let err = resolve_remote_endpoint_in(&path, &target(), Some("ssh-none")).unwrap_err();
        assert!(err.contains("sshConnectionNotFound"), "{err}");

        // host 不一致 → mismatch。
        write_connections(
            &path,
            &[connection_with("ssh-a", "other.example.com", 2222, Some("dev"))],
        );
        let err = resolve_remote_endpoint_in(&path, &target(), Some("ssh-a")).unwrap_err();
        assert!(err.contains("sshConnectionMismatch"), "{err}");

        // port 不一致 → mismatch。
        write_connections(&path, &[connection_with("ssh-a", "host.example.com", 22, Some("dev"))]);
        let err = resolve_remote_endpoint_in(&path, &target(), Some("ssh-a")).unwrap_err();
        assert!(err.contains("sshConnectionMismatch"), "{err}");

        // user 不一致 → mismatch。
        write_connections(&path, &[connection_with("ssh-a", "host.example.com", 2222, Some("root"))]);
        let err = resolve_remote_endpoint_in(&path, &target(), Some("ssh-a")).unwrap_err();
        assert!(err.contains("sshConnectionMismatch"), "{err}");

        // 一致 → 返回 endpoint。
        write_connections(
            &path,
            &[SshConnection {
                key_path: Some("~/keys/id_ed25519".to_string()),
                ..connection_with("ssh-a", "host.example.com", 2222, Some("dev"))
            }],
        );
        let endpoint = resolve_remote_endpoint_in(&path, &target(), Some("ssh-a")).unwrap();
        assert_eq!(endpoint.host, "host.example.com");
        assert_eq!(endpoint.port, 2222);
        assert_eq!(endpoint.user.as_deref(), Some("dev"));
        // keyPath 的 ~ 展开（to_endpoint 行为）。
        assert!(!endpoint.key_path.unwrap().starts_with('~'));
        let _ = std::fs::remove_file(&path);
    }

    /// 全链路 mock 单测：`PIX_SSH_COMMAND` 注入 node 回显程序替代 ssh，
    /// 走完整的 PTY spawn → `term://output` base64 帧 → ConPTY CPR 握手 →
    /// term_write → kill → `term://exit` 链路，不发起真实 SSH。
    #[test]
    fn mock_ssh_terminal_roundtrips_frames_and_kill() {
        let Some(node) = find_test_program("node") else {
            eprintln!("跳过：开发环境未找到 node");
            return;
        };
        if node.to_string_lossy().contains(' ') {
            eprintln!("跳过：node 路径含空白，无法经 PIX_SSH_COMMAND 注入");
            return;
        }
        // 回显 bot：stdin 数据原样写回 stdout（无空白，满足注入格式约束）。
        let bot = "process.stdin.resume();process.stdin.on('data',d=>process.stdout.write(d))";
        assert_eq!(bot.split_ascii_whitespace().count(), 1);

        let _guard = env_lock();
        std::env::set_var(
            "PIX_SSH_COMMAND",
            format!("{} -e {} --", node.display(), bot),
        );
        let cmd = build_remote_command(&target(), &endpoint());
        std::env::remove_var("PIX_SSH_COMMAND");
        drop(_guard);

        let state = TerminalState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink: Arc<dyn TermSink> = Arc::new(ChannelSink(tx));
        let id = spawn_terminal(&sink, &state, cmd, None, 80, 24).expect("mock 终端应创建成功");

        // 先等 ConPTY DSR（新版 Windows 渲染门控）并应答；xterm.js 在生产里
        // 做同样的事。之后行结束用 \r（Enter，与 xterm.js 一致）。
        let decoded = collect_frames(
            &state,
            id,
            &rx,
            std::time::Instant::now() + Duration::from_secs(15),
            &|decoded| decoded.as_bytes().windows(4).any(|w| w == CONPTY_DSR),
        );
        assert!(!decoded.is_empty(), "应收到非空 term://output 帧");
        std::thread::sleep(Duration::from_millis(500));

        // 回显命令文本：输出帧（base64 解码）必须含它。
        let marker = "PIX_TEST_ECHO_OK";
        write_session(&state, id, &format!("echo {marker}\r")).unwrap();
        let decoded = collect_frames(
            &state,
            id,
            &rx,
            std::time::Instant::now() + Duration::from_secs(15),
            &|decoded| decoded.contains(marker),
        );
        assert!(decoded.contains(marker), "回显应出现于解码输出: {decoded:?}");

        // kill 后本地子进程退出，term://exit 到达。
        kill_session(&state, id);
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut exited = false;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(("term://exit", payload)) => {
                    assert_eq!(payload["id"], id);
                    exited = true;
                    break;
                }
                Ok(("term://output", _)) => continue,
                Ok((event, _)) => panic!("意外事件 {event}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(e) => panic!("事件通道断开: {e}"),
            }
        }
        assert!(exited, "kill 后应收到 term://exit");
        // 会话已移除，再写报 terminalClosed。
        let err = write_session(&state, id, "x").unwrap_err();
        assert!(err.contains("terminalClosed"), "{err}");
    }

    /// 读取实机测试环境变量（契约 §6：任一缺失则 eprintln! 后跳过）。
    fn read_ssh_test_env() -> Option<(String, u16, String, String, String)> {
        let read = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        let (host, port, user, key_path, project) = (
            read("PIX_SSH_TEST_HOST"),
            read("PIX_SSH_TEST_PORT"),
            read("PIX_SSH_TEST_USER"),
            read("PIX_SSH_TEST_KEY_PATH"),
            read("PIX_SSH_TEST_PROJECT"),
        );
        let (Some(host), Some(port), Some(user), Some(key_path), Some(project)) =
            (host, port, user, key_path, project)
        else {
            eprintln!("跳过：缺少 PIX_SSH_TEST_* 环境变量（WSL 实机环境未配置）");
            return None;
        };
        match port.parse::<u16>() {
            Ok(port) => Some((host, port, user, key_path, project)),
            Err(_) => {
                eprintln!("跳过：PIX_SSH_TEST_PORT 不是合法端口: {port}");
                None
            }
        }
    }

    /// T-R 组共用：按实机环境变量构造远程终端命令并 spawn，返回
    /// (state, rx, id)。Windows 注入 `-4` 强制 IPv4（见下方 T-R1 注释）。
    fn ssh_real_open_terminal(
        env: &(String, u16, String, String, String),
    ) -> (
        TerminalState,
        std::sync::mpsc::Receiver<(&'static str, serde_json::Value)>,
        u32,
    ) {
        let (host, port, user, key_path, project) = env;
        let uri = format!("ssh://{user}@{host}:{port}{project}");
        let target =
            ssh::parse_ssh_uri(&uri).unwrap_or_else(|| panic!("测试 URI 应可解析: {uri:?}"));
        let endpoint = SshEndpoint {
            host: target.host.clone(),
            port: target.port,
            user: target.user.clone(),
            key_path: Some(key_path.clone()),
        };

        // 拿 env_lock 防其它测试并发改动 PIX_SSH_COMMAND。Windows OpenSSH
        // 对 localhost 优先走 ::1，而 WSL2 的 localhost 转发只正确中继 IPv4
        // （::1 连接会在 banner exchange 被拒），经冻结注入点加 -4 强制 IPv4；
        // known_hosts 条目按主机名 `[localhost]:2222` 记录，不受影响。
        let _guard = env_lock();
        #[cfg(windows)]
        std::env::set_var("PIX_SSH_COMMAND", "ssh -4");
        let cmd = build_remote_command(&target, &endpoint);
        #[cfg(windows)]
        std::env::remove_var("PIX_SSH_COMMAND");
        drop(_guard);

        let state = TerminalState::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let sink: Arc<dyn TermSink> = Arc::new(ChannelSink(tx));
        let id = spawn_terminal(&sink, &state, cmd, None, 80, 24)
            .expect("远程终端应创建成功（需 WSL sshd 就绪，见 docs/plans/wsl-test-env.md）");
        (state, rx, id)
    }

    /// T-R 组共用：等 ConPTY DSR 握手 + 登录 shell 提示符，确认输出链路就绪。
    fn ssh_real_wait_prompt(
        state: &TerminalState,
        id: u32,
        rx: &std::sync::mpsc::Receiver<(&'static str, serde_json::Value)>,
    ) -> String {
        let decoded = collect_frames(
            state,
            id,
            rx,
            std::time::Instant::now() + Duration::from_secs(30),
            &|decoded| {
                decoded.as_bytes().windows(4).any(|w| w == CONPTY_DSR)
                    && decoded.contains('$')
            },
        );
        assert!(
            decoded.as_bytes().windows(4).any(|w| w == CONPTY_DSR)
                && decoded.contains('$'),
            "30 秒内未收到完整 DSR 握手与提示符: {decoded:?}"
        );
        decoded
    }

    /// T-R 组共用：等 kill 后的 term://exit（本地 ssh 退出）。
    fn ssh_real_wait_exit(
        rx: &std::sync::mpsc::Receiver<(&'static str, serde_json::Value)>,
        id: u32,
    ) {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut exited = false;
        while std::time::Instant::now() < deadline {
            match rx.recv_timeout(Duration::from_secs(1)) {
                Ok(("term://exit", payload)) => {
                    assert_eq!(payload["id"], id);
                    exited = true;
                    break;
                }
                Ok(("term://output", _)) => continue,
                Ok((event, _)) => panic!("意外事件 {event}"),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(e) => panic!("事件通道断开: {e}"),
            }
        }
        assert!(exited, "kill 后 15 秒内未收到 term://exit");
    }

    /// 实机用例 T-R1（契约 §6 终端组，过滤器 ssh_real）：对 WSL 测试环境
    /// 真实开一个 `ssh -tt` 远程终端，写入命令，断言 `term://output`
    /// base64 帧非空且解码后含命令回显，kill 后 `term://exit` 到达。
    #[test]
    #[ignore]
    fn ssh_real_term_create_remote_terminal_roundtrip() {
        let Some(env) = read_ssh_test_env() else {
            return;
        };
        // 实机用例共享单 sshd（sshd 默认 MaxStartups=10，并发会 Connection
        // refused）与远端 ~/.pix 文件，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        let (state, rx, id) = ssh_real_open_terminal(&env);
        ssh_real_wait_prompt(&state, id, &rx);

        // 写入命令；回显（tty echo）+ 命令输出必须出现在解码后的帧里。
        // 行结束用 \r（Enter，与 xterm.js 一致）：Windows ConPTY 行输入只认
        // \r，远端 Linux tty 经 ICRNL 把 \r 归一为 \n。
        let marker = format!("PIX_TEST_{}", uuid::Uuid::new_v4());
        write_session(&state, id, &format!("echo {marker}\r")).unwrap();
        let decoded = collect_frames(
            &state,
            id,
            &rx,
            std::time::Instant::now() + Duration::from_secs(30),
            &|decoded| decoded.contains(&marker),
        );
        assert!(
            decoded.contains(&marker),
            "解码输出应含 {marker}: {decoded:?}"
        );

        // 进程可 kill：本地 ssh 退出并发出 term://exit。
        kill_session(&state, id);
        ssh_real_wait_exit(&rx, id);
    }

    /// 实机用例 T-R2（契约 §6）：resize 生效——term_resize 只 resize 本地
    /// master，ssh 检测到本地 stdin 为 tty 时把 SIGWINCH 转发为远端 PTY
    /// 尺寸变更；随后远端 `stty size` 的输出应反映新 cols/rows。
    #[test]
    #[ignore]
    fn ssh_real_term_resize_propagates_to_remote_pty() {
        let Some(_env) = read_ssh_test_env() else {
            return;
        };
        // 实机用例共享单 sshd，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        let (state, rx, id) = ssh_real_open_terminal(&_env);
        ssh_real_wait_prompt(&state, id, &rx);

        // resize 到 100x30（创建时为 80x24），稍候让 SIGWINCH 传播。
        {
            let sessions = state.sessions.lock().unwrap();
            sessions
                .get(&id)
                .expect("会话应存在")
                .master
                .resize(PtySize {
                    rows: 30,
                    cols: 100,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .expect("resize 本地 master 应成功");
        }
        std::thread::sleep(Duration::from_millis(500));

        // `stty size` 输出 "rows cols"；带唯一 marker 定界本次输出。
        let marker = format!("PIX_TEST_{}", uuid::Uuid::new_v4());
        write_session(&state, id, &format!("stty size; echo {marker}\r")).unwrap();
        let decoded = collect_frames(
            &state,
            id,
            &rx,
            std::time::Instant::now() + Duration::from_secs(30),
            &|decoded| decoded.contains(&marker),
        );
        assert!(
            decoded.contains(&marker),
            "解码输出应含 {marker}: {decoded:?}"
        );
        assert!(
            decoded.contains("30 100"),
            "resize 后远端 stty size 应报告 \"30 100\": {decoded:?}"
        );

        kill_session(&state, id);
        ssh_real_wait_exit(&rx, id);
    }

    /// 实机用例 T-R3（契约 §6）：kill 清理——term_kill 后本地 ssh 退出
    /// （term://exit），且远端无残留：kill 前先在远端放入带唯一标记的长驻
    /// 进程（`bash -c` 的完整 -c 字符串保留在 cmdline 中，`pgrep -f` 可匹配；
    /// 前导确认进程已出现，防止 kill 先于进程创建导致空断言平凡成立），
    /// kill 后经一次 exec `pgrep -f` 验证该标记进程已消失。
    #[tokio::test]
    #[ignore]
    async fn ssh_real_term_kill_leaves_no_remote_residual() {
        use crate::ssh::transport::ssh_exec;

        let Some((host, port, user, key_path, _project)) = read_ssh_test_env() else {
            return;
        };
        // 实机用例共享单 sshd，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        let endpoint = SshEndpoint {
            host: host.clone(),
            port,
            user: Some(user.clone()),
            key_path: Some(key_path.clone()),
        };
        let env = (host, port, user, key_path, _project);
        let (state, rx, id) = ssh_real_open_terminal(&env);
        ssh_real_wait_prompt(&state, id, &rx);

        let marker = format!("PIX_TEST_{}", uuid::Uuid::new_v4());
        // 长驻进程（sleep 60 自灭兜底）；`; true` 防 bash -c 单命令 exec 优化
        // 把 cmdline 换成 sleep 导致 pgrep -f 匹配不到标记。
        write_session(&state, id, &format!("bash -c 'sleep 60; true # {marker}'\r")).unwrap();

        // 前导确认：标记进程确实已在远端出现。
        // pgrep 无匹配时远端 exit 1，ssh_exec 归为 Err(Remote, exit 1)——视为空；
        // 其余 Err（超时/认证等）是真实失败，直接 panic。
        let pgrep = |marker: &str| {
            let endpoint = endpoint.clone();
            let script = format!("pgrep -f {}\n", ssh::posix_quote(marker));
            async move {
                match ssh_exec(&endpoint, &script, Duration::from_secs(10)).await {
                    Ok(output) => output.stdout.trim().to_string(),
                    Err(e)
                        if e.kind == crate::ssh::transport::SshErrorKind::Remote
                            && e.exit_code == Some(1) =>
                    {
                        String::new()
                    }
                    Err(e) => panic!("pgrep 探测 exec 意外失败: {e:?}"),
                }
            }
        };
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        loop {
            let pids = pgrep(&marker).await;
            if !pids.is_empty() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "30 秒内未见标记进程出现在远端"
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        }

        // kill：本地 ssh 退出，远端会话随连接关闭被 sshd 清理。
        kill_session(&state, id);
        ssh_real_wait_exit(&rx, id);

        // 远端无残留：轮询 pgrep 直至为空（给 sshd SIGHUP 传播留时间）；
        // 标记进程 sleep 60 自灭兜底不会掩盖真实残留（清理失败的进程会
        // 在整个轮询窗口内持续被命中）。
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        loop {
            let pids = pgrep(&marker).await;
            if pids.is_empty() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "kill 后远端仍有残留标记进程: {pids}"
            );
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    }
}
