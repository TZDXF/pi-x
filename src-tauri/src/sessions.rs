//! Scan `~/.pi/agent/sessions/` for session files belonging to a project.
//!
//! Layout: `<agent-dir>/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
//! The encoding of the cwd in directory names is an implementation detail of
//! pi, so we don't reconstruct it — instead we read each file's first line
//! (the session header JSON) and filter by its `cwd` field.

use crate::trust::agent_dir;
use dunce::canonicalize;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::UNIX_EPOCH;

const MAX_SESSIONS: usize = 50;
const MAX_ARCHIVED: usize = 500;
const PREVIEW_SCAN_BYTES: u64 = 32 * 1024;

#[derive(Serialize, Clone)]
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
fn first_user_preview(path: &Path) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    f.seek(SeekFrom::Start(0)).ok()?;
    let mut buf = Vec::new();
    {
        let limit = PREVIEW_SCAN_BYTES;
        let mut handle = f.take(limit);
        handle.read_to_end(&mut buf).ok()?;
    }
    let text = String::from_utf8_lossy(&buf);
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if v.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let msg = v.get("message")?;
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
            let t: String = t.chars().map(|c| if c == '\n' || c == '\r' { ' ' } else { c }).collect();
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Some(t.chars().take(120).collect());
            }
        }
    }
    None
}

fn normalize(p: &Path) -> Option<String> {
    canonicalize(p).ok().map(|s| s.to_string_lossy().to_string())
}

/// Reject paths outside the pi sessions directory (or non-session files).
pub(crate) fn validate_session_path(file: &str) -> Result<PathBuf, String> {
    let path = canonicalize(file).map_err(|e| e.to_string())?;
    let root = canonicalize(agent_dir().join("sessions")).map_err(|e| e.to_string())?;
    if !path.starts_with(root) || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err("无效的会话路径".into());
    }
    Ok(path)
}

/// List the most recent sessions whose `cwd` matches `project`.
pub async fn list(project: String) -> Result<Vec<SessionMeta>, String> {
    let project_norm = normalize(Path::new(&project))
        .ok_or_else(|| format!("invalid project path: {project}"))?;

    tokio::task::spawn_blocking(move || {
        let sessions_root = agent_dir().join("sessions");
        let mut candidates: Vec<(PathBuf, u64)> = Vec::new();

        let dirs = match std::fs::read_dir(&sessions_root) {
            Ok(d) => d,
            Err(_) => return Ok(Vec::new()), // no sessions yet
        };
        for dir in dirs.flatten() {
            let Ok(files) = std::fs::read_dir(dir.path()) else { continue };
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                    continue;
                }
                candidates.push((p.clone(), mtime_ms(&p)));
            }
        }

        // newest first, then parse headers until we have enough matches
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then(b.0.cmp(&a.0)));

        let mut out = Vec::new();
        for (path, mtime) in candidates {
            if out.len() >= MAX_SESSIONS {
                break;
            }
            // Skip unreadable/partial/corrupt files instead of failing the
            // whole listing (one bad file must not empty the sidebar).
            let Ok(meta) = read_session_meta(&path, mtime) else { continue };
            let cwd_norm = normalize(Path::new(&meta.cwd)).unwrap_or_else(|| meta.cwd.clone());
            if cwd_norm != project_norm {
                continue;
            }
            out.push(meta);
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("session scan failed: {e}"))?
}

/// Build `SessionMeta` for one session file (header + preview + presentation).
fn read_session_meta(path: &Path, mtime: u64) -> Result<SessionMeta, String> {
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
    cache.get(path).filter(|c| c.mtime == mtime).map(|c| c.meta.clone())
}
fn cache_meta(path: &Path, mtime: u64, meta: &SessionMeta) {
    if let Ok(mut cache) = meta_cache().lock() {
        if cache.len() >= META_CACHE_CAP {
            cache.clear();
        }
        cache.insert(path.to_path_buf(), CachedMeta { mtime, meta: meta.clone() });
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
            let Ok(files) = std::fs::read_dir(dir.path()) else { continue };
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
                name = entry["name"].as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned);
            }
        }
    }
    Ok(name)
}

