//! Session-file surgery driven by the live pi process: prompt rewind and
//! serialized session renaming. These are sessions-domain operations (they
//! rewrite or rename the JSONL log) but must go through the running runtime's
//! RPC transport, so they take [`crate::rpc::ProcessState`] and only use its
//! transport/navigation accessors — no reverse dependency on storage details.

use crate::rpc::ProcessState;
use serde_json::{json, Value};
use std::collections::HashMap;
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
    let messages = transport
        .request(json!({"type": "get_fork_messages"}))
        .await?;
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
    // Read the live selection before the log is rewritten: the switch_session
    // below restores the model from the branch, so the rewind has to carry it.
    let live = LiveSelection::from_state(data);
    let revised = rewind_log(&original, &target, &live)?;
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
    crate::atomic_write::write(Path::new(file), content.as_bytes()).map_err(|e| e.to_string())
}

/// pi's live selection at rewind time (the `get_state` model and thinking level).
///
/// Editing drops the question's subtree, and switches the user made **while
/// editing** were recorded in exactly that subtree as `model_change` /
/// `thinking_level_change` entries. pi reloads the rewinded log through
/// `switch_session`, which restores the model and thinking level from the branch
/// (pi's `getBranchSelection` / `getSessionContextSettings`). Without re-recording
/// the live selection the resent question would be answered by the *old* model
/// while the picker had already shown the new one.
#[derive(Default)]
struct LiveSelection {
    /// `(provider, model id)` of the running session; absent when pi reports none.
    model: Option<(String, String)>,
    thinking: Option<String>,
}

impl LiveSelection {
    fn from_state(state: &Value) -> Self {
        let model = match (
            state["model"]["provider"].as_str(),
            state["model"]["id"].as_str(),
        ) {
            (Some(provider), Some(id)) if !provider.is_empty() && !id.is_empty() => {
                Some((provider.to_owned(), id.to_owned()))
            }
            _ => None,
        };
        Self {
            model,
            thinking: state["thinkingLevel"].as_str().map(str::to_owned),
        }
    }
}

/// The branch a reloaded log ends on, walked from `leaf` through `parentId`.
fn branch_entries<'a>(kept: &[&'a Value], leaf: &str) -> Vec<&'a Value> {
    let mut by_id: HashMap<&str, &Value> = HashMap::new();
    for item in kept {
        if let Some(id) = item["id"].as_str() {
            by_id.insert(id, item);
        }
    }
    let mut path = Vec::new();
    let mut cursor = Some(leaf.to_owned());
    let mut seen = std::collections::HashSet::new();
    while let Some(id) = cursor {
        // Cycle guard: a hand-edited log must not loop forever.
        if !seen.insert(id.clone()) {
            break;
        }
        let Some(item) = by_id.get(id.as_str()) else {
            break;
        };
        path.push(*item);
        cursor = item["parentId"].as_str().map(str::to_owned);
    }
    path
}

