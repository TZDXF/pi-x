//! WSL 后端：发行版枚举与错误归类（多后端契约 §4.2/§4.4）。
//!
//! `wsl.exe` 自身消息（`-l` 列表、错误信息）是 UTF-16LE 或混合编码（V1/V8
//! 实测）；Linux 程序的输出按字节透传（V7）——因此 [`decode_wsl_output`]
//! 只用于 wsl.exe 自身输出，`remote_exec` 的脚本输出不做此处理。
//! 列表解析：`wsl.exe -l -v` 表头与数据列按 ≥2 空白分隔，`*` 前缀标记
//! default；数据行从右往左切（末 token = version，倒数第二 = state，
//! 其余剥 `*` 与空白 = name），使 name 内含单个空格也能存活。
//! 枚举不区分 default 排序，保持 wsl.exe 原顺序。

use std::process::Stdio;
use std::time::Duration;

use serde::Serialize;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

use super::backend::wsl_program_parts;
use super::transport::{SshError, SshErrorKind, CREATE_NO_WINDOW};
use crate::errors::{pix_error, pix_error_detail};

/// 枚举的整体超时（契约 §4.2：15s）。
pub const WSL_LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// 一条发行版信息（契约 §4.1）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WslDistroInfo {
    /// 原样（大小写保留）。
    pub name: String,
    /// "Running" / "Stopped" / …（wsl.exe 原文）。
    pub state: String,
    /// 1 | 2
    pub version: u32,
    /// `*` 前缀行。
    pub is_default: bool,
}

/// 本地 wsl.exe 一次性命令的原始输出；`exit_code` 为 `None` 表示 spawn 失败
/// （`timed_out == false`）或超时被 kill（`timed_out == true`）——两者必须可区分，
/// 超时是暂时性故障，不能归类为「未安装」。
#[derive(Debug, Default)]
pub struct RawOutput {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    /// 等待退出时超时（进程被 kill_on_drop 杀掉）。
    pub timed_out: bool,
}

/// 编码归一化（唯一入口，契约 §4.2 第 2 条）：字节流含 `\0` → 按 UTF-16LE
/// lossy 解码；否则 UTF-8 lossy。随后统一剥 `\0`、`\r`、UTF-16 BOM。
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    let decoded = if bytes.contains(&0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    decoded
        .chars()
        .filter(|c| !matches!(c, '\0' | '\r' | '\u{FEFF}'))
        .collect()
}

/// 解析 `wsl.exe -l -v` 输出（契约 §4.2 第 3 条）：跳过表头行（含 `NAME`）；
/// 数据行从右往左切：末 token = version（数字），倒数第二 token = state，
/// 其余（剥去行首 `*` 与空白）= name。解析不出的行静默跳过。
pub fn parse_wsl_list(stdout: &str) -> Vec<WslDistroInfo> {
    let mut distros = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (is_default, rest) = match trimmed.strip_prefix('*') {
            Some(rest) => (true, rest.trim_start()),
            None => (false, trimmed),
        };
        let tokens: Vec<&str> = rest.split_ascii_whitespace().collect();
        if tokens.len() < 3 {
            continue;
        }
        // 表头行（NAME STATE VERSION）：首 token 为 NAME 或末 token 非数字。
        if tokens[0].eq_ignore_ascii_case("name") {
            continue;
        }
        let Ok(version) = tokens[tokens.len() - 1].parse::<u32>() else {
            continue;
        };
        let state = tokens[tokens.len() - 2].to_string();
        let name = tokens[..tokens.len() - 2].join(" ");
        if name.is_empty() {
            continue;
        }
        distros.push(WslDistroInfo {
            name,
            state,
            version,
            is_default,
        });
    }
    distros
}

