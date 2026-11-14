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

/// 与 `lib/sidebarTabs.ts` 的 `SIDEBAR_TAB_KINDS` 保持一致；`aux`/未知 kind 读盘即丢弃。
const SIDEBAR_TAB_KINDS: [&str; 4] = ["review", "files", "terminal", "browser"];
const SIDEBAR_TAB_LIMIT: usize = 20;

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
    sidebar_tabs: BTreeMap<String, SidebarTabs>,
}
/// 右侧侧栏 Tab：只存 kind 顺序与 active 下标，按会话身份键分组。
///
/// 反序列化刻意做成**宽容**的：单条记录格式不对（`kinds` 不是数组、项不是字符串、
/// `active` 是字符串或负数）只按能读出来的部分重建，绝不让整份 `workspace.json`
/// 解析失败。`active` 因此用有符号类型并在解析期钳成 0（用 `usize` 时磁盘上
/// 出现 `-1` 会让 `read()` 直接失败，`update()` 也随之失败——用户只能手改文件）。
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SidebarTabs {
    kinds: Vec<String>,
    active: usize,
}

fn lenient_sidebar_tabs(value: &serde_json::Value) -> SidebarTabs {
    let kinds = value
        .get("kinds")
        .and_then(|kinds| kinds.as_array())
        .map(|kinds| {
            kinds
                .iter()
                .filter_map(|kind| kind.as_str().map(str::to_owned))
                .take(SIDEBAR_TAB_LIMIT)
                .collect()
        })
        .unwrap_or_default();
    let active = match value.get("active") {
        Some(serde_json::Value::Number(number)) => number
            .as_i64()
            .or_else(|| number.as_f64().map(|value| value.trunc() as i64))
            .unwrap_or(0),
        _ => 0,
    };
    SidebarTabs { kinds, active: active.max(0) as usize }
}

