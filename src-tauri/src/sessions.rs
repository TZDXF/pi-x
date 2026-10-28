//! Scan `~/.pi/agent/sessions/` for session files belonging to a project.
//!
//! Layout: `<agent-dir>/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
//! The encoding of the cwd in directory names is an implementation detail of
//! pi, so we don't reconstruct it — instead we read each file's first line
//! (the session header JSON) and filter by its `cwd` field.

use crate::errors::{pix_error, pix_error_detail};
use crate::trust::agent_dir;
use dunce::canonicalize;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

/// 会话文件手术（rewind/重命名），需经运行中 runtime 的 RPC 传输完成；
/// 实现见 `edit.rs`，由 `crate::rpc` 池层调用。
pub(crate) mod edit;

const MAX_SESSIONS: usize = 50;
const MAX_ARCHIVED: usize = 500;
const PREVIEW_SCAN_BYTES: u64 = 32 * 1024;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub file: String,
    pub id: String,
    pub cwd: String,
    pub timestamp: Option<String>,
    pub mtime_ms: u64,
    pub preview: Option<String>,
    pub title: Option<String>,
    pub archived: bool,
}

fn mtime_ms(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Read just the first line of a file (up to 4 KB).
fn first_line(path: &Path) -> Option<String> {
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = [0u8; 4096];
    let n = f.read(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf[..n]);
    let line = text.lines().next()?;
    Some(line.to_string())
}

/// Extract a short preview from the first user message in the session file.
///
/// Streams line by line with a total budget instead of slicing a fixed byte
/// window: pi writes one huge system-preamble line before the first user
/// message, which would otherwise swallow the whole window and leave the
/// session without a preview (rendered as "untitled" in the sidebar).
/// Every line — including `message` entries — pays a capped amount of the
/// budget, so the scan stays bounded even when a file opens with many giant
/// preamble messages; entries missing their `message` field are skipped
/// instead of silently aborting the whole preview.
fn first_user_preview(path: &Path) -> Option<String> {
    use std::io::{BufRead, BufReader};
    const LINE_COST_CAP: usize = 4 * 1024;
    let file = std::fs::File::open(path).ok()?;
    let mut budget = PREVIEW_SCAN_BYTES;
    for line in BufReader::new(file).lines() {
        if budget == 0 {
            break;
        }
        let Ok(line) = line else { break };
        budget = budget.saturating_sub(line.len().min(LINE_COST_CAP) as u64);
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(msg) = v.get("message") else { continue };
        if msg.get("role").and_then(|r| r.as_str()) != Some("user") {
            continue;
        }
        let text = match msg.get("content") {
            Some(serde_json::Value::String(s)) => Some(s.clone()),
            Some(serde_json::Value::Array(blocks)) => blocks.iter().find_map(|b| {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    b.get("text").and_then(|t| t.as_str()).map(String::from)
                } else {
                    None
                }
            }),
            _ => None,
        };
        if let Some(t) = text {
            let t: String = t
                .chars()
                .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
                .collect();
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Some(t.chars().take(120).collect());
            }
        }
    }
    None
}

pub(crate) fn normalize(p: &Path) -> Option<String> {
    canonicalize(p)
        .ok()
        .map(|s| s.to_string_lossy().to_string())
}

/// Reject paths outside the pi sessions directory (or non-session files).
pub(crate) fn validate_session_path(file: &str) -> Result<PathBuf, String> {
    let path = canonicalize(file).map_err(|e| e.to_string())?;
    let root = canonicalize(agent_dir().join("sessions")).map_err(|e| e.to_string())?;
    if !path.starts_with(root) || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err(pix_error("sessionPathInvalid", "无效的会话路径"));
    }
    Ok(path)
}

/// List sessions whose `cwd` matches `project`, newest creation time first.
pub async fn list(project: String) -> Result<Vec<SessionMeta>, String> {
    if let Err(error) = std::fs::metadata(&project) {
        if error.kind() == std::io::ErrorKind::NotFound {
            return Err(pix_error(
                "projectDirMissing",
                "Project directory does not exist",
            ));
        }
        return Err(format!("invalid project path: {project}: {error}"));
    }
    let project_norm =
        normalize(Path::new(&project)).ok_or_else(|| format!("invalid project path: {project}"))?;

    tokio::task::spawn_blocking(move || {
        list_project_sessions(&agent_dir().join("sessions"), &project_norm)
    })
    .await
    .map_err(|e| format!("session scan failed: {e}"))?
}

fn creation_time(timestamp: Option<&str>) -> i64 {
    timestamp
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.timestamp_millis())
        .unwrap_or(0)
}

fn list_project_sessions(
    sessions_root: &Path,
    project_norm: &str,
) -> Result<Vec<SessionMeta>, String> {
    let mut candidates = Vec::new();
    let dirs = match std::fs::read_dir(sessions_root) {
        Ok(d) => d,
        Err(_) => return Ok(Vec::new()), // no sessions yet
    };
    for dir in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let mtime = mtime_ms(&path);
            // Inspect only the header until the creation order and limit are
            // known; avoid scanning every session's transcript for its title.
            let (cwd, created) = if let Some(meta) = cached_meta(&path, mtime) {
                (meta.cwd, creation_time(meta.timestamp.as_deref()))
            } else {
                let Some(header) =
                    first_line(&path).and_then(|line| serde_json::from_str::<Value>(&line).ok())
                else {
                    continue;
                };
                if header.get("type").and_then(Value::as_str) != Some("session") {
                    continue;
                }
                (
                    header
                        .get("cwd")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string(),
                    creation_time(header.get("timestamp").and_then(Value::as_str)),
                )
            };
            if normalize(Path::new(&cwd)).unwrap_or(cwd) != project_norm {
                continue;
            }
            // 只展示 PiX 纳管的会话（带 .pix.json sidecar）；pi CLI 等其他
            // 入口直接创建的会话没有 sidecar，不出现在项目会话列表里。
            if !has_sidecar(&path) {
                continue;
            }
            candidates.push((path, mtime, created));
        }
    }
    candidates.sort_by(|a, b| b.2.cmp(&a.2).then(b.0.cmp(&a.0)));
    let mut out = Vec::new();
    for (path, mtime, _) in candidates {
        if out.len() >= MAX_SESSIONS {
            break;
        }
        // One unreadable/partial/corrupt file must not empty the sidebar.
        if let Ok(meta) = read_session_meta(&path, mtime) {
            out.push(meta);
        }
    }
    Ok(out)
}

