//! Watches project directories on request so the project-files sidebar can
//! refresh directory listings and the open preview without a manual reload.
//!
//! Subscriptions are keyed by **(root, subscriber token)**: several sidebar
//! tabs may show the same project, each with its own version of what the user
//! is browsing. The OS watch is reference counted per root and removed with the
//! last subscriber, and reported paths are the **union** of every subscriber's
//! scope, so one tab never narrows another's sync (a hidden tab can only widen
//! it, which costs nothing because receivers reload only what they loaded).
//!
//! Two boundaries shape what is reported:
//!
//! * **Browsed scope** — each subscriber sends the directories it has loaded
//!   plus the file it is previewing (`set_project_files_interest`). Only changes
//!   inside that union (or of an ancestor of it) are reported, so a busy
//!   `node_modules` costs nothing until someone opens it; nothing is hidden.
//! * **Root lifetime** — a project root can be deleted, renamed or recreated
//!   (worktree cleanup, `git` operations). Every event batch re-checks armed
//!   roots, re-arms recovered ones and tells the front-end to reload, and
//!   unsubscribing still finds the entry when the directory is gone.
//!
//! Remote (ssh/wsl/docker) projects live on another host and are explicitly
//! rejected — the front-end keeps manual refresh for those.

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
/// Idle re-check of armed roots. A deleted/renamed root stops producing events
/// (notify cannot report inside a directory that no longer exists), so the watch
/// would otherwise stay dead until another project happened to change.
const IDLE_CHECK: Duration = Duration::from_secs(2);
/// Cap per-project payloads so a huge `git checkout` cannot flood the channel.
const MAX_PATHS_PER_EVENT: usize = 200;

/// One batch of changes handed to the front-end for a project.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectChange {
    pub project: String,
    pub paths: Vec<String>,
    /// Everything the front-end browsed may have changed (root re-armed or lost
    /// its watch): reload loaded directories and the preview wholesale.
    pub reset: bool,
}

struct WatchEntry {
    /// Project string as the front-end passed it, echoed back in the event.
    project: String,
    root: PathBuf,
    /// Per-subscriber browsed scope (subscriber token → project-relative paths).
    subscribers: HashMap<String, HashSet<String>>,
    /// Whether the recursive OS watch for `root` is currently installed.
    armed: bool,
}

impl WatchEntry {
    /// Union of every subscriber's scope, always including the root listing.
    fn interest(&self) -> HashSet<String> {
        let mut union: HashSet<String> = HashSet::from([String::new()]);
        for scope in self.subscribers.values() {
            union.extend(scope.iter().cloned());
        }
        union
    }
}

/// Watcher + subscriptions. Kept as one struct so the lifetime rules above
/// are testable without an `AppHandle`.
#[derive(Default)]
struct WatchCore {
    watcher: Option<notify::RecommendedWatcher>,
    entries: HashMap<String, WatchEntry>,
}

fn core() -> &'static Mutex<WatchCore> {
    static CORE: OnceLock<Mutex<WatchCore>> = OnceLock::new();
    CORE.get_or_init(|| Mutex::new(WatchCore::default()))
}

