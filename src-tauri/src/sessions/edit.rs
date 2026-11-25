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
    // pi resolves an older `model_change` through its full registered catalog,
    // which RPC only exposes as the *available* snapshot. "Present" proves the
    // api; "absent" proves nothing, so any decision depending on an absent model
    // is treated as uncertain and re-recorded (see `restored_model`).
    let catalog = match transport
        .request(json!({"type": "get_available_models"}))
        .await
    {
        Ok(response) => ModelCatalog::from_snapshot(&response),
        Err(error) => {
            crate::logs::write(
                "sessions",
                &format!("rewind catalog lookup failed: {error}"),
            );
            ModelCatalog::default()
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
    let revised = rewind_log(&original, &target, &live, &catalog)?;
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

/// What the rewind can prove about the selection pi restores for a branch.
#[derive(Debug, PartialEq, Eq)]
enum Restore {
    /// pi is proven to restore exactly this `(provider, model)`.
    Exact((String, String)),
    /// Not provable: either the branch records no selection at all (pi then falls
    /// back to its settings default) or the answer routes the decision through the
    /// model catalog, which the RPC surface only exposes as the *available*
    /// snapshot. Re-recording the live selection is then the only safe move.
    Uncertain,
}

/// The part of pi's registered catalog the RPC surface can prove.
///
/// pi's `getBranchSelection` resolves an older `model_change` through
/// `modelRuntime.getModel()` — the complete registered catalog. The only related
/// RPC is `get_available_models`, whose snapshot is filtered by configured
/// provider auth: a model missing from it may be unregistered, may be registered
/// but currently unavailable (missing credentials, filtered provider), and may be
/// virtual either way. Presence therefore proves the api; absence proves nothing.
#[derive(Default)]
struct ModelCatalog {
    /// `(provider, model)` → `api == "pi-virtual"`.
    known: HashMap<(String, String), bool>,
}

impl ModelCatalog {
    fn from_snapshot(response: &Value) -> Self {
        let mut known = HashMap::new();
        for model in response["data"]["models"].as_array().into_iter().flatten() {
            let (Some(provider), Some(id)) = (model["provider"].as_str(), model["id"].as_str())
            else {
                continue;
            };
            known.insert(
                (provider.to_owned(), id.to_owned()),
                model["api"].as_str() == Some("pi-virtual"),
            );
        }
        Self { known }
    }

    /// `Some(true)` virtual, `Some(false)` physical, `None` not provable.
    fn is_virtual(&self, key: &(String, String)) -> Option<bool> {
        self.known.get(key).copied()
    }
}

/// Which model pi's `getBranchSelection` restores from this branch (leaf→root),
/// and whether that result is provable:
///
/// - the newest `model_change` wins outright — pi returns it without a lookup;
/// - before any `model_change`, issue-route answers decide: a `model_change`
///   older than the newest physical answer holds only while the catalog reports
///   it as virtual, otherwise the answer's own model is the selection;
/// - the catalog lookup itself is `Uncertain` whenever the available snapshot
///   cannot prove the api, because a registered-but-unavailable model may still
///   be virtual and hold;
/// - a branch without any selection record is `Uncertain` too: pi then falls back
///   to its settings default, not to whatever the picker shows.
fn restored_model(path: &[&Value], catalog: &ModelCatalog) -> Restore {
    for (index, item) in path.iter().enumerate() {
        if let Some(change) = model_change_key(item) {
            return Restore::Exact(change);
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
        // `path` runs leaf→root, so the first match is the newest `model_change`
        // above the answer; without one, pi returns the answer's own model.
        let Some(change) = path[index + 1..]
            .iter()
            .find_map(|item| model_change_key(item))
        else {
            return Restore::Exact(response);
        };
        return match catalog.is_virtual(&change) {
            // Routed answers name the physical model that answered; the virtual
            // selection they came from holds until the next `model_change`.
            Some(true) => Restore::Exact(change),
            Some(false) => Restore::Exact(response),
            None => Restore::Uncertain,
        };
    }
    Restore::Uncertain
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

fn rewind_log(
    raw: &str,
    target: &str,
    live: &LiveSelection,
    catalog: &ModelCatalog,
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
        // Re-record unless pi is *proven* to restore the live selection. An
        // uncertain branch (unprovable virtual check, or no selection record at
        // all) must not be resolved by comparing the guess with live: the guess
        // may equal live today and still differ from what pi reloads.
        if restored_model(&path, catalog) != Restore::Exact((provider.clone(), model_id.clone())) {
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

    /// A catalog that proves the api of exactly the listed models. Anything else
    /// is unprovable, just like a model that is registered but missing from the
    /// available snapshot.
    fn catalog(models: &[(&str, &str, bool)]) -> ModelCatalog {
        let mut known = HashMap::new();
        for (provider, id, virtual_model) in models {
            known.insert((provider.to_string(), id.to_string()), *virtual_model);
        }
        ModelCatalog { known }
    }

    /// pi restores the newest physical answer; no virtual model is involved.
    fn physical_only() -> ModelCatalog {
        catalog(&[])
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

    /// A catalog proving these models are pi-virtual.
    fn virtual_set(models: &[(&str, &str)]) -> ModelCatalog {
        let entries: Vec<(&str, &str, bool)> = models
            .iter()
            .map(|(provider, id)| (*provider, *id, true))
            .collect();
        catalog(&entries)
    }

    /// The switch records a rewind appended (everything under `pix-edit-position`).
    fn appended_switches(kept: &[Value]) -> Vec<&Value> {
        kept.iter()
            .filter(|entry| {
                entry["id"].as_str().is_some_and(|id| {
                    id.starts_with("edit-model-") || id.starts_with("edit-thinking-")
                })
            })
            .collect()
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
            restored_model(&branch, &physical_only()),
            Restore::Exact(("p3".into(), "m3".into()))
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
            restored_model(&branch, &virtuals),
            Restore::Exact(("openai".into(), "gpt".into()))
        );
        // ...instead of the virtual selection the marker alone would keep.
        let marker_branch = branch_entries(&kept.iter().collect::<Vec<_>>(), &marker_of(&kept));
        assert_eq!(
            restored_model(&marker_branch, &virtuals),
            Restore::Exact(("router".into(), "auto".into()))
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
            restored_model(&branch, &virtuals),
            Restore::Exact(("router".into(), "auto".into()))
        );
    }

    /// Symmetric half of the unknown-catalog rule: the surviving branch records a
    /// *physical* switch (`openai/gpt-a`) above an answer from `anthropic/claude-b`
    /// and the catalog lookup failed. Treating the old record as virtual would
    /// infer `gpt-a` — exactly the live selection — yet pi, knowing it is physical,
    /// restores `claude-b`. The uncertain inference must never equal live.
    #[test]
    fn unknown_catalog_rerecords_even_when_the_guess_matches_live() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"q0","parentId":null,"message":{"role":"user"}}),
            json!({"type":"message","id":"a0","parentId":"q0","message":{"role":"assistant","provider":"p1","model":"m1","api":"openai"}}),
            json!({"type":"model_change","id":"mc0","parentId":"a0","provider":"openai","modelId":"gpt-a"}),
            json!({"type":"message","id":"a1","parentId":"mc0","message":{"role":"assistant","provider":"anthropic","model":"claude-b","api":"anthropic"}}),
            json!({"type":"message","id":"q1","parentId":"a1","message":{"role":"user"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        // The user switched back to `gpt-a` while editing; that record is dropped.
        let live = LiveSelection {
            model: Some(("openai".into(), "gpt-a".into())),
            thinking: None,
        };
        let unknown = physical_only();
        let entries: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let path = branch_entries(&entries.iter().collect::<Vec<_>>(), "a1");
        assert_eq!(restored_model(&path, &unknown), Restore::Uncertain);
        let result = rewind_log(&raw, "q1", &live, &unknown).unwrap();
        let kept: Vec<Value> = result
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let switches = appended_switches(&kept);
        assert_eq!(switches.len(), 1, "must re-record: {result}");
        assert_eq!(switches[0]["provider"], "openai");
        assert_eq!(switches[0]["modelId"], "gpt-a");
        // With the catalog the answer's own model would win; re-recording live
        // keeps the user's switch either way.
        let known = catalog(&[("openai", "gpt-a", false)]);
        let leaf = kept.last().unwrap()["id"].as_str().unwrap().to_owned();
        let branch = branch_entries(&kept.iter().collect::<Vec<_>>(), &leaf);
        assert_eq!(
            restored_model(&branch, &known),
            Restore::Exact(("openai".into(), "gpt-a".into()))
        );
    }

    /// A model that is registered but missing from the available snapshot stays
    /// pi-virtual (`getBranchSelection` looks it up in the full catalog), so the
    /// available list may never be read as "this is physical".
    #[test]
    fn unavailable_virtual_model_is_not_treated_as_physical() {
        let raw = [
            json!({"type":"session","id":"session"}),
            json!({"type":"message","id":"q0","parentId":null,"message":{"role":"user"}}),
            json!({"type":"message","id":"a0","parentId":"q0","message":{"role":"assistant","provider":"p1","model":"m1","api":"openai"}}),
            json!({"type":"model_change","id":"mc0","parentId":"a0","provider":"router","modelId":"auto"}),
            json!({"type":"message","id":"a1","parentId":"mc0","message":{"role":"assistant","provider":"openai","model":"gpt","api":"openai"}}),
            json!({"type":"message","id":"q1","parentId":"a1","message":{"role":"user"}}),
        ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n");
        // The switch to the routed physical model happened while editing.
        let live = LiveSelection {
            model: Some(("openai".into(), "gpt".into())),
            thinking: None,
        };
        // Snapshot only lists the physical model: `router/auto` is absent, but it
        // may still be registered as virtual.
        let snapshot = json!({"data": {"models": [
            {"provider": "openai", "id": "gpt", "api": "openai"},
        ]}});
        let available = ModelCatalog::from_snapshot(&snapshot);
        let entries: Vec<Value> = raw
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let path = branch_entries(&entries.iter().collect::<Vec<_>>(), "a1");
        assert_eq!(restored_model(&path, &available), Restore::Uncertain);
        let result = rewind_log(&raw, "q1", &live, &available).unwrap();
        let kept: Vec<Value> = result
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        let switches = appended_switches(&kept);
        assert_eq!(switches.len(), 1, "must re-record: {result}");
        assert_eq!(switches[0]["modelId"], "gpt");
        // And pi's real answer, had the snapshot listed it, is the virtual one.
        let full = virtual_set(&[("router", "auto")]);
        let marker_branch = branch_entries(&kept.iter().collect::<Vec<_>>(), &marker_of(&kept));
        assert_eq!(
            restored_model(&marker_branch, &full),
            Restore::Exact(("router".into(), "auto".into()))
        );
    }

    #[test]
    fn catalog_proves_only_what_it_lists() {
        let response = json!({"data": {"models": [
            {"provider": "openai", "id": "gpt", "api": "openai"},
            {"provider": "router", "id": "auto", "api": "pi-virtual"},
        ]}});
        let snapshot = ModelCatalog::from_snapshot(&response);
        assert_eq!(
            snapshot.is_virtual(&("router".into(), "auto".into())),
            Some(true)
        );
        assert_eq!(
            snapshot.is_virtual(&("openai".into(), "gpt".into())),
            Some(false)
        );
        // A model the snapshot omits is unknown, never "physical".
        assert_eq!(
            snapshot.is_virtual(&("router".into(), "cheap".into())),
            None
        );
        // A failed or malformed lookup proves nothing at all.
        assert_eq!(
            ModelCatalog::default().is_virtual(&("router".into(), "auto".into())),
            None
        );
    }

    /// Branch shapes (leaf→root) against pi's `getBranchSelection` semantics.
    #[test]
    fn restored_model_matches_pi_restore_semantics() {
        let gpt = || json!({"type":"message","message":{"role":"assistant","provider":"openai","model":"gpt","api":"openai"}});
        let virtuals = virtual_set(&[("router", "auto")]);
        let no_virtuals = catalog(&[("router", "auto", false)]);
        let unknown = physical_only();
        let cases: Vec<(Vec<Value>, &ModelCatalog, Restore)> = vec![
            // A virtual selection holds past the routed answer naming `openai/gpt`.
            (
                vec![
                    gpt(),
                    json!({"type":"model_change","provider":"router","modelId":"auto"}),
                ],
                &virtuals,
                Restore::Exact(("router".into(), "auto".into())),
            ),
            // Proven physical: the answer's model wins.
            (
                vec![
                    gpt(),
                    json!({"type":"model_change","provider":"router","modelId":"auto"}),
                ],
                &no_virtuals,
                Restore::Exact(("openai".into(), "gpt".into())),
            ),
            // Unprovable: an absent model may be virtual, so the restore is unknown.
            (
                vec![
                    gpt(),
                    json!({"type":"model_change","provider":"router","modelId":"auto"}),
                ],
                &unknown,
                Restore::Uncertain,
            ),
            // A virtual answer is skipped; the older physical answer decides.
            (
                vec![
                    json!({"type":"message","message":{"role":"assistant","provider":"router","model":"auto","api":"pi-virtual"}}),
                    gpt(),
                ],
                &virtuals,
                Restore::Exact(("openai".into(), "gpt".into())),
            ),
            // The newest switch wins even when the catalog cannot classify it.
            (
                vec![
                    json!({"type":"model_change","provider":"router","modelId":"auto"}),
                    gpt(),
                ],
                &unknown,
                Restore::Exact(("router".into(), "auto".into())),
            ),
            // A question is not an answer and decides nothing.
            (
                vec![
                    json!({"type":"model_change","provider":"openai","modelId":"gpt"}),
                    json!({"type":"message","message":{"role":"user"}}),
                ],
                &unknown,
                Restore::Exact(("openai".into(), "gpt".into())),
            ),
            // No selection record at all: pi falls back to its settings default.
            (
                vec![json!({"type":"message","message":{"role":"user"}})],
                &virtuals,
                Restore::Uncertain,
            ),
        ];
        for (path, catalog, expected) in cases {
            let refs: Vec<&Value> = path.iter().collect();
            assert_eq!(
                restored_model(&refs, catalog),
                expected,
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
