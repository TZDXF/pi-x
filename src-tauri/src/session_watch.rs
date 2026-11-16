//! Watches `~/.pi/agent/sessions/` for external session-file changes (e.g. a
//! session continued from a terminal) and notifies the frontend so it can
//! refresh the session list and reload the affected conversations.

use crate::trust::agent_dir;
use notify::{Event, RecursiveMode, Result as NotifyResult, Watcher};
use serde_json::json;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

pub const SESSIONS_CHANGED_EVENT: &str = "pi://sessions-changed";

/// Coalesce bursts of fs events, then report the distinct session files.
const QUIET_WINDOW: Duration = Duration::from_millis(600);

static START: OnceLock<()> = OnceLock::new();

/// Start watching the pi sessions directory. Idempotent; never panics.
pub fn start(app: AppHandle) {
    if START.set(()).is_err() {
        return;
    }
    let root = agent_dir().join("sessions");
    if !root.is_dir() {
        return;
    }
    let (tx, rx) = mpsc::channel::<NotifyResult<Event>>();
    let mut watcher = match notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    }) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("session watcher unavailable: {e}");
            return;
        }
    };
    if let Err(e) = watcher.watch(&root, RecursiveMode::Recursive) {
        eprintln!("session watcher unavailable: {e}");
        return;
    }
    // The watcher must stay alive for the process lifetime.
    std::mem::forget(watcher);

    std::thread::Builder::new()
        .name("session-watch".into())
        .spawn(move || coalesce_loop(app, root, rx))
        .ok();
}

fn coalesce_loop(app: AppHandle, root: PathBuf, rx: mpsc::Receiver<NotifyResult<Event>>) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    loop {
        match rx.recv() {
            Ok(ev) => collect(&mut pending, &root, ev),
            Err(_) => return, // channel closed: watcher gone
        }
        // Keep draining until the stream is quiet for QUIET_WINDOW.
        loop {
            match rx.recv_timeout(QUIET_WINDOW) {
                Ok(ev) => collect(&mut pending, &root, ev),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if pending.is_empty() {
            continue;
        }
        let files: Vec<String> = pending
            .drain()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        crate::remote::emit(&app, SESSIONS_CHANGED_EVENT, json!({ "files": files }));
    }
}

fn collect(pending: &mut HashSet<PathBuf>, root: &Path, ev: NotifyResult<Event>) {
    let Ok(ev) = ev else { return };
    for path in ev.paths {
        if !path.starts_with(root) {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            pending.insert(path);
        } else if let Some(stem) = path
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| name.strip_suffix(".pix.json"))
        {
            // Archive/restore writes only the sidecar. Refresh the owning
            // session without pretending its JSONL content has changed.
            pending.insert(path.with_file_name(format!("{stem}.jsonl")));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_visibility_sidecar_changes_refresh_the_same_session_once() {
        let root = std::env::temp_dir().join("pix-session-watch");
        let session = root.join("project/session.jsonl");
        let mut pending = HashSet::new();
        let mut event = Event::new(notify::EventKind::Any);
        event.paths = vec![
            session.with_extension("pix.json"),
            root.join("project/session.pix.json.tmp"),
            std::env::temp_dir().join("outside.pix.json"),
        ];
        collect(&mut pending, &root, Ok(event));
        assert_eq!(pending, HashSet::from([session.clone()]));
        let mut duplicate = Event::new(notify::EventKind::Any);
        duplicate.paths = vec![session.clone(), session.with_extension("pix.json")];
        collect(&mut pending, &root, Ok(duplicate));
        assert_eq!(pending, HashSet::from([session]));
    }
}
