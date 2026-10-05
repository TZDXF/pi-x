//! SSH 载荷构造：POSIX 单引号转义与 base64 载荷通道（契约 §3.4–§3.5）。
//!
//! 所有远端脚本经 `/bin/sh -c 'echo <B64> | base64 -d | /bin/sh'` 投递：
//! 外层强制 POSIX shell 规避 fish/csh 等非 POSIX 登录 shell 的二次解析；
//! B64 字符集仅 `[A-Za-z0-9+/=]`，不含单引号，内层安全。

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;

/// 远程 spawn payload 的约定退出码：cd 失败（目录不存在）。
pub const EXIT_CODE_CHDIR_FAILED: i32 = 90;
/// 远程 spawn payload 的约定退出码：远程未安装 pi。
pub const EXIT_CODE_PI_MISSING: i32 = 92;
/// 远程 spawn payload 的约定退出码：SDK dist 未找到（远程信任流程，P2 预留）。
pub const EXIT_CODE_SDK_DIST_MISSING: i32 = 93;

/// probe 脚本（契约 §2.3）：单次 exec 收集 uname / node / pi 版本，
/// 以 `PIX_PROBE_DONE` 标记完成。
pub const PROBE_SCRIPT: &str = r#"
echo "UNAME_S=$(uname -s 2>/dev/null)"
echo "UNAME_M=$(uname -m 2>/dev/null)"
if command -v node >/dev/null 2>&1; then echo "NODE_V=$(node -v 2>/dev/null)"; fi
PI_BIN=$(command -v pi 2>/dev/null)
echo "PI_BIN=$PI_BIN"
if [ -n "$PI_BIN" ]; then echo "PI_V=$("$PI_BIN" --version 2>/dev/null | head -n 1)"; fi
echo "PIX_PROBE_DONE"
"#;

/// POSIX 单引号安全包裹：内部 `'` 转义为 `'\''`；空串产出 `''`。
pub fn posix_quote(value: &str) -> String {
    let mut quoted = String::with_capacity(value.len() + 2);
    quoted.push('\'');
    for c in value.chars() {
        if c == '\'' {
            quoted.push_str("'\\''");
        } else {
            quoted.push(c);
        }
    }
    quoted.push('\'');
    quoted
}

/// 标准字母表 base64 编码（契约 §3.4，与 TS 侧 btoa/Buffer 同字母表）。
pub fn encode_payload(script: &str) -> String {
    BASE64_STANDARD.encode(script.as_bytes())
}

/// 远端命令包装（唯一入口）：argv 单元素传递，内部含引号是刻意设计。
pub fn wrap_payload(script: &str) -> String {
    format!(
        "/bin/sh -c 'echo {} | base64 -d | /bin/sh'",
        encode_payload(script)
    )
}

/// 远程 spawn payload（契约 §3.5 精确文本）：
/// `$$` 在 `exec` 前取 shell pid，`exec` 后即 pi 的 pid，写 stderr；
/// `--session` 与 extra args 逐项单引号包裹（P1 远程 extra args 恒为空）。
pub fn build_spawn_payload(
    project_path: &str,
    session_file: Option<&str>,
    extra_args: &[String],
) -> String {
    let mut script = format!(
        "cd {} || exit {EXIT_CODE_CHDIR_FAILED}\n\
         echo \"PIX_PI_PID=$$\" >&2\n\
         PI_BIN=$(command -v pi) || exit {EXIT_CODE_PI_MISSING}\n\
         exec \"$PI_BIN\" --mode rpc",
        posix_quote(project_path)
    );
    if let Some(session) = session_file {
        script.push_str(" --session ");
        script.push_str(&posix_quote(session));
    }
    for arg in extra_args {
        script.push(' ');
        script.push_str(&posix_quote(arg));
    }
    script.push('\n');
    script
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posix_quote_wraps_and_escapes_single_quotes() {
        assert_eq!(posix_quote("abc"), "'abc'");
        assert_eq!(posix_quote(""), "''");
        assert_eq!(posix_quote("it's"), "'it'\\''s'");
        // 双引号与 $ 无需转义：单引号内不展开。
        assert_eq!(posix_quote("a\"$b c"), "'a\"$b c'");
        // 含换行的会话路径也原样保留（经 base64 通道投递，不直接进入远端 shell）。
        assert_eq!(posix_quote("a\nb"), "'a\nb'");
    }

    #[test]
    fn wrap_payload_carries_script_verbatim_through_base64() {
        let script = "cd '/home/d v'\necho hi \"$?\"\n";
        let wrapped = wrap_payload(script);
        assert!(wrapped.starts_with("/bin/sh -c 'echo "));
        assert!(wrapped.ends_with(" | base64 -d | /bin/sh'"));
        // 载荷段不含单引号，外层单引号包裹保持完整。
        let b64 = wrapped
            .strip_prefix("/bin/sh -c 'echo ")
            .and_then(|rest| rest.strip_suffix(" | base64 -d | /bin/sh'"))
            .unwrap();
        assert!(!b64.contains('\''));
        let decoded = String::from_utf8(BASE64_STANDARD.decode(b64).unwrap()).unwrap();
        assert_eq!(decoded, script);
    }

    #[test]
    fn spawn_payload_matches_contract_text() {
        let payload = build_spawn_payload(
            "/home/dev/proj",
            Some("/home/dev/.pi/sessions/s.jsonl"),
            &[],
        );
        assert_eq!(
            payload,
            "cd '/home/dev/proj' || exit 90\n\
             echo \"PIX_PI_PID=$$\" >&2\n\
             PI_BIN=$(command -v pi) || exit 92\n\
             exec \"$PI_BIN\" --mode rpc --session '/home/dev/.pi/sessions/s.jsonl'\n"
        );
        // 无 --session 时不追加该参数。
        let bare = build_spawn_payload("/a", None, &[]);
        assert_eq!(
            bare,
            "cd '/a' || exit 90\n\
             echo \"PIX_PI_PID=$$\" >&2\n\
             PI_BIN=$(command -v pi) || exit 92\n\
             exec \"$PI_BIN\" --mode rpc\n"
        );
    }

    #[test]
    fn spawn_payload_quotes_paths_with_single_quotes_and_extra_args() {
        let payload = build_spawn_payload(
            "/home/d'v",
            Some("/a/b'.jsonl"),
            &["--model".to_string(), "gpt'5".to_string()],
        );
        assert!(payload.starts_with("cd '/home/d'\\''v' || exit 90\n"));
        assert!(payload.contains("--session '/a/b'\\''.jsonl'"));
        // 契约 §3.5：extra args 每项独立单引号包裹（含开关本身）。
        assert!(payload.ends_with(" '--model' 'gpt'\\''5'\n"));
    }

    #[test]
    fn probe_script_contains_contract_markers() {
        for marker in [
            "UNAME_S=", "UNAME_M=", "NODE_V=", "PI_BIN=", "PI_V=", "PIX_PROBE_DONE",
        ] {
            assert!(PROBE_SCRIPT.contains(marker), "probe 脚本缺 {marker:?}");
        }
        // 可整体经 base64 通道无损往返。
        let decoded = String::from_utf8(BASE64_STANDARD.decode(encode_payload(PROBE_SCRIPT)).unwrap())
            .unwrap();
        assert_eq!(decoded, PROBE_SCRIPT);
    }
}