/// Build `SessionMeta` for one session file (header + preview + presentation).
pub(crate) fn read_session_meta(path: &Path, mtime: u64) -> Result<SessionMeta, String> {
    if let Some(cached) = cached_meta(path, mtime) {
        return Ok(cached);
    }
    let Some(line) = first_line(path) else {
        return Err("empty session file".into());
    };
    let header = serde_json::from_str::<serde_json::Value>(&line)
        .map_err(|e| format!("invalid session header: {e}"))?;
    if header.get("type").and_then(|t| t.as_str()) != Some("session") {
        return Err("not a session file".into());
    }
    let cwd = header
        .get("cwd")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();
    let id = header
        .get("id")
        .and_then(|i| i.as_str())
        .unwrap_or_default()
        .to_string();
    let timestamp = header
        .get("timestamp")
        .and_then(|t| t.as_str())
        .map(String::from);
    let preview = first_user_preview(path);
    let presentation = {
        let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
        read_presentation(path)?
    };
    let meta = SessionMeta {
        file: path.to_string_lossy().to_string(),
        id,
        cwd,
        timestamp,
        mtime_ms: mtime,
        preview,
        title: read_session_name(path)?,
        archived: presentation.archived,
    };
    cache_meta(path, mtime, &meta);
    Ok(meta)
}

/// Parse results cache keyed by path + mtime: listing sessions repeatedly
/// re-reads every file (header + 32 KB preview scan + full name scan); the
/// cache skips that work until the file changes on disk.
struct CachedMeta {
    mtime: u64,
    meta: SessionMeta,
}
fn meta_cache() -> &'static std::sync::Mutex<HashMap<PathBuf, CachedMeta>> {
    static CACHE: OnceLock<std::sync::Mutex<HashMap<PathBuf, CachedMeta>>> = OnceLock::new();
    CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}
const META_CACHE_CAP: usize = 4096;
fn cached_meta(path: &Path, mtime: u64) -> Option<SessionMeta> {
    let cache = meta_cache().lock().ok()?;
    cache
        .get(path)
        .filter(|c| c.mtime == mtime)
        .map(|c| c.meta.clone())
}
fn cache_meta(path: &Path, mtime: u64, meta: &SessionMeta) {
    if let Ok(mut cache) = meta_cache().lock() {
        if cache.len() >= META_CACHE_CAP {
            cache.clear();
        }
        cache.insert(
            path.to_path_buf(),
            CachedMeta {
                mtime,
                meta: meta.clone(),
            },
        );
    }
}
fn invalidate_meta_cache(path: &Path) {
    if let Ok(mut cache) = meta_cache().lock() {
        cache.remove(path);
    }
}

/// List archived sessions across all projects (newest first).
pub async fn list_archived() -> Result<Vec<SessionMeta>, String> {
    tokio::task::spawn_blocking(move || {
        let sessions_root = agent_dir().join("sessions");
        let mut candidates: Vec<(PathBuf, u64)> = Vec::new();

        let dirs = match std::fs::read_dir(&sessions_root) {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()), // no sessions yet
        };
        for dir in dirs.flatten() {
            let Ok(files) = std::fs::read_dir(dir.path()) else {
                continue;
            };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                candidates.push((p.clone(), mtime_ms(&p)));
            }
        }

        // newest first, then keep only archived sessions
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));

        let mut out = Vec::new();
        for (path, mtime) in candidates {
            if out.len() >= MAX_ARCHIVED {
                break;
            }
            // Cheap presentation check first: skip unarchived files without
            // parsing headers and scanning previews.
            let archived = match cached_meta(&path, mtime) {
                Some(meta) => meta.archived,
                None => {
                    let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
                    read_presentation(&path)?.archived
                }
            };
            if !archived {
                continue;
            }
            if let Ok(meta) = read_session_meta(&path, mtime) {
                out.push(meta);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("session scan failed: {e}"))?
}

/// Read the last Pi session_info entry, including renames made in the terminal.
pub(crate) fn read_session_name(path: &Path) -> Result<Option<String>, String> {
    use std::io::{BufRead, BufReader};
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let mut name = None;
    for line in BufReader::new(file).lines() {
        let line = line.map_err(|e| e.to_string())?;
        if let Ok(entry) = serde_json::from_str::<serde_json::Value>(&line) {
            if entry["type"] == "session_info" {
                name = entry["name"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned);
            }
        }
    }
    Ok(name)
}

pub(crate) async fn set_session_name(
    app: &AppHandle,
    path: &Path,
    title: String,
    only_if_empty: bool,
) -> Result<Option<String>, String> {
    crate::rpc::set_session_name(
        &app.state::<crate::rpc::RpcState>(),
        path,
        title,
        only_if_empty,
    )
    .await
}

// Only PiX-only archive/generation bookkeeping lives in the sidecar.
#[derive(serde::Deserialize, Serialize, Default)]
pub struct Presentation {
    #[serde(default)]
    pub archived: bool,
    #[serde(default)]
    pub title_generation_attempted: bool,
}
pub(crate) static PRESENTATION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

pub(crate) fn read_presentation(file: &Path) -> Result<Presentation, String> {
    match std::fs::read(file.with_extension("pix.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Presentation::default()),
        Err(e) => Err(e.to_string()),
    }
}
// Readers always see a complete JSON document, even while another client lists sessions.
pub(crate) fn write_presentation(file: &Path, presentation: &Presentation) -> Result<(), String> {
    let bytes = serde_json::to_vec(presentation).map_err(|e| e.to_string())?;
    crate::atomic_write::write(&file.with_extension("pix.json"), &bytes).map_err(|e| e.to_string())
}
/// PiX 纳管会话的标记：会话的 .pix.json sidecar 存在。
fn has_sidecar(path: &Path) -> bool {
    path.with_extension("pix.json").is_file()
}

/// 将会话纳入 PiX 管理：sidecar 缺失时写入默认值。幂等；
/// 与 session_update 一样拒绝符号链接的 sidecar 路径。
pub fn adopt(file: &Path) -> Result<(), String> {
    let sidecar = file.with_extension("pix.json");
    if std::fs::symlink_metadata(&sidecar).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(pix_error("sessionMetaPathInvalid", "无效的会话元数据路径"));
    }
    let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
    // 锁内复查：其他客户端可能同时纳管同一会话。
    if sidecar.exists() {
        return Ok(());
    }
    write_presentation(file, &Presentation::default())
}

