//! Watches project directories on request so the project-files sidebar can
//! refresh directory listings and the open preview without a manual reload.
//!
//! Subscribers are reference counted per canonical project root: several
//! sidebar tabs may show the same project, and the OS watch is only removed
//! when the last of them stops watching (tab close, project switch or app
//! shutdown). Remote (ssh/wsl/docker) projects live on another host and are
//! explicitly rejected — the front-end keeps manual refresh for those.

use notify::{Event, RecursiveMode, Result as NotifyResult, Watcher};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::AppHandle;

pub const PROJECT_FILES_CHANGED_EVENT: &str = "pi://project-files-changed";

/// Coalesce bursts of fs events before reporting the distinct changed paths.
const QUIET_WINDOW: Duration = Duration::from_millis(200);
/// Cap per-project payloads so a huge `git checkout` cannot flood the channel.
const MAX_PATHS_PER_EVENT: usize = 200;

struct WatchEntry {
    root: PathBuf,
    /// Project string as the front-end passed it, echoed back in the event.
    project: String,
    subscribers: usize,
}

fn registry() -> &'static Mutex<HashMap<String, WatchEntry>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, WatchEntry>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn watcher_slot() -> &'static Mutex<Option<notify::RecommendedWatcher>> {
    static WATCHER: OnceLock<Mutex<Option<notify::RecommendedWatcher>>> = OnceLock::new();
    WATCHER.get_or_init(|| Mutex::new(None))
}

