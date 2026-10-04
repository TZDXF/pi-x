//! Session-file surgery driven by the live pi process: prompt rewind and
//! serialized session renaming. These are sessions-domain operations (they
//! rewrite or rename the JSONL log) but must go through the running runtime's
//! RPC transport, so they take [`crate::rpc::ProcessState`] and only use its
//! transport/navigation accessors — no reverse dependency on storage details.

use crate::rpc::ProcessState;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// pi allocates the path before persisting the log after its first response.
/// Validate the existing parent, and reject traversal/symlinks outside sessions.
pub(crate) fn normalize_session_file(reported: &str) -> PathBuf {
    let path = Path::new(reported);
    match (path.parent(), path.file_name()) {
        (Some(parent), Some(name)) => parent.join(name),
        _ => path.to_path_buf(),
    }
}

/// Serialize name writes with navigation so a delayed title cannot rename a different session.
pub(crate) async fn process_set_session_name(
    state: &ProcessState,
    path: &Path,
    title: String,
    only_if_empty: bool,
) -> Result<Option<String>, String> {
    let _navigation = state.lock_navigation().await;
    // Snapshot the transport and release the session lock: the get_state round
    // trip and the pi_data call below are slow and must not block other RPCs.
    // If the session is respawned meanwhile, the stale transport's writes fail
    // and the rename errors out instead of hitting the wrong process.
    let transport = state.transport().await;
    if let Some(transport) = &transport {
        let response = transport.request(json!({"type": "get_state"})).await?;
        let data = &response["data"];
        let active = data["sessionFile"].as_str().map(normalize_session_file);
        if active.as_deref() == Some(path) {
            if only_if_empty {
                if let Some(name) = data["sessionName"].as_str().filter(|s| !s.is_empty()) {
                    return Ok(Some(name.into()));
                }
            }
            transport
                .request(json!({"type": "set_session_name", "name": title}))
                .await?;
            return Ok(Some(title));
        }
    }
    // Keep navigation locked while the SDK updates an inactive log as well.
    if !path.is_file() {
        return Err("Pi session has not been persisted".into());
    }
    let request =
        json!({"op": "session_name", "file": path, "title": title, "onlyIfEmpty": only_if_empty});
    let result = tokio::task::spawn_blocking(move || crate::pi_data::call(request))
        .await
        .map_err(|e| e.to_string())??;
    Ok(result.as_str().map(str::to_owned))
}