/// Adopt a session into PiX so it appears in the PiX-only session listing.
#[tauri::command]
pub async fn session_adopt(file: String) -> Result<(), String> {
    let path = validate_session_path(&file)?;
    tokio::task::spawn_blocking(move || adopt(&path))
        .await
        .map_err(|e| format!("session adopt failed: {e}"))?
}

/// 一次性迁移：PiX 专属列表过滤引入前，侧栏已展示过的会话可能缺少
/// sidecar；为它们补写，避免升级后用户已管理的会话从侧栏消失。
pub fn adopt_known_sessions(files: Vec<PathBuf>) {
    for file in files {
        if file.extension().and_then(|s| s.to_str()) == Some("jsonl") && file.is_file() {
            if let Err(error) = adopt(&file) {
                crate::logs::write(
                    "sessions",
                    &format!("adopt {} failed: {error}", file.display()),
                );
            }
        }
    }
}

/// Error details of the last failed assistant message recorded in a session
/// file. pi drops most retry failures from the RPC message projection via
/// `context_edit`, so clients read the file to surface the final failure.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionLastError {
    /// `message.timestamp` (milliseconds since epoch), when present.
    pub timestamp: Option<u64>,
    pub error_message: String,
}

/// Scan a session file backwards for the last assistant message that ended
/// with `stopReason: "error"` and a non-empty `errorMessage`.
fn last_session_error(path: &Path) -> Result<Option<SessionLastError>, String> {
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    for line in content.lines().rev() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(msg) = v.get("message") else {
            continue;
        };
        if msg.get("role").and_then(|r| r.as_str()) != Some("assistant") {
            continue;
        }
        if msg.get("stopReason").and_then(|r| r.as_str()) != Some("error") {
            continue;
        }
        let error_message = msg
            .get("errorMessage")
            .and_then(|m| m.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        if error_message.is_empty() {
            continue;
        }
        let timestamp = msg.get("timestamp").and_then(|t| t.as_u64());
        return Ok(Some(SessionLastError {
            timestamp,
            error_message,
        }));
    }
    Ok(None)
}

/// Last provider error recorded in a session file; `None` when the session
/// never failed. Used to supplement RPC history, which omits retried errors.
#[tauri::command]
pub async fn session_last_error(file: String) -> Result<Option<SessionLastError>, String> {
    let path = tokio::task::spawn_blocking(move || validate_session_path(&file))
        .await
        .map_err(|e| format!("session scan failed: {e}"))??;
    tokio::task::spawn_blocking(move || last_session_error(&path))
        .await
        .map_err(|e| format!("session scan failed: {e}"))?
}

/// Read the full current-branch transcript from the session file, including
/// turns collapsed by compaction (pi's RPC `get_messages` only returns the
/// projected post-compaction context). Compaction entries are mapped to
/// `compactionSummary` messages matching the RPC shape; `context_edit` and
/// unknown custom entries pass through with their raw pi entry shape.
#[tauri::command]
pub async fn session_history(file: String) -> Result<Vec<serde_json::Value>, String> {
    let path = tokio::task::spawn_blocking(move || validate_session_path(&file))
        .await
        .map_err(|e| format!("session scan failed: {e}"))??;
    tokio::task::spawn_blocking(move || read_session_history(&path))
        .await
        .map_err(|e| format!("session scan failed: {e}"))?
}

fn read_session_history(path: &Path) -> Result<Vec<serde_json::Value>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| {
        pix_error_detail("sessionFileReadFailed", format!("无法读取会话文件: {e}"), e)
    })?;
    // First pass: index every entry's parent so the current branch can be
    // reconstructed by walking parentIds from the last entry.
    let mut parents: HashMap<String, Option<String>> = HashMap::new();
    let mut leaf: Option<String> = None;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let parent = entry
            .get("parentId")
            .and_then(|v| v.as_str())
            .map(str::to_string);
        parents.insert(id.to_string(), parent);
        leaf = Some(id.to_string());
    }
    let mut branch: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cursor = leaf;
    while let Some(id) = cursor {
        if !branch.insert(id.clone()) {
            break; // cycle guard
        }
        cursor = parents.get(&id).cloned().flatten();
    }
    // Second pass: keep current-branch entries in file order, as messages.
    let mut messages = Vec::new();
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        if !branch.contains(id) {
            continue;
        }
        match entry.get("type").and_then(|v| v.as_str()) {
            Some("message") => {
                let Some(message) = entry.get("message") else {
                    continue;
                };
                if message.get("role").and_then(|v| v.as_str()) == Some("system") {
                    continue;
                }
                let mut message = message.clone();
                // Lets the frontend estimate the context kept at each marker.
                message["_entryId"] = id.into();
                messages.push(message);
            }
            Some("compaction") => {
                let mut msg = serde_json::json!({
                    "role": "compactionSummary",
                    "summary": entry.get("summary").and_then(|v| v.as_str()).unwrap_or(""),
                    "_entryId": id,
                });
                if let Some(kept) = entry.get("firstKeptEntryId").and_then(|v| v.as_str()) {
                    msg["firstKeptEntryId"] = kept.into();
                }
                if let Some(tokens) = entry.get("tokensBefore").and_then(|v| v.as_u64()) {
                    msg["tokensBefore"] = tokens.into();
                }
                if let Some(ts) = entry
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                {
                    msg["timestamp"] = ts.timestamp_millis().into();
                }
                messages.push(msg);
            }
            Some("custom")
                if entry.get("customType").and_then(|v| v.as_str()) == Some("pix-file-change") =>
            {
                let mut message = serde_json::json!({
                    "role": "custom",
                    "customType": "pix-file-change",
                    "data": entry.get("data").cloned().unwrap_or(Value::Null),
                    "_entryId": id,
                });
                if let Some(ts) = entry
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                {
                    message["timestamp"] = ts.timestamp_millis().into();
                }
                messages.push(message);
            }
            // pi ≥0.87: edit of an earlier context-producing entry. Pass the
            // raw entry through verbatim so the frontend can materialize its
            // "context edited" marker.
            Some("context_edit") => messages.push(entry.clone()),
            // Model switches render as conversation dividers; pass the raw
            // entry through verbatim (provider/modelId plus timestamps).
            Some("model_change") => messages.push(entry.clone()),
            // Unknown extension entries pass through verbatim too; the
            // frontend decides which custom types render (internal ones like
            // `pi.virtual-model-state` are skipped there).
            Some("custom") if entry.get("customType").and_then(|v| v.as_str()).is_some() => {
                messages.push(entry.clone())
            }
            _ => {}
        }
    }
    Ok(messages)
}

