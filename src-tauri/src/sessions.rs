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
