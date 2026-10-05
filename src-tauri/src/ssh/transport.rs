//! 系统 ssh 传输实现（契约 §3.2–§3.3）。
//!
//! 通过 `tokio::process::Command` 以独立参数数组调用本机 ssh 客户端，
//! 本地不经任何 shell；远端命令经 payload 模块包装为单元素 argv。
//! `PIX_SSH_COMMAND` 环境变量可整体替换 ssh 程序（`program` 或
//! `program arg1 arg2 …`，ASCII 空白切分），供测试注入 mock，绝不发起真实 SSH。
//!
//! host key 校验交给用户 known_hosts 默认（不覆盖 StrictHostKeyChecking）；
//! `BatchMode=yes` 防挂在交互提示上；`ServerAliveInterval=15 × 3` 判定死链。

use std::future::Future;
use std::process::ExitStatus;
use std::time::Duration;

use std::process::Stdio;

use tokio::io::AsyncReadExt;
use tokio::process::{Child, Command};

use super::payload::{wrap_payload, PROBE_SCRIPT};

/// probe 的整体超时（契约 §2.4：30s 内未见 `PIX_PROBE_DONE` 判 `timeout`）。
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// Windows 下隐藏 ssh 客户端控制台窗口。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshEndpoint {
    pub host: String,
    pub port: u16,
    pub user: Option<String>,
    pub key_path: Option<String>,
}

/// 一次性命令输出。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// SSH 失败归一化（契约 §2.4）。coded error 的映射由上层完成，
/// 这里保留退出码与 stderr 摘要以保证信息不丢失（如 `test -d` 的 exit 1）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SshError {
    pub kind: SshErrorKind,
    /// 远端/客户端退出码；spawn 失败或超时为 `None`。
    pub exit_code: Option<i32>,
    /// stderr 摘要或本地错误说明，供日志与 coded error 参数使用。
    pub detail: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SshErrorKind {
    /// 本机 spawn ssh 失败（未安装 ssh 客户端；Windows 为可选功能）。
    SshMissing,
    /// 认证失败 / host key 校验失败。
    Auth,
    /// 主机解析或网络连接失败。
    Network,
    /// 整体超时。
    Timeout,
    /// 其余失败（非零退出、脚本中止等）。
    Remote,
}

impl SshError {
    pub fn new(kind: SshErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            exit_code: None,
            detail: detail.into(),
        }
    }
}

/// probe 结果（契约 §2.3 标签行协议解析产物）。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteProbe {
    pub uname: Option<String>,
    pub arch: Option<String>,
    pub node_version: Option<String>,
    pub pi_version: Option<String>,
    /// `NODE_V` 行出现即视为 node 存在。
    pub node_found: bool,
    /// `PI_BIN` 非空即视为 pi 存在。
    pub pi_found: bool,
}

/// 读取 `PIX_SSH_COMMAND`（整体替换 ssh 程序），缺省 `ssh`。
pub fn ssh_program() -> String {
    std::env::var("PIX_SSH_COMMAND").unwrap_or_else(|_| "ssh".to_string())
}

/// 按 ASCII 空白切分程序说明；首段为程序路径，其余为前置参数。
/// 空值回退为系统 `ssh`。
pub fn split_program_spec(spec: &str) -> Vec<String> {
    let parts: Vec<String> = spec.split_ascii_whitespace().map(str::to_string).collect();
    if parts.is_empty() {
        vec!["ssh".to_string()]
    } else {
        parts
    }
}

/// 当前生效的 ssh 程序与前置参数（`PIX_SSH_COMMAND` 注入点）。
pub fn ssh_program_parts() -> Vec<String> {
    split_program_spec(&ssh_program())
}

/// 纯函数：ssh 客户端参数数组（不含程序本体与 `PIX_SSH_COMMAND` 前置参数）。
/// `-p` 恒定传递（含 22），保证参数序列确定、可测。
pub fn build_ssh_args(endpoint: &SshEndpoint) -> Vec<String> {
    let mut args: Vec<String> = [
        "-o",
        "BatchMode=yes",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ConnectTimeout=10",
    ]
    .iter()
    .map(|s| (*s).to_string())
    .collect();
    args.push("-p".to_string());
    args.push(endpoint.port.to_string());
    if let Some(key_path) = &endpoint.key_path {
        args.push("-i".to_string());
        args.push(key_path.clone());
    }
    match &endpoint.user {
        Some(user) => args.push(format!("{user}@{}", endpoint.host)),
        None => args.push(endpoint.host.clone()),
    }
    args
}