fn lock<T>(mutex: &'static Mutex<T>) -> std::sync::MutexGuard<'static, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn watcher_error(error: impl std::fmt::Display) -> String {
    format!("project watcher unavailable: {error}")
}

fn project_missing() -> String {
    crate::errors::pix_error("projectDirMissing", "项目目录不存在")
}

/// Canonical directory for a local project root, or `None` when it is gone.
fn resolve_root(project: &str) -> Option<PathBuf> {
    let root = dunce::canonicalize(project).ok()?;
    root.is_dir().then_some(root)
}

/// Comparison key for a project path: separators unified, trailing separators
/// dropped, and ASCII case folded on Windows (drive letters are case-insensitive).
fn normalize_key(path: &str) -> String {
    let united = path.replace('\\', "/");
    let trimmed = united.trim_end_matches('/').to_string();
    if cfg!(windows) {
        trimmed.to_ascii_lowercase()
    } else {
        trimmed
    }
}

/// Registry key used for a subscription: the canonical root when it exists,
/// the normalized request otherwise, so a vanished root keeps its identity.
fn entry_key(project: &str) -> String {
    match resolve_root(project) {
        Some(root) => normalize_key(&root.to_string_lossy()),
        None => normalize_key(project),
    }
}

/// Project-relative path in the same shape `list_project_directory` returns.
/// Rejects absolute paths, `.`/`..` and backslashes; "" is the project root.
fn normalize_relative(path: &str) -> Option<String> {
    let united = path.replace('\\', "/");
    let trimmed = united.trim_matches('/');
    if trimmed.is_empty() {
        return Some(String::new());
    }
    if trimmed
        .split('/')
        .any(|part| part.is_empty() || part == "." || part == "..")
    {
        return None;
    }
    Some(trimmed.to_string())
}

/// Display directory of a project-relative path ("" for root entries).
fn parent_relative(path: &str) -> String {
    match path.rfind('/') {
        Some(index) => path[..index].to_string(),
        None => String::new(),
    }
}

/// Whether a change belongs to what the UI currently shows.
///
/// Reported: the browsed entry itself, an entry inside a browsed directory (a
/// child was added, removed or renamed) and an ancestor of a browsed path
/// (a loaded directory was renamed or deleted). Everything else is skipped so
/// unrelated churn never reaches the UI.
fn is_interesting(relative: &str, interested: &HashSet<String>) -> bool {
    if interested.is_empty() {
        return false;
    }
    if interested.contains(relative) || interested.contains(&parent_relative(relative)) {
        return true;
    }
    interested.iter().any(|path| {
        path.len() > relative.len()
            && path.starts_with(relative)
            && path.as_bytes().get(relative.len()) == Some(&b'/')
    })
}

impl WatchCore {
    /// Replace the process-wide watcher callback with the event channel used
    /// by [`coalesce_loop`]; idempotent.
    fn ensure_watcher(
        &mut self,
        callback: impl FnMut(NotifyResult<Event>) + Send + 'static,
    ) -> Result<(), String> {
        if self.watcher.is_some() {
            return Ok(());
        }
        self.watcher = Some(notify::recommended_watcher(callback).map_err(watcher_error)?);
        Ok(())
    }

    fn watcher_mut(&mut self) -> Result<&mut notify::RecommendedWatcher, String> {
        self.watcher
            .as_mut()
            .ok_or_else(|| watcher_error("not started"))
    }

    /// Subscribe one UI subscriber (reference counted per `(root, subscriber)`).
    /// Re-subscribing with the same token keeps its scope; a stale entry whose
    /// root vanished is re-armed rather than silently accepted.
    fn subscribe(&mut self, project: &str, subscriber: &str) -> Result<(), String> {
        if crate::ssh::is_remote_uri(project) {
            return Err(crate::errors::pix_error(
                "projectWatchRemote",
                "远程项目暂不支持文件自动同步",
            ));
        }
        let key = entry_key(project);
        if self.entries.contains_key(&key) {
            if let Some(entry) = self.entries.get_mut(&key) {
                entry.project = project.to_string();
                entry
                    .subscribers
                    .entry(subscriber.to_string())
                    .or_insert_with(|| HashSet::from([String::new()]));
            }
            // 已订阅的根消失（worktree 清理、git 操作）时保持订阅并标记为未 arm：
            // 目录重建后由空闲检查重新 arm 并通知前端重载，不需要前端重试。
            let _ = self.heal(&key);
            return Ok(());
        }
        let root = resolve_root(project).ok_or_else(project_missing)?;
        self.watcher_mut()?
            .watch(&root, RecursiveMode::Recursive)
            .map_err(watcher_error)?;
        self.entries.insert(
            key,
            WatchEntry {
                project: project.to_string(),
                root,
                // The root listing is always on screen.
                subscribers: HashMap::from([(
                    subscriber.to_string(),
                    HashSet::from([String::new()]),
                )]),
                armed: true,
            },
        );
        Ok(())
    }

    /// Find the entry to release even when the root no longer canonicalizes
    /// (deleted or renamed between subscribing and closing the tab).
    fn key_for_stop(&self, project: &str) -> Option<String> {
        let key = entry_key(project);
        if self.entries.contains_key(&key) {
            return Some(key);
        }
        let wanted = normalize_key(project);
        self.entries
            .iter()
            .find(|(_, entry)| {
                normalize_key(&entry.project) == wanted
                    || normalize_key(&entry.root.to_string_lossy()) == wanted
            })
            .map(|(key, _)| key.clone())
    }

    /// Release **one** subscriber's scope; other subscribers of the same root
    /// keep watching, and the OS watch ends with the last one.
    fn unsubscribe(&mut self, project: &str, subscriber: &str) {
        let Some(key) = self.key_for_stop(project) else {
            return;
        };
        let release = {
            let Some(entry) = self.entries.get_mut(&key) else {
                return;
            };
            entry.subscribers.remove(subscriber);
            entry.subscribers.is_empty().then(|| entry.root.clone())
        };
        let Some(root) = release else {
            return;
        };
        self.entries.remove(&key);
        if let Ok(watcher) = self.watcher_mut() {
            // The directory may already be gone; nothing else to clean up.
            let _ = watcher.unwatch(&root);
        }
    }

    /// Record what one subscriber shows. Other subscribers keep their own scope.
    fn set_interest(&mut self, project: &str, subscriber: &str, paths: &[String]) {
        let Some(key) = self.key_for_stop(project) else {
            return;
        };
        let Some(entry) = self.entries.get_mut(&key) else {
            return;
        };
        let mut interested = HashSet::from([String::new()]);
        interested.extend(paths.iter().filter_map(|path| normalize_relative(path)));
        entry
            .subscribers
            .insert(subscriber.to_string(), interested);
    }

    /// Re-arm or drop a subscription whose root moved, disappeared or came back.
    /// Returns whether the watch is installed afterwards.
    fn heal(&mut self, key: &str) -> bool {
        let Some((project, root, armed)) = self
            .entries
            .get(key)
            .map(|entry| (entry.project.clone(), entry.root.clone(), entry.armed))
        else {
            return false;
        };
        let wanted = resolve_root(&project);
        if armed && wanted.as_deref() == Some(root.as_path()) {
            return true;
        }
        if let Ok(watcher) = self.watcher_mut() {
            if armed {
                let _ = watcher.unwatch(&root);
            }
            if let Some(next) = wanted {
                if watcher.watch(&next, RecursiveMode::Recursive).is_ok() {
                    if let Some(entry) = self.entries.get_mut(key) {
                        entry.root = next;
                        entry.armed = true;
                    }
                    return true;
                }
            }
        }
        if let Some(entry) = self.entries.get_mut(key) {
            entry.armed = false;
        }
        false
    }

    /// Re-check every subscription; report the projects whose watch flipped
    /// state so the front-end reloads what it can no longer trust.
    fn heal_all(&mut self) -> Vec<String> {
        let keys: Vec<String> = self.entries.keys().cloned().collect();
        let mut flipped = Vec::new();
        for key in keys {
            let Some((project, armed)) = self
                .entries
                .get(&key)
                .map(|entry| (entry.project.clone(), entry.armed))
            else {
                continue;
            };
            // Only an armed root can silently die; a live one costs one stat.
            if armed && self.entries.get(&key).is_some_and(|entry| entry.root.is_dir()) {
                continue;
            }
            if self.heal(&key) != armed {
                flipped.push(project);
            }
        }
        flipped
    }

    /// Filter a batch of raw filesystem paths into per-project reports.
    fn changes(&mut self, changed: &HashSet<PathBuf>) -> Vec<ProjectChange> {
        let resets = self.heal_all();
        let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
        let watched: Vec<(PathBuf, String, HashSet<String>)> = self
            .entries
            .values()
            .map(|entry| (entry.root.clone(), entry.project.clone(), entry.interest()))
            .collect();
        for path in changed {
            for (root, project, interested) in &watched {
                let Some(relative) = relative_to(root, path) else {
                    continue;
                };
                if !is_interesting(&relative, interested) {
                    continue;
                }
                let paths = grouped.entry(project.clone()).or_default();
                if paths.len() < MAX_PATHS_PER_EVENT && !paths.contains(&relative) {
                    paths.push(relative);
                }
            }
        }
        let mut result: Vec<ProjectChange> = grouped
            .into_iter()
            .map(|(project, paths)| ProjectChange {
                project,
                paths,
                reset: false,
            })
            .collect();
        for project in resets {
            result.push(ProjectChange {
                project,
                paths: Vec::new(),
                reset: true,
            });
        }
        result
    }
}

/// Start watching a local project directory for one UI subscriber
/// (reference counted per `(root, subscriber)`).
#[tauri::command]
pub async fn watch_project_files(
    app: AppHandle,
    project: String,
    subscriber: String,
) -> Result<(), String> {
    let mut core = lock(core());
    if core.watcher.is_none() {
        let (tx, rx) = mpsc::channel::<NotifyResult<Event>>();
        core.ensure_watcher(move |result| {
            let _ = tx.send(result);
        })?;
        let handle = app;
        std::thread::Builder::new()
            .name("project-watch".into())
            .spawn(move || coalesce_loop(handle, rx))
            .map_err(watcher_error)?;
    }
    core.subscribe(&project, &subscriber)
}

/// Release this subscriber only; other subscribers keep their watch.
#[tauri::command]
pub async fn unwatch_project_files(project: String, subscriber: String) -> Result<(), String> {
    lock(core()).unsubscribe(&project, &subscriber);
    Ok(())
}

/// Declare what this subscriber currently shows: its loaded directories plus
/// the previewed file. Reported changes are the union across subscribers.
#[tauri::command]
pub async fn set_project_files_interest(
    project: String,
    subscriber: String,
    paths: Vec<String>,
) -> Result<(), String> {
    lock(core()).set_interest(&project, &subscriber, &paths);
    Ok(())
}

fn coalesce_loop(app: AppHandle, rx: mpsc::Receiver<NotifyResult<Event>>) {
    loop {
        let mut pending: HashSet<PathBuf> = HashSet::new();
        match rx.recv_timeout(IDLE_CHECK) {
            Ok(ev) => collect(&mut pending, ev),
            // Idle: re-check the roots so a recreated directory is re-armed and
            // the front-end learns it must reload.
            Err(mpsc::RecvTimeoutError::Timeout) => {
                flush(&app, &pending);
                continue;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => return, // watcher gone
        }
        // Keep draining until the stream is quiet for QUIET_WINDOW.
        loop {
            match rx.recv_timeout(QUIET_WINDOW) {
                Ok(ev) => collect(&mut pending, ev),
                Err(mpsc::RecvTimeoutError::Timeout) => break,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
        flush(&app, &pending);
    }
}

fn collect(pending: &mut HashSet<PathBuf>, ev: NotifyResult<Event>) {
    let Ok(ev) = ev else { return };
    for path in ev.paths {
        pending.insert(path);
    }
}

/// Filter one batch (possibly empty) and emit the resulting per-project reports.
fn flush(app: &AppHandle, changed: &HashSet<PathBuf>) {
    let changes = lock(core()).changes(changed);
    for change in changes {
        crate::remote::emit(
            app,
            PROJECT_FILES_CHANGED_EVENT,
            json!({
                "project": change.project,
                "paths": change.paths,
                "reset": change.reset,
            }),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "pix-watch-test-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        dunce::canonicalize(dir).unwrap()
    }

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(path, body).unwrap();
    }

    /// Accumulate raw watcher events for `waited`, then run the same
    /// per-project filtering the coalescing loop applies.
    fn collect_changes(
        core: &mut WatchCore,
        rx: &mpsc::Receiver<NotifyResult<Event>>,
        waited: Duration,
    ) -> Vec<ProjectChange> {
        let deadline = std::time::Instant::now() + waited;
        let mut batch: HashSet<PathBuf> = HashSet::new();
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            match rx.recv_timeout(remaining.min(Duration::from_millis(100))) {
                Ok(Ok(ev)) => batch.extend(ev.paths),
                Ok(Err(_)) => {}
                Err(_) => {}
            }
        }
        if batch.is_empty() {
            return Vec::new();
        }
        core.changes(&batch)
    }

    fn paths_of(changes: &[ProjectChange]) -> Vec<String> {
        changes
            .iter()
            .flat_map(|change| change.paths.clone())
            .collect()
    }

    fn with_watcher() -> (WatchCore, mpsc::Receiver<NotifyResult<Event>>) {
        let (tx, rx) = mpsc::channel::<NotifyResult<Event>>();
        let mut core = WatchCore::default();
        core.ensure_watcher(move |result| {
            let _ = tx.send(result);
        })
        .unwrap();
        (core, rx)
    }

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
    fn interest_covers_browsed_entries_and_their_ancestors_only() {
        let interested = HashSet::from(["".to_string(), "src".to_string(), "src/lib.ts".to_string()]);
        for reported in ["src/lib.ts", "src/new.ts", "README.md"] {
            assert!(is_interesting(reported, &interested), "{reported} should report");
        }
        // 已加载目录被删除/移动（祖先路径）也必须通知文件树。
        assert!(is_interesting("src", &interested));
        // 未展开目录不在关注范围内，避免构建输出刷屏。
        assert!(!is_interesting("node_modules/vue/index.js", &interested));
        assert!(!is_interesting("documents/a.md", &interested));
        // 已加载目录内的子项（新增/删除/重命名）都要上报。
        assert!(is_interesting("src/other.ts", &interested));
        // 形似前缀的兄弟路径不能被误判为子项。
        assert!(!is_interesting("srcX/y.ts", &interested));
        assert!(!is_interesting("src/lib.ts", &HashSet::new()));
    }

    #[test]
    fn interest_paths_are_normalized_without_escaping_the_project() {
        assert_eq!(normalize_relative(""), Some(String::new()));
        assert_eq!(normalize_relative("/src/"), Some("src".to_string()));
        assert_eq!(normalize_relative("src\\stores"), Some("src/stores".to_string()));
        assert_eq!(normalize_relative("../escape"), None);
        assert_eq!(normalize_relative("src//lib.ts"), None);
        assert_eq!(parent_relative("src/lib.ts"), "src");
        assert_eq!(parent_relative("README.md"), "");
    }

    #[test]
    fn releasing_a_subscription_survives_a_vanished_root() {
        let dir = scratch("stop");
        let (mut core, _rx) = with_watcher();
        core.subscribe(dir.to_string_lossy().as_ref(), "tab-a")
            .unwrap();
        let request = dir.to_string_lossy().to_string();
        fs::remove_dir_all(&dir).unwrap();
        // canonicalize 已经失败；仍必须找到并释放注册项，不能泄漏 OS watch。
        core.unsubscribe(&request, "tab-a");
        assert!(core.entries.is_empty());
        assert!(matches!(
            core.subscribe(&request, "tab-b"),
            Err(message) if message.contains("projectDirMissing")
        ));
    }

    #[test]
    fn resubscribing_after_the_root_was_recreated_rearms_the_watch() {
        let dir = scratch("recreate");
        let (mut core, rx) = with_watcher();
        let request = dir.to_string_lossy().to_string();
        core.subscribe(&request, "tab-a").unwrap();
        let _ = collect_changes(&mut core, &rx, Duration::from_millis(300));
        fs::remove_dir_all(&dir).unwrap();
        core.unsubscribe(&request, "tab-a");
        assert!(core.entries.is_empty());
        // 重建同名目录后再次订阅：必须重新 arm，事件才能恢复上报。
        fs::create_dir_all(dir.join("src")).unwrap();
        core.subscribe(&request, "tab-a").unwrap();
        // 前端重新加载列表后重新声明关注范围（根 + 已展开目录）。
        core.set_interest(&request, "tab-a", &[String::new(), "src".to_string()]);
        write(&dir.join("src").join("new.ts"), "export const value = 1\n");
        let changes = collect_changes(&mut core, &rx, Duration::from_secs(2));
        assert!(
            paths_of(&changes).iter().any(|path| path == "src/new.ts"),
            "expected src/new.ts, got {:?}",
            paths_of(&changes)
        );
    }

    #[test]
    fn a_root_that_disappears_and_returns_is_rearmed_and_reported_as_reset() {
        let dir = scratch("heal");
        let (mut core, rx) = with_watcher();
        let request = dir.to_string_lossy().to_string();
        core.subscribe(&request, "tab-a").unwrap();
        let _ = collect_changes(&mut core, &rx, Duration::from_millis(300));

        // 根目录消失时 notify 无法再上报其内部变化；空批次（空闲检查）必须
        // 检测到并转为未 arm，同时通知前端重载。
        fs::remove_dir_all(&dir).unwrap();
        let dropped = core.changes(&HashSet::new());
        assert_eq!(dropped.len(), 1);
        assert!(dropped[0].reset);
        assert!(!core.entries.values().next().unwrap().armed);

        // 同名目录重建后，下一次空批次重新 arm 并再次通知前端。
        fs::create_dir_all(dir.join("src")).unwrap();
        core.set_interest(&request, "tab-a", &[String::new(), "src".to_string()]);
        let rearmed = core.changes(&HashSet::new());
        assert_eq!(rearmed.len(), 1);
        assert!(rearmed[0].reset);
        assert!(core.entries.values().next().unwrap().armed);

        write(&dir.join("src").join("lib.ts"), "one\n");
        let live = collect_changes(&mut core, &rx, Duration::from_secs(3));
        assert!(
            paths_of(&live).iter().any(|path| path == "src/lib.ts"),
            "expected src/lib.ts after re-arm, got {:?}",
            paths_of(&live)
        );
    }

    #[test]
    fn subscriber_scopes_are_unioned_instead_of_overwritten() {
        let dir = scratch("union");
        let (mut core, rx) = with_watcher();
        let request = dir.to_string_lossy().to_string();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("dist")).unwrap();
        core.subscribe(&request, "tab-a").unwrap();
        core.subscribe(&request, "tab-b").unwrap();
        core.set_interest(&request, "tab-a", &[String::new(), "src".to_string()]);
        core.set_interest(&request, "tab-b", &[String::new(), "dist".to_string()]);
        let _ = collect_changes(&mut core, &rx, Duration::from_millis(300));

        // H1 回归：第二个订阅者不能收窄第一个订阅者的关注范围。
        write(&dir.join("src").join("lib.ts"), "one\n");
        write(&dir.join("dist").join("bundle.js"), "one\n");
        let reported = collect_changes(&mut core, &rx, Duration::from_secs(3));
        let paths = paths_of(&reported);
        assert!(
            paths.iter().any(|path| path == "src/lib.ts"),
            "expected src/lib.ts, got {paths:?}"
        );
        assert!(
            paths.iter().any(|path| path == "dist/bundle.js"),
            "expected dist/bundle.js, got {paths:?}"
        );
    }

    #[test]
    fn releasing_one_subscriber_keeps_the_others_scope() {
        let dir = scratch("partial");
        let (mut core, rx) = with_watcher();
        let request = dir.to_string_lossy().to_string();
        fs::create_dir_all(dir.join("src")).unwrap();
        fs::create_dir_all(dir.join("dist")).unwrap();
        core.subscribe(&request, "tab-a").unwrap();
        core.subscribe(&request, "tab-b").unwrap();
        core.set_interest(&request, "tab-a", &[String::new(), "src".to_string()]);
        core.set_interest(&request, "tab-b", &[String::new(), "dist".to_string()]);
        let _ = collect_changes(&mut core, &rx, Duration::from_millis(300));

        // 关闭其中一个页签只清理它自己的订阅，另一个继续同步。
        core.unsubscribe(&request, "tab-b");
        assert!(core.entries.contains_key(&normalize_key(&request)));
        write(&dir.join("src").join("lib.ts"), "two\n");
        write(&dir.join("dist").join("bundle.js"), "two\n");
        let reported = collect_changes(&mut core, &rx, Duration::from_secs(3));
        let paths = paths_of(&reported);
        assert!(paths.iter().any(|path| path == "src/lib.ts"), "got {paths:?}");
        assert!(
            !paths.iter().any(|path| path == "dist/bundle.js"),
            "the released subscriber's scope must stop reporting: {paths:?}"
        );

        // 最后一个订阅者离开时才撤销 OS watch。
        core.unsubscribe(&request, "tab-a");
        assert!(core.entries.is_empty());
        write(&dir.join("src").join("lib.ts"), "three\n");
        let after = collect_changes(&mut core, &rx, Duration::from_secs(2));
        assert!(paths_of(&after).is_empty(), "got {:?}", paths_of(&after));
    }

    #[test]
    fn reloaded_directories_start_reporting_previously_skipped_changes() {
        let dir = scratch("interest");
        let (mut core, rx) = with_watcher();
        let request = dir.to_string_lossy().to_string();
        fs::create_dir_all(dir.join("dist")).unwrap();
        fs::create_dir_all(dir.join("src")).unwrap();
        core.subscribe(&request, "tab-a").unwrap();
        core.set_interest(&request, "tab-a", &[String::new()]);
        write(&dir.join("src").join("lib.ts"), "one\n");
        let _ = collect_changes(&mut core, &rx, Duration::from_secs(2));

        // dist 可见但尚未展开：变更不上报，避免构建输出刷屏。
        write(&dir.join("dist").join("bundle.js"), "one\n");
        let hidden = collect_changes(&mut core, &rx, Duration::from_secs(2));
        assert!(!paths_of(&hidden).iter().any(|path| path == "dist/bundle.js"));

        // 用户展开 dist 后，同一目录的变更必须同步（不靠隐藏目录规避）。
        core.set_interest(&request, "tab-a", &[String::new(), "dist".to_string()]);
        write(&dir.join("dist").join("bundle.js"), "two\n");
        let reported = collect_changes(&mut core, &rx, Duration::from_secs(5));
        assert!(
            paths_of(&reported).iter().any(|path| path == "dist/bundle.js"),
            "expected dist/bundle.js, got {:?}",
            paths_of(&reported)
        );
        // 根目录列表始终在关注范围内。
        write(&dir.join("README.md"), "readme\n");
        let root_change = collect_changes(&mut core, &rx, Duration::from_secs(3));
        assert!(paths_of(&root_change).iter().any(|path| path == "README.md"));
    }

    #[test]
    fn interest_narrows_again_after_the_directory_is_collapsed() {
        let dir = scratch("narrow");
        let (mut core, rx) = with_watcher();
        let request = dir.to_string_lossy().to_string();
        fs::create_dir_all(dir.join("dist")).unwrap();
        core.subscribe(&request, "tab-a").unwrap();
        core.set_interest(&request, "tab-a", &[String::new(), "dist".to_string()]);
        write(&dir.join("dist").join("bundle.js"), "one\n");
        let first = collect_changes(&mut core, &rx, Duration::from_secs(3));
        assert!(paths_of(&first).iter().any(|path| path == "dist/bundle.js"));
        // 收起目录后不再为一个不可见的目录持续推送事件。
        core.set_interest(&request, "tab-a", &[String::new()]);
        write(&dir.join("dist").join("bundle.js"), "two\n");
        let second = collect_changes(&mut core, &rx, Duration::from_secs(2));
        assert!(!paths_of(&second).iter().any(|path| path == "dist/bundle.js"));
    }

    #[test]
    fn remote_projects_are_refused() {
        let (mut core, _rx) = with_watcher();
        let error = core.subscribe("ssh://dev@host/work", "tab-a").unwrap_err();
        assert!(error.contains("projectWatchRemote"));
        assert!(core.entries.is_empty());
    }

    #[test]
    fn unknown_subscribers_are_safe_no_ops() {
        let dir = scratch("unknown");
        let (mut core, _rx) = with_watcher();
        let request = dir.to_string_lossy().to_string();
        core.subscribe(&request, "tab-a").unwrap();
        // 未知 token 的 set_interest 不应改变现有订阅者的范围。
        core.set_interest(&request, "ghost", &[String::new()]);
        core.unsubscribe(&request, "ghost");
        assert!(core.entries.contains_key(&normalize_key(&request)));
        let entry = core.entries.values().next().unwrap();
        assert_eq!(entry.subscribers.len(), 1);
    }
}