/// 经 `wsl_program_parts()` spawn 一次本地 wsl.exe 命令（独立参数，
/// stdio piped、`CREATE_NO_WINDOW`、超时 kill_on_drop）。
pub async fn run_wsl_command(args: &[&str], timeout: Duration) -> RawOutput {
    run_local_command(&wsl_program_parts(), args, timeout).await
}

/// `wsl.exe -l -v`（消费 `PIX_WSL_COMMAND` 测试钩子）。
pub async fn run_wsl_list() -> RawOutput {
    run_wsl_command(&["-l", "-v"], WSL_LIST_TIMEOUT).await
}

pub(crate) async fn run_local_command(program_parts: &[String], args: &[&str], timeout: Duration) -> RawOutput {
    let mut command = Command::new(&program_parts[0]);
    command.args(&program_parts[1..]);
    command.args(args);
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    let Ok(mut child) = command.spawn() else {
        return RawOutput::default();
    };
    let stdout = child.stdout.take().expect("wsl stdout is piped");
    let stderr = child.stderr.take().expect("wsl stderr is piped");
    let waited = tokio::time::timeout(timeout, async move {
        let mut out_buf = Vec::new();
        let mut err_buf = Vec::new();
        let mut stdout = stdout;
        let mut stderr = stderr;
        let (out, err, status) = tokio::join!(
            stdout.read_to_end(&mut out_buf),
            stderr.read_to_end(&mut err_buf),
            child.wait()
        );
        out.ok();
        err.ok();
        (out_buf, err_buf, status.ok().map(|s| s.code().unwrap_or(-1)))
    })
    .await;
    match waited {
        Ok((out_buf, err_buf, exit_code)) => RawOutput {
            stdout: out_buf,
            stderr: err_buf,
            exit_code,
            timed_out: false,
        },
        // 超时：与 spawn 失败（RawOutput::default）区分，列表路径据此归类 timeout。
        Err(_elapsed) => RawOutput {
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: None,
            timed_out: true,
        },
    }
}

/// 错误归类（契约 §4.4）：返回 errorKind 字符串。
/// - spawn wsl.exe 失败 → `wslNotInstalled`；
/// - 超时 → `timeout`（复用既有键）；
/// - 退出码 127 或输出（剥 NUL 后）含 `WSL_E_DISTRO_NOT_FOUND`（V8）→
///   `wslDistroNotFound`；
/// - 其余 → `wslExecFailed`。
pub fn classify_wsl_failure(e: &SshError) -> &'static str {
    match e.kind {
        SshErrorKind::SshMissing => return "wslNotInstalled",
        SshErrorKind::Timeout => return "timeout",
        _ => {}
    }
    let text = normalize_error_text(&e.detail);
    if e.exit_code == Some(127) || text.contains("wsl_e_distro_not_found") {
        return "wslDistroNotFound";
    }
    "wslExecFailed"
}

/// coded error（契约 §4.4 文案冻结）。
pub fn wsl_exec_error(e: &SshError) -> String {
    match classify_wsl_failure(e) {
        "wslNotInstalled" => pix_error(
            "wslNotInstalled",
            "未找到 wsl.exe 或 WSL 未安装。请在「启用或关闭 Windows 功能」中启用「适用于 Linux 的 Windows 子系统」。",
        ),
        "timeout" => pix_error("sshTimeout", "连接超时，网络过慢或主机无响应。"),
        "wslDistroNotFound" => pix_error(
            "wslDistroNotFound",
            "WSL 发行版不存在或已被注销。请确认发行版名称。",
        ),
        _ => pix_error_detail("wslExecFailed", "WSL 命令执行失败: {detail}", &e.detail),
    }
}

/// wsl.exe 错误流是混合编码（GBK 中文 + UTF-16LE 尾段，V8）：NUL 剥除后
/// 才能用 ASCII 关键词匹配——归类前必须先做这一步编码归一化。
pub(crate) fn normalize_error_text(text: &str) -> String {
    text.chars().filter(|c| *c != '\0').collect::<String>().to_lowercase()
}

