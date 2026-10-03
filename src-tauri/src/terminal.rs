//! Built-in interactive terminal backed by a real PTY (ConPTY on Windows).
//!
//! Each terminal gets an id; output is streamed to the frontend through the
//! `term://output` event (base64-encoded so multi-byte UTF-8 split across
//! reads survives). Emitting via `remote::emit` reaches both the desktop
//! webview and remote browser clients over their respective channels. Input
//! and resize travel through regular commands.

use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde_json::json;
use std::collections::HashMap;

use crate::errors::{pix_error, pix_error_detail};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
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

    let shell = default_shell();
    let mut cmd = CommandBuilder::new(&shell);
    if cfg!(windows) {
        cmd.arg("-NoLogo");
    }
    if !cwd.is_empty() {
        cmd.cwd(&cwd);
    }
    if cfg!(not(windows)) && std::env::var_os("TERM").is_none() {
        cmd.env("TERM", "xterm-256color");
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| pix_error_detail("shellSpawnFailed", format!("启动 shell 失败: {e}"), e))?;
    let killer = child.clone_killer();
    let writer = pair.master.take_writer().map_err(|e| format!("{e}"))?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| format!("{e}"))?;

    // Stream PTY output to the frontend. The PTY read is blocking, so it runs
    // on a dedicated blocking thread instead of pinning an async worker.
    let app_out = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = tokio::task::spawn_blocking(move || {
            let app = app_out;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let encoded = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                        crate::remote::emit(
                            &app,
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
    tauri::async_runtime::spawn(async move {
        let status = tokio::task::spawn_blocking(move || child.wait()).await;
        let code = match status {
            Ok(Ok(c)) => c.exit_code(),
            _ => 1,
        };
        crate::remote::emit(&app, "term://exit", json!({ "id": id, "code": code }));
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
    if let Some(session) = state.sessions.lock().unwrap().remove(&id) {
        let mut killer = session.killer;
        let _ = killer.kill();
    }
    Ok(())
}

/// Kill every live terminal (called on app exit).
pub fn kill_all(state: &TerminalState) {
    let mut sessions = state.sessions.lock().unwrap();
    for (_, session) in sessions.drain() {
        let mut killer = session.killer;
        let _ = killer.kill();
    }
}