/// Which model pi would restore from this branch: the newest `model_change`
/// after the newest physical answer wins, otherwise the answer's own model (pi's
/// `getBranchSelection`; virtual answers name a routed physical model and are
/// skipped there, so they are skipped here too).
fn branch_model(path: &[&Value]) -> Option<(String, String)> {
    for item in path {
        match item["type"].as_str() {
            Some("model_change") => {
                if let (Some(provider), Some(model_id)) =
                    (item["provider"].as_str(), item["modelId"].as_str())
                {
                    return Some((provider.to_owned(), model_id.to_owned()));
                }
            }
            Some("message") => {
                let message = &item["message"];
                if message["role"].as_str() == Some("assistant")
                    && message["api"].as_str() != Some("pi-virtual")
                {
                    if let (Some(provider), Some(model)) =
                        (message["provider"].as_str(), message["model"].as_str())
                    {
                        return Some((provider.to_owned(), model.to_owned()));
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn branch_thinking(path: &[&Value]) -> Option<String> {
    path.iter().find_map(|item| {
        (item["type"] == "thinking_level_change")
            .then(|| item["thinkingLevel"].as_str().map(str::to_owned))
            .flatten()
    })
}

fn rewind_log(raw: &str, target: &str, live: &LiveSelection) -> Result<String, String> {
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
    let mut kept: Vec<&Value> = Vec::new();
    // A thinking record inside the dropped subtree is the only way the branch
    // loses it; without any record pi falls back to its settings default, which
    // is what it would use anyway.
    let mut dropped_thinking = false;
    for item in &entries {
        if item["id"].as_str().is_some_and(|id| removed.contains(id))
            || item["parentId"]
                .as_str()
                .is_some_and(|id| removed.contains(id))
        {
            if item["type"] == "thinking_level_change" {
                dropped_thinking = true;
            }
            if let Some(id) = item["id"].as_str() {
                removed.insert(id.to_owned());
            }
            continue;
        }
        kept.push(item);
    }
    // The last record selects the original parent, without keeping abandoned answers
    // in the active context. Other branches in the file remain intact.
    let timestamp = entry["timestamp"].clone();
    let marker_id = format!("edit-{}", uuid::Uuid::new_v4());
    let marker = json!({"type": "custom", "id": marker_id, "parentId": entry["parentId"],
        "timestamp": timestamp, "customType": "pix-edit-position", "data": {}});
    // Re-record the live selection under the marker when the surviving branch
    // would restore something else. The marker is itself a custom entry and is
    // always the file's last record, so its branch is the kept ancestors of the
    // edited question's parent; switches made while editing sat below that
    // question and are gone with it.
    let parent = entry["parentId"].as_str().unwrap_or_default().to_owned();
    let path = branch_entries(&kept, &parent);
    let mut appended: Vec<Value> = Vec::new();
    // Each re-recorded selection hangs off the previous one, so the file ends
    // with the newest record as leaf.
    let mut parent_id = marker_id.clone();
    if let Some((provider, model_id)) = &live.model {
        if branch_model(&path).as_ref() != Some(&(provider.clone(), model_id.clone())) {
            let id = format!("edit-model-{}", uuid::Uuid::new_v4());
            appended.push(
                json!({"type": "model_change", "id": id, "parentId": parent_id,
                "timestamp": timestamp, "provider": provider, "modelId": model_id}),
            );
            parent_id = id;
        }
    }
    if let Some(level) = &live.thinking {
        // A branch with no record leaves the level to the settings default, which
        // is only wrong when the edit dropped a level the user had just picked.
        let recorded = branch_thinking(&path);
        if recorded.as_deref() != Some(level.as_str()) && (recorded.is_some() || dropped_thinking) {
            let id = format!("edit-thinking-{}", uuid::Uuid::new_v4());
            appended.push(
                json!({"type": "thinking_level_change", "id": id, "parentId": parent_id,
                "timestamp": timestamp, "thinkingLevel": level}),
            );
        }
    }
    let mut output = String::new();
    for item in &kept {
        output.push_str(&item.to_string());
        output.push('\n');
    }
    output.push_str(&marker.to_string());
    output.push('\n');
    for item in &appended {
        output.push_str(&item.to_string());
        output.push('\n');
    }
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
        let result = rewind_log(&raw, "question", &LiveSelection::default()).unwrap();
        let entries: Vec<Value> = result
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[2]["id"], "sibling");
        assert_eq!(entries[3]["parentId"], "before");
        assert!(rewind_log(&raw, "missing", &LiveSelection::default()).is_err());
        assert!(rewind_log(&raw, "answer", &LiveSelection::default()).is_err());
    }

    /// The reported TZD-146 bug: switching the model while editing records the
    /// switch below the edited question, so the rewind dropped it and pi restored
    /// the previous model after `switch_session` while the picker still showed
    /// the newly selected one.
    #[test]
    fn rewind_keeps_the_model_selected_while_editing() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"q0","parentId":null,"message":{"role":"user"}}),
            json!({"type":"message","id":"a0","parentId":"q0","message":{"role":"assistant","provider":"p1","model":"m1","api":"openai"}}),
            json!({"type":"model_change","id":"mc0","parentId":"a0","provider":"p2","modelId":"m2"}),
            json!({"type":"message","id":"q1","parentId":"mc0","message":{"role":"user"}}),
            json!({"type":"message","id":"a1","parentId":"q1","message":{"role":"assistant","provider":"p2","model":"m2","api":"openai"}}),
            json!({"type":"model_change","id":"mc1","parentId":"a1","provider":"p3","modelId":"m3"}),
            json!({"type":"thinking_level_change","id":"tl1","parentId":"mc1","thinkingLevel":"high"}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let live = LiveSelection {
            model: Some(("p3".into(), "m3".into())),
            thinking: Some("high".into()),
        };
        let result = rewind_log(&raw, "q1", &live).unwrap();
        let kept: Vec<Value> = result
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        // The edited question and its answer are gone.
        assert!(!kept
            .iter()
            .any(|entry| entry["id"] == "q1" || entry["id"] == "a1"));
        // The live selection survives the rewind: pi restores it from the branch.
        let leaf = kept.last().unwrap()["id"].as_str().unwrap().to_owned();
        let branch = branch_entries(&kept.iter().collect::<Vec<_>>(), &leaf);
        assert_eq!(branch_model(&branch), Some(("p3".into(), "m3".into())));
        assert_eq!(branch_thinking(&branch), Some("high".into()));
    }

    #[test]
    fn rewind_does_not_rerecord_a_selection_the_branch_already_keeps() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"q0","parentId":null,"message":{"role":"user"}}),
            json!({"type":"message","id":"a0","parentId":"q0","message":{"role":"assistant","provider":"p1","model":"m1","api":"openai"}}),
            json!({"type":"model_change","id":"mc0","parentId":"a0","provider":"p2","modelId":"m2"}),
            json!({"type":"thinking_level_change","id":"tl0","parentId":"mc0","thinkingLevel":"low"}),
            json!({"type":"message","id":"q1","parentId":"tl0","message":{"role":"user"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let live = LiveSelection {
            model: Some(("p2".into(), "m2".into())),
            thinking: Some("low".into()),
        };
        let result = rewind_log(&raw, "q1", &live).unwrap();
        let appended = result
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|entry| {
                entry["type"] == "model_change" || entry["type"] == "thinking_level_change"
            })
            .count();
        assert_eq!(appended, 2, "only the branch's own records: {result}");
    }

    #[test]
    fn live_selection_is_read_from_get_state() {
        let state = json!({
            "model": {"provider": "p", "id": "m", "name": "M"},
            "thinkingLevel": "medium",
            "sessionFile": "s.jsonl"
        });
        let live = LiveSelection::from_state(&state);
        assert_eq!(live.model, Some(("p".into(), "m".into())));
        assert_eq!(live.thinking, Some("medium".into()));
        // A session without a model must not fabricate a switch record.
        let empty = LiveSelection::from_state(&json!({"model": null}));
        assert_eq!(empty.model, None);
        assert_eq!(empty.thinking, None);
    }
}