/// 纯函数：完整本地命令 `(程序, 参数数组)`。
/// 远端命令恒为最后一个 argv 元素（单元素，内部含引号是刻意设计）。
pub fn build_ssh_command(endpoint: &SshEndpoint, remote_command: &str) -> (String, Vec<String>) {
    let parts = ssh_program_parts();
    let mut args = Vec::with_capacity(parts.len() - 1 + 9 + 1);
    args.extend(parts[1..].iter().cloned());
    args.extend(build_ssh_args(endpoint));
    args.push(remote_command.to_string());
    (parts[0].clone(), args)
}

/// 按契约 §2.4 把退出码 + stderr 归一化为 errorKind。
pub fn classify_failure(exit_code: i32, stderr: &str) -> SshErrorKind {
    let lower = stderr.to_lowercase();
    if exit_code == 255
        && [
            "permission denied",
            "host key verification failed",
            "publickey",
        ]
        .iter()
        .any(|keyword| lower.contains(keyword))
    {
        return SshErrorKind::Auth;
    }
    if [
        "could not resolve hostname",
        "connection refused",
        "connection timed out",
    ]
    .iter()
    .any(|keyword| lower.contains(keyword))
    {
        return SshErrorKind::Network;
    }
    SshErrorKind::Remote
}

/// 解析 probe 输出：stdout 逐行匹配 `^([A-Z_]+)=(.*)$`，非标签行
/// （SSH banner/motd）静默忽略；未读到 `PIX_PROBE_DONE` 返回 `None`。
pub fn parse_probe_output(stdout: &str) -> Option<RemoteProbe> {
    let mut probe = RemoteProbe::default();
    let mut done = false;
    for line in stdout.lines() {
        // 完成标记行不含 '='，需在标签行匹配前识别。
        if line.trim_end() == "PIX_PROBE_DONE" {
            done = true;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let is_label = !key.is_empty()
            && key
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b == b'_');
        if !is_label {
            continue;
        }
        let value = value.trim();
        let non_empty = (!value.is_empty()).then(|| value.to_string());
        match key {
            "UNAME_S" => probe.uname = non_empty,
            "UNAME_M" => probe.arch = non_empty,
            "NODE_V" => {
                probe.node_found = true;
                probe.node_version = non_empty;
            }
            "PI_BIN" => probe.pi_found = !value.is_empty(),
            "PI_V" => probe.pi_version = non_empty,
            "PIX_PROBE_DONE" => done = true,
            _ => {}
        }
    }
    done.then_some(probe)
}

/// 单次 exec：本地 ssh 进程以独立参数数组运行，输出整体收取；
/// 超时或 spawn 失败返回 `Err`，非零退出按 §2.4 归类为 `Err`（保留退出码与 stderr）。
pub async fn ssh_exec(
    endpoint: &SshEndpoint,
    script: &str,
    timeout: Duration,
) -> Result<ExecOutput, SshError> {
    let remote_command = wrap_payload(script);
    let mut command = build_command(endpoint, &remote_command);
    let mut child = command.spawn().map_err(spawn_error)?;
    let mut stdout = child.stdout.take().expect("ssh stdout is piped");
    let mut stderr = child.stderr.take().expect("ssh stderr is piped");
    // 超时后 future 被 drop，kill_on_drop 负责杀掉 ssh 子进程。
    let waited = tokio::time::timeout(timeout, async move {
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let (out_result, err_result, wait_result) = tokio::join!(
            stdout.read_to_end(&mut out_buf),
            stderr.read_to_end(&mut err_buf),
            child.wait(),
        );
        out_result?;
        err_result?;
        let status = wait_result?;
        Ok::<(Vec<u8>, Vec<u8>, ExitStatus), std::io::Error>((out_buf, err_buf, status))
    })
    .await;
    match waited {
        Err(_elapsed) => Err(SshError::new(
            SshErrorKind::Timeout,
            format!("ssh 执行超时（{} 秒）", timeout.as_secs()),
        )),
        Ok(Err(e)) => Err(SshError::new(
            SshErrorKind::Remote,
            format!("读取 ssh 输出失败: {e}"),
        )),
        Ok(Ok((out_buf, err_buf, status))) => {
            let stdout_text = String::from_utf8_lossy(&out_buf).into_owned();
            let stderr_text = String::from_utf8_lossy(&err_buf).into_owned();
            // 信号终止时没有退出码，记 -1；仅用于归类，不会与远端约定码 90/92/93 混淆。
            let exit_code = status.code().unwrap_or(-1);
            if exit_code == 0 {
                return Ok(ExecOutput {
                    stdout: stdout_text,
                    stderr: stderr_text,
                    exit_code,
                });
            }
            Err(SshError {
                kind: classify_failure(exit_code, &stderr_text),
                exit_code: Some(exit_code),
                detail: summarize_failure(exit_code, &stderr_text),
            })
        }
    }
}

