//! Full-text search across stored Pi session JSONL files.
//!
//! Only user/assistant text is searched. System prompts, tool calls and tool
//! output are deliberately excluded so a query finds conversation content,
//! not implementation details embedded in a session recording.

use crate::sessions::{read_session_meta, SessionMeta};
use crate::trust::agent_dir;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::UNIX_EPOCH;

pub const MAX_SESSION_SEARCH_RESULTS: usize = 100;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionSearchHit {
    pub session: SessionMeta,
    pub role: Option<String>,
    pub snippet: Option<String>,
    /// Number of messages containing the query. Title-only matches are zero.
    pub match_count: usize,
}

#[tauri::command]
pub async fn session_search(query: String) -> Result<Vec<SessionSearchHit>, String> {
    tokio::task::spawn_blocking(move || search_root(&agent_dir().join("sessions"), &query))
        .await
        .map_err(|e| format!("session search failed: {e}"))?
}

fn search_root(root: &Path, query: &str) -> Result<Vec<SessionSearchHit>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file()
                && path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
            {
                files.push(path);
            }
        }
    }

    let mut hits = files
        .iter()
        .filter_map(|path| search_file(path, &query).ok().flatten())
        .collect::<Vec<_>>();
    hits.sort_by(|a, b| {
        b.session
            .mtime_ms
            .cmp(&a.session.mtime_ms)
            .then_with(|| a.session.file.cmp(&b.session.file))
    });
    hits.truncate(MAX_SESSION_SEARCH_RESULTS);
    Ok(hits)
}

fn search_file(path: &Path, query: &str) -> Result<Option<SessionSearchHit>, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(file).lines();
    let header = lines
        .next()
        .ok_or_else(|| "empty session file".to_string())?
        .map_err(|e| e.to_string())?;
    let header: Value = serde_json::from_str(&header).map_err(|e| e.to_string())?;
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Ok(None);
    }

    let mut title = None;
    let mut role = None;
    let mut snippet = None;
    let mut match_count = 0;
    for line in lines {
        let Ok(line) = line else { continue };
        let Ok(entry) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        match entry.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                title = entry
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|name| !name.is_empty())
                    .map(String::from);
            }
            Some("message") => {
                let Some(message) = entry.get("message") else {
                    continue;
                };
                let Some(message_role) = message.get("role").and_then(Value::as_str) else {
                    continue;
                };
                if message_role != "user" && message_role != "assistant" {
                    continue;
                }
                let mut matched = false;
                match message.get("content") {
                    Some(Value::String(text)) => {
                        matched =
                            record_text_match(text, query, message_role, &mut role, &mut snippet);
                    }
                    Some(Value::Array(blocks)) => {
                        for text in blocks.iter().filter_map(|block| {
                            (block.get("type").and_then(Value::as_str) == Some("text"))
                                .then(|| block.get("text").and_then(Value::as_str))
                                .flatten()
                        }) {
                            matched |= record_text_match(
                                text,
                                query,
                                message_role,
                                &mut role,
                                &mut snippet,
                            );
                        }
                    }
                    _ => {}
                }
                if matched {
                    match_count += 1;
                }
            }
            _ => {}
        }
    }

    let id_matches = header
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|id| id.to_lowercase().contains(query));
    let title_matches = title
        .as_deref()
        .is_some_and(|name| name.to_lowercase().contains(query));
    if match_count == 0 && !id_matches && !title_matches {
        return Ok(None);
    }
    let mtime = std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let session = read_session_meta(path, mtime)?;
    Ok(Some(SessionSearchHit {
        session,
        role,
        snippet,
        match_count,
    }))
}

fn record_text_match(
    text: &str,
    query: &str,
    message_role: &str,
    role: &mut Option<String>,
    snippet: &mut Option<String>,
) -> bool {
    let Some(found) = make_snippet(text, query) else {
        return false;
    };
    if snippet.is_none() {
        *snippet = Some(found);
        *role = Some(message_role.to_string());
    }
    true
}

fn make_snippet(text: &str, folded_query: &str) -> Option<String> {
    let folded = text.to_lowercase();
    let byte_index = folded.find(folded_query)?;
    let match_start = folded[..byte_index].chars().count();
    let chars = text.chars().collect::<Vec<_>>();
    let start = match_start.saturating_sub(48).min(chars.len());
    let end = (match_start + folded_query.chars().count() + 88).min(chars.len());
    let mut snippet = String::new();
    if start > 0 {
        snippet.push('…');
    }
    snippet.extend(
        chars[start..end]
            .iter()
            .map(|c| if c.is_whitespace() { ' ' } else { *c }),
    );
    if end < chars.len() {
        snippet.push('…');
    }
    Some(snippet.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_root() -> PathBuf {
        let root = std::env::temp_dir().join(format!("pix-search-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        root
    }

    #[test]
    fn searches_all_nested_sessions_and_message_text_case_insensitively() {
        let root = fixture_root();
        let file = root.join("nested").join("one.jsonl");
        std::fs::write(
            &file,
            concat!(
                "{\"type\":\"session\",\"cwd\":\"/project\",\"id\":\"one\",\"timestamp\":\"2026-01-01T00:00:00Z\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"system\",\"content\":\"Needle in system\"}}\n",
                "not json\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"先看这里\"},{\"type\":\"text\",\"text\":\"A Needle in Unicode 内容\"}]}}\n",
                "{\"type\":\"session_info\",\"name\":\"A conversation\"}\n"
            ),
        )
        .unwrap();
        std::fs::write(
            root.join("other.jsonl"),
            concat!(
                "{\"type\":\"session\",\"cwd\":\"/other\",\"id\":\"other\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"nothing here\"}}\n"
            ),
        )
        .unwrap();

        let hits = search_root(&root, "needle").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].session.id, "one");
        assert_eq!(hits[0].role.as_deref(), Some("user"));
        assert_eq!(hits[0].match_count, 1);
        assert!(hits[0].snippet.as_deref().unwrap().contains("Needle"));
        assert!(search_root(&root, "system").unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn title_and_id_match_without_a_content_snippet() {
        let root = fixture_root();
        std::fs::write(
            root.join("nested").join("one.jsonl"),
            concat!(
                "{\"type\":\"session\",\"cwd\":\"/project\",\"id\":\"Alpha-42\"}\n",
                "{\"type\":\"session_info\",\"name\":\"跨会话检索\"}\n",
                "{\"type\":\"message\",\"message\":{\"role\":\"assistant\",\"content\":\"done\"}}\n"
            ),
        )
        .unwrap();
        for query in ["跨会话", "alpha"] {
            let hits = search_root(&root, query).unwrap();
            assert_eq!(hits.len(), 1);
            assert_eq!(hits[0].match_count, 0);
            assert!(hits[0].snippet.is_none());
        }
        assert!(search_root(&root, " ").unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snippet_handles_unicode_and_collapses_whitespace() {
        let snippet = make_snippet("前缀\n需要保留的 Needle\t后缀", "needle").unwrap();
        assert_eq!(snippet, "前缀 需要保留的 Needle 后缀");
        assert_eq!(make_snippet("nothing", "needle"), None);
    }
}
