//! Scan `~/.pi/agent/sessions/` for session files belonging to a project.
//!
//! Layout: `<agent-dir>/sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`.
//! The encoding of the cwd in directory names is an implementation detail of
//! pi, so we don't reconstruct it — instead we read each file's first line
//! (the session header JSON) and filter by its `cwd` field.

use crate::trust::agent_dir;
use dunce::canonicalize;
use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const MAX_SESSIONS: usize = 50;
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
            let Some(line) = first_line(&path) else { continue };
            let Ok(header) = serde_json::from_str::<serde_json::Value>(&line) else { continue };
            if header.get("type").and_then(|t| t.as_str()) != Some("session") {
                continue;
            }
            let cwd = header
                .get("cwd")
                .and_then(|c| c.as_str())
                .unwrap_or_default()
                .to_string();
            let cwd_norm = normalize(Path::new(&cwd)).unwrap_or_else(|| cwd.clone());
            if cwd_norm != project_norm {
                continue;
            }
            let id = header
                .get("id")
                .and_then(|i| i.as_str())
                .unwrap_or_default()
                .to_string();
            let timestamp = header
                .get("timestamp")
                .and_then(|t| t.as_str())
                .map(String::from);
            let preview = first_user_preview(&path);
            let presentation = {
                let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
                read_presentation(&path)?
            };
            out.push(SessionMeta {
                file: path.to_string_lossy().to_string(),
                id,
                cwd,
                timestamp,
                mtime_ms: mtime,
                preview,
                title: presentation.title,
                archived: presentation.archived,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| format!("session scan failed: {e}"))?
}


// UI metadata is separate from pi's append-only conversation log.
#[derive(serde::Deserialize, Serialize, Default)]
pub struct Presentation {
    pub title: Option<String>,
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
pub async fn session_update(file: String, title: Option<String>, archived: bool) -> Result<(), String> {
    let path = canonicalize(&file).map_err(|e| e.to_string())?;
    let root = canonicalize(agent_dir().join("sessions")).map_err(|e| e.to_string())?;
    if !path.starts_with(root) || path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
        return Err("无效的会话路径".into());
    }
    if std::fs::symlink_metadata(path.with_extension("pix.json")).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("无效的会话元数据路径".into());
    }
    update_presentation(&path, title, archived)
}

fn update_presentation(path: &Path, title: Option<String>, archived: bool) -> Result<(), String> {
    let _guard = PRESENTATION_LOCK.lock().map_err(|e| e.to_string())?;
    let mut presentation = read_presentation(path)?;
    let title = title.map(|t| t.trim().chars().take(120).collect::<String>()).filter(|t| !t.is_empty());
    if title.is_some() { presentation.title = title; }
    presentation.archived = archived;
    write_presentation(&path, &presentation)
}


#[cfg(test)]
mod presentation_tests {
    use super::*;
    #[test]
    fn rename_archive_restore() {
        let dir = std::env::temp_dir().join(format!("pix-metadata-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let file = dir.join("session.jsonl");
        let original = "{\"type\":\"session\"}\n";
        std::fs::write(&file, original).unwrap();
        assert!(!read_presentation(&file).unwrap().archived);
        update_presentation(&file, Some("  新标题  ".into()), false).unwrap();
        assert_eq!(read_presentation(&file).unwrap().title.as_deref(), Some("新标题"));
        update_presentation(&file, None, true).unwrap();
        let archived = read_presentation(&file).unwrap();
        assert!(archived.archived);
        assert_eq!(archived.title.as_deref(), Some("新标题"));
        update_presentation(&file, None, false).unwrap();
        assert!(!read_presentation(&file).unwrap().archived);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), original);
        std::fs::remove_file(file.with_extension("pix.json")).unwrap();
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