/// 长驻流：返回已 stdio-piped 的本地 ssh 子进程（`kill_on_drop(true)`），
/// stdout 即远端进程输出；不设 `current_dir`。
pub async fn ssh_exec_stream(endpoint: &SshEndpoint, script: &str) -> Result<Child, SshError> {
    let remote_command = wrap_payload(script);
    let mut command = build_command(endpoint, &remote_command);
    command.spawn().map_err(spawn_error)
}

fn build_command(endpoint: &SshEndpoint, remote_command: &str) -> Command {
    let (program, args) = build_ssh_command(endpoint, remote_command);
    let mut command = Command::new(program);
    command.args(&args);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn spawn_error(e: std::io::Error) -> SshError {
    SshError::new(
        SshErrorKind::SshMissing,
        format!("无法启动本机 ssh 客户端: {e}"),
    )
}

fn summarize_failure(exit_code: i32, stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        format!("ssh 退出码 {exit_code}")
    } else {
        format!("ssh 退出码 {exit_code}: {trimmed}")
    }
}

/// SSH 传输抽象：本地系统 ssh 是 P1 后端；russh 等后续后端按此 trait 接入。
pub trait SshTransport: Send + Sync {
    /// 探测远端平台与 node/pi 安装情况（单次 exec，30s 超时）。
    fn probe(&self) -> impl Future<Output = Result<RemoteProbe, SshError>> + Send;
    /// 一次性远端命令。
    fn exec(
        &self,
        script: &str,
        timeout: Duration,
    ) -> impl Future<Output = Result<ExecOutput, SshError>> + Send;
    /// 长驻流（`pi --mode rpc`），返回本地 ssh 子进程。
    fn exec_stream(&self, script: &str)
        -> impl Future<Output = Result<Child, SshError>> + Send;
}

/// 系统 ssh 实现。
pub struct SystemSsh {
    endpoint: SshEndpoint,
}

impl SystemSsh {
    pub fn new(endpoint: SshEndpoint) -> Self {
        Self { endpoint }
    }
}

impl SshTransport for SystemSsh {
    async fn probe(&self) -> Result<RemoteProbe, SshError> {
        let output = ssh_exec(&self.endpoint, PROBE_SCRIPT, PROBE_TIMEOUT).await?;
        parse_probe_output(&output.stdout).ok_or_else(|| {
            SshError::new(
                SshErrorKind::Timeout,
                "probe 输出缺少完成标记 PIX_PROBE_DONE",
            )
        })
    }

    async fn exec(&self, script: &str, timeout: Duration) -> Result<ExecOutput, SshError> {
        ssh_exec(&self.endpoint, script, timeout).await
    }

    async fn exec_stream(&self, script: &str) -> Result<Child, SshError> {
        ssh_exec_stream(&self.endpoint, script).await
    }
}