#[tauri::command]
pub async fn session_mtime(file: String) -> Result<u64, String> {
    let path = tokio::task::spawn_blocking(move || validate_session_path(&file))
        .await
        .map_err(|e| format!("session scan failed: {e}"))??;
    tokio::task::spawn_blocking(move || mtime_ms(&path))
        .await
        .map_err(|e| format!("session scan failed: {e}"))
}

#[tauri::command]
pub async fn session_update(
    app: AppHandle,
    file: String,
    title: Option<String>,
    archived: bool,
) -> Result<u64, String> {
    let path = tokio::task::spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        if std::fs::symlink_metadata(path.with_extension("pix.json"))
            .is_ok_and(|m| m.file_type().is_symlink())
        {
            return Err(pix_error("sessionMetaPathInvalid", "无效的会话元数据路径"));
        }
        Ok(path)
    })
    .await
    .map_err(|e| format!("session scan failed: {e}"))??;
    if let Some(title) = title.filter(|s| !s.trim().is_empty()) {
        set_session_name(&app, &path, title.trim().chars().take(120).collect(), false).await?;
    }
    tokio::task::spawn_blocking(move || {
        update_presentation(&path, archived)?;
        Ok(mtime_ms(&path))
    })
    .await
    .map_err(|e| format!("session update failed: {e}"))?
}

fn update_presentation(path: &Path, archived: bool) -> Result<(), String> {
    let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let mut presentation = read_presentation(path)?;
    presentation.archived = archived;
    write_presentation(&path, &presentation)?;
    // The jsonl mtime is unchanged, so the meta cache must be told explicitly.
    invalidate_meta_cache(path);
    Ok(())
}

/// Rewrite session content for duplication: fresh id/timestamp in the header,
/// identical body. Returns the new content along with a file name matching
/// pi's `<timestamp>_<uuid>.jsonl` convention.
fn duplicate_content(content: &str, timestamp: &str, id: &str) -> Result<String, String> {
    let mut lines = content.lines();
    let header_line = lines.next().ok_or("empty session file")?;
    let mut header = serde_json::from_str::<serde_json::Value>(header_line)
        .map_err(|e| format!("invalid session header: {e}"))?;
    if header.get("type").and_then(|t| t.as_str()) != Some("session") {
        return Err("not a session file".into());
    }
    header["id"] = serde_json::Value::String(id.to_string());
    header["timestamp"] = serde_json::Value::String(timestamp.to_string());
    let mut out = serde_json::to_string(&header).map_err(|e| e.to_string())?;
    for line in lines {
        out.push('\n');
        out.push_str(line);
    }
    if content.ends_with('\n') {
        out.push('\n');
    }
    Ok(out)
}

/// Copy a session file with a fresh id and timestamp; returns the new path.
#[tauri::command]
pub async fn session_duplicate(
    state: tauri::State<'_, crate::rpc::RpcState>,
    file: String,
    before_entry_id: Option<String>,
    runtime_id: Option<String>,
) -> Result<String, String> {
    if let Some(runtime_id) = runtime_id {
        if let Some(endpoint) = crate::rpc::session_endpoint(&state, &runtime_id).await? {
            return duplicate_remote_session(&endpoint, &file, before_entry_id.as_deref()).await;
        }
    }
    tokio::task::spawn_blocking(move || {
        let source = validate_session_path(&file)?;
        let content = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
        let content = match before_entry_id {
            Some(entry_id) => branch_before_entry(&content, &entry_id)?,
            None => content,
        };
        let timestamp = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let content = duplicate_content(&content, &timestamp, &id)?;
        let name = format!("{}_{id}.jsonl", timestamp.replace([':', '.'], "-"));
        let target = source.parent().ok_or("invalid session path")?.join(name);
        std::fs::write(&target, content).map_err(|e| e.to_string())?;
        // 复制出的会话同样是 PiX 纳管会话，缺 sidecar 会从列表里消失。
        adopt(&target)?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("session duplicate failed: {e}"))?
}

async fn duplicate_remote_session(
    endpoint: &crate::ssh::RemoteEndpoint,
    file: &str,
    before_entry_id: Option<&str>,
) -> Result<String, String> {
    let snapshot =
        remote_session_snapshot(endpoint, serde_json::json!({"op": "read", "file": file})).await?;
    let content = snapshot["content"]
        .as_str()
        .ok_or("Missing session snapshot")?;
    let branch = before_entry_id
        .map(|id| branch_before_entry(content, id))
        .transpose()?;
    let timestamp = chrono::Utc::now()
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let content = duplicate_content(branch.as_deref().unwrap_or(content), &timestamp, &id)?;
    let result = remote_session_snapshot(
        endpoint,
        serde_json::json!({
            "op": "write", "file": file, "content": content,
            "name": format!("{}_{id}.jsonl", timestamp.replace([':', '.'], "-")),
        }),
    )
    .await?;
    result["file"]
        .as_str()
        .map(str::to_owned)
        .ok_or("Missing copied session path".into())
}

async fn remote_session_snapshot(
    endpoint: &crate::ssh::RemoteEndpoint,
    request: Value,
) -> Result<Value, String> {
    let script = crate::ssh::payload::build_session_snapshot_script();
    let output = crate::ssh::transport::remote_exec_session_snapshot(
        endpoint,
        &script,
        request.to_string().as_bytes(),
        std::time::Duration::from_secs(20),
    )
    .await
    .map_err(|e| crate::commands::ssh::remote_error_coded(endpoint, &e))?;
    let json = output
        .stdout
        .lines()
        .find_map(|line| line.strip_prefix("PIX_SESSION_SNAPSHOT="))
        .ok_or("Missing remote session snapshot response")?;
    serde_json::from_str(json).map_err(|e| e.to_string())
}

/// Select the target's ancestors without navigating or modifying the live worker.
/// Stop reading at the target so an in-progress append after it is irrelevant.
fn branch_before_entry(content: &str, target: &str) -> Result<String, String> {
    let mut lines = content.lines();
    let header = lines.next().ok_or("empty session file")?;
    let mut entries = Vec::new();
    let mut parents = HashMap::new();
    let mut leaf = None;
    let mut found = false;
    for line in lines.filter(|line| !line.trim().is_empty()) {
        let entry: Value = serde_json::from_str(line).map_err(|e| e.to_string())?;
        if entry["id"].as_str() == Some(target) {
            if entry["type"] != "message" || entry["message"]["role"] != "user" {
                return Err("Fork target is not a user question".into());
            }
            leaf = entry["parentId"].as_str().map(str::to_owned);
            found = true;
            break;
        }
        if let Some(id) = entry["id"].as_str() {
            parents.insert(id.to_owned(), entry["parentId"].as_str().map(str::to_owned));
        }
        entries.push((line, entry));
    }
    if !found {
        return Err("Question no longer exists in the session".into());
    }
    let mut branch = std::collections::HashSet::new();
    while let Some(id) = leaf {
        if !branch.insert(id.clone()) {
            return Err("Invalid session branch: cyclic parent".into());
        }
        leaf = parents
            .get(&id)
            .ok_or("Missing session branch parent")?
            .clone();
    }
    let mut output = format!("{header}\n");
    for (line, entry) in entries {
        if entry["id"].as_str().is_some_and(|id| branch.contains(id)) {
            output.push_str(line);
            output.push('\n');
        }
    }
    Ok(output)
}

/// Permanently delete a session file and its PiX presentation metadata.
#[tauri::command]
pub async fn session_delete(file: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        // Presentation metadata is optional; ignore a missing sidecar.
        let _ = std::fs::remove_file(path.with_extension("pix.json"));
        let _ = crate::session_file_rewind::delete_state_for_session(&path);
        invalidate_meta_cache(&path);
        Ok(())
    })
    .await
    .map_err(|e| format!("session delete failed: {e}"))?
}