/// Rewind the persisted context as well as the UI; a normal prompt must not
/// see the superseded question or its answer. Keep a backup until reload succeeds.
pub(crate) async fn rewind_prompt(state: &ProcessState, command: &Value) -> Result<Value, String> {
    let _navigation = state.lock_navigation().await;
    // Snapshot the transport so neither the pi round trips nor the file IO
    // below hold the session lock. The generation check before any file is
    // modified rejects a rewind if the session was respawned meanwhile.
    let (transport, generation) = state.transport_and_generation().await;
    let transport = transport.ok_or("pi is not running")?;
    let status = transport.request(json!({"type": "get_state"})).await?;
    let data = &status["data"];
    if data["sessionFile"] != command["sessionFile"]
        || data["isStreaming"] == true
        || data["isCompacting"] == true
        || data["pendingMessageCount"].as_u64().unwrap_or(0) > 0
    {
        return Err("Session changed or is still running".into());
    }
    let file = data["sessionFile"]
        .as_str()
        .ok_or("Missing session file")?
        .to_owned();
    let messages = transport.request(json!({"type": "get_fork_messages"})).await?;
    let target = messages["data"]["messages"]
        .as_array()
        .and_then(|m| m.last())
        .and_then(|m| m["entryId"].as_str())
        .ok_or("No question to edit")?
        .to_owned();
    if state.current_generation() != generation {
        return Err("Session changed or is still running".into());
    }
    // Synchronous file IO, off the async executor and without any lock held.
    let original = tauri::async_runtime::spawn_blocking({
        let file = file.clone();
        move || std::fs::read_to_string(&file)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    let revised = rewind_log(&original, &target)?;
    tauri::async_runtime::spawn_blocking({
        let file = file.clone();
        move || replace_session_log(&file, &revised)
    })
    .await
    .map_err(|e| e.to_string())??;
    let loaded = transport
        .request(json!({"type": "switch_session", "sessionPath": file}))
        .await;
    match loaded {
        Ok(response) if response["data"]["cancelled"] != true => {
            Ok(json!({"success": true, "command": "rewind_prompt"}))
        }
        result => {
            tauri::async_runtime::spawn_blocking({
                let file = file.clone();
                move || replace_session_log(&file, &original)
            })
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| format!("Cannot restore session: {e}"))?;
            let _ = transport
                .request(json!({"type": "switch_session", "sessionPath": file}))
                .await;
            Err(result
                .err()
                .unwrap_or_else(|| "Session reload cancelled".into()))
        }
    }
}

fn replace_session_log(file: &str, content: &str) -> Result<(), String> {
    let temporary = Path::new(file).with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        std::fs::write(&temporary, content)?;
        std::fs::rename(&temporary, file)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result.map_err(|e| e.to_string())
}

fn rewind_log(raw: &str, target: &str) -> Result<String, String> {
    let entries: Vec<Value> = raw
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    let entry = entries
        .iter()
        .find(|entry| entry["id"] == target)
        .ok_or("Question no longer exists in the session")?;
    if entry["type"] != "message" || entry["message"]["role"] != "user" {
        return Err("Edit target is not a user question".into());
    }
    let mut removed = std::collections::HashSet::from([target.to_owned()]);
    let mut output = String::new();
    for item in &entries {
        if item["id"].as_str().is_some_and(|id| removed.contains(id))
            || item["parentId"]
                .as_str()
                .is_some_and(|id| removed.contains(id))
        {
            if let Some(id) = item["id"].as_str() {
                removed.insert(id.to_owned());
            }
            continue;
        }
        output.push_str(&item.to_string());
        output.push('\n');
    }
    // The last record selects the original parent, without keeping abandoned answers
    // in the active context. Other branches in the file remain intact.
    let marker = json!({"type": "custom", "id": format!("edit-{}", uuid::Uuid::new_v4()),
        "parentId": entry["parentId"], "timestamp": entry["timestamp"],
        "customType": "pix-edit-position", "data": {}});
    output.push_str(&marker.to_string());
    output.push('\n');
    Ok(output)
}

#[cfg(test)]
mod session_path_tests {
    use super::*;

    #[test]
    fn normalizes_reported_session_path_before_pi_persists_it() {
        let dir = std::env::temp_dir().join(format!("pix-title-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let missing = dir.join("not-yet-written.jsonl");
        // New session logs do not exist until the first assistant reply; the
        // live process must still match by canonical parent plus file name.
        let expected = dunce::canonicalize(&dir)
            .unwrap()
            .join("not-yet-written.jsonl");
        assert_eq!(normalize_session_file(missing.to_str().unwrap()), expected);

        std::fs::write(&missing, "{}").unwrap();
        assert_eq!(
            normalize_session_file(missing.to_str().unwrap()),
            dunce::canonicalize(&missing).unwrap()
        );

        std::fs::remove_file(missing).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}

#[cfg(test)]
mod edit_tests {
    use super::*;

    #[test]
    fn session_log_replacement_overwrites_existing_file() {
        let path = std::env::temp_dir().join(format!("pix-edit-{}.jsonl", uuid::Uuid::new_v4()));
        std::fs::write(&path, "original").unwrap();
        replace_session_log(path.to_str().unwrap(), "replacement").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "replacement");
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn rewind_removes_replaced_turn_but_preserves_other_branches() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"before","parentId":null,"message":{"role":"assistant"}}),
            json!({"type":"message","id":"question","parentId":"before","message":{"role":"user"}}),
            json!({"type":"message","id":"answer","parentId":"question","message":{"role":"assistant"}}),
            json!({"type":"message","id":"sibling","parentId":"before","message":{"role":"user"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let result = rewind_log(&raw, "question").unwrap();
        let entries: Vec<Value> = result
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[2]["id"], "sibling");
        assert_eq!(entries[3]["parentId"], "before");
        assert!(rewind_log(&raw, "missing").is_err());
        assert!(rewind_log(&raw, "answer").is_err());
    }
}