impl<'de> Deserialize<'de> for SidebarTabs {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // 非对象（字符串/数组/null）当作空记录，同样不会让整份状态解析失败；
        // 空记录会在 `normalize` 里被当作"没有可恢复内容"丢掉。
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(lenient_sidebar_tabs(&value))
    }
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
    sidebar_tabs: BTreeMap<String, Option<SidebarTabs>>,
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
    // 侧栏 Tab：只接受四个已知 kind，`active` 钳到合法下标。
    //
    // 丢弃未知/aux kind 后若某组为空，**删除该组键**而不是整体报错：`read()` 里
    // 一次 normalize 失败会拒绝整个 workspace.json，把其余项目的侧栏状态一起丢掉，
    // 与"丢掉未知 Tab、保留其余状态"的备份/降级语义不符。
    for (key, tabs) in std::mem::take(&mut state.sidebar_tabs) {
        if key.trim().is_empty() {
            continue;
        }
        let mut kinds: Vec<String> = tabs
            .kinds
            .into_iter()
            .filter(|kind| SIDEBAR_TAB_KINDS.contains(&kind.as_str()))
            .take(SIDEBAR_TAB_LIMIT)
            .collect();
        if kinds.is_empty() {
            continue;
        }
        let active = tabs.active.min(kinds.len() - 1);
        kinds.shrink_to_fit();
        state
            .sidebar_tabs
            .insert(key, SidebarTabs { kinds, active });
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
    // 会话身份键不是路径：必须走 identity_map，否则 normalize_path 会破坏键。
    update_identity_map(&mut state.sidebar_tabs, patch.sidebar_tabs);
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
    fn sidebar_tabs_patch_round_trips_and_keeps_identity_keys() {
        let path = path();
        // 本地身份键是 `project\0file`，project 可能是 Windows 路径（带反斜杠）。
        // `update_map` 会把它当路径走 `normalize_path`（反斜杠→斜杠、去尾斜杠），
        // 因此必须用真实的 Windows 反斜杠 + NUL 键，才能区分 identity_map 与 update_map。
        let key = "C:\\Users\\dev\\proj\0C:\\Users\\dev\\proj\\sessions\\a.jsonl";
        let state = update(
            &path,
            patch(json!({
                "sidebarTabs": { key: { "kinds": ["review", "files", "terminal"], "active": 2 } }
            })),
        )
        .unwrap();
        assert_eq!(
            state.sidebar_tabs.keys().next().map(String::as_str),
            Some(key),
            "Windows 反斜杠 + NUL 的身份键必须原样保留"
        );
        assert_eq!(
            state.sidebar_tabs[key].kinds,
            vec!["review", "files", "terminal"]
        );
        assert_eq!(state.sidebar_tabs[key].active, 2);

        // 远程项目的 JSON 数组身份键同样原样保留（键里含 / 与引号）。
        let remote_key = "[\"ssh://dev@host:22/home/dev/proj\",\"/home/dev/proj/s.jsonl\"]";
        let state = update(
            &path,
            patch(json!({ "sidebarTabs": { remote_key: { "kinds": ["browser"], "active": 0 } } })),
        )
        .unwrap();
        assert!(state.sidebar_tabs.contains_key(remote_key));

        // 删除条目（关闭最后一个 Tab），两个键都要能精确命中。
        let state = update(
            &path,
            patch(json!({ "sidebarTabs": { key: null, remote_key: null } })),
        )
        .unwrap();
        assert!(state.sidebar_tabs.is_empty());
        cleanup(&path);
    }

    /// 仅含未知/aux kind 的组被清空 → 删除该组键，而不是让 read() 拒绝整个
    /// workspace.json（其余组必须保留）。
    #[test]
    fn sidebar_tabs_group_with_only_unknown_kinds_is_dropped_not_fatal() {
        let path = path();
        let state = update(
            &path,
            patch(json!({
                "sidebarTabs": {
                    "runtime:a": { "kinds": ["aux"], "active": 0 },
                    "runtime:b": { "kinds": ["review", "aux"], "active": 1 }
                }
            })),
        )
        .unwrap();
        assert!(!state.sidebar_tabs.contains_key("runtime:a"));
        assert_eq!(state.sidebar_tabs["runtime:b"].kinds, vec!["review"]);
        assert_eq!(state.sidebar_tabs["runtime:b"].active, 0);
        cleanup(&path);
    }

    #[test]
    fn sidebar_tabs_normalize_drops_aux_and_unknown_kinds_and_clamps_active() {
        let path = path();
        let state = update(
            &path,
            patch(json!({
                "sidebarTabs": { "runtime:r1": { "kinds": ["aux", "review", "mystery", "browser"], "active": 9 } }
            })),
        )
        .unwrap();
        // `aux`（TZD-94）与未知 kind 读盘即丢弃；active 钳到合法下标。
        assert_eq!(state.sidebar_tabs["runtime:r1"].kinds, vec!["review", "browser"]);
        assert_eq!(state.sidebar_tabs["runtime:r1"].active, 1);
        cleanup(&path);
    }

    /// 空 kinds / 空白键：静默丢弃该组，不影响其余状态（与"丢未知 Tab 保留其余"一致）。
    #[test]
    fn sidebar_tabs_drop_empty_groups_without_failing() {
        let path = path();
        let state = update(
            &path,
            patch(json!({
                "sidebarTabs": {
                    "k": { "kinds": [], "active": 0 },
                    " ": { "kinds": ["review"], "active": 0 },
                    "runtime:ok": { "kinds": ["review"], "active": 0 }
                }
            })),
        )
        .unwrap();
        assert!(!state.sidebar_tabs.contains_key("k"));
        assert_eq!(state.sidebar_tabs.len(), 1, "只保留合法组");
        assert!(state.sidebar_tabs.contains_key("runtime:ok"));
        if path.parent().is_some_and(|dir| dir.exists()) {
            cleanup(&path);
        }
    }

    /// 负数/越界 `active` 与超限 kinds：反序列化与 normalize 都必须局部净化。
    #[test]
    fn sidebar_tabs_negative_active_deserializes_and_clamps_to_zero() {
        let path = path();
        let state = update(
            &path,
            patch(json!({
                "sidebarTabs": {
                    "runtime:neg": { "kinds": ["review", "files"], "active": -1 },
                    "runtime:many": {
                        "kinds": std::iter::repeat("review").take(SIDEBAR_TAB_LIMIT + 1).collect::<Vec<_>>(),
                        "active": 99
                    }
                }
            })),
        )
        .unwrap();
        assert_eq!(state.sidebar_tabs["runtime:neg"].active, 0);
        let many = &state.sidebar_tabs["runtime:many"];
        assert_eq!(many.kinds.len(), SIDEBAR_TAB_LIMIT, "超限必须截断而不是拒绝写入");
        assert_eq!(many.active, SIDEBAR_TAB_LIMIT - 1);
        cleanup(&path);
    }

    /// 被污染的 workspace.json：读路径必须能读出其余状态，且删除脏键的 patch 必须成功
    /// （否则用户只能手改文件）。
    #[test]
    fn sidebar_tabs_polluted_file_is_readable_and_the_dirty_key_can_be_deleted() {
        let path = path();
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({
                "revision": 1,
                "projects": ["C:/project"],
                "sidebarTabs": {
                    "runtime:many": {
                        "kinds": std::iter::repeat("review").take(SIDEBAR_TAB_LIMIT + 1).collect::<Vec<_>>(),
                        "active": -1
                    },
                    "runtime:aux": { "kinds": ["aux", "mystery"], "active": 0 },
                    "runtime:junk": "not-an-object",
                    "runtime:ok": { "kinds": ["review", "browser"], "active": 1 }
                }
            }))
            .unwrap(),
        )
        .unwrap();
        let state = read(&path).expect("单条脏记录不得让整份 workspace 读取失败");
        assert_eq!(state.projects, vec!["C:/project"]);
        assert_eq!(state.sidebar_tabs["runtime:many"].kinds.len(), SIDEBAR_TAB_LIMIT);
        assert!(!state.sidebar_tabs.contains_key("runtime:aux"));
        assert_eq!(state.sidebar_tabs["runtime:ok"].kinds, vec!["review", "browser"]);

        // 删除所有脏键：`update` 内部先 `read`，所以这条同时验证"读路径不阻断更新"。
        let state = update(
            &path,
            patch(json!({
                "sidebarTabs": {
                    "runtime:many": null,
                    "runtime:aux": null,
                    "runtime:junk": null,
                    "runtime:ok": null
                }
            })),
        )
        .expect("删除脏键必须成功");
        assert!(state.sidebar_tabs.is_empty());
        cleanup(&path);
    }

    /// **直接 `read()` 回归**：把**原始**含未知/aux/空组的 JSON 写到磁盘（不经
    /// `update()` 过滤），断言 `read()` 接受它、保留合法组、丢弃非法组。
    /// 之前两条测试都从空文件出发走 `update()`，未知组在写盘前就被过滤掉了，
    /// 根本没走到"读一个本来就有脏组的文件"这条路径。
    #[test]
    fn read_accepts_a_file_that_already_contains_unknown_or_empty_groups() {
        let path = path();
        let dir = path.parent().unwrap();
        std::fs::create_dir_all(dir).unwrap();
        let raw = json!({
            "revision": 3,
            "sidebarTabs": {
                "runtime:aux-only": { "kinds": ["aux"], "active": 0 },
                "runtime:unknown-only": { "kinds": ["mystery"], "active": 0 },
                "runtime:empty": { "kinds": [], "active": 0 },
                "runtime:blank-key": { "kinds": ["review"], "active": 5 },
                "runtime:good": { "kinds": ["review", "aux", "browser"], "active": 9 }
            }
        });
        std::fs::write(&path, serde_json::to_vec_pretty(&raw).unwrap()).unwrap();

        // 旧实现（空组直接 Err）会在这里整体失败。
        let state = read(&path).expect("含未知/aux/空组的文件必须被接受");

        assert!(
            !state.sidebar_tabs.contains_key("runtime:aux-only"),
            "只有 aux 的组要被丢弃"
        );
        assert!(
            !state.sidebar_tabs.contains_key("runtime:unknown-only"),
            "只有未知 kind 的组要被丢弃"
        );
        assert!(
            !state.sidebar_tabs.contains_key("runtime:empty"),
            "空 kinds 的组要被丢弃"
        );
        // 合法组保留，未知 kind 被剔除，active 被钳制。
        assert_eq!(state.sidebar_tabs["runtime:good"].kinds, vec!["review", "browser"]);
        assert_eq!(state.sidebar_tabs["runtime:good"].active, 1);
        assert_eq!(
            state.sidebar_tabs["runtime:blank-key"].kinds,
            vec!["review"],
            "key 不是空白（runtime:blank-key）→ 保留"
        );
        assert_eq!(state.sidebar_tabs["runtime:blank-key"].active, 0);
        assert_eq!(state.revision, 3, "其余字段不受影响");
        cleanup(&path);
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
