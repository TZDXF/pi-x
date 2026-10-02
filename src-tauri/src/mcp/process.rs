//! Command construction, Windows shim handling, stderr draining and child cleanup.
use super::config::{def_str, def_string_record};
use crate::errors::pix_error;
use crate::pi_locate::{is_windows_script, Launcher};
use serde_json::Value;
use std::time::Duration;
use tokio::process::{Child, Command};
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// Stderr tail kept for stdio failure reports.
const STDERR_TAIL: usize = 2000;

pub(super) fn build_list_command(
    info: &crate::pi_locate::PiInfo,
    args: &[&str],
) -> Result<Command, String> {
    let mut cmd = match &info.launcher {
        Some(Launcher::Node { node, script }) => {
            let mut c = Command::new(node);
            c.arg(script).args(args);
            c
        }
        Some(Launcher::Binary { path }) => {
            let mut c = Command::new(path);
            c.args(args);
            c
        }
        None => {
            let path = info.path.clone().ok_or("pi path not resolved")?;
            if cfg!(windows) && is_windows_script(&path) {
                let mut c = Command::new("cmd");
                c.arg("/C").arg(&path).args(args);
                c
            } else {
                let mut c = Command::new(&path);
                c.args(args);
                c
            }
        }
    };
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// Windows: resolve a bare command name to a real executable via PATH +
/// PATHEXT, mirroring what cross-spawn (used by pi itself) does for MCP
/// servers — `npx` on Windows is actually `npx.cmd`, which CreateProcess
/// cannot launch directly. Returns the input unchanged when nothing resolves
/// (the spawn error then surfaces as before).
#[cfg(windows)]
fn resolve_windows_command(command: &str) -> String {
    use std::path::Path;
    let path = Path::new(command);
    // Relative/absolute paths are used as-is; the OS handles them.
    if path.components().count() > 1 {
        return command.to_string();
    }
    let path_ext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    let exts: Vec<&str> = path_ext
        .split(';')
        .map(str::trim)
        .filter(|ext| !ext.is_empty())
        .collect();
    // A name with an explicit extension (e.g. "npx.cmd") is looked up as-is;
    // otherwise try every PATHEXT entry in order.
    let names: Vec<String> = if path.extension().is_some() {
        vec![command.to_string()]
    } else {
        exts.iter().map(|ext| format!("{command}{ext}")).collect()
    };
    if let Some(dirs) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&dirs) {
            for name in &names {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return candidate.to_string_lossy().to_string();
                }
            }
        }
    }
    command.to_string()
}

#[cfg(not(windows))]
fn resolve_windows_command(command: &str) -> String {
    command.to_string()
}

/// Build the command line handed to `cmd /s /c` for a .cmd/.bat shim (same
/// shape cross-spawn builds): quoted executable plus quoted arguments.
#[cfg(windows)]
fn windows_cmd_line(resolved: &str, args: &[&str]) -> String {
    let mut line = format!("\"{resolved}\"");
    for arg in args {
        line.push(' ');
        line.push_str(&windows_quote_arg(arg));
    }
    line
}

/// Quote one argument for a `cmd /s /c` command line (same shape cross-spawn
/// builds for .cmd/.bat shims).
#[cfg(windows)]
fn windows_quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.chars().any(|c| matches!(c, ' ' | '\t' | '"')) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        match ch {
            '\\' => {
                backslashes += 1;
                out.push('\\');
            }
            '"' => {
                // Backslashes preceding a quote are doubled and the quote is
                // escaped, or CommandLineToArgvW swallows it (a"b -> ab) or
                // splits the argument (a\"b -> two args).
                for _ in 0..backslashes {
                    out.push('\\');
                }
                backslashes = 0;
                out.push_str("\\\"");
            }
            _ => {
                backslashes = 0;
                out.push(ch);
            }
        }
    }
    for _ in 0..backslashes {
        out.push('\\');
    }
    out.push('"');
    out
}

/// Build the spawn command for a stdio server definition (command + args +
/// env + cwd). The child inherits this process's environment so PATH-based
/// launchers like `npx` keep working; def.env entries are layered on top.
/// Returns the command plus whether it was wrapped in `cmd /c` (Windows
/// script shims) — those need a taskkill of the whole process tree.
pub(super) fn spawn_command(def: &Value) -> Result<(Command, bool), String> {
    let command = def_str(def, "command")
        .filter(|c| !c.trim().is_empty())
        .ok_or_else(|| {
            pix_error(
                "mcpServerInvalid",
                "该服务器缺少 command（stdio）或 url（HTTP）",
            )
        })?;
    let args: Vec<&str> = def
        .get("args")
        .and_then(|v| v.as_array())
        .map(|items| items.iter().filter_map(|v| v.as_str()).collect())
        .unwrap_or_default();
    let resolved = resolve_windows_command(command);
    let is_script = {
        let lower = resolved.to_ascii_lowercase();
        #[cfg(windows)]
        {
            lower.ends_with(".cmd") || lower.ends_with(".bat")
        }
        #[cfg(not(windows))]
        {
            let _ = lower;
            false
        }
    };
    let mut cmd = if is_script {
        let mut c = Command::new("cmd");
        c.arg("/d").arg("/s").arg("/c");
        // The line is appended verbatim and wrapped in one outer quote pair:
        // `cmd /s` strips exactly that pair and keeps the inner quotes intact.
        // Handed over as a regular argument, the inner quotes would be
        // \"-escaped by the standard quoting and cmd would fail to resolve
        // the shim (exit before the MCP handshake). Verified against
        // `npx`-style shims and paths containing spaces.
        #[cfg(windows)]
        c.raw_arg(format!("\"{}\"", windows_cmd_line(&resolved, &args)));
        #[cfg(not(windows))]
        {
            let _ = (&resolved, &args);
        }
        c
    } else {
        let mut c = Command::new(&resolved);
        c.args(&args);
        c
    };
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in def_string_record(def, "env") {
        cmd.env(key, value);
    }
    if let Some(cwd) = def_str(def, "cwd").filter(|c| !c.trim().is_empty()) {
        cmd.current_dir(cwd);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok((cmd, is_script))
}

/// Background stderr drain so a chatty server cannot block on a full pipe;
/// the tail (last STDERR_TAIL bytes) is collected after the exchange ends and
/// attached to failure reports (a server that exits early usually explains
/// why there).
pub(super) fn drain_stderr(child: &mut Child) -> Option<tokio::task::JoinHandle<String>> {
    let mut stderr = child.stderr.take()?;
    Some(tokio::spawn(async move {
        use tokio::io::AsyncReadExt;
        let mut buf = Vec::new();
        let mut chunk = [0u8; 512];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() > STDERR_TAIL {
                        let drop = buf.len() - STDERR_TAIL;
                        buf.drain(..drop);
                    }
                }
            }
        }
        String::from_utf8_lossy(&buf).to_string()
    }))
}

