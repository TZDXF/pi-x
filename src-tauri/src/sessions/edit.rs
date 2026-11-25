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
    // pi restores a virtual selection only while it is still registered, so the
    // rewind has to know the catalog. A failed lookup falls back to treating any
    // older `model_change` as possibly virtual (see `branch_model`).
    let virtual_models = match transport
        .request(json!({"type": "get_available_models"}))
        .await
    {
        Ok(response) => virtual_models_from_catalog(&response),
        Err(error) => {
            crate::logs::write(
                "sessions",
                &format!("rewind catalog lookup failed: {error}"),
            );
            None
        }
    };
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
    let revised = rewind_log(&original, &target, &live, &virtual_models)?;
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

/// Which model pi would restore from this branch, following pi's
/// `getBranchSelection` exactly:
///
/// - the newest `model_change` wins outright;
/// - a `model_change` older than the newest physical answer only wins when it
///   names a model pi still registers as virtual (`api: pi-virtual`), because
///   routed responses name the physical model that answered, not the selection;
/// - otherwise the newest physical answer's own model is the selection.
///
/// `virtual_models` is `None` when the catalog could not be read. Any
/// preceding `model_change` is then treated as possibly virtual: re-recording the
/// live selection is harmless (it names the same model pi already runs), while
/// guessing "physical" would drop the user's switch and reintroduce TZD-146.
fn branch_model(path: &[&Value], virtual_models: &VirtualModels) -> Option<(String, String)> {
    for (index, item) in path.iter().enumerate() {
        if let Some(change) = model_change_key(item) {
            return Some(change);
        }
        if item["type"] != "message" {
            continue;
        }
        let message = &item["message"];
        if message["role"].as_str() != Some("assistant")
            || message["api"].as_str() == Some("pi-virtual")
        {
            continue;
        }
        let response = match (message["provider"].as_str(), message["model"].as_str()) {
            (Some(provider), Some(model)) => (provider.to_owned(), model.to_owned()),
            _ => continue,
        };
        // `path` runs leaf→root, so older entries are the ones after this index
        // and the first match is the newest `model_change` before the answer.
        let change = path[index + 1..]
            .iter()
            .find_map(|item| model_change_key(item));
        return match change {
            Some(change)
                if virtual_models
                    .as_ref()
                    .is_none_or(|set| set.contains(&change)) =>
            {
                Some(change)
            }
            _ => Some(response),
        };
    }
    None
}

fn model_change_key(item: &Value) -> Option<(String, String)> {
    if item["type"] != "model_change" {
        return None;
    }
    match (item["provider"].as_str(), item["modelId"].as_str()) {
        (Some(provider), Some(model_id)) => Some((provider.to_owned(), model_id.to_owned())),
        _ => None,
    }
}

fn branch_thinking(path: &[&Value]) -> Option<String> {
    path.iter().find_map(|item| {
        (item["type"] == "thinking_level_change")
            .then(|| item["thinkingLevel"].as_str().map(str::to_owned))
            .flatten()
    })
}

/// Provider/model keys pi still registers as virtual (`api: pi-virtual`), read
/// from `get_available_models`. `None` means the catalog was unavailable.
type VirtualModels = Option<std::collections::HashSet<(String, String)>>;

fn virtual_models_from_catalog(response: &Value) -> VirtualModels {
    let models = response["data"]["models"].as_array()?;
    Some(
        models
            .iter()
            .filter(|model| model["api"].as_str() == Some("pi-virtual"))
            .filter_map(|model| {
                Some((
                    model["provider"].as_str()?.to_owned(),
                    model["id"].as_str()?.to_owned(),
                ))
            })
            .collect(),
    )
}