pub(crate) async fn set_session_name(app: &AppHandle, path: &Path, title: String, only_if_empty: bool) -> Result<Option<String>, String> {
    crate::rpc::set_session_name(&app.state::<crate::rpc::RpcState>(), path, title, only_if_empty).await
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
    let temporary = file.with_extension(format!("pix.{}.tmp", uuid::Uuid::new_v4()));
    std::fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, file.with_extension("pix.json")).map_err(|e| e.to_string())
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
        let Some(msg) = v.get("message") else { continue };
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
        return Ok(Some(SessionLastError { timestamp, error_message }));
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
/// `compactionSummary` messages matching the RPC shape.
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
    let text = std::fs::read_to_string(path).map_err(|e| format!("无法读取会话文件: {e}"))?;
    // First pass: index every entry's parent so the current branch can be
    // reconstructed by walking parentIds from the last entry.
    let mut parents: HashMap<String, Option<String>> = HashMap::new();
    let mut leaf: Option<String> = None;
    for line in text.lines() {
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else { continue };
        let parent = entry.get("parentId").and_then(|v| v.as_str()).map(str::to_string);
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
        let Ok(entry) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        let Some(id) = entry.get("id").and_then(|v| v.as_str()) else { continue };
        if !branch.contains(id) {
            continue;
        }
        match entry.get("type").and_then(|v| v.as_str()) {
            Some("message") => {
                let Some(message) = entry.get("message") else { continue };
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
                if let Some(ts) = entry.get("timestamp").and_then(|v| v.as_str())
                    .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                {
                    msg["timestamp"] = ts.timestamp_millis().into();
                }
                messages.push(msg);
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
    Ok(mtime_ms(&path))
}

#[tauri::command]
pub async fn session_update(app: AppHandle, file: String, title: Option<String>, archived: bool) -> Result<u64, String> {
    let path = validate_session_path(&file)?;
    if std::fs::symlink_metadata(path.with_extension("pix.json")).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("无效的会话元数据路径".into());
    }
    if let Some(title) = title.filter(|s| !s.trim().is_empty()) {
        set_session_name(&app, &path, title.trim().chars().take(120).collect(), false).await?;
    }
    update_presentation(&path, archived)?;
    Ok(mtime_ms(&path))
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
pub async fn session_duplicate(file: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let source = validate_session_path(&file)?;
        let content = std::fs::read_to_string(&source).map_err(|e| e.to_string())?;
        let timestamp = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let content = duplicate_content(&content, &timestamp, &id)?;
        let name = format!("{}_{id}.jsonl", timestamp.replace([':', '.'], "-"));
        let target = source.parent().ok_or("invalid session path")?.join(name);
        std::fs::write(&target, content).map_err(|e| e.to_string())?;
        Ok(target.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("session duplicate failed: {e}"))?
}

/// Permanently delete a session file and its PiX presentation metadata.
#[tauri::command]
pub async fn session_delete(file: String) -> Result<(), String> {
    let path = tokio::task::spawn_blocking(move || validate_session_path(&file))
        .await
        .map_err(|e| format!("session scan failed: {e}"))??;
    let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
    std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    // Presentation metadata is optional; ignore a missing sidecar.
    let _ = std::fs::remove_file(path.with_extension("pix.json"));
    invalidate_meta_cache(&path);
    Ok(())
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
    fn last_session_error_finds_latest_failure() {
        let file = std::env::temp_dir().join(format!("pix-last-error-{}.jsonl", uuid::Uuid::new_v4()));
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
        assert_eq!(lines.next().unwrap(), "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":\"hi old-id\"}}");
        assert!(lines.next().is_none());
        assert!(copy.ends_with('\n'));
        assert!(duplicate_content("{\"type\":\"message\"}\n", "t", "i").is_err());
        assert!(duplicate_content("", "t", "i").is_err());
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
    fn meta_cache_serves_same_mtime_and_invalidates_on_write() {
        let file = std::env::temp_dir().join(format!("pix-cache-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&file, "{\"type\":\"session\",\"cwd\":\"/tmp\",\"id\":\"cache-test\"}\n").unwrap();
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
        );
        std::fs::write(&file, content).unwrap();
        let messages = read_session_history(&file).unwrap();
        let roles: Vec<&str> = messages.iter().filter_map(|m| m["role"].as_str()).collect();
        assert_eq!(roles, ["user", "assistant", "compactionSummary", "user", "assistant"]);
        assert_eq!(messages[0]["content"], "first");
        assert_eq!(messages[2]["summary"], "collapsed");
        assert_eq!(messages[2]["tokensBefore"], 222767);
        assert_eq!(messages[2]["timestamp"], 1790421602479i64);
        assert_eq!(messages[2]["firstKeptEntryId"], "m2");
        assert_eq!(messages[0]["_entryId"], "m1");
        assert_eq!(messages[3]["content"], "second");
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