/// Tail of the drained stderr, formatted as an error detail suffix (empty
/// when the server printed nothing).
pub(super) async fn stderr_tail_detail(
    stderr_task: Option<tokio::task::JoinHandle<String>>,
) -> String {
    let Some(task) = stderr_task else {
        return String::new();
    };
    // The child is gone, so the stderr pipe closes and the drain task
    // finishes promptly; the timeout only guards a stuck pipe.
    match tokio::time::timeout(Duration::from_secs(2), task).await {
        Ok(Ok(text)) if !text.trim().is_empty() => format!(": {}", text.trim()),
        _ => String::new(),
    }
}

/// Kill a stdio server process. cmd.exe wrappers (npx & friends) fork the
/// real server, so kill the whole process tree the same way pi-mcp does.
pub(super) async fn kill_stdio_child(child: &mut Child, wrapped: bool) {
    #[cfg(windows)]
    if wrapped {
        if let Some(pid) = child.id() {
            let mut killer = Command::new("taskkill");
            killer
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null());
            killer.creation_flags(CREATE_NO_WINDOW);
            let _ = killer.status().await;
        }
    }
    #[cfg(not(windows))]
    let _ = wrapped;
    let _ = child.kill().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_command_builds_stdio_definition() {
        let def: Value = serde_json::from_str(
            r#"{"command":"npx","args":["-y","pkg"],"env":{"KEY":"v"},"cwd":"."}"#,
        )
        .unwrap();
        let (cmd, wrapped) = spawn_command(&def).unwrap();
        // The Debug output no longer carries the shim line (raw_arg), so only
        // the wrap flag is asserted here; the line itself is covered below.
        let _ = cmd;
        #[cfg(windows)]
        assert!(wrapped);
        let no_command: Value = serde_json::from_str(r#"{"args":[]}"#).unwrap();
        assert!(spawn_command(&no_command).is_err());
        // Resolution of a nonexistent bare name cannot wrap it in cmd.
        let missing: Value =
            serde_json::from_str(r#"{"command":"definitely-not-a-real-pix-cmd"}"#).unwrap();
        let (_, wrapped_missing) = spawn_command(&missing).unwrap();
        assert!(!wrapped_missing);
        // Keep the unused-variable shape identical on every platform.
        let _ = wrapped;
    }

    // `cmd /s /c` strips exactly one outer quote pair, so the whole line is
    // double-wrapped before being handed to raw_arg verbatim. Without the
    // outer pair a spaced path would be cut at the first space; passing the
    // line as a regular argument would escape inner quotes to \" and cmd
    // would fail to resolve the shim (regression: every npx-style stdio
    // server exited before the MCP handshake on Windows).
    #[cfg(windows)]
    #[test]
    fn windows_cmd_line_is_quoted_for_s_strip() {
        assert_eq!(
            windows_cmd_line(r"C:\Program Files\nodejs\npx.cmd", &["-y", "pkg"]),
            r#""C:\Program Files\nodejs\npx.cmd" -y pkg"#
        );
        assert_eq!(
            windows_cmd_line(r"C:\tools\x.cmd", &["a b", "c"]),
            r#""C:\tools\x.cmd" "a b" c"#
        );
    }

    // Embedded quotes must be escaped per the Windows argument rules:
    // backslashes before a quote are doubled and the quote becomes \".
    // A bare quote is swallowed by CommandLineToArgvW (a"b parses as ab)
    // and an unescaped backslash-quote pair splits into two arguments.
    #[cfg(windows)]
    #[test]
    fn windows_quote_arg_escapes_embedded_quotes() {
        assert_eq!(windows_quote_arg("a\"b"), r#""a\"b""#);
        assert_eq!(windows_quote_arg("a\\\"b"), r#""a\\\"b""#);
        assert_eq!(windows_quote_arg("x y\\"), r#""x y\\""#);
        assert_eq!(windows_quote_arg("plain"), "plain");
    }

    #[cfg(windows)]
    #[test]
    fn resolve_windows_command_finds_cmd_shim() {
        assert!(resolve_windows_command("cmd")
            .to_ascii_lowercase()
            .ends_with(".exe"));
        assert!(resolve_windows_command("npx")
            .to_ascii_lowercase()
            .ends_with(".cmd"));
        // Unresolvable names come back unchanged.
        assert_eq!(
            resolve_windows_command("definitely-not-a-real-pix-cmd"),
            "definitely-not-a-real-pix-cmd"
        );
    }
}