fn rewind_log(
    raw: &str,
    target: &str,
    live: &LiveSelection,
    virtual_models: &VirtualModels,
) -> Result<String, String> {
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
        if branch_model(&path, virtual_models).as_ref()
            != Some(&(provider.clone(), model_id.clone()))
        {
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

    /// A catalog without virtual models: pi restores the newest physical answer.
    fn physical_only() -> VirtualModels {
        Some(std::collections::HashSet::new())
    }

    /// The `pix-edit-position` marker this rewind wrote, i.e. the branch that
    /// existed before the appended switch records.
    fn marker_of(kept: &[Value]) -> String {
        kept.iter()
            .find(|entry| entry["customType"] == "pix-edit-position")
            .and_then(|entry| entry["id"].as_str())
            .expect("rewind marker")
            .to_owned()
    }

    fn virtual_set(models: &[(&str, &str)]) -> VirtualModels {
        Some(
            models
                .iter()
                .map(|(provider, id)| (provider.to_string(), id.to_string()))
                .collect(),
        )
    }

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
        let result = rewind_log(
            &raw,
            "question",
            &LiveSelection::default(),
            &physical_only(),
        )
        .unwrap();
        let entries: Vec<Value> = result
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(entries.len(), 4);
        assert_eq!(entries[2]["id"], "sibling");
        assert_eq!(entries[3]["parentId"], "before");
        assert!(rewind_log(&raw, "missing", &LiveSelection::default(), &physical_only()).is_err());
        assert!(rewind_log(&raw, "answer", &LiveSelection::default(), &physical_only()).is_err());
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
        let result = rewind_log(&raw, "q1", &live, &physical_only()).unwrap();
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
        assert_eq!(
            branch_model(&branch, &physical_only()),
            Some(("p3".into(), "m3".into()))
        );
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
        let result = rewind_log(&raw, "q1", &live, &physical_only()).unwrap();
        let appended = result
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .filter(|entry| {
                entry["type"] == "model_change" || entry["type"] == "thinking_level_change"
            })
            .count();
        assert_eq!(appended, 2, "only the branch's own records: {result}");
    }

    /// Review regression 1 (TZD-146): a virtual selection keeps holding after the
    /// routed response names the physical model, so the surviving branch restores
    /// `router/auto` even though the last answer came from `openai/gpt`. Switching
    /// to that same physical model while editing must still be re-recorded, or pi
    /// reloads the virtual selection and the answer uses the wrong model again.
    #[test]
    fn virtual_branch_rerecords_a_physical_model_selected_while_editing() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"q0","parentId":null,"message":{"role":"user"}}),
            json!({"type":"message","id":"a0","parentId":"q0","message":{"role":"assistant","provider":"p1","model":"m1","api":"openai"}}),
            json!({"type":"model_change","id":"mc0","parentId":"a0","provider":"router","modelId":"auto"}),
            json!({"type":"message","id":"q1","parentId":"mc0","message":{"role":"user"}}),
            // Routed answer: names the physical model, not the virtual selection.
            json!({"type":"message","id":"a1","parentId":"q1","message":{"role":"assistant","provider":"openai","model":"gpt","api":"openai"}}),
            // Switch made while editing; it lives below q1 and the rewind drops it.
            json!({"type":"model_change","id":"mc1","parentId":"a1","provider":"openai","modelId":"gpt"}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let live = LiveSelection {
            model: Some(("openai".into(), "gpt".into())),
            thinking: None,
        };
        let virtuals = virtual_set(&[("router", "auto")]);
        let result = rewind_log(&raw, "q1", &live, &virtuals).unwrap();
        let kept: Vec<Value> = result
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let leaf = kept.last().unwrap()["id"].as_str().unwrap().to_owned();
        let branch = branch_entries(&kept.iter().collect::<Vec<_>>(), &leaf);
        // The rewind dropped `mc1` and appended exactly one switch record.
        let appended: Vec<&Value> = kept
            .iter()
            .filter(|entry| {
                entry["id"]
                    .as_str()
                    .is_some_and(|id| id.starts_with("edit-model-"))
            })
            .collect();
        assert_eq!(appended.len(), 1, "one re-recorded model_change: {result}");
        assert_eq!(appended[0]["provider"], "openai");
        assert_eq!(appended[0]["modelId"], "gpt");
        // pi now restores the physical model the user picked while editing...
        assert_eq!(
            branch_model(&branch, &virtuals),
            Some(("openai".into(), "gpt".into()))
        );
        // ...instead of the virtual selection the marker alone would keep.
        let marker_branch = branch_entries(&kept.iter().collect::<Vec<_>>(), &marker_of(&kept));
        assert_eq!(
            branch_model(&marker_branch, &virtuals),
            Some(("router".into(), "auto".into()))
        );
    }

    /// Review regression 2: when the user did not switch while editing, the virtual
    /// selection still holds and pi restores it — nothing may be re-recorded.
    #[test]
    fn virtual_selection_that_still_holds_is_not_rerecorded() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"q0","parentId":null,"message":{"role":"user"}}),
            json!({"type":"message","id":"a0","parentId":"q0","message":{"role":"assistant","provider":"p1","model":"m1","api":"openai"}}),
            json!({"type":"model_change","id":"mc0","parentId":"a0","provider":"router","modelId":"auto"}),
            json!({"type":"message","id":"a1","parentId":"mc0","message":{"role":"assistant","provider":"openai","model":"gpt","api":"openai"}}),
            json!({"type":"message","id":"q1","parentId":"a1","message":{"role":"user"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        // get_state reports the virtual selection the session still runs on.
        let live = LiveSelection {
            model: Some(("router".into(), "auto".into())),
            thinking: None,
        };
        let virtuals = virtual_set(&[("router", "auto")]);
        let result = rewind_log(&raw, "q1", &live, &virtuals).unwrap();
        assert!(
            !result.contains("\"edit-model-"),
            "no re-recorded model_change: {result}"
        );
        let kept: Vec<Value> = result
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let leaf = kept.last().unwrap()["id"].as_str().unwrap().to_owned();
        let branch = branch_entries(&kept.iter().collect::<Vec<_>>(), &leaf);
        assert_eq!(
            branch_model(&branch, &virtuals),
            Some(("router".into(), "auto".into()))
        );
    }

    /// An unknown catalog must assume the older `model_change` may be virtual: the
    /// switch is re-recorded (harmless when it names the same model) instead of
    /// silently keeping what pi would restore.
    #[test]
    fn unknown_catalog_falls_back_to_rerecording() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"q0","parentId":null,"message":{"role":"user"}}),
            json!({"type":"model_change","id":"mc0","parentId":"q0","provider":"router","modelId":"auto"}),
            json!({"type":"message","id":"a0","parentId":"mc0","message":{"role":"assistant","provider":"openai","model":"gpt","api":"openai"}}),
            json!({"type":"message","id":"q1","parentId":"a0","message":{"role":"user"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        let live = LiveSelection {
            model: Some(("openai".into(), "gpt".into())),
            thinking: None,
        };
        let unknown: VirtualModels = None;
        let entries: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let path = branch_entries(&entries.iter().collect::<Vec<_>>(), "a0");
        assert_eq!(
            branch_model(&path, &unknown),
            Some(("router".into(), "auto".into()))
        );
        let result = rewind_log(&raw, "q1", &live, &unknown).unwrap();
        assert!(result.contains("\"edit-model-"), "{result}");
    }

    #[test]
    fn catalog_marks_only_pi_virtual_models() {
        let response = json!({"data": {"models": [
            {"provider": "openai", "id": "gpt", "api": "openai"},
            {"provider": "router", "id": "auto", "api": "pi-virtual"},
        ]}});
        let virtuals = virtual_models_from_catalog(&response).unwrap();
        assert!(virtuals.contains(&("router".into(), "auto".into())));
        assert!(!virtuals.contains(&("openai".into(), "gpt".into())));
        // A malformed catalog is "unknown", never "nothing is virtual".
        assert!(virtual_models_from_catalog(&json!({"data": {}})).is_none());
    }

    /// Table of branch shapes (leaf→root) whose restored selection follows pi's
    /// `getBranchSelection`, including the virtual cases the review named.
    #[test]
    fn branch_model_matches_pi_restore_semantics() {
        let gpt = || json!({"type":"message","message":{"role":"assistant","provider":"openai","model":"gpt","api":"openai"}});
        let cases: Vec<(Vec<Value>, Option<(&str, &str)>, bool)> = vec![
            // A virtual selection holds past the routed answer naming `openai/gpt`.
            (
                vec![
                    gpt(),
                    json!({"type":"model_change","provider":"router","modelId":"auto"}),
                ],
                Some(("router", "auto")),
                true,
            ),
            // The same branch without a registered virtual model: the answer wins.
            (
                vec![
                    gpt(),
                    json!({"type":"model_change","provider":"router","modelId":"auto"}),
                ],
                Some(("openai", "gpt")),
                false,
            ),
            // A physical selection does not hold: the answer's model wins.
            (
                vec![
                    gpt(),
                    json!({"type":"model_change","provider":"anthropic","modelId":"claude"}),
                ],
                Some(("openai", "gpt")),
                true,
            ),
            // A virtual answer is skipped; the older physical answer decides.
            (
                vec![
                    json!({"type":"message","message":{"role":"assistant","provider":"router","model":"auto","api":"pi-virtual"}}),
                    gpt(),
                ],
                Some(("openai", "gpt")),
                true,
            ),
            // The newest switch wins even when it names a virtual model.
            (
                vec![
                    json!({"type":"model_change","provider":"router","modelId":"auto"}),
                    gpt(),
                ],
                Some(("router", "auto")),
                true,
            ),
            // A user question is not an answer and decides nothing.
            (
                vec![
                    json!({"type":"model_change","provider":"openai","modelId":"gpt"}),
                    json!({"type":"message","message":{"role":"user"}}),
                ],
                Some(("openai", "gpt")),
                true,
            ),
        ];
        let virtuals = virtual_set(&[("router", "auto")]);
        let unregistered: VirtualModels = Some(std::collections::HashSet::new());
        for (path, expected, with_virtuals) in cases {
            let refs: Vec<&Value> = path.iter().collect();
            let catalog = if with_virtuals {
                &virtuals
            } else {
                &unregistered
            };
            assert_eq!(
                branch_model(&refs, catalog),
                expected.map(|(provider, id)| (provider.to_string(), id.to_string())),
                "branch: {:?}",
                path.iter().map(Value::to_string).collect::<Vec<_>>()
            );
        }
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
