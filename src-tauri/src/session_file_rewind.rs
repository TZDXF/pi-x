//! Hash-checked file rewind for tool-level file-change artifacts.

use std::collections::{BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::task::spawn_blocking;

use crate::{
    data_dir,
    errors::{pix_error, pix_error_detail},
    sessions,
};

const MISSING_HASH: &str = "missing";
static REWIND_STATE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Default, Deserialize, Serialize)]
struct RewindState {
    version: u8,
    reverted: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRewindArtifact {
    pub tool_call_id: String,
    pub tool_name: String,
    pub files: Vec<FileRewindArtifactFile>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRewindArtifactFile {
    pub path: String,
    pub existed_before: bool,
    pub before_content: Option<String>,
    pub before_hash: Option<String>,
    pub after_content: Option<String>,
    pub after_hash: Option<String>,
    pub unsupported_reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRewindFile {
    pub path: String,
    pub operation_count: usize,
    pub tool_names: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRewindPreview {
    pub can_apply: bool,
    pub safe_files: Vec<FileRewindFile>,
    pub unsafe_files: Vec<FileRewindFile>,
    pub ignored_files: Vec<FileRewindFile>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRewindApplyResult {
    pub applied: bool,
    pub preview: FileRewindPreview,
    pub response: String,
    pub reverted_tool_call_ids: Vec<String>,
}

#[derive(Clone)]
struct PlannedFile {
    path: String,
    resolved: PathBuf,
    delete: bool,
    before_content: Option<String>,
    expected_hash: String,
    operation_count: usize,
    tool_names: BTreeSet<String>,
}

struct RewindPlan {
    preview: FileRewindPreview,
    files: Vec<PlannedFile>,
}

fn hash_bytes(bytes: &[u8]) -> String {
    // sha2 0.11 的 finalize() 返回值不再实现 LowerHex，手动转十六进制
    let digest = {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        hasher.finalize()
    };
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest.iter() {
        use std::fmt::Write as _;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn hash_optional(content: Option<&str>) -> String {
    content
        .map(|value| hash_bytes(value.as_bytes()))
        .unwrap_or_else(|| MISSING_HASH.into())
}

fn resolve_project_path(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(raw);
    // 缺失路径不能靠 starts_with 检查含 .. 的未归一化字符串，避免越过项目边界。
    if raw.trim().is_empty()
        || candidate
            .components()
            .any(|part| part == Component::ParentDir)
    {
        return Err(pix_error_detail(
            "rewindPathInvalid",
            "无效的文件路径: {detail}",
            raw,
        ));
    }
    let mut path = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(candidate)
    };
    if path.exists() {
        path = dunce::canonicalize(&path)
            .map_err(|_| pix_error_detail("rewindPathInvalid", "无效的文件路径: {detail}", raw))?;
    } else {
        let mut missing = Vec::new();
        let mut ancestor = path.as_path();
        while !ancestor.exists() {
            let name = ancestor.file_name().ok_or_else(|| {
                pix_error_detail("rewindPathInvalid", "无效的文件路径: {detail}", raw)
            })?;
            missing.push(name.to_os_string());
            ancestor = ancestor.parent().ok_or_else(|| {
                pix_error_detail("rewindPathInvalid", "无效的文件路径: {detail}", raw)
            })?;
        }
        let mut resolved = dunce::canonicalize(ancestor)
            .map_err(|_| pix_error_detail("rewindPathInvalid", "无效的文件路径: {detail}", raw))?;
        for part in missing.into_iter().rev() {
            resolved.push(part);
        }
        path = resolved;
    }
    if !path.starts_with(root) {
        return Err(pix_error_detail(
            "rewindPathInvalid",
            "无效的文件路径: {detail}",
            raw,
        ));
    }
    Ok(path)
}

fn is_ignored_shell(tool_name: &str) -> bool {
    let normalized: String = tool_name
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    normalized == "bash"
        || normalized == "shell"
        || normalized.contains("terminal")
        || normalized.ends_with("shell")
}

fn read_optional_text(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| {
            pix_error_detail(
                "rewindNotUtf8",
                "文件不是 UTF-8 文本: {detail}",
                path.display(),
            )
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(pix_error_detail(
            "rewindReadFailed",
            "读取文件失败: {detail}",
            e,
        )),
    }
}

fn safe_file(file: &PlannedFile) -> FileRewindFile {
    FileRewindFile {
        path: file.path.clone(),
        operation_count: file.operation_count,
        tool_names: file.tool_names.iter().cloned().collect(),
        reason: None,
        expected_hash: None,
        current_hash: None,
        message: None,
    }
}

fn unsafe_file(
    path: impl Into<String>,
    reason: &str,
    operation_count: usize,
    tool_names: BTreeSet<String>,
    message: Option<String>,
) -> FileRewindFile {
    FileRewindFile {
        path: path.into(),
        operation_count,
        tool_names: tool_names.into_iter().collect(),
        reason: Some(reason.into()),
        expected_hash: None,
        current_hash: None,
        message,
    }
}

fn build_plan(root: &Path, artifacts: &[FileRewindArtifact]) -> RewindPlan {
    let mut plans: HashMap<PathBuf, PlannedFile> = HashMap::new();
    let mut unsafe_files: Vec<FileRewindFile> = Vec::new();
    let mut ignored_files: Vec<FileRewindFile> = Vec::new();

    for artifact in artifacts {
        if is_ignored_shell(&artifact.tool_name) {
            for file in &artifact.files {
                if let Some(existing) = ignored_files.iter_mut().find(|item| item.path == file.path)
                {
                    existing.operation_count += 1;
                    if !existing.tool_names.contains(&artifact.tool_name) {
                        existing.tool_names.push(artifact.tool_name.clone());
                    }
                } else {
                    ignored_files.push(FileRewindFile {
                        path: file.path.clone(),
                        operation_count: 1,
                        tool_names: vec![artifact.tool_name.clone()],
                        reason: Some("bash_ignored".into()),
                        expected_hash: None,
                        current_hash: None,
                        message: None,
                    });
                }
            }
            continue;
        }

        for file in &artifact.files {
            let complete = file.existed_before == file.before_content.is_some()
                && file
                    .before_hash
                    .as_deref()
                    .is_none_or(|hash| hash == hash_optional(file.before_content.as_deref()))
                && file
                    .after_hash
                    .as_deref()
                    .is_none_or(|hash| hash == hash_optional(file.after_content.as_deref()));
            let unsupported = file.unsupported_reason.as_deref().or_else(|| {
                (!complete || artifact.tool_call_id.trim().is_empty())
                    .then_some("incomplete_artifact")
            });
            if let Some(reason) = unsupported {
                unsafe_files.push(unsafe_file(
                    file.path.clone(),
                    "unsupported_artifact",
                    1,
                    BTreeSet::from([artifact.tool_name.clone()]),
                    Some(reason.into()),
                ));
                continue;
            }
            let resolved = match resolve_project_path(root, &file.path) {
                Ok(path) => path,
                Err(message) => {
                    unsafe_files.push(unsafe_file(
                        file.path.clone(),
                        "file_read_failed",
                        1,
                        BTreeSet::from([artifact.tool_name.clone()]),
                        Some(message),
                    ));
                    continue;
                }
            };
            let expected_hash = hash_optional(file.after_content.as_deref());
            let delete = !file.existed_before;
            let key = resolved.clone();
            if let Some(existing) = plans.get_mut(&key) {
                // 必须逐操作验证 before/after 衔接，不能只检查最后一次 after。
                // 两次工具修改之间的外部编辑也会使整组撤销失败。
                if existing.expected_hash != hash_optional(file.before_content.as_deref()) {
                    unsafe_files.push(unsafe_file(
                        file.path.clone(),
                        "unsupported_artifact",
                        existing.operation_count + 1,
                        BTreeSet::from([artifact.tool_name.clone()]),
                        Some("File change records are discontinuous.".into()),
                    ));
                }
                existing.operation_count += 1;
                existing.tool_names.insert(artifact.tool_name.clone());
                existing.expected_hash = expected_hash;
                continue;
            }
            plans.insert(
                key,
                PlannedFile {
                    path: file.path.clone(),
                    resolved,
                    delete,
                    before_content: file.before_content.clone(),
                    expected_hash,
                    operation_count: 1,
                    tool_names: BTreeSet::from([artifact.tool_name.clone()]),
                },
            );
        }
    }

    let unsafe_paths = unsafe_files
        .iter()
        .filter_map(|file| resolve_project_path(root, &file.path).ok())
        .collect::<BTreeSet<_>>();
    let mut safe_plans = Vec::new();
    for (path, file) in plans {
        // 同一实际文件的任一记录不安全，就不能又出现在“可安全回滚”列表里。
        if unsafe_paths.contains(&path) {
            continue;
        }
        match read_optional_text(&file.resolved) {
            Ok(current) => {
                let current_hash = hash_optional(current.as_deref());
                if current_hash == file.expected_hash {
                    safe_plans.push(file);
                } else {
                    let mut unsafe_file = unsafe_file(
                        file.path,
                        "external_modified",
                        file.operation_count,
                        file.tool_names,
                        None,
                    );
                    unsafe_file.current_hash = Some(current_hash);
                    unsafe_file.expected_hash = Some(file.expected_hash);
                    unsafe_files.push(unsafe_file);
                }
            }
            Err(message) => unsafe_files.push(unsafe_file(
                file.path,
                "file_read_failed",
                file.operation_count,
                file.tool_names,
                Some(message),
            )),
        }
    }

    safe_plans.sort_by(|a, b| a.path.cmp(&b.path));
    unsafe_files.sort_by(|a, b| a.path.cmp(&b.path));
    ignored_files.sort_by(|a, b| a.path.cmp(&b.path));
    let safe_files = safe_plans.iter().map(safe_file).collect::<Vec<_>>();
    let can_apply = !safe_files.is_empty() && unsafe_files.is_empty();
    RewindPlan {
        preview: FileRewindPreview {
            can_apply,
            safe_files,
            unsafe_files,
            ignored_files,
        },
        files: safe_plans,
    }
}

fn write_text_atomic(path: &Path, content: &str) -> Result<(), String> {
    // std::fs::rename 在 Windows 上可直接覆盖已存在的目标文件，
    // 不能先删再写：两步之间崩溃会丢失原文件内容。
    crate::atomic_write::write(path, content.as_bytes())
        .map_err(|e| pix_error_detail("rewindWriteFailed", "写入文件失败: {detail}", e))
}

fn remove_missing_ok(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(pix_error_detail(
            "rewindWriteFailed",
            "删除文件失败: {detail}",
            e,
        )),
    }
}

fn compensate(journal: &[(PathBuf, Option<String>)]) -> Result<(), String> {
    let mut errors = Vec::new();
    for (path, previous) in journal.iter().rev() {
        let result = match previous {
            Some(content) => write_text_atomic(path, content),
            None => remove_missing_ok(path),
        };
        if let Err(error) = result {
            errors.push(format!("{}: {error}", path.display()));
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("; "))
    }
}

fn apply_plan_with_commit(
    root: &Path,
    plan: &RewindPlan,
    commit: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let mut journal = Vec::new();
    let result = (|| {
        for file in &plan.files {
            // 预览后父目录/符号链接可能改变，写入前再次确认路径仍属于项目。
            if resolve_project_path(root, &file.path)? != file.resolved {
                return Err(pix_error(
                    "rewindPathInvalid",
                    "文件路径已改变，无法自动回滚",
                ));
            }
            let previous = read_optional_text(&file.resolved)?;
            if hash_optional(previous.as_deref()) != file.expected_hash {
                return Err(pix_error(
                    "rewindExternalModified",
                    "文件已被外部修改，无法自动回滚",
                ));
            }
            journal.push((file.resolved.clone(), previous));
            if file.delete {
                remove_missing_ok(&file.resolved)?;
            } else {
                write_text_atomic(&file.resolved, file.before_content.as_deref().unwrap_or(""))?;
            }
        }
        // 已撤销标记属于这次操作的提交边界；保存失败时文件也恢复原状。
        commit()
    })();
    if let Err(error) = result {
        if let Err(compensation_error) = compensate(&journal) {
            return Err(pix_error_detail(
                "rewindCompensationFailed",
                "撤销失败且无法完整恢复文件: {detail}",
                format!("{error}; {compensation_error}"),
            ));
        }
        return Err(error);
    }
    Ok(())
}

#[cfg(test)]
fn apply_plan(root: &Path, plan: &RewindPlan) -> Result<(), String> {
    apply_plan_with_commit(root, plan, || Ok(()))
}

fn state_hash(text: &str) -> u64 {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn state_path(file: &Path) -> PathBuf {
    data_dir::root()
        .join("file-rewinds")
        .join(format!("{:016x}.json", state_hash(&file.to_string_lossy())))
}

fn read_state(file: &Path) -> RewindState {
    read_state_at(&state_path(file))
}

fn read_state_at(path: &Path) -> RewindState {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return RewindState {
            version: 1,
            reverted: Vec::new(),
        };
    };
    let mut state = serde_json::from_str::<RewindState>(&raw).unwrap_or_default();
    state.version = 1;
    state.reverted.sort();
    state.reverted.dedup();
    state
}

fn write_state(file: &Path, state: &RewindState) -> Result<(), String> {
    write_state_at(&state_path(file), state)
}

fn write_state_at(path: &Path, state: &RewindState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            pix_error_detail("rewindStateWriteFailed", "写入回滚状态失败: {detail}", e)
        })?;
    }
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| pix_error_detail("rewindStateWriteFailed", "写入回滚状态失败: {detail}", e))?;
    crate::atomic_write::write(path, body.as_bytes())
        .map_err(|e| pix_error_detail("rewindStateWriteFailed", "写入回滚状态失败: {detail}", e))
}

#[tauri::command]
pub async fn session_file_rewind_preview(
    project: String,
    artifacts: Vec<FileRewindArtifact>,
) -> Result<FileRewindPreview, String> {
    spawn_blocking(move || {
        let root = dunce::canonicalize(&project)
            .map_err(|_| pix_error("projectDirMissing", "项目目录不存在"))?;
        Ok(build_plan(&root, &artifacts).preview)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_file_rewind_apply(
    project: String,
    artifacts: Vec<FileRewindArtifact>,
    file: Option<String>,
) -> Result<FileRewindApplyResult, String> {
    spawn_blocking(move || {
        let root = dunce::canonicalize(&project)
            .map_err(|_| pix_error("projectDirMissing", "项目目录不存在"))?;
        // 先验证会话路径，再进行任何文件写入；锁防止并发撤销重复消费同一记录。
        let session = file
            .as_deref()
            .map(sessions::validate_session_path)
            .transpose()?;
        let _guard = REWIND_STATE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut state = session.as_deref().map(read_state);
        let mut plan = build_plan(&root, &artifacts);
        if let Some(state) = &state {
            for artifact in &artifacts {
                if !is_ignored_shell(&artifact.tool_name)
                    && state.reverted.contains(&artifact.tool_call_id)
                {
                    for item in &artifact.files {
                        plan.preview.unsafe_files.push(unsafe_file(
                            &item.path,
                            "already_reverted",
                            1,
                            BTreeSet::from([artifact.tool_name.clone()]),
                            None,
                        ));
                    }
                    plan.preview
                        .safe_files
                        .retain(|file| !artifact.files.iter().any(|item| item.path == file.path));
                    plan.preview.can_apply = false;
                }
            }
        }
        if !plan.preview.can_apply {
            return Ok(FileRewindApplyResult {
                applied: false,
                preview: plan.preview,
                response: "File rewind was not applied because at least one file is unsafe.".into(),
                reverted_tool_call_ids: Vec::new(),
            });
        }
        let reverted_tool_call_ids = artifacts
            .iter()
            .filter(|artifact| !is_ignored_shell(&artifact.tool_name))
            .map(|artifact| artifact.tool_call_id.clone())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        apply_plan_with_commit(&root, &plan, || {
            if let (Some(session), Some(state)) = (session.as_deref(), state.as_mut()) {
                state
                    .reverted
                    .extend(reverted_tool_call_ids.iter().cloned());
                state.reverted.sort();
                state.reverted.dedup();
                write_state(session, state)?;
            }
            Ok(())
        })?;
        let count = plan.preview.safe_files.len();
        Ok(FileRewindApplyResult {
            applied: true,
            preview: plan.preview,
            response: format!(
                "Rewound {count} file{} from tool change records.",
                if count == 1 { "" } else { "s" }
            ),
            reverted_tool_call_ids,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_file_rewind_state_get(file: String) -> Result<Vec<String>, String> {
    spawn_blocking(move || {
        let path = sessions::validate_session_path(&file)?;
        let _guard = REWIND_STATE_LOCK.lock().map_err(|e| e.to_string())?;
        Ok(read_state(&path).reverted)
    })
    .await
    .map_err(|e| e.to_string())?
}

/** 删除会话时使用此前已验证的路径，不能再要求 JSONL 仍存在。 */
pub(crate) fn delete_state_for_session(path: &Path) -> Result<(), String> {
    let _guard = REWIND_STATE_LOCK.lock().map_err(|e| e.to_string())?;
    remove_missing_ok(&state_path(path))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(
        tool_name: &str,
        path: &str,
        before: Option<&str>,
        after: Option<&str>,
    ) -> FileRewindArtifact {
        FileRewindArtifact {
            tool_call_id: uuid::Uuid::new_v4().to_string(),
            tool_name: tool_name.into(),
            files: vec![FileRewindArtifactFile {
                path: path.into(),
                existed_before: before.is_some(),
                before_content: before.map(str::to_string),
                before_hash: before.map(|value| hash_bytes(value.as_bytes())),
                after_content: after.map(str::to_string),
                after_hash: after.map(|value| hash_bytes(value.as_bytes())),
                unsupported_reason: None,
            }],
        }
    }

    #[test]
    fn created_then_deleted_is_external_modified() {
        let dir = std::env::temp_dir().join(format!("pix-rewind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let plan = build_plan(&dir, &[artifact("write", "new.txt", None, Some("hello\n"))]);
        assert!(!plan.preview.can_apply);
        assert_eq!(
            plan.preview.unsafe_files[0].reason.as_deref(),
            Some("external_modified")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn matching_overwrite_restores_before_content() {
        let dir = std::env::temp_dir().join(format!("pix-rewind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file.txt");
        std::fs::write(&path, "after\n").unwrap();
        let plan = build_plan(
            &dir,
            &[artifact(
                "write",
                "file.txt",
                Some("before\n"),
                Some("after\n"),
            )],
        );
        assert!(plan.preview.can_apply);
        apply_plan(&dir, &plan).unwrap();
        assert_eq!(std::fs::read_to_string(path).unwrap(), "before\n");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn write_text_atomic_overwrites_existing_file_in_place() {
        // 覆盖写不得先删目标文件：rename 直接替换，原内容全程可见。
        let dir = std::env::temp_dir().join(format!("pix-rewind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file.txt");
        std::fs::write(&path, "original\n").unwrap();
        write_text_atomic(&path, "replaced\n").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "replaced\n");
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "leftover temp files: {leftovers:?}");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn shell_changes_are_ignored_and_aggregate_operation_counts() {
        let dir = std::env::temp_dir().join(format!("pix-rewind-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("file.txt");
        std::fs::write(&path, "after\n").unwrap();
        let first = artifact("write", "file.txt", Some("before\n"), Some("middle\n"));
        let second = artifact("write", "file.txt", Some("middle\n"), Some("after\n"));
        let plan = build_plan(&dir, &[first, second]);
        assert!(plan.preview.can_apply);
        assert_eq!(plan.preview.safe_files[0].operation_count, 2);

        let ignored = build_plan(
            &dir,
            &[artifact(
                "bash",
                "file.txt",
                Some("before\n"),
                Some("after\n"),
            )],
        );
        assert!(!ignored.preview.can_apply);
        assert_eq!(
            ignored.preview.ignored_files[0].reason.as_deref(),
            Some("bash_ignored")
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    struct Workspace(PathBuf);

    impl Workspace {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("pix-artifact-undo-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dunce::canonicalize(dir).unwrap())
        }

        fn write(&self, path: &str, content: &str) {
            write_text_atomic(&self.0.join(path), content).unwrap();
        }

        fn read(&self, path: &str) -> String {
            std::fs::read_to_string(self.0.join(path)).unwrap()
        }
    }

    impl Drop for Workspace {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn repeated_tools_restore_first_before_without_a_git_repository() {
        let workspace = Workspace::new();
        workspace.write("file.txt", "final\n");
        workspace.write("untouched.txt", "external\n");
        let plan = build_plan(
            &workspace.0,
            &[
                artifact("write", "file.txt", Some("initial\n"), Some("middle\n")),
                artifact("edit", "file.txt", Some("middle\n"), Some("final\n")),
            ],
        );
        assert!(plan.preview.can_apply);
        assert_eq!(plan.preview.safe_files[0].operation_count, 2);
        apply_plan(&workspace.0, &plan).unwrap();
        assert_eq!(workspace.read("file.txt"), "initial\n");
        assert_eq!(workspace.read("untouched.txt"), "external\n");
        assert!(!workspace.0.join(".git").exists());
    }

    #[test]
    fn canonical_paths_group_relative_and_absolute_aliases() {
        let workspace = Workspace::new();
        workspace.write("file.txt", "final");
        let path = workspace.0.join("file.txt").to_string_lossy().into_owned();
        let plan = build_plan(
            &workspace.0,
            &[
                artifact("write", "./file.txt", Some("initial"), Some("middle")),
                artifact("edit", &path, Some("middle"), Some("final")),
            ],
        );
        assert!(plan.preview.can_apply);
        assert_eq!(plan.preview.safe_files.len(), 1);
        assert_eq!(plan.preview.safe_files[0].operation_count, 2);
        apply_plan(&workspace.0, &plan).unwrap();
        assert_eq!(workspace.read("file.txt"), "initial");
    }

    #[test]
    fn external_edit_between_tools_blocks_even_when_final_hash_matches() {
        let workspace = Workspace::new();
        workspace.write("file.txt", "final");
        let plan = build_plan(
            &workspace.0,
            &[
                artifact("write", "file.txt", Some("initial"), Some("middle")),
                artifact("edit", "file.txt", Some("external edit"), Some("final")),
            ],
        );
        assert!(!plan.preview.can_apply);
        assert_eq!(
            plan.preview.unsafe_files[0].reason.as_deref(),
            Some("unsupported_artifact")
        );
        assert!(plan.preview.safe_files.is_empty());
        assert_eq!(workspace.read("file.txt"), "final");
    }

    #[test]
    fn incomplete_before_is_not_treated_as_a_created_file() {
        let workspace = Workspace::new();
        workspace.write("file.txt", "after");
        let mut record = artifact("write", "file.txt", None, Some("after"));
        record.files[0].existed_before = true;
        let plan = build_plan(&workspace.0, &[record]);
        assert!(!plan.preview.can_apply);
        assert_eq!(
            plan.preview.unsafe_files[0].reason.as_deref(),
            Some("unsupported_artifact")
        );
        assert_eq!(workspace.read("file.txt"), "after");
    }

    #[test]
    fn inconsistent_content_hashes_are_not_trusted() {
        let workspace = Workspace::new();
        workspace.write("file.txt", "after");
        let mut record = artifact("write", "file.txt", Some("before"), Some("after"));
        record.files[0].after_hash = Some(hash_bytes(b"different content"));
        let plan = build_plan(&workspace.0, &[record]);
        assert!(!plan.preview.can_apply);
        assert_eq!(workspace.read("file.txt"), "after");
    }

    #[test]
    fn new_files_are_deleted_and_captured_deletions_can_be_restored() {
        let workspace = Workspace::new();
        workspace.write("created.txt", "created");
        let plan = build_plan(
            &workspace.0,
            &[
                artifact("write", "created.txt", None, Some("created")),
                artifact("edit", "deleted.txt", Some("deleted before"), None),
            ],
        );
        assert!(plan.preview.can_apply);
        apply_plan(&workspace.0, &plan).unwrap();
        assert!(!workspace.0.join("created.txt").exists());
        assert_eq!(workspace.read("deleted.txt"), "deleted before");
    }

    #[test]
    fn shell_files_are_ignored_without_blocking_safe_recorded_tools() {
        let workspace = Workspace::new();
        workspace.write("tool.txt", "after");
        workspace.write("pulled.txt", "remote change");
        let plan = build_plan(
            &workspace.0,
            &[
                artifact("write", "tool.txt", Some("before"), Some("after")),
                artifact("Bash", "pulled.txt", Some("old"), Some("remote change")),
            ],
        );
        assert!(plan.preview.can_apply);
        assert_eq!(plan.preview.ignored_files.len(), 1);
        apply_plan(&workspace.0, &plan).unwrap();
        assert_eq!(workspace.read("tool.txt"), "before");
        assert_eq!(workspace.read("pulled.txt"), "remote change");
    }

    #[tokio::test]
    async fn one_unsafe_file_blocks_the_whole_apply() {
        let workspace = Workspace::new();
        workspace.write("safe.txt", "after");
        workspace.write("unsafe.txt", "user edited");
        let result = session_file_rewind_apply(
            workspace.0.to_string_lossy().into_owned(),
            vec![
                artifact("write", "safe.txt", Some("before"), Some("after")),
                artifact("write", "unsafe.txt", Some("before"), Some("after")),
            ],
            None,
        )
        .await
        .unwrap();
        assert!(!result.applied);
        assert!(result.reverted_tool_call_ids.is_empty());
        assert_eq!(workspace.read("safe.txt"), "after");
        assert_eq!(workspace.read("unsafe.txt"), "user edited");
    }

    #[test]
    fn later_file_drift_compensates_earlier_writes() {
        let workspace = Workspace::new();
        workspace.write("a.txt", "after a");
        workspace.write("b.txt", "after b");
        let plan = build_plan(
            &workspace.0,
            &[
                artifact("write", "a.txt", Some("before a"), Some("after a")),
                artifact("write", "b.txt", Some("before b"), Some("after b")),
            ],
        );
        assert!(plan.preview.can_apply);
        workspace.write("b.txt", "external change after preview");
        assert!(apply_plan(&workspace.0, &plan).is_err());
        assert_eq!(workspace.read("a.txt"), "after a");
        assert_eq!(workspace.read("b.txt"), "external change after preview");
    }

    #[test]
    fn marker_commit_failure_compensates_restores_and_deletions() {
        let workspace = Workspace::new();
        workspace.write("created.txt", "created");
        workspace.write("existing.txt", "after");
        let plan = build_plan(
            &workspace.0,
            &[
                artifact("write", "created.txt", None, Some("created")),
                artifact("write", "existing.txt", Some("before"), Some("after")),
            ],
        );
        let result =
            apply_plan_with_commit(&workspace.0, &plan, || Err("marker write failed".into()));
        assert_eq!(result.unwrap_err(), "marker write failed");
        assert_eq!(workspace.read("created.txt"), "created");
        assert_eq!(workspace.read("existing.txt"), "after");
    }

    #[test]
    fn compensation_failure_is_reported_instead_of_silently_swallowed() {
        let workspace = Workspace::new();
        workspace.write("file.txt", "after");
        let plan = build_plan(
            &workspace.0,
            &[artifact("write", "file.txt", Some("before"), Some("after"))],
        );
        let error = apply_plan_with_commit(&workspace.0, &plan, || {
            std::fs::remove_file(workspace.0.join("file.txt")).unwrap();
            std::fs::create_dir(workspace.0.join("file.txt")).unwrap();
            Err("commit failed".into())
        })
        .unwrap_err();
        assert!(error.contains("rewindCompensationFailed"));
    }

    #[test]
    fn missing_paths_cannot_use_parent_traversal_to_escape_the_project() {
        let workspace = Workspace::new();
        let project = workspace.0.join("project");
        std::fs::create_dir(&project).unwrap();
        workspace.write("outside.txt", "do not touch");
        let plan = build_plan(
            &project,
            &[artifact(
                "write",
                "missing/../../outside.txt",
                None,
                Some("do not touch"),
            )],
        );
        assert!(!plan.preview.can_apply);
        assert_eq!(
            plan.preview.unsafe_files[0].reason.as_deref(),
            Some("file_read_failed")
        );
        assert_eq!(workspace.read("outside.txt"), "do not touch");
    }

    #[test]
    fn absolute_paths_outside_the_project_and_binary_files_are_unsafe() {
        let workspace = Workspace::new();
        let project = workspace.0.join("project");
        std::fs::create_dir(&project).unwrap();
        workspace.write("outside.txt", "do not touch");
        let outside = workspace
            .0
            .join("outside.txt")
            .to_string_lossy()
            .into_owned();
        assert!(
            !build_plan(
                &project,
                &[artifact("write", &outside, None, Some("do not touch"))]
            )
            .preview
            .can_apply
        );
        std::fs::write(project.join("binary.txt"), [0xff, 0xfe]).unwrap();
        assert!(
            !build_plan(
                &project,
                &[artifact("write", "binary.txt", None, Some("text"))]
            )
            .preview
            .can_apply
        );
    }

    #[test]
    fn utf8_bom_and_crlf_are_restored_byte_for_byte() {
        let workspace = Workspace::new();
        workspace.write("file.txt", "\u{feff}after\r\n");
        let plan = build_plan(
            &workspace.0,
            &[artifact(
                "write",
                "file.txt",
                Some("\u{feff}before\r\n"),
                Some("\u{feff}after\r\n"),
            )],
        );
        assert!(plan.preview.can_apply);
        apply_plan(&workspace.0, &plan).unwrap();
        assert_eq!(workspace.read("file.txt"), "\u{feff}before\r\n");
    }

    #[test]
    fn marker_state_is_atomic_and_survives_reopening() {
        let workspace = Workspace::new();
        let state_path = workspace.0.join("state").join("rewinds.json");
        write_state_at(
            &state_path,
            &RewindState {
                version: 1,
                reverted: vec!["second".into(), "first".into(), "first".into()],
            },
        )
        .unwrap();
        let reopened = read_state_at(&state_path);
        assert_eq!(reopened.version, 1);
        assert_eq!(reopened.reverted, ["first", "second"]);
        assert!(std::fs::read_dir(state_path.parent().unwrap())
            .unwrap()
            .all(|entry| !entry
                .unwrap()
                .path()
                .extension()
                .is_some_and(|ext| ext == "tmp")));
    }
}
