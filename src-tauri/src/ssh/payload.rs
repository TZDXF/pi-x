//! SSH 载荷构造：POSIX 单引号转义与 base64 载荷通道（契约 §3.4–§3.5）。
//!
//! 所有远端脚本经 `/bin/sh -c 'eval "$(echo <B64> | base64 -d)"'` 投递：
//! 外层强制 POSIX shell 规避 fish/csh 等非 POSIX 登录 shell 的二次解析；
//! B64 字符集仅 `[A-Za-z0-9+/=]`，不含单引号，内层安全。
//! 采用 `eval`（而非管道喂 sh 的 stdin）是刻意设计：脚本若经 stdin 投递，
//! 脚本内所有命令（pi 的 RPC stdin、信任请求 JSON、交互 shell）继承到的
//! stdin 将是 base64 管道而非 ssh 会话 stdin——实测（WSL 实机，2026-10-06）
//! 会把 ssh stdin 数据静默丢失；`eval` 让脚本在外层 shell 内展开执行，
//! 脚本内命令的 stdin 即 ssh 会话 stdin，且命令替换输出不会被二次展开。

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine as _;

/// 远程 spawn payload 的约定退出码：cd 失败（目录不存在）。
pub const EXIT_CODE_CHDIR_FAILED: i32 = 90;
/// 远程 spawn payload 的约定退出码：远程未安装 pi。
pub const EXIT_CODE_PI_MISSING: i32 = 92;
/// 远程 spawn payload 的约定退出码：SDK dist 未找到（远程信任流程）。
pub const EXIT_CODE_SDK_DIST_MISSING: i32 = 93;
/// 远程信任上传 payload 的约定退出码：写临时文件失败（契约 P2 §4.1）。
pub const EXIT_CODE_UPLOAD_WRITE_FAILED: i32 = 95;
/// 远程信任上传 payload 的约定退出码：目录创建/改名失败（契约 P2 §4.1）。
pub const EXIT_CODE_UPLOAD_STAGE_FAILED: i32 = 96;

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

/// 远程会话扫描脚本模板（契约 P2 §2.2 冻结文本）：单次 exec 完成枚举 + 逐文件
/// 元数据提取，输出 `PIX_SESSION_*` 标签行并以 `PIX_SESSIONS_DONE` 收尾；
/// 退出码恒 0（业务语义走标签行 + DONE 标记），`find`/`stat`/`grep` 失败静默降级。
/// `'<PROJECT>'` 占位符（含单引号）由 [`build_sessions_script`] 以 `posix_quote`
/// 注入；`IFS="	"` 中的字面制表符（0x09）用于按 tab 切分 mtime 与路径。
pub const SESSIONS_SCRIPT: &str = r#"
SESS_ROOT="$HOME/.pi/agent/sessions"
PHYS=$(cd '<PROJECT>' >/dev/null 2>&1 && pwd -P)
echo "PIX_SESSION_CWD=$PHYS"
[ -n "$PHYS" ] || { echo "PIX_SESSIONS_DONE"; exit 0; }
[ -d "$SESS_ROOT" ] || { echo "PIX_SESSIONS_DONE"; exit 0; }
find "$SESS_ROOT" -type f -name '*.jsonl' 2>/dev/null | while IFS= read -r f; do
  m=$(stat -c %Y "$f" 2>/dev/null) || m=$(stat -f %m "$f" 2>/dev/null) || m=0
  printf '%s\t%s\n' "$m" "$f"
done | sort -rn | head -n 200 | while IFS="	" read -r m f; do
  echo "PIX_SESSION_FILE=$f"
  echo "PIX_SESSION_MTIME=$m"
  echo "PIX_SESSION_HEADER=$(head -c 8192 "$f" 2>/dev/null | head -n 1)"
  echo "PIX_SESSION_TITLE=$(grep '\"type\":\"session_info\"' "$f" 2>/dev/null | tail -n 1)"
done
echo "PIX_SESSIONS_DONE"
"#;

/// 远程信任上传脚本（契约 P2 §4.1）：pi_data.mjs 内容走 ssh stdin、同目录临时
/// 文件 + `mv` 原子落盘（不走 base64——stdin 是二进制安全管道）。临时名带远端
/// shell 的 `$$`：多个客户端进程并发首传时各写各的临时文件，`mv` 为原子 rename，
/// 避免固定临时名下的交错写入把损坏的 mjs 留在目标位。
pub const TRUST_UPLOAD_SCRIPT: &str = r#"
mkdir -p "$HOME/.pix" || exit 96
TMP="$HOME/.pix/pi_data.mjs.$$"
cat > "$TMP" || exit 95
mv "$TMP" "$HOME/.pix/pi_data.mjs" || exit 96
echo "PIX_TRUST_UPLOAD_DONE"
"#;