/// 测试辅助：沿 PATH 查找可执行文件（找不到返回 None，调用方跳过测试）。
#[cfg(test)]
pub(crate) fn find_test_program(name: &str) -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH")?;
    let suffixes: &[String] = if cfg!(windows) {
        &[format!("{name}.exe"), name.to_string()]
    } else {
        &[name.to_string()]
    };
    for dir in std::env::split_paths(&path) {
        for suffix in suffixes {
            let candidate = dir.join(suffix);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// 环境变量是进程全局的，涉及 `PIX_SSH_COMMAND` 的测试（含跨模块，
/// 如 child.rs 的 mock spawn 链路）共用一把锁串行执行。
#[cfg(test)]
pub(crate) fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::super::payload::wrap_payload;
    use super::*;
    use std::path::PathBuf;

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        env_lock()
    }

    fn endpoint() -> SshEndpoint {
        SshEndpoint {
            host: "host.example.com".to_string(),
            port: 2222,
            user: Some("dev".to_string()),
            key_path: None,
        }
    }

    #[test]
    fn build_ssh_args_follows_contract_order() {
        let mut endpoint = endpoint();
        endpoint.key_path = Some("/home/dev/id_ed25519".to_string());
        assert_eq!(
            build_ssh_args(&endpoint),
            vec![
                "-o",
                "BatchMode=yes",
                "-o",
                "ServerAliveInterval=15",
                "-o",
                "ServerAliveCountMax=3",
                "-o",
                "ConnectTimeout=10",
                "-p",
                "2222",
                "-i",
                "/home/dev/id_ed25519",
                "dev@host.example.com",
            ]
        );
    }

    #[test]
    fn build_ssh_args_defaults_and_constant_port() {
        let endpoint = SshEndpoint {
            host: "host".to_string(),
            port: 22,
            user: None,
            key_path: None,
        };
        let args = build_ssh_args(&endpoint);
        // -p 恒定传递（含 22）；未配置 keyPath 时不出现 -i；目的地无 user 前缀。
        assert!(args.windows(2).any(|pair| pair == ["-p", "22"]));
        assert!(!args.iter().any(|arg| arg == "-i"));
        assert_eq!(args.last().map(String::as_str), Some("host"));
    }

    #[test]
    fn ssh_program_defaults_to_system_ssh() {
        let _guard = lock_env();
        std::env::remove_var("PIX_SSH_COMMAND");
        assert_eq!(ssh_program(), "ssh");
        assert_eq!(ssh_program_parts(), vec!["ssh".to_string()]);
    }

    #[test]
    fn pix_ssh_command_splits_program_and_prefix_args() {
        let _guard = lock_env();
        std::env::set_var("PIX_SSH_COMMAND", "mock-ssh   -F /tmp/ssh-config\t-vv");
        assert_eq!(
            ssh_program_parts(),
            vec![
                "mock-ssh".to_string(),
                "-F".to_string(),
                "/tmp/ssh-config".to_string(),
                "-vv".to_string(),
            ]
        );
        // 前置参数插入最前，远端命令是最后一个单元素 argv。
        let (program, args) = build_ssh_command(&endpoint(), "/bin/sh -c 'echo AB | base64 -d | /bin/sh'");
        assert_eq!(program, "mock-ssh");
        assert_eq!(args.first().map(String::as_str), Some("-F"));
        assert_eq!(
            args.last().map(String::as_str),
            Some("/bin/sh -c 'echo AB | base64 -d | /bin/sh'")
        );
        assert!(args.contains(&"dev@host.example.com".to_string()));
        std::env::remove_var("PIX_SSH_COMMAND");
    }

    #[test]
    fn classify_failure_maps_stderr_to_error_kinds() {
        assert_eq!(
            classify_failure(255, "dev@host: Permission denied (publickey)."),
            SshErrorKind::Auth
        );
        assert_eq!(
            classify_failure(255, "Host key verification failed."),
            SshErrorKind::Auth
        );
        assert_eq!(
            classify_failure(255, "ssh: Could not resolve hostname host: Name or service not known"),
            SshErrorKind::Network
        );
        assert_eq!(
            classify_failure(255, "connect to host 10.0.0.1 port 22: Connection refused"),
            SshErrorKind::Network
        );
        assert_eq!(
            classify_failure(1, "cd: /no/such/dir: No such file or directory"),
            SshErrorKind::Remote
        );
        assert_eq!(classify_failure(90, ""), SshErrorKind::Remote);
    }

    #[test]
    fn parse_probe_output_extracts_labels_and_ignores_banner() {
        let stdout = "Welcome to Ubuntu 24.04 LTS\nLast login: Fri Oct  3 09:00:00 2026\n\
                      UNAME_S=Linux\nUNAME_M=x86_64\nNODE_V=v22.10.0\n\
                      PI_BIN=/usr/local/bin/pi\nPI_V=0.9.3\nPIX_PROBE_DONE\n";
        let probe = parse_probe_output(stdout).expect("读到 PIX_PROBE_DONE 应解析成功");
        assert_eq!(probe.uname.as_deref(), Some("Linux"));
        assert_eq!(probe.arch.as_deref(), Some("x86_64"));
        assert!(probe.node_found);
        assert_eq!(probe.node_version.as_deref(), Some("v22.10.0"));
        assert!(probe.pi_found);
        assert_eq!(probe.pi_version.as_deref(), Some("0.9.3"));
    }

    #[test]
    fn parse_probe_output_requires_done_marker() {
        // 未读到完成标记（超时/截断）→ None。
        assert!(parse_probe_output("UNAME_S=Linux\nUNAME_M=x86_64\n").is_none());
        assert!(parse_probe_output("").is_none());
    }

    #[test]
    fn parse_probe_output_handles_missing_node_and_pi() {
        let probe = parse_probe_output("UNAME_S=Darwin\nUNAME_M=arm64\nPI_BIN=\nPIX_PROBE_DONE\n")
            .expect("应解析成功");
        assert!(!probe.node_found);
        assert!(!probe.pi_found);
        assert!(probe.node_version.is_none());
        assert!(probe.pi_version.is_none());
        assert_eq!(probe.uname.as_deref(), Some("Darwin"));
        assert_eq!(probe.arch.as_deref(), Some("arm64"));
    }

    /// 沿 PATH 查找可执行文件（找不到则跳过对应测试）。
    fn find_program(name: &str) -> Option<PathBuf> {
        find_test_program(name)
    }

    #[tokio::test]
    async fn ssh_exec_runs_injected_mock_program_without_real_ssh() {
        // 端到端验证参数与单元素 argv 传递：注入 node 作为 mock ssh，
        // 打印收到的最后一个 argv（远端命令）。要求开发环境 Node >= 22。
        let Some(node) = find_program("node") else {
            eprintln!("跳过：开发环境未找到 node");
            return;
        };
        if node.to_string_lossy().contains(' ') {
            eprintln!("跳过：node 路径含空白，无法经 PIX_SSH_COMMAND 注入");
            return;
        }
        let _guard = lock_env();
        std::env::set_var(
            "PIX_SSH_COMMAND",
            format!("{} -e console.log(process.argv.at(-1)) --", node.display()),
        );
        let result = ssh_exec(&endpoint(), "echo hi", Duration::from_secs(30)).await;
        std::env::remove_var("PIX_SSH_COMMAND");
        let output = result.expect("mock ssh exec 应成功");
        assert_eq!(output.exit_code, 0);
        assert_eq!(output.stdout.trim_end(), wrap_payload("echo hi"));
        assert_eq!(output.stderr, "");
    }

    #[tokio::test]
    async fn system_ssh_probe_parses_mock_probe_output() {
        let Some(node) = find_program("node") else {
            eprintln!("跳过：开发环境未找到 node");
            return;
        };
        if node.to_string_lossy().contains(' ') {
            eprintln!("跳过：node 路径含空白，无法经 PIX_SSH_COMMAND 注入");
            return;
        }
        let _guard = lock_env();
        std::env::set_var(
            "PIX_SSH_COMMAND",
            format!(
                "{} -e console.log('UNAME_S=Linux\\nUNAME_M=x86_64\\nPIX_PROBE_DONE') --",
                node.display()
            ),
        );
        let transport = SystemSsh::new(endpoint());
        let probe = transport.probe().await;
        std::env::remove_var("PIX_SSH_COMMAND");
        let probe = probe.expect("mock probe 应成功");
        assert_eq!(probe.uname.as_deref(), Some("Linux"));
        assert_eq!(probe.arch.as_deref(), Some("x86_64"));
        assert!(!probe.node_found);
        assert!(!probe.pi_found);
    }
}