/// 枚举失败（退出码非 0 且无可解析数据行）的 errorKind + coded error：
/// `wslNotInstalled`（契约 §4.2 第 4 条）。
pub fn wsl_list_failure(raw: &RawOutput) -> (&'static str, String) {
    let detail = decode_wsl_output(&raw.stderr);
    let detail = if detail.trim().is_empty() {
        decode_wsl_output(&raw.stdout)
    } else {
        detail
    };
    let kind = "wslNotInstalled";
    let coded = pix_error_detail(
        kind,
        "未找到 wsl.exe 或 WSL 未安装。请在「启用或关闭 Windows 功能」中启用「适用于 Linux 的 Windows 子系统」。",
        detail.trim(),
    );
    (kind, coded)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 把 UTF-8 字符串编码为 UTF-16LE 字节（含 CRLF 行尾，模拟 wsl.exe 输出）。
    fn utf16le(text: &str) -> Vec<u8> {
        let mut bytes = Vec::new();
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn decode_wsl_output_parses_utf16le_list_output() {
        // V1 实测形态：UTF-16LE、CRLF 行尾、`*` 标记 default。
        let bytes = utf16le("  NAME      STATE   VERSION\r\n* Ubuntu     Running 2\r\n  Debian     Stopped 2\r\n");
        let text = decode_wsl_output(&bytes);
        assert!(!text.contains('\0'));
        assert!(!text.contains('\r'));
        let distros = parse_wsl_list(&text);
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "Ubuntu");
        assert_eq!(distros[0].state, "Running");
        assert_eq!(distros[0].version, 2);
        assert!(distros[0].is_default);
        assert_eq!(distros[1].name, "Debian");
        assert_eq!(distros[1].state, "Stopped");
        assert!(!distros[1].is_default);
    }

    #[test]
    fn decode_wsl_output_handles_plain_utf8_and_bom() {
        // Linux 程序输出字节透传（V7）：无 NUL → UTF-8 lossy。
        assert_eq!(decode_wsl_output(b"plain utf8"), "plain utf8");
        // 含 NUL 即按 UTF-16LE 解码：ASCII 文本的 UTF-16LE 还原为原文。
        assert_eq!(decode_wsl_output(b"a\0b\0c\0"), "abc");
        // UTF-16 BOM 剥除。
        let bom = utf16le("\u{FEFF}text");
        assert_eq!(decode_wsl_output(&bom), "text");
    }

    #[test]
    fn parse_wsl_list_preserves_names_with_single_space_and_skips_header() {
        // 从右往左切：name 内含单个空格也能存活（契约 §4.2 第 3 条）。
        let text = "  NAME            STATE    VERSION\n* openSUSE-Tumbleweed  Running  2\n  My Distro  Stopped  1\n";
        let distros = parse_wsl_list(text);
        assert_eq!(distros.len(), 2);
        assert_eq!(distros[0].name, "openSUSE-Tumbleweed");
        assert_eq!(distros[1].name, "My Distro");
        assert_eq!(distros[1].version, 1);
        // 表头行（version 列非数字）跳过。
        assert!(parse_wsl_list("NAME STATE VERSION\n").is_empty());
        // 空输出。
        assert!(parse_wsl_list("").is_empty());
        // 无 default 标记的数据行。
        let distros = parse_wsl_list("Ubuntu Running 2\n");
        assert_eq!(distros.len(), 1);
        assert!(!distros[0].is_default);
    }

    #[test]
    fn classify_wsl_failure_follows_contract_keywords() {
        // V8：exit 127 → wslDistroNotFound（stderr 混合编码，NUL 剥除后含关键词）。
        let mixed = "找不到 wsl\r\0W\0s\0l\0/\0S\0e\0r\0v\0i\0c\0e\0/\0W\0S\0L\0_\0E\0_\0D\0I\0S\0T\0R\0O\0_\0N\0O\0T\0_\0F\0O\0U\0N\0D\0";
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(127),
            detail: format!("远程命令退出码 127: {mixed}"),
        };
        assert_eq!(classify_wsl_failure(&e), "wslDistroNotFound");
        // 非 127 但含关键词同样命中。
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(1),
            detail: format!("boom \0W\0S\0L\0_\0E\0_\0D\0I\0S\0T\0R\0O\0_\0N\0O\0T\0_\0F\0O\0U\0N\0D\0"),
        };
        assert_eq!(classify_wsl_failure(&e), "wslDistroNotFound");
        // spawn 失败 → wslNotInstalled。
        let e = SshError::new(SshErrorKind::SshMissing, "无法启动本机远程传输程序");
        assert_eq!(classify_wsl_failure(&e), "wslNotInstalled");
        // 超时复用 timeout。
        let e = SshError::new(SshErrorKind::Timeout, "远程执行超时");
        assert_eq!(classify_wsl_failure(&e), "timeout");
        // 其余 → wslExecFailed。
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(1),
            detail: "boom".into(),
        };
        assert_eq!(classify_wsl_failure(&e), "wslExecFailed");
    }

    #[test]
    fn wsl_exec_error_maps_to_contract_coded_errors() {
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(127),
            detail: "WSL_E_DISTRO_NOT_FOUND".into(),
        };
        let coded = wsl_exec_error(&e);
        assert!(coded.starts_with("PIXERR:"), "{coded}");
        assert!(coded.contains("wslDistroNotFound"), "{coded}");
        let e = SshError::new(SshErrorKind::SshMissing, "no wsl.exe");
        assert!(wsl_exec_error(&e).contains("wslNotInstalled"));
        let e = SshError::new(SshErrorKind::Timeout, "timeout");
        assert!(wsl_exec_error(&e).contains("sshTimeout"));
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(3),
            detail: "detail-xyz".into(),
        };
        let coded = wsl_exec_error(&e);
        assert!(coded.contains("wslExecFailed"), "{coded}");
        assert!(coded.contains("detail-xyz"), "{coded}");
    }

    #[test]
    fn wsl_list_failure_reports_not_installed_with_detail() {
        let raw = RawOutput {
            stdout: utf16le("WSL 未安装\r\n"),
            stderr: Vec::new(),
            exit_code: Some(1),
            timed_out: false,
        };
        let (kind, coded) = wsl_list_failure(&raw);
        assert_eq!(kind, "wslNotInstalled");
        assert!(coded.contains("wslNotInstalled"), "{coded}");
        assert!(coded.contains("WSL 未安装"), "{coded}");
    }

    /// 超时与 spawn 失败必须可区分（列表路径据此归类 timeout 而非 wslNotInstalled）。
    #[tokio::test]
    async fn run_local_command_distinguishes_timeout_from_spawn_failure() {
        #[cfg(windows)]
        let (parts, args): (Vec<String>, Vec<&str>) = (
            vec!["cmd.exe".to_string(), "/c".to_string()],
            vec!["ping -n 2 127.0.0.1 > nul"],
        );
        #[cfg(not(windows))]
        let (parts, args): (Vec<String>, Vec<&str>) =
            (vec!["/bin/sh".to_string()], vec!["-c", "sleep 2"]);
        let timed_out = run_local_command(&parts, &args, Duration::from_millis(100)).await;
        assert!(timed_out.timed_out, "超时应标记 timed_out");
        assert_eq!(timed_out.exit_code, None);
        // spawn 失败：timed_out 为 false，与超时可区分。
        let spawn_failed = run_local_command(
            &["pix-definitely-missing-program-xyz".to_string()],
            &[],
            Duration::from_secs(5),
        )
        .await;
        assert!(!spawn_failed.timed_out, "spawn 失败不应标记 timed_out");
        assert_eq!(spawn_failed.exit_code, None);
    }
}