fn lock<T>(mutex: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Start watching a local project directory (reference counted).
#[tauri::command]
pub async fn watch_project_files(app: AppHandle, project: String) -> Result<(), String> {
    if crate::ssh::is_remote_uri(&project) {
        return Err(crate::errors::pix_error(
            "projectWatchRemote",
            "远程项目暂不支持文件自动同步",
        ));
    }
    let root = dunce::canonicalize(&project).map_err(|e| {
        crate::errors::pix_error_detail("projectDirMissing", "项目目录不存在", e)
    })?;
    if !root.is_dir() {
        return Err(crate::errors::pix_error(
            "projectDirMissing",
            "项目目录不存在",
        ));
    }
    ensure_started(&app)?;
    let key = root.to_string_lossy().to_string();
    let mut entries = lock(registry());
    if let Some(entry) = entries.get_mut(&key) {
        entry.subscribers += 1;
        return Ok(());
    }
    let mut slot = lock(watcher_slot());
    let watcher = slot
        .as_mut()
        .ok_or_else(|| "project watcher unavailable".to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("project watcher unavailable: {e}"))?;
    entries.insert(
        key,
        WatchEntry {
            root,
            project,
            subscribers: 1,
        },
    );
    Ok(())
}

/// Release one subscriber; the OS watch is removed with the last one.
#[tauri::command]
pub async fn unwatch_project_files(project: String) -> Result<(), String> {
    stop(&project);
    Ok(())
}

fn stop(project: &str) {
    let Ok(root) = dunce::canonicalize(project) else {
        return;
    };
    let key = root.to_string_lossy().to_string();
    let mut entries = lock(registry());
    let Some(entry) = entries.get_mut(&key) else {
        return;
    };
    entry.subscribers = entry.subscribers.saturating_sub(1);
    if entry.subscribers > 0 {
        return;
    }
    entries.remove(&key);
    let mut slot = lock(watcher_slot());
    if let Some(watcher) = slot.as_mut() {
        let _ = watcher.unwatch(&root);
    }
}

/// Create the single process-wide watcher and its coalescing thread once.
fn ensure_started(app: &AppHandle) -> Result<(), String> {
    static INIT: Mutex<()> = Mutex::new(());
    let _init = INIT.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let mut slot = lock(watcher_slot());
    if slot.is_some() {
        return Ok(());
    }
    let (tx, rx) = mpsc::channel::<NotifyResult<Event>>();
    let watcher = notify::recommended_watcher(move |res| {
        let _ = tx.send(res);
    })
    .map_err(|e| format!("project watcher unavailable: {e}"))?;
    let handle = app.clone();
    std::thread::Builder::new()
        .name("project-watch".into())
        .spawn(move || coalesce_loop(handle, rx))
        .map_err(|e| format!("project watcher unavailable: {e}"))?;
    *slot = Some(watcher);
    Ok(())
}

fn coalesce_loop(app: AppHandle, rx: mpsc::Receiver<NotifyResult<Event>>) {
    let mut pending: HashSet<PathBuf> = HashSet::new();
    loop {
        match rx.recv() {
            Ok(ev) => collect(&mut pending, ev),
            Err(_) => return, // channel closed: watcher gone
        }
        // Keep draining until the stream is quiet for QUIET_WINDOW.
        loop {
            match rx.recv_timeout(QUIET_WINDOW) {
                Ok(ev) => collect(&mut pending, ev),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        if pending.is_empty() {
            continue;
        }
        emit_changes(&app, &pending);
        pending.clear();
    }
}

fn collect(pending: &mut HashSet<PathBuf>, ev: NotifyResult<Event>) {
    let Ok(ev) = ev else { return };
    for path in ev.paths {
        pending.insert(path);
    }
}

fn emit_changes(app: &AppHandle, changed: &HashSet<PathBuf>) {
    let watched: Vec<(PathBuf, String)> = {
        let entries = lock(registry());
        entries
            .values()
            .map(|entry| (entry.root.clone(), entry.project.clone()))
            .collect()
    };
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    for path in changed {
        for (root, project) in &watched {
            let Some(relative) = relative_to(root, path) else {
                continue;
            };
            if is_ignored_relative(&relative) {
                continue;
            }
            let paths = grouped.entry(project.clone()).or_default();
            if paths.len() < MAX_PATHS_PER_EVENT && !paths.contains(&relative) {
                paths.push(relative);
            }
        }
    }
    for (project, paths) in grouped {
        crate::remote::emit(
            app,
            PROJECT_FILES_CHANGED_EVENT,
            json!({ "project": project, "paths": paths }),
        );
    }
}

/// Project-relative path with forward slashes for the given change.
///
/// Windows file events may use a different letter case than the watched root,
/// so components are compared case-insensitively as a fallback.
fn relative_to(root: &Path, path: &Path) -> Option<String> {
    if let Ok(relative) = path.strip_prefix(root) {
        if relative.as_os_str().is_empty() {
            return None;
        }
        return Some(relative.to_string_lossy().replace('\\', "/"));
    }
    #[cfg(windows)]
    {
        use std::path::Component;
        let root_parts: Vec<Component> = root.components().collect();
        let path_parts: Vec<Component> = path.components().collect();
        if path_parts.len() <= root_parts.len() {
            return None;
        }
        for (expected, actual) in root_parts.iter().zip(path_parts.iter()) {
            if !expected
                .as_os_str()
                .to_string_lossy()
                .eq_ignore_ascii_case(&actual.as_os_str().to_string_lossy())
            {
                return None;
            }
        }
        let relative = path_parts[root_parts.len()..]
            .iter()
            .map(|part| part.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        return Some(relative.replace('\\', "/"));
    }
    #[cfg(not(windows))]
    None
}

/// Dependency/build output directories never feed the sidebar tree; ignoring
/// them keeps a busy `node_modules` from flooding the event channel.
fn is_ignored_relative(relative: &str) -> bool {
    relative
        .split('/')
        .any(|part| crate::fs_search::SKIP_DIRS.contains(&part))
}

#[cfg(test)]
mod tests {
    use super::{is_ignored_relative, relative_to};
    use std::path::Path;

    #[test]
    fn relative_paths_are_forward_slashed_and_stay_inside_the_root() {
        let root = Path::new("C:/repo");
        assert_eq!(
            relative_to(root, Path::new("C:/repo/src/lib.ts")).as_deref(),
            Some("src/lib.ts")
        );
        assert_eq!(relative_to(root, Path::new("C:/repo")), None);
        assert_eq!(relative_to(root, Path::new("C:/other/src/lib.ts")), None);
    }

    #[cfg(windows)]
    #[test]
    fn windows_case_differences_still_map_to_the_project() {
        let root = Path::new("C:/repo");
        assert_eq!(
            relative_to(root, Path::new("c:/REPO/src/lib.ts")).as_deref(),
            Some("src/lib.ts")
        );
    }

    #[test]
    fn build_output_directories_are_ignored() {
        assert!(is_ignored_relative("node_modules/vue/index.js"));
        assert!(is_ignored_relative(".git/HEAD"));
        assert!(is_ignored_relative("src-tauri/target/debug/build.log"));
        assert!(is_ignored_relative("dist/bundle.js"));
        assert!(!is_ignored_relative("src/lib.ts"));
        assert!(!is_ignored_relative("src/distribute.ts"));
    }
}
