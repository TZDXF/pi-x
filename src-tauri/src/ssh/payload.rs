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

/// 单次 Node 扫描：所有文件只读最多 8192 字节头部，cwd 过滤、排序、取 50 条后
/// 才流式读取标题。项目路径仅作为 argv 传递，不拼入 JavaScript。
/// Node 缺失或扫描失败输出 PIX_SESSIONS_ERROR 且不输出 DONE，不能伪装成空列表；
/// 退出码恒 0（对齐契约 P2 §2.1：remote_exec 对非零退出码只回传 stderr，
/// 业务错误必须走 stdout 标签行才能携带具体原因）。
pub const SESSIONS_SCRIPT: &str = r#"
command -v node >/dev/null 2>&1 || {
  echo "PIX_SESSIONS_ERROR=远端未安装 Node.js，无法扫描会话"
  exit 0
}
node -e '<NODE_SCRIPT>' -- '<PROJECT>'
"#;

pub(crate) const SESSIONS_NODE_SCRIPT: &str = r#"
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const project = process.argv[1];
const root = path.join(os.homedir(), '.pi', 'agent', 'sessions');
const emit = (key, value) => console.log(key + '=' + value);
async function scan() {
  let physical;
  try {
    physical = fs.realpathSync(project);
    if (!fs.statSync(physical).isDirectory()) throw new Error('not a directory');
  } catch {
    console.log('PIX_SESSIONS_DONE');
    return;
  }
  emit('PIX_SESSION_CWD', physical);
  const records = [];
  const buffer = Buffer.alloc(8192);
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(file); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      let fd;
      try {
        fd = fs.openSync(file, 'r');
        const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
        const header = JSON.parse(buffer.toString('utf8', 0, size).split('\n', 1)[0]);
        if (header?.type !== 'session' ||
            (header.cwd !== project && header.cwd !== physical)) continue;
        const mtime = Math.max(0, Math.floor(fs.fstatSync(fd).mtimeMs / 1000));
        records.push({ file, mtime, header });
      } catch { /* 损坏、删除或不可读的单个文件不影响其余会话。 */ }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  }
  walk(root);
  records.sort((a, b) => b.mtime - a.mtime ||
    Buffer.compare(Buffer.from(a.file), Buffer.from(b.file)));
  for (const record of records.slice(0, 50)) {
    let title = '';
    const input = fs.createReadStream(record.file);
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try {
          const value = JSON.parse(line);
          if (value?.type === 'session_info') title = JSON.stringify(value);
        } catch { /* 忽略损坏的 JSONL 行。 */ }
      }
    } catch { /* 文件消失或读取失败时仍保留头部元数据。 */ }
    finally { lines.close(); input.destroy(); }
    emit('PIX_SESSION_FILE', record.file);
    emit('PIX_SESSION_MTIME', record.mtime);
    emit('PIX_SESSION_HEADER', JSON.stringify(record.header));
    emit('PIX_SESSION_TITLE', title);
  }
  console.log('PIX_SESSIONS_DONE');
}
scan().catch(() => {
  console.log('PIX_SESSIONS_ERROR=远端会话扫描失败');
});
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

/// 远程会话扫描脚本：Node 内联脚本与项目路径均按契约 §3.4 单引号包裹注入
/// [`SESSIONS_SCRIPT`]（路径仅作 `node -e` 的 argv，不进入 JavaScript 源码）。
pub fn build_sessions_script(project_path: &str) -> String {
    SESSIONS_SCRIPT
        .replace("'<NODE_SCRIPT>'", &posix_quote(SESSIONS_NODE_SCRIPT))
        .replace("'<PROJECT>'", &posix_quote(project_path))
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
        assert!(script.ends_with(" -- '/home/d'\\''v/proj'\n"));
        assert!(script.contains("command -v node"));
        assert!(script.contains("PIX_SESSIONS_ERROR="));
        assert!(SESSIONS_NODE_SCRIPT.contains("Buffer.alloc(8192)"));
        assert!(SESSIONS_NODE_SCRIPT.contains("records.slice(0, 50)"));
        assert!(!script.contains("grep"));
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
