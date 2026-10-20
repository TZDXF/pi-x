//! Shared sidebar metadata. No webview/localStorage migration: development starts fresh.
use std::{collections::BTreeMap, path::Path, sync::Mutex};

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
    let windows = |s: &str| {
        s.starts_with("//")
            || (s.len() >= 3
                && s.as_bytes()[0].is_ascii_alphabetic()
                && &s.as_bytes()[1..3] == b":/")
    };
    if windows(&a) || windows(&b) {
        a.to_lowercase() == b.to_lowercase()
    } else {
        a == b
    }
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
fn normalize(state: &mut WorkspaceState) -> Result<(), String> {
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
}
