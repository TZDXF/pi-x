//! Shared sidebar metadata. No webview/localStorage migration: development starts fresh.
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::errors::{pix_error, pix_error_detail};

static STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceState {
    revision: u64,
    projects: Vec<String>,
    pinned_projects: Vec<String>,
    project_groups: BTreeMap<String, ProjectGroup>,
    removed_projects: Vec<String>,
    session_order: BTreeMap<String, Vec<String>>,
    board_column_order: BTreeMap<String, Vec<String>>,
    board_drafts: BTreeMap<String, BoardDraft>,
    session_activities: BTreeMap<String, SessionActivity>,
    session_acknowledgements: BTreeMap<String, String>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardDraft {
    id: String,
    project: String,
    message: String,
    created_at: f64,
    updated_at: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_file: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    runtime_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thinking_level: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attachments: Vec<BoardDraftAttachment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    selection: Option<BoardDraftSelection>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardDraftSelection {
    project: String,
    worktree: bool,
    branch: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BoardDraftAttachment {
    #[serde(skip_serializing_if = "Option::is_none")]
    filename: Option<String>,
    media_type: String,
    url: String,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum SessionActivityStatus {
    Running,
    Completed,
    Error,
    Idle,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionActivity {
    file: String,
    project: String,
    status: SessionActivityStatus,
    run_id: String,
    updated_at: f64,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct ProjectGroup {
    name: String,
    folders: Vec<String>,
    primary: String,
}
#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct PathChanges {
    add: Vec<String>,
    remove: Vec<String>,
    order: Option<Vec<String>>,
}
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct WorkspaceStatePatch {
    projects: Option<PathChanges>,
    pinned_projects: Option<PathChanges>,
    removed_projects: Option<PathChanges>,
    project_groups: BTreeMap<String, Option<ProjectGroup>>,
    session_order: BTreeMap<String, Option<Vec<String>>>,
    board_column_order: BTreeMap<String, Option<Vec<String>>>,
    board_drafts: BTreeMap<String, Option<BoardDraft>>,
    session_activities: BTreeMap<String, Option<SessionActivity>>,
    session_acknowledgements: BTreeMap<String, Option<String>>,
}

fn normalize_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let trimmed = normalized.trim_end_matches('/');
    if trimmed.is_empty() {
        if normalized.starts_with("//") {
            "//".into()
        } else if normalized.starts_with('/') {
            "/".into()
        } else {
            String::new()
        }
    } else if trimmed.len() == 2
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
        && trimmed.ends_with(':')
        && normalized.ends_with('/')
    {
        format!("{trimmed}/")
    } else {
        trimmed.into()
    }
}
fn same_path(a: &str, b: &str) -> bool {
    let a = normalize_path(a);
    let b = normalize_path(b);
    crate::paths::eq_norm(&a, &b)
}
fn unique_paths(paths: Vec<String>) -> Vec<String> {
    let mut result = Vec::new();
    for path in paths {
        let path = normalize_path(&path);
        if !path.is_empty() && !result.iter().any(|old: &String| same_path(old, &path)) {
            result.push(path);
        }
    }
    result
}
fn update_paths(paths: &mut Vec<String>, changes: Option<PathChanges>) {
    let Some(changes) = changes else { return };
    paths.retain(|path| {
        !changes
            .remove
            .iter()
            .any(|removed| same_path(path, removed))
    });
    paths.extend(changes.add);
    *paths = unique_paths(std::mem::take(paths));
    if let Some(order) = changes.order {
        let mut ordered = Vec::new();
        for path in order {
            if let Some(existing) = paths.iter().find(|old| same_path(old, &path)) {
                ordered.push(existing.clone());
            }
        }
        ordered.append(paths);
        *paths = unique_paths(ordered);
    }
}
fn update_map<T>(map: &mut BTreeMap<String, T>, changes: BTreeMap<String, Option<T>>) {
    for (path, value) in changes {
        let key = map
            .keys()
            .find(|old| same_path(old, &path))
            .cloned()
            .unwrap_or_else(|| normalize_path(&path));
        if let Some(value) = value {
            map.insert(key, value);
        } else {
            map.remove(&key);
        }
    }
}
// Board IDs, column keys and composite session identities must never pass through path normalization.
fn update_identity_map<T>(map: &mut BTreeMap<String, T>, changes: BTreeMap<String, Option<T>>) {
    for (key, value) in changes {
        if let Some(value) = value {
            map.insert(key, value);
        } else {
            map.remove(&key);
        }
    }
}
fn valid_timestamp(value: f64) -> bool {
    value.is_finite() && value >= 0.0
}
fn normalize(state: &mut WorkspaceState) -> Result<(), String> {
    if state.board_drafts.iter().any(|(key, draft)| {
        key.trim().is_empty()
            || key != &draft.id
            || !valid_timestamp(draft.created_at)
            || !valid_timestamp(draft.updated_at)
            || draft.updated_at < draft.created_at
    }) || state.session_activities.iter().any(|(key, activity)| {
        key.trim().is_empty()
            || activity.file.trim().is_empty()
            || activity.run_id.trim().is_empty()
            || !valid_timestamp(activity.updated_at)
    }) || state
        .session_acknowledgements
        .iter()
        .any(|(key, run_id)| key.trim().is_empty() || run_id.trim().is_empty())
    {
        return Err(pix_error("workspaceInvalid", "工作区目录列表无效"));
    }
    state.projects = unique_paths(std::mem::take(&mut state.projects));
    state.removed_projects = unique_paths(std::mem::take(&mut state.removed_projects));
    state.projects.retain(|path| {
        !state
            .removed_projects
            .iter()
            .any(|removed| same_path(path, removed))
    });
    state.pinned_projects = unique_paths(std::mem::take(&mut state.pinned_projects))
        .into_iter()
        .filter_map(|path| state.projects.iter().find(|p| same_path(p, &path)).cloned())
        .collect();
    let mut folders: Vec<String> = Vec::new();
    for (key, mut group) in std::mem::take(&mut state.project_groups) {
        let Some(primary) = state.projects.iter().find(|p| same_path(p, &key)).cloned() else {
            continue;
        };
        if !same_path(&group.primary, &primary) {
            return Err(pix_error("workspaceInvalid", "工作区目录列表无效"));
        }
        group.primary = primary.clone();
        group.name = group.name.trim().into();
        group.folders = unique_paths(group.folders);
        for folder in &mut group.folders {
            if same_path(folder, &primary) {
                *folder = primary.clone();
            }
        }
        if group.name.is_empty()
            || group.name.chars().count() > 120
            || group.folders.is_empty()
            || group.folders.len() > 32
            || !group.folders.iter().any(|p| same_path(p, &primary))
            || group.folders.iter().any(|p| {
                folders.iter().any(|old| same_path(old, p))
                    || state
                        .projects
                        .iter()
                        .any(|other| !same_path(other, &primary) && same_path(other, p))
            })
        {
            return Err(pix_error("workspaceInvalid", "工作区目录列表无效"));
        }
        folders.extend(group.folders.iter().cloned());
        state.project_groups.insert(primary, group);
    }
    for (key, files) in std::mem::take(&mut state.session_order) {
        let key = state
            .projects
            .iter()
            .find(|p| same_path(p, &key))
            .cloned()
            .unwrap_or_else(|| normalize_path(&key));
        let merged = state.session_order.entry(key).or_default();
        for file in files {
            if !merged.contains(&file) {
                merged.push(file);
            }
        }
    }
    for ids in state.board_column_order.values_mut() {
        let mut seen = BTreeSet::new();
        ids.retain(|id| seen.insert(id.clone()));
    }
    Ok(())
}
fn read(path: &Path) -> Result<WorkspaceState, String> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(WorkspaceState::default())
        }
        Err(error) => {
            return Err(pix_error_detail(
                "configReadFailed",
                "无法读取配置文件: {detail}",
                error,
            ))
        }
    };
    let mut state = serde_json::from_slice(&bytes)
        .map_err(|e| pix_error_detail("configParseFailed", "解析配置失败: {detail}", e))?;
    normalize(&mut state)?;
    Ok(state)
}
fn update(path: &Path, patch: WorkspaceStatePatch) -> Result<WorkspaceState, String> {
    let mut state = read(path)?;
    update_paths(&mut state.projects, patch.projects);
    update_paths(&mut state.pinned_projects, patch.pinned_projects);
    update_paths(&mut state.removed_projects, patch.removed_projects);
    update_map(&mut state.project_groups, patch.project_groups);
    update_map(&mut state.session_order, patch.session_order);
    update_identity_map(&mut state.board_column_order, patch.board_column_order);
    update_identity_map(&mut state.board_drafts, patch.board_drafts);
    for (key, activity) in patch.session_activities {
        if let Some(activity) = activity {
            if state.session_activities.get(&key).is_none_or(|previous| {
                (previous.run_id.starts_with("local:") && !activity.run_id.starts_with("local:"))
                    || activity.updated_at >= previous.updated_at
            }) {
                state.session_activities.insert(key, activity);
            }
        } else {
            state.session_activities.remove(&key);
        }
    }
    for (key, run_id) in patch.session_acknowledgements {
        if let Some(run_id) = run_id {
            if state
                .session_activities
                .get(&key)
                .is_none_or(|activity| activity.run_id == run_id)
            {
                state.session_acknowledgements.insert(key, run_id);
            }
        } else {
            state.session_acknowledgements.remove(&key);
        }
    }
    normalize(&mut state)?;
    state.revision += 1;
    let body = serde_json::to_vec_pretty(&state)
        .map_err(|e| pix_error_detail("configSerializeFailed", "序列化配置失败: {detail}", e))?;
    crate::atomic_write::write(path, &body)
        .map_err(|e| pix_error_detail("configWriteFailed", "无法写入配置文件: {detail}", e))?;
    Ok(state)
}
#[tauri::command]
pub fn workspace_state_get() -> Result<WorkspaceState, String> {
    let _guard = STATE_LOCK.lock().map_err(|e| e.to_string())?;
    read(&crate::data_dir::root().join("workspace.json"))
}

/// 侧栏曾经展示过的全部会话文件：会话列表过滤改为仅 PiX 纳管会话之前的
/// 历史记录，供启动时一次性迁移（补写 sidecar）使用。
pub fn known_session_files() -> Vec<std::path::PathBuf> {
    workspace_state_get()
        .map(|state| {
            state
                .session_order
                .into_values()
                .flatten()
                .map(std::path::PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}
#[tauri::command]
pub fn workspace_state_update(
    app: AppHandle,
    patch: WorkspaceStatePatch,
) -> Result<WorkspaceState, String> {
    let state = {
        let _guard = STATE_LOCK.lock().map_err(|e| e.to_string())?;
        update(&crate::data_dir::root().join("workspace.json"), patch)?
    };
    crate::remote::emit(
        &app,
        "pi://workspace-state-changed",
        serde_json::to_value(&state).map_err(|e| e.to_string())?,
    );
    Ok(state)
}

fn runtime_activity_patch(payload: &serde_json::Value) -> Option<WorkspaceStatePatch> {
    let file = payload["pixSessionFile"].as_str()?;
    let project = payload["pixProject"].as_str()?;
    let activity: SessionActivity = serde_json::from_value(serde_json::json!({
        "file": file, "project": project, "status": payload["pixRunStatus"],
        "runId": payload["pixRunId"], "updatedAt": payload["pixRunUpdatedAt"],
    }))
    .ok()?;
    let key = runtime_activity_key(project, file)?;
    let mut patch = WorkspaceStatePatch::default();
    patch.session_activities.insert(key, Some(activity));
    Some(patch)
}

fn runtime_activity_key(project: &str, file: &str) -> Option<String> {
    if crate::ssh::is_remote_uri(project) {
        Some(serde_json::to_string(&[normalize_path(project), file.to_string()]).ok()?)
    } else {
        Some(file.replace('\\', "/"))
    }
}

fn rebind_runtime_activity_at(
    path: &Path,
    payload: &serde_json::Value,
) -> Result<Option<WorkspaceState>, String> {
    let Some(previous_project) = payload["previousProject"].as_str() else {
        return Ok(None);
    };
    let Some(project) = payload["pixProject"].as_str() else {
        return Ok(None);
    };
    let Some(file) = payload["pixSessionFile"].as_str() else {
        return Ok(None);
    };
    let (Some(previous_key), Some(key)) = (
        runtime_activity_key(previous_project, file),
        runtime_activity_key(project, file),
    ) else {
        return Ok(None);
    };
    let current = read(path)?;
    let Some(mut activity) = current.session_activities.get(&previous_key).cloned() else {
        return Ok(None);
    };
    activity.project = project.to_string();
    let mut patch = WorkspaceStatePatch::default();
    patch.session_activities.insert(previous_key.clone(), None);
    patch.session_activities.insert(key.clone(), Some(activity));
    if let Some(run_id) = current.session_acknowledgements.get(&previous_key).cloned() {
        patch.session_acknowledgements.insert(previous_key, None);
        patch.session_acknowledgements.insert(key, Some(run_id));
    }
    update(path, patch).map(Some)
}

fn record_runtime_activity_at(
    path: &Path,
    payload: &serde_json::Value,
) -> Result<Option<WorkspaceState>, String> {
    let Some(patch) = runtime_activity_patch(payload) else {
        return Ok(None);
    };
    let current = read(path)?;
    if patch
        .session_activities
        .iter()
        .all(|(key, value)| current.session_activities.get(key) == value.as_ref())
    {
        return Ok(None);
    }
    update(path, patch).map(Some)
}

/// Preserve terminal results even when every remote browser is disconnected
/// and the scheduler reaps its worker before a browser returns.
pub(crate) fn record_runtime_activity(app: &AppHandle, payload: &serde_json::Value) {
    let result = (|| {
        let _guard = STATE_LOCK.lock().map_err(|e| e.to_string())?;
        record_runtime_activity_at(&crate::data_dir::root().join("workspace.json"), payload)
    })();
    match result {
        Ok(Some(state)) => {
            if let Ok(value) = serde_json::to_value(state) {
                crate::remote::emit(app, "pi://workspace-state-changed", value);
            }
        }
        Ok(None) => {}
        Err(error) => crate::logs::write(
            "workspace",
            &format!("runtime activity persistence failed: {error}"),
        ),
    }
}

pub(crate) fn rebind_runtime_activity(app: &AppHandle, payload: &serde_json::Value) {
    let result = (|| {
        let _guard = STATE_LOCK.lock().map_err(|e| e.to_string())?;
        rebind_runtime_activity_at(&crate::data_dir::root().join("workspace.json"), payload)
    })();
    match result {
        Ok(Some(state)) => {
            if let Ok(value) = serde_json::to_value(state) {
                crate::remote::emit(app, "pi://workspace-state-changed", value);
            }
        }
        Ok(None) => {}
        Err(error) => crate::logs::write(
            "workspace",
            &format!("runtime activity rebind failed: {error}"),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn patch(value: serde_json::Value) -> WorkspaceStatePatch {
        serde_json::from_value(value).unwrap()
    }
    fn path() -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("pix-workspace-state-{}", uuid::Uuid::new_v4()))
            .join("workspace.json")
    }
    fn cleanup(path: &Path) {
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn backend_results_survive_without_a_connected_client_and_retry_starts_do_not_rewrite() {
        let path = path();
        let mut event = json!({
            "pixSessionFile":"C:\\sessions\\one.jsonl", "pixProject":"C:/project",
            "pixRunStatus":"running", "pixRunId":"backend-run", "pixRunUpdatedAt":1,
        });
        let started = record_runtime_activity_at(&path, &event).unwrap().unwrap();
        assert_eq!(
            started.session_activities["C:/sessions/one.jsonl"].status,
            SessionActivityStatus::Running
        );
        assert!(record_runtime_activity_at(&path, &event).unwrap().is_none());
        event["pixRunStatus"] = json!("completed");
        event["pixRunUpdatedAt"] = json!(2);
        record_runtime_activity_at(&path, &event).unwrap();
        let restored = read(&path).unwrap();
        assert_eq!(restored.revision, 2);
        assert_eq!(
            restored.session_activities["C:/sessions/one.jsonl"].status,
            SessionActivityStatus::Completed
        );
        cleanup(&path);
    }

    #[test]
    fn backend_activity_keeps_remote_endpoint_identities_separate() {
        let event = json!({
            "pixSessionFile":"/sessions/one.jsonl", "pixProject":"ssh://host-a/project",
            "pixRunStatus":"error", "pixRunId":"backend-run", "pixRunUpdatedAt":1,
        });
        let patch = runtime_activity_patch(&event).unwrap();
        assert!(patch
            .session_activities
            .contains_key("[\"ssh://host-a/project\",\"/sessions/one.jsonl\"]"));
        assert!(runtime_activity_patch(&json!({"pixRunStatus":"running"})).is_none());
    }

    #[test]
    fn realpath_rebind_moves_persisted_activity_to_the_authoritative_project() {
        let path = path();
        let event = json!({
            "pixSessionFile":"/sessions/one.jsonl", "pixProject":"ssh://host/alias",
            "pixRunStatus":"running", "pixRunId":"backend-run", "pixRunUpdatedAt":1,
        });
        record_runtime_activity_at(&path, &event).unwrap();
        let old_key = runtime_activity_key("ssh://host/alias", "/sessions/one.jsonl").unwrap();
        let new_key = runtime_activity_key("ssh://host/physical", "/sessions/one.jsonl").unwrap();
        update(
            &path,
            patch(json!({
                "sessionAcknowledgements": {(old_key.clone()): "backend-run"},
            })),
        )
        .unwrap();
        let rebound = json!({
            "previousProject":"ssh://host/alias", "pixProject":"ssh://host/physical",
            "pixSessionFile":"/sessions/one.jsonl",
        });
        rebind_runtime_activity_at(&path, &rebound)
            .unwrap()
            .unwrap();
        let state = read(&path).unwrap();
        assert!(!state.session_activities.contains_key(&old_key));
        assert!(!state.session_acknowledgements.contains_key(&old_key));
        assert_eq!(state.session_acknowledgements[&new_key], "backend-run");
        assert_eq!(
            state.session_activities[&new_key].project,
            "ssh://host/physical"
        );
        assert_eq!(state.session_activities[&new_key].run_id, "backend-run");
        cleanup(&path);
    }

    #[test]
    fn missing_file_starts_empty_and_metadata_survives_reload() {
        let path = path();
        assert_eq!(read(&path).unwrap(), WorkspaceState::default());
        let state = update(&path, patch(json!({
            "projects": {"add": ["C:/one", "C:/two"], "order": ["C:/two", "C:/one"]},
            "pinnedProjects": {"add": ["C:/one"]},
            "projectGroups": {"C:/one": {"name": "One", "primary": "C:/one", "folders": ["C:/one", "C:/extra"]}},
            "sessionOrder": {"C:/one": ["b", "a"]}
        }))).unwrap();
        assert_eq!(state.projects, ["C:/two", "C:/one"]);
        assert_eq!(state.revision, 1);
        assert_eq!(read(&path).unwrap(), state);
        cleanup(&path);
    }
    #[test]
    fn concurrent_client_patches_preserve_unrelated_additions() {
        let path = path();
        update(&path, patch(json!({"projects": {"add": ["one"]}}))).unwrap();
        let state = update(
            &path,
            patch(json!({"projects": {"add": ["two"], "order": ["two"]}})),
        )
        .unwrap();
        assert_eq!(state.projects, ["two", "one"]);
        assert_eq!(state.revision, 2);
        cleanup(&path);
    }
    #[test]
    fn removed_marker_blocks_stale_automatic_add_until_explicit_readd() {
        let path = path();
        update(
            &path,
            patch(json!({"projects": {"add": ["one"]}, "pinnedProjects": {"add": ["one"]}})),
        )
        .unwrap();
        update(
            &path,
            patch(json!({"projects": {"remove": ["one"]}, "removedProjects": {"add": ["one"]}})),
        )
        .unwrap();
        let state = update(&path, patch(json!({"projects": {"add": ["one"]}}))).unwrap();
        assert!(state.projects.is_empty());
        assert!(state.pinned_projects.is_empty());
        let state = update(
            &path,
            patch(json!({"projects": {"add": ["one"]}, "removedProjects": {"remove": ["one"]}})),
        )
        .unwrap();
        assert_eq!(state.projects, ["one"]);
        assert!(state.removed_projects.is_empty());
        cleanup(&path);
    }
    #[test]
    fn windows_variants_merge_and_posix_paths_remain_case_sensitive() {
        let path = path();
        let state = update(&path, patch(json!({
            "projects": {"add": ["C:\\one\\", "c:/ONE", "/Work", "/work"]},
            "pinnedProjects": {"add": ["c:/one/"]},
            "projectGroups": {"c:/ONE/": {"name": " One ", "primary": "C:/one", "folders": ["c:/one/", "C:\\extra"]}},
            "sessionOrder": {"c:/ONE/": ["a", "a"]}
        }))).unwrap();
        assert_eq!(state.projects, ["C:/one", "/Work", "/work"]);
        assert_eq!(state.pinned_projects, ["C:/one"]);
        assert_eq!(state.project_groups["C:/one"].name, "One");
        assert_eq!(
            state.project_groups["C:/one"].folders,
            ["C:/one", "C:/extra"]
        );
        assert_eq!(state.session_order["C:/one"], ["a"]);
        cleanup(&path);
    }
    #[test]
    fn invalid_group_does_not_overwrite_saved_state() {
        let path = path();
        let before = update(&path, patch(json!({"projects": {"add": ["one", "two"]}}))).unwrap();
        assert!(update(
            &path,
            patch(json!({"projectGroups": {
                "one": {"name": "Invalid", "primary": "one", "folders": ["one", "two"]}
            }}))
        )
        .is_err());
        assert_eq!(read(&path).unwrap(), before);
        cleanup(&path);
    }
    #[test]
    fn corrupt_file_is_reported_not_reset_or_overwritten() {
        let path = path();
        crate::atomic_write::write(&path, b"broken").unwrap();
        assert!(read(&path).is_err());
        assert!(update(&path, WorkspaceStatePatch::default()).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"broken");
        cleanup(&path);
    }
    #[test]
    fn metadata_deletion_and_unpin_are_persisted() {
        let path = path();
        update(
            &path,
            patch(json!({
                "projects": {"add": ["one"]}, "pinnedProjects": {"add": ["one"]},
                "projectGroups": {"one": {"name": "One", "primary": "one", "folders": ["one"]}},
                "sessionOrder": {"one": ["a"]}
            })),
        )
        .unwrap();
        let state = update(&path, patch(json!({
            "pinnedProjects": {"remove": ["one"]}, "projectGroups": {"one": null}, "sessionOrder": {"one": null}
        }))).unwrap();
        assert!(state.pinned_projects.is_empty());
        assert!(state.project_groups.is_empty());
        assert!(state.session_order.is_empty());
        assert_eq!(read(&path).unwrap(), state);
        cleanup(&path);
    }

    fn draft(id: &str) -> serde_json::Value {
        json!({"id": id, "project": "", "message": "", "createdAt": 1, "updatedAt": 2})
    }
    fn activity(run_id: &str, updated_at: u64) -> serde_json::Value {
        json!({"file": "/session.jsonl", "project": "ssh://dev@host/project", "status": "running", "runId": run_id, "updatedAt": updated_at})
    }

    #[test]
    fn old_workspace_defaults_kanban_maps_and_independent_drafts_survive_restart() {
        let path = path();
        crate::atomic_write::write(&path, br#"{"revision":4,"projects":["one"]}"#).unwrap();
        let legacy = read(&path).unwrap();
        assert!(legacy.board_column_order.is_empty());
        assert!(legacy.board_drafts.is_empty());
        assert!(legacy.session_activities.is_empty());
        assert!(legacy.session_acknowledgements.is_empty());
        update(&path, patch(json!({"boardDrafts": {"a": draft("a")}}))).unwrap();
        let state = update(&path, patch(json!({"boardDrafts": {"b": draft("b")}}))).unwrap();
        assert_eq!(state.board_drafts.len(), 2);
        assert_eq!(read(&path).unwrap(), state);
        let mut launched = draft("a");
        launched["sessionFile"] = json!("/real.jsonl");
        launched["runtimeId"] = json!("a");
        launched["updatedAt"] = json!(3);
        let state = update(&path, patch(json!({"boardDrafts": {"a": launched}}))).unwrap();
        assert_eq!(state.board_drafts["a"].message, "");
        assert_eq!(state.board_drafts["a"].runtime_id.as_deref(), Some("a"));
        assert_eq!(read(&path).unwrap(), state);
        let state = update(&path, patch(json!({"boardDrafts": {"a": null}}))).unwrap();
        assert!(!state.board_drafts.contains_key("a"));
        assert!(state.board_drafts.contains_key("b"));
        cleanup(&path);
    }

    #[test]
    fn board_draft_composer_options_and_attachment_bytes_survive_restart() {
        let path = path();
        let mut value = draft("image-task");
        value["modelKey"] = json!("test/reasoner");
        value["thinkingLevel"] = json!("high");
        value["selection"] = json!({"project": "/repo", "worktree": true, "branch": "main"});
        value["attachments"] = json!([{
            "filename": "photo.png", "mediaType": "image/png",
            "url": "data:image/png;base64,aGVsbG8="
        }]);
        let state = update(&path, patch(json!({"boardDrafts": {"image-task": value}}))).unwrap();
        let saved = &state.board_drafts["image-task"];
        assert_eq!(saved.model_key.as_deref(), Some("test/reasoner"));
        assert_eq!(saved.thinking_level.as_deref(), Some("high"));
        let selection = saved.selection.as_ref().unwrap();
        assert_eq!(selection.project, "/repo");
        assert!(selection.worktree);
        assert_eq!(selection.branch, "main");
        assert_eq!(saved.attachments[0].url, "data:image/png;base64,aGVsbG8=");
        assert_eq!(read(&path).unwrap(), state);
        cleanup(&path);
    }

    #[test]
    fn column_orders_patch_opaque_keys_independently_and_survive_restart() {
        let path = path();
        let key = serde_json::to_string(&[r"C:\Project\", "running"]).unwrap();
        let other_key = serde_json::to_string(&["C:/Project/", "running"]).unwrap();
        let ids = [r"C:\Cards\one", "c:/cards/one", "draft:two"];
        let first = update(
            &path,
            patch(json!({
                "boardColumnOrder": {(&key): [ids[0], ids[1], ids[0], ids[2], ids[2]]}
            })),
        )
        .unwrap();
        assert_eq!(first.board_column_order[&key], ids);
        let state = update(
            &path,
            patch(json!({
                "boardColumnOrder": {(&other_key): ["remote"]}
            })),
        )
        .unwrap();
        assert_eq!(state.board_column_order.len(), 2);
        assert_eq!(state.board_column_order[&key], ids);
        assert_eq!(state.board_column_order[&other_key], ["remote"]);
        assert_eq!(read(&path).unwrap(), state);
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(saved["boardColumnOrder"][&key], json!(ids));
        let state = update(
            &path,
            patch(json!({
                "boardColumnOrder": {(&key): [], (&other_key): null}
            })),
        )
        .unwrap();
        assert_eq!(state.board_column_order.len(), 1);
        assert!(state.board_column_order[&key].is_empty());
        assert_eq!(read(&path).unwrap(), state);
        cleanup(&path);
    }

    #[test]
    fn reading_column_orders_deduplicates_without_normalizing_keys_or_ids() {
        let path = path();
        let key = serde_json::to_string(&["ssh://HOST/project/", "todo"]).unwrap();
        let ids = ["draft:one", r"C:\Cards\one", "C:/Cards/one", "", " "];
        crate::atomic_write::write(&path, &serde_json::to_vec(&json!({
            "boardColumnOrder": {(&key): [ids[0], ids[1], ids[2], ids[0], ids[3], ids[4], ids[3]]}
        })).unwrap()).unwrap();
        let state = read(&path).unwrap();
        assert_eq!(state.board_column_order.len(), 1);
        assert_eq!(state.board_column_order[&key], ids);
        cleanup(&path);
    }

    #[test]
    fn composite_keys_remain_exact_and_old_activity_and_ack_cannot_hide_new_run() {
        let path = path();
        let key = r#"["ssh://dev@HOST/project","C:\\sessions\\one.jsonl"]"#;
        let other_key = r#"["ssh://dev@host/project","C:/sessions/one.jsonl"]"#;
        update(&path, patch(json!({
            "sessionActivities": {(key): activity("old", 10), (other_key): activity("other", 10)},
            "sessionAcknowledgements": {(key): "old"}
        }))).unwrap();
        let state = update(
            &path,
            patch(json!({"sessionActivities": {(key): activity("new", 20)}})),
        )
        .unwrap();
        assert_eq!(state.session_acknowledgements[key], "old");
        assert_eq!(state.session_activities[key].run_id, "new");
        update(
            &path,
            patch(json!({"sessionAcknowledgements": {(key): "new"}})),
        )
        .unwrap();
        let state = update(
            &path,
            patch(json!({
                "sessionActivities": {(key): activity("old", 19)},
                "sessionAcknowledgements": {(key): "old"}
            })),
        )
        .unwrap();
        assert_eq!(state.session_activities.len(), 2);
        assert_eq!(state.session_activities[key].run_id, "new");
        assert_eq!(state.session_acknowledgements[key], "new");
        assert!(state.session_activities.contains_key(other_key));
        assert_eq!(read(&path).unwrap(), state);
        let state = update(
            &path,
            patch(json!({
                "sessionActivities": {(other_key): null}, "sessionAcknowledgements": {(key): null}
            })),
        )
        .unwrap();
        assert_eq!(state.session_activities.len(), 1);
        assert!(state.session_acknowledgements.is_empty());
        cleanup(&path);
    }

    #[test]
    fn invalid_kanban_records_do_not_overwrite_saved_state() {
        let path = path();
        let before = update(
            &path,
            patch(json!({"boardDrafts": {"saved": draft("saved")}})),
        )
        .unwrap();
        for invalid in [
            json!({"boardDrafts": {"wrong-key": draft("different-id")}}),
            json!({"boardDrafts": {"": draft("")}}),
            json!({"boardDrafts": {"bad-time": {"id": "bad-time", "project": "", "message": "", "createdAt": 3, "updatedAt": 2}}}),
            json!({"sessionActivities": {"key": activity("", 10)}}),
            json!({"sessionActivities": {"key": {"file": "", "project": "", "status": "idle", "runId": "r", "updatedAt": 10}}}),
            json!({"sessionActivities": {"key": {"file": "f", "project": "", "status": "idle", "runId": "r", "updatedAt": -1}}}),
            json!({"sessionAcknowledgements": {"key": ""}}),
        ] {
            assert!(update(&path, patch(invalid)).is_err());
            assert_eq!(read(&path).unwrap(), before);
        }
        assert!(serde_json::from_value::<WorkspaceStatePatch>(json!({
            "sessionActivities": {"key": {"file": "f", "project": "", "status": "invalid", "runId": "r", "updatedAt": 10}}
        })).is_err());
        cleanup(&path);
    }

    #[test]
    fn stable_run_replaces_local_placeholder_even_with_an_earlier_timestamp() {
        let path = path();
        let key = "session-key";
        update(
            &path,
            patch(json!({"sessionActivities": {(key): activity("local:pending", 100)}})),
        )
        .unwrap();
        let state = update(
            &path,
            patch(json!({"sessionActivities": {(key): activity("local:older", 99)}})),
        )
        .unwrap();
        assert_eq!(state.session_activities[key].run_id, "local:pending");
        let state = update(
            &path,
            patch(json!({"sessionActivities": {(key): activity("stable-uuid", 10)}})),
        )
        .unwrap();
        assert_eq!(state.session_activities[key].run_id, "stable-uuid");
        assert_eq!(state.session_activities[key].updated_at, 10.0);
        let state = update(
            &path,
            patch(json!({"sessionActivities": {(key): activity("older-uuid", 9)}})),
        )
        .unwrap();
        assert_eq!(state.session_activities[key].run_id, "stable-uuid");
        assert_eq!(read(&path).unwrap(), state);
        cleanup(&path);
    }

    #[test]
    fn board_drafts_have_no_count_limit() {
        let path = path();
        let drafts: serde_json::Map<String, serde_json::Value> = (0..1001)
            .map(|i| {
                let id = format!("draft-{i}");
                (id.clone(), draft(&id))
            })
            .collect();
        let state = update(&path, patch(json!({"boardDrafts": drafts}))).unwrap();
        assert_eq!(state.board_drafts.len(), 1001);
        assert_eq!(read(&path).unwrap(), state);
        cleanup(&path);
    }
}