/// List archived sessions across every project, newest first.
#[tauri::command]
pub async fn session_list_archived() -> Result<Vec<SessionMeta>, String> {
    list_archived().await
}

#[cfg(test)]
mod presentation_tests {
    use super::*;

    #[test]
    fn project_listing_limits_by_creation_time_and_ignores_later_writes() {
        let root = std::env::temp_dir().join(format!("pix-list-created-{}", uuid::Uuid::new_v4()));
        let sessions = root.join("sessions");
        let folder = sessions.join("encoded-project");
        std::fs::create_dir_all(&folder).unwrap();
        let project_norm = normalize(&root).unwrap();
        let base = chrono::DateTime::parse_from_rfc3339("2026-10-20T00:00:00Z").unwrap();
        for index in 0..MAX_SESSIONS + 2 {
            let header = serde_json::json!({
                "type": "session",
                "id": index.to_string(),
                "cwd": root.to_string_lossy(),
                "timestamp": (base + chrono::Duration::minutes(index as i64)).to_rfc3339(),
            });
            let path = folder.join(format!("session-{index:03}.jsonl"));
            std::fs::write(&path, format!("{header}\n")).unwrap();
            adopt(&path).unwrap();
            let modified = UNIX_EPOCH + std::time::Duration::from_secs(10_000 - index as u64);
            std::fs::OpenOptions::new()
                .write(true)
                .open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
        }
        std::fs::write(folder.join("corrupt.jsonl"), "incomplete header\n").unwrap();
        let other = serde_json::json!({
            "type": "session",
            "cwd": folder.to_string_lossy(),
            "timestamp": "2026-10-21T00:00:00Z",
        });
        std::fs::write(folder.join("other.jsonl"), format!("{other}\n")).unwrap();

        let expected: Vec<String> = (2..MAX_SESSIONS + 2).rev().map(|i| i.to_string()).collect();
        for _ in 0..2 {
            let rows = list_project_sessions(&sessions, &project_norm).unwrap();
            assert_eq!(
                rows.iter().map(|meta| meta.id.clone()).collect::<Vec<_>>(),
                expected
            );
            // An older session becoming the most recently modified must not
            // displace any of the newest-created 50, even with cached metadata.
            std::fs::OpenOptions::new()
                .write(true)
                .open(folder.join("session-000.jsonl"))
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()))
                .unwrap();
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn project_listing_shows_only_adopted_sessions() {
        let root = std::env::temp_dir().join(format!("pix-list-adopted-{}", uuid::Uuid::new_v4()));
        let folder = root.join("sessions").join("encoded-project");
        std::fs::create_dir_all(&folder).unwrap();
        let project_norm = normalize(&root).unwrap();
        for name in ["pix-owned", "cli-created"] {
            let header = serde_json::json!({
                "type": "session",
                "id": name,
                "cwd": root.to_string_lossy(),
                "timestamp": "2026-10-22T00:00:00Z",
            });
            std::fs::write(folder.join(format!("{name}.jsonl")), format!("{header}\n")).unwrap();
        }
        // pi CLI 直接创建的会话没有 sidecar，不出现在 PiX 的列表里。
        adopt(&folder.join("pix-owned.jsonl")).unwrap();

        let rows = list_project_sessions(&root.join("sessions"), &project_norm).unwrap();
        assert_eq!(
            rows.iter().map(|meta| meta.id.as_str()).collect::<Vec<_>>(),
            ["pix-owned"]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn adopt_creates_sidecar_once_and_preserves_existing_metadata() {
        let file = std::env::temp_dir().join(format!("pix-adopt-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&file, "{\"type\":\"session\",\"id\":\"s\"}\n").unwrap();
        adopt(&file).unwrap();
        assert!(file.with_extension("pix.json").is_file());

        // 再次纳管不得覆盖已有元数据（例如归档状态）。
        write_presentation(
            &file,
            &Presentation {
                archived: true,
                title_generation_attempted: false,
            },
        )
        .unwrap();
        adopt(&file).unwrap();
        assert!(read_presentation(&file).unwrap().archived);
        std::fs::remove_file(&file).unwrap();
        std::fs::remove_file(file.with_extension("pix.json")).unwrap();
    }

    #[tokio::test]
    async fn missing_project_has_specific_error_code() {
        let path =
            std::env::temp_dir().join(format!("pix-missing-project-{}", uuid::Uuid::new_v4()));
        let error = match list(path.to_string_lossy().into_owned()).await {
            Ok(_) => panic!("missing directory unexpectedly loaded"),
            Err(error) => error,
        };
        assert!(error.contains("\"code\":\"projectDirMissing\""));
    }

    #[test]
    fn last_session_error_finds_latest_failure() {
        let file =
            std::env::temp_dir().join(format!("pix-last-error-{}.jsonl", uuid::Uuid::new_v4()));
        let content = concat!(
            "{\"type\":\"session\",\"id\":\"s\"}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"timestamp\":1000,\"errorMessage\":\"first\"}}\n",
            "{\"type\":\"context_edit\",\"targetId\":\"a\",\"replacement\":null}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"toolResult\",\"content\":\"ok\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"timestamp\":2000,\"errorMessage\":\"last 503\"}}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"done\"}],\"stopReason\":\"toolUse\",\"timestamp\":3000}}\n",
        );
        std::fs::write(&file, content).unwrap();
        let last = last_session_error(&file).unwrap().unwrap();
        assert_eq!(last.error_message, "last 503");
        assert_eq!(last.timestamp, Some(2000));
        // No error at all, and errors without a message are skipped.
        std::fs::write(&file, "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"error\",\"timestamp\":1}}\n").unwrap();
        assert!(last_session_error(&file).unwrap().is_none());
        std::fs::write(&file, "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":[],\"stopReason\":\"stop\"}}\n").unwrap();
        assert!(last_session_error(&file).unwrap().is_none());
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn duplicate_rewrites_header_and_keeps_body() {
        let original = "{\"type\":\"session\",\"version\":3,\"id\":\"old-id\",\"timestamp\":\"2026-01-01T00:00:00.000Z\",\"cwd\":\"/tmp\"}\n{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi old-id\"}}\n";
        let copy = duplicate_content(original, "2026-09-26T01:02:03.456Z", "new-id").unwrap();
        let mut lines = copy.lines();
        let header: serde_json::Value = serde_json::from_str(lines.next().unwrap()).unwrap();
        assert_eq!(header["id"], "new-id");
        assert_eq!(header["timestamp"], "2026-09-26T01:02:03.456Z");
        assert_eq!(header["cwd"], "/tmp");
        assert_eq!(
            lines.next().unwrap(),
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi old-id\"}}"
        );
        assert!(lines.next().is_none());
        assert!(copy.ends_with('\n'));
        assert!(duplicate_content("{\"type\":\"message\"}\n", "t", "i").is_err());
        assert!(duplicate_content("", "t", "i").is_err());
    }

    #[tokio::test]
    async fn remote_duplicate_and_branch_accept_snapshots_over_default_exec_limit() {
        use crate::ssh::transport::{env_lock, find_test_program, AuthMethod, SshEndpoint};
        let Some(node) = find_test_program("node") else { return };
        let script = std::env::temp_dir().join(format!(
            "pix-snapshot-mock-{}.cjs", uuid::Uuid::new_v4()
        ));
        // PIX_SSH_COMMAND uses whitespace-separated arguments, just like the other mock-ssh tests.
        if node.to_string_lossy().contains(' ') || script.to_string_lossy().contains(' ') {
            return;
        }
        std::fs::write(&script, r#"
const fs = require('node:fs');
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
if (request.op === 'read') {
  const header = JSON.stringify({type:'session',id:'old'}) + '\n';
  const blob = JSON.stringify({type:'custom',id:'blob',parentId:null,data:'x'.repeat(16*1024*1024)}) + '\n';
  const question = JSON.stringify({type:'message',id:'q',parentId:'blob',message:{role:'user'}}) + '\n';
  process.stdout.write('PIX_SESSION_SNAPSHOT=' + JSON.stringify({content:header+blob+question}) + '\n');
} else {
  const lines = request.content.trim().split('\n');
  const branch = request.file === '/branch.jsonl';
  if (request.content.length <= 16*1024*1024 || lines.length !== (branch ? 2 : 3)) process.exit(1);
  process.stdout.write('PIX_SESSION_SNAPSHOT=' + JSON.stringify({file:'/copied.jsonl'}) + '\n');
}
"#).unwrap();
        let _guard = env_lock();
        let previous = std::env::var_os("PIX_SSH_COMMAND");
        std::env::set_var(
            "PIX_SSH_COMMAND", format!("{} {}", node.display(), script.display())
        );
        let endpoint = crate::ssh::RemoteEndpoint::Ssh(SshEndpoint {
            host: "mock".into(),
            port: 22,
            user: None,
            key_path: None,
            auth_method: AuthMethod::Key,
            password: None,
            key_passphrase: None,
        });
        let duplicate = duplicate_remote_session(&endpoint, "/original.jsonl", None).await;
        let branch = duplicate_remote_session(&endpoint, "/branch.jsonl", Some("q")).await;
        match previous {
            Some(value) => std::env::set_var("PIX_SSH_COMMAND", value),
            None => std::env::remove_var("PIX_SSH_COMMAND"),
        }
        std::fs::remove_file(script).unwrap();
        assert_eq!(duplicate.unwrap(), "/copied.jsonl");
        assert_eq!(branch.unwrap(), "/copied.jsonl");
    }

    #[test]
    fn branch_copy_keeps_ancestors_and_excludes_later_turns_and_other_branches() {
        let lines = [
            serde_json::json!({"type": "session", "id": "original", "version": 3, "cwd": "/tmp"}),
            serde_json::json!({"type": "model_change", "id": "model", "parentId": null}),
            serde_json::json!({"type": "message", "id": "q1", "parentId": "model", "message": {"role": "user", "content": "repeat"}}),
            serde_json::json!({"type": "message", "id": "a1", "parentId": "q1", "message": {"role": "assistant", "content": []}}),
            serde_json::json!({"type": "message", "id": "abandoned", "parentId": "q1", "message": {"role": "assistant", "content": []}}),
            serde_json::json!({"type": "compaction", "id": "compact", "parentId": "a1", "summary": "summary", "firstKeptEntryId": "q1"}),
            serde_json::json!({"type": "message", "id": "q2", "parentId": "compact", "message": {"role": "user", "content": "repeat"}}),
            serde_json::json!({"type": "message", "id": "a2", "parentId": "q2", "message": {"role": "assistant", "content": []}}),
        ];
        let original = lines
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        // A live worker can be appending a partial JSON record after the target.
        let original = format!("{original}\n{{\"type\":");
        let branch = branch_before_entry(&original, "q2").unwrap();
        let copy = duplicate_content(&branch, "now", "copy").unwrap();
        let entries: Vec<Value> = copy
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(entries[0]["id"], "copy");
        assert_eq!(
            entries[1..],
            [
                lines[1].clone(),
                lines[2].clone(),
                lines[3].clone(),
                lines[5].clone()
            ]
        );
        assert!(original.contains("abandoned"));
        assert!(original.contains("a2"));
    }

    #[test]
    fn branch_copy_before_first_question_preserves_setup_entries() {
        let original = concat!(
            "{\"type\":\"session\",\"id\":\"old\"}\n",
            "{\"type\":\"thinking_level_change\",\"id\":\"setup\",\"parentId\":null}\n",
            "{\"type\":\"message\",\"id\":\"q\",\"parentId\":\"setup\",\"message\":{\"role\":\"user\"}}\n",
        );
        assert_eq!(
            branch_before_entry(original, "q").unwrap(),
            original.lines().take(2).collect::<Vec<_>>().join("\n") + "\n"
        );
    }

    #[test]
    fn branch_copy_rejects_missing_or_non_user_targets_and_broken_ancestry() {
        let header = "{\"type\":\"session\",\"id\":\"old\"}\n";
        assert!(branch_before_entry(header, "missing").is_err());
        let assistant = format!("{header}{{\"type\":\"message\",\"id\":\"a\",\"parentId\":null,\"message\":{{\"role\":\"assistant\"}}}}\n");
        assert!(branch_before_entry(&assistant, "a").is_err());
        for parent in ["missing", "cycle"] {
            let original = format!("{header}{{\"type\":\"custom\",\"id\":\"cycle\",\"parentId\":\"{parent}\"}}\n{{\"type\":\"message\",\"id\":\"q\",\"parentId\":\"cycle\",\"message\":{{\"role\":\"user\"}}}}\n");
            assert!(branch_before_entry(&original, "q").is_err());
        }
    }
    #[test]
    fn native_session_names_use_latest_entry_and_support_clearing() {
        let file = std::env::temp_dir().join(format!("pix-name-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&file, "{\"type\":\"session_info\",\"name\":\"First\"}\n{\"type\":\"session_info\",\"name\":\" Last \"}\n").unwrap();
        assert_eq!(read_session_name(&file).unwrap().as_deref(), Some("Last"));
        std::fs::write(&file, "{\"type\":\"session_info\",\"name\":\"\"}\n").unwrap();
        assert_eq!(read_session_name(&file).unwrap(), None);
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn preview_survives_oversized_system_preamble_line() {
        // pi writes a huge system-preamble message before the first user
        // message; a fixed byte window would swallow it and lose the preview.
        let file = std::env::temp_dir().join(format!("pix-preview-{}.jsonl", uuid::Uuid::new_v4()));
        let huge = "x".repeat(60 * 1024);
        let content = format!(
            concat!(
                "{{\"type\":\"session\",\"cwd\":\"/tmp\",\"id\":\"p\"}}\n",
                "{{\"type\":\"message\",\"message\":{{\"role\":\"system\",\"content\":\"{}\"}}}}\n",
                "{{\"type\":\"message\",\"message\":{{\"role\":\"user\",\"content\":\"调用 3 个智能体\"}}}}\n",
            ),
            huge
        );
        std::fs::write(&file, content).unwrap();
        let meta = read_session_meta(&file, mtime_ms(&file)).unwrap();
        assert_eq!(meta.preview.as_deref(), Some("调用 3 个智能体"));
        std::fs::remove_file(file).unwrap();
    }
    #[test]
    fn preview_scan_stays_bounded_with_giant_message_preamble() {
        // Message lines must pay the budget too: a file padded with huge
        // system/assistant messages before the first user message would
        // otherwise grant the scan unlimited budget over the whole file.
        let file =
            std::env::temp_dir().join(format!("pix-preview-bound-{}.jsonl", uuid::Uuid::new_v4()));
        let huge = "x".repeat(4 * 1024);
        let mut content = String::from("{\"type\":\"session\",\"cwd\":\"/tmp\",\"id\":\"p\"}\n");
        for _ in 0..32 {
            content.push_str(&format!(
                "{{\"type\":\"message\",\"message\":{{\"role\":\"system\",\"content\":\"{huge}\"}}}}\n"
            ));
        }
        content.push_str(
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"after preamble\"}}\n",
        );
        std::fs::write(&file, content).unwrap();
        // The 32 KB budget is exhausted by the preamble long before the user
        // message, so the scan stops instead of reading to the end.
        assert_eq!(first_user_preview(&file), None);
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn preview_skips_message_entries_without_a_message_field() {
        // An entry with type "message" but no `message` field must not abort
        // the scan (`?` on a missing key used to drop the whole preview).
        let file =
            std::env::temp_dir().join(format!("pix-preview-nomsg-{}.jsonl", uuid::Uuid::new_v4()));
        let content = concat!(
            "{\"type\":\"session\",\"cwd\":\"/tmp\",\"id\":\"p\"}\n",
            "{\"type\":\"message\"}\n",
            "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"still found\"}}\n",
        );
        std::fs::write(&file, content).unwrap();
        assert_eq!(first_user_preview(&file).as_deref(), Some("still found"));
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn meta_cache_serves_same_mtime_and_invalidates_on_write() {
        let file = std::env::temp_dir().join(format!("pix-cache-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(
            &file,
            "{\"type\":\"session\",\"cwd\":\"/tmp\",\"id\":\"cache-test\"}\n",
        )
        .unwrap();
        let mtime = mtime_ms(&file);
        let fresh = read_session_meta(&file, mtime).unwrap();
        assert_eq!(fresh.id, "cache-test");
        // File disappears but mtime is unchanged: the cache still answers.
        std::fs::remove_file(&file).unwrap();
        let cached = read_session_meta(&file, mtime).unwrap();
        assert_eq!(cached.id, "cache-test");
        // After invalidation the missing file is reported again.
        invalidate_meta_cache(&file);
        assert!(read_session_meta(&file, mtime).is_err());
    }
    #[test]
    fn history_reconstructs_current_branch_and_keeps_compactions() {
        let file = std::env::temp_dir().join(format!("pix-history-{}.jsonl", uuid::Uuid::new_v4()));
        let content = concat!(
            "{\"type\":\"session\",\"id\":\"h\",\"parentId\":null}\n",
            "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":\"h\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"m1\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n",
            "{\"type\":\"compaction\",\"id\":\"c1\",\"parentId\":\"m2\",\"timestamp\":\"2026-09-26T11:20:02.479Z\",\"summary\":\"collapsed\",\"tokensBefore\":222767,\"firstKeptEntryId\":\"m2\"}\n",
            "{\"type\":\"message\",\"id\":\"m3\",\"parentId\":\"c1\",\"message\":{\"role\":\"user\",\"content\":\"second\"}}\n",
            // A forked branch off m1 must not leak into the current branch.
            "{\"type\":\"message\",\"id\":\"fork\",\"parentId\":\"m1\",\"message\":{\"role\":\"user\",\"content\":\"forked\"}}\n",
            "{\"type\":\"message\",\"id\":\"m4\",\"parentId\":\"m3\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n",
            "{\"type\":\"custom\",\"id\":\"fc1\",\"parentId\":\"m4\",\"timestamp\":\"2026-09-26T11:20:03.000Z\",\"customType\":\"pix-file-change\",\"data\":{\"toolCallId\":\"call-1\",\"files\":[]}}\n",
        );
        std::fs::write(&file, content).unwrap();
        let messages = read_session_history(&file).unwrap();
        let roles: Vec<&str> = messages.iter().filter_map(|m| m["role"].as_str()).collect();
        assert_eq!(
            roles,
            [
                "user",
                "assistant",
                "compactionSummary",
                "user",
                "assistant",
                "custom"
            ]
        );
        assert_eq!(messages[0]["content"], "first");
        assert_eq!(messages[2]["summary"], "collapsed");
        assert_eq!(messages[2]["tokensBefore"], 222767);
        assert_eq!(messages[2]["timestamp"], 1790421602479i64);
        assert_eq!(messages[2]["firstKeptEntryId"], "m2");
        assert_eq!(messages[0]["_entryId"], "m1");
        assert_eq!(messages[3]["content"], "second");
        assert_eq!(messages[5]["customType"], "pix-file-change");
        assert_eq!(messages[5]["data"]["toolCallId"], "call-1");
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn history_passes_through_context_edit_and_custom_entries() {
        let file =
            std::env::temp_dir().join(format!("pix-history-edit-{}.jsonl", uuid::Uuid::new_v4()));
        let content = concat!(
            "{\"type\":\"session\",\"id\":\"h\",\"parentId\":null}\n",
            "{\"type\":\"message\",\"id\":\"m1\",\"parentId\":\"h\",\"message\":{\"role\":\"user\",\"content\":\"first\"}}\n",
            "{\"type\":\"context_edit\",\"id\":\"ce1\",\"parentId\":\"m1\",\"timestamp\":\"2026-09-26T11:20:02.000Z\",\"targetId\":\"m1\",\"replacement\":null}\n",
            "{\"type\":\"context_edit\",\"id\":\"ce2\",\"parentId\":\"ce1\",\"timestamp\":\"2026-09-26T11:20:03.000Z\",\"targetId\":\"m1\",\"replacement\":\"edited\"}\n",
            "{\"type\":\"custom\",\"id\":\"cu1\",\"parentId\":\"ce2\",\"timestamp\":\"2026-09-26T11:20:04.000Z\",\"customType\":\"pi.bug-report\",\"data\":{\"note\":\"hi\"}}\n",
            // Internal bookkeeping stays dropped; model changes pass through
            // as conversation dividers.
            "{\"type\":\"custom\",\"id\":\"cu2\",\"parentId\":\"cu1\",\"customType\":\"pi.virtual-model-state\",\"data\":{}}\n",
            "{\"type\":\"custom\",\"id\":\"cu3\",\"parentId\":\"cu2\",\"data\":{}}\n",
            "{\"type\":\"model_change\",\"id\":\"mc1\",\"parentId\":\"cu1\",\"timestamp\":\"2026-09-26T11:20:05.000Z\",\"provider\":\"p\",\"modelId\":\"m\"}\n",
            // A forked-branch edit must not leak into the current branch.
            "{\"type\":\"context_edit\",\"id\":\"cef\",\"parentId\":\"m1\",\"targetId\":\"m1\",\"replacement\":null}\n",
            "{\"type\":\"message\",\"id\":\"m2\",\"parentId\":\"mc1\",\"message\":{\"role\":\"assistant\",\"content\":[]}}\n",
        );
        std::fs::write(&file, content).unwrap();
        let messages = read_session_history(&file).unwrap();
        // m1, ce1, ce2, cu1, mc1, m2 — passthrough entries keep their raw shape.
        assert_eq!(messages.len(), 6);
        assert_eq!(messages[1]["type"], "context_edit");
        assert_eq!(messages[1]["id"], "ce1");
        assert_eq!(messages[1]["targetId"], "m1");
        assert_eq!(messages[1]["replacement"], serde_json::Value::Null);
        assert_eq!(messages[2]["targetId"], "m1");
        assert_eq!(messages[2]["replacement"], "edited");
        assert_eq!(messages[3]["type"], "custom");
        assert_eq!(messages[3]["customType"], "pi.bug-report");
        assert_eq!(messages[3]["data"]["note"], "hi");
        assert_eq!(messages[4]["type"], "model_change");
        assert_eq!(messages[4]["provider"], "p");
        assert_eq!(messages[4]["modelId"], "m");
        assert_eq!(messages[5]["role"], "assistant");
        std::fs::remove_file(file).unwrap();
    }

    #[test]
    fn rename_archive_restore() {
        let dir = std::env::temp_dir().join(format!("pix-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("session.jsonl");
        let original = "{\"type\":\"session\"}\n";
        std::fs::write(&file, original).unwrap();
        assert!(!read_presentation(&file).unwrap().archived);
        update_presentation(&file, false).unwrap();
        update_presentation(&file, true).unwrap();
        let archived = read_presentation(&file).unwrap();
        assert!(archived.archived);
        update_presentation(&file, false).unwrap();
        assert!(!read_presentation(&file).unwrap().archived);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        update_presentation(&file, true).unwrap();
        assert!(std::fs::remove_file(&file).is_ok());
        let _ = std::fs::remove_file(file.with_extension("pix.json"));
        assert!(!file.exists());
        std::fs::remove_dir(dir).unwrap();
    }
}