/// 远程信任执行脚本（契约 P2 §4.1）：合并 SDK dist 发现（对齐本地
/// `pi_locate.rs` 的 4 级祖先查找）与调用，请求 JSON 走 ssh stdin，
/// 响应 JSON 走 stdout；`--eval "$(cat …)"` + `argv[1]=dist` 与本地
/// `pi_data.rs` 的调用形态一致。
pub const TRUST_RUN_SCRIPT: &str = r#"
PI_BIN=$(command -v pi) || exit 92
REAL=$(readlink -f "$PI_BIN"); DIR=$(dirname "$REAL")
for i in 1 2 3 4 5; do
  DIR=$(dirname "$DIR")
  if [ -f "$DIR/core/settings-manager.js" ] && [ -f "$DIR/config.js" ]; then
    node --input-type=module --eval "$(cat "$HOME/.pix/pi_data.mjs")" "$DIR"
    exit $?
  fi
done
exit 93
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
/// 脚本经 `eval` 在外层 shell 内执行（见模块注释：保证脚本内命令的
/// stdin 是 ssh 会话 stdin，而非 base64 管道）。
pub fn wrap_payload(script: &str) -> String {
    format!(
        "/bin/sh -c 'eval \"$(echo {} | base64 -d)\"'",
        encode_payload(script)
    )
}

/// 远程会话扫描脚本：把项目路径按契约 §3.4 单引号包裹注入 [`SESSIONS_SCRIPT`]。
pub fn build_sessions_script(project_path: &str) -> String {
    SESSIONS_SCRIPT.replace("'<PROJECT>'", &posix_quote(project_path))
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
        assert!(wrapped.starts_with("/bin/sh -c 'eval \"$(echo "));
        assert!(wrapped.ends_with(" | base64 -d)\"'"));
        // 载荷段不含单引号，外层单引号包裹保持完整。
        let b64 = wrapped
            .strip_prefix("/bin/sh -c 'eval \"$(echo ")
            .and_then(|rest| rest.strip_suffix(" | base64 -d)\"'"))
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

    #[test]
    fn sessions_script_injects_project_path_and_contract_markers() {
        let script = build_sessions_script("/home/d'v/proj");
        assert!(script.contains("PHYS=$(cd '/home/d'\\''v/proj' >/dev/null 2>&1 && pwd -P)"));
        for marker in [
            "PIX_SESSION_CWD=",
            "PIX_SESSION_FILE=",
            "PIX_SESSION_MTIME=",
            "PIX_SESSION_HEADER=",
            "PIX_SESSION_TITLE=",
            "PIX_SESSIONS_DONE",
        ] {
            assert!(script.contains(marker), "sessions 脚本缺 {marker:?}");
        }
        // 契约 P2 §2.2 冻结要点：head -c 8192 截头、200 个上限、tab 切分、
        // stat -c/-f 回退链。
        assert!(script.contains("head -c 8192"));
        assert!(script.contains("head -n 200"));
        assert!(script.contains("while IFS=\"\t\" read -r m f"));
        assert!(script.contains("stat -c %Y") && script.contains("stat -f %m"));
        // 脚本中不得再残留占位符。
        assert!(!script.contains("<PROJECT>"));
        // 可整体经 base64 通道无损往返。
        let decoded = String::from_utf8(BASE64_STANDARD.decode(encode_payload(&script)).unwrap())
            .unwrap();
        assert_eq!(decoded, script);
    }

    #[test]
    fn trust_scripts_carry_contract_markers_and_exit_codes() {
        for marker in ["mkdir -p \"$HOME/.pix\"", "pi_data.mjs.$$", "PIX_TRUST_UPLOAD_DONE"] {
            assert!(TRUST_UPLOAD_SCRIPT.contains(marker), "上传脚本缺 {marker:?}");
        }
        // 临时名必须带 $$：固定名在多进程并发首传时会产生 mv 竞态（实机复现）。
        assert!(!TRUST_UPLOAD_SCRIPT.contains(".pixtmp"));
        for marker in [
            "command -v pi",
            "core/settings-manager.js",
            "config.js",
            "--input-type=module",
        ] {
            assert!(TRUST_RUN_SCRIPT.contains(marker), "信任脚本缺 {marker:?}");
        }
        // 契约 P2 §4.1：dist 发现失败 exit 93、上传写失败 95、目录/改名失败 96。
        assert!(TRUST_RUN_SCRIPT.trim_end().ends_with("exit 93"));
        assert!(TRUST_UPLOAD_SCRIPT.contains("|| exit 95"));
        assert!(TRUST_UPLOAD_SCRIPT.matches("|| exit 96").count() == 2);
        // 两个脚本均可整体经 base64 通道无损往返。
        for script in [TRUST_UPLOAD_SCRIPT, TRUST_RUN_SCRIPT] {
            let decoded = String::from_utf8(BASE64_STANDARD.decode(encode_payload(script)).unwrap())
                .unwrap();
            assert_eq!(decoded, *script);
        }
    }
}
