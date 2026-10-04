//! Hash-checked file rewind for tool-level file-change artifacts.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
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
    pub tool_name: String,
    pub files: Vec<FileRewindArtifactFile>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRewindArtifactFile {
    pub path: String,
    pub existed_before: bool,
    pub before_content: Option<String>,
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
    let mut plans: HashMap<String, PlannedFile> = HashMap::new();
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
            if let Some(reason) = file.unsupported_reason.as_deref() {
                unsafe_files.push(unsafe_file(
                    file.path.clone(),
                    "unsupported_checkpoint",
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
            let expected_hash = file
                .after_hash
                .clone()
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| hash_optional(file.after_content.as_deref()));
            let delete = !file.existed_before || file.before_content.is_none();
            let key = file.path.clone();
            if let Some(existing) = plans.get_mut(&key) {
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

    let mut safe_plans = Vec::new();
    for file in plans.into_values() {
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
    let can_apply = !safe_files.is_empty() && unsafe_files.is_empty() && ignored_files.is_empty();
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

fn compensate(journal: &[(PathBuf, Option<String>)]) {
    for (path, previous) in journal.iter().rev() {
        match previous {
            Some(content) => {
                let _ = write_text_atomic(path, content);
            }
            None => {
                let _ = remove_missing_ok(path);
            }
        }
    }
}

fn apply_plan(plan: &RewindPlan) -> Result<(), String> {
    let mut journal = Vec::new();
    for file in &plan.files {
        let previous = match read_optional_text(&file.resolved) {
            Ok(value) => value,
            Err(error) => {
                compensate(&journal);
                return Err(error);
            }
        };
        if hash_optional(previous.as_deref()) != file.expected_hash {
            compensate(&journal);
            return Err(pix_error(
                "rewindExternalModified",
                "文件已被外部修改，无法自动回滚",
            ));
        }
        journal.push((file.resolved.clone(), previous));
        let result = if file.delete {
            remove_missing_ok(&file.resolved)
        } else {
            write_text_atomic(&file.resolved, file.before_content.as_deref().unwrap_or(""))
        };
        if let Err(error) = result {
            compensate(&journal);
            return Err(error);
        }
    }
    Ok(())
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
    let Ok(raw) = std::fs::read_to_string(state_path(file)) else {
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
    let path = state_path(file);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            pix_error_detail("rewindStateWriteFailed", "写入回滚状态失败: {detail}", e)
        })?;
    }
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| pix_error_detail("rewindStateWriteFailed", "写入回滚状态失败: {detail}", e))?;
    std::fs::write(path, body)
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
) -> Result<FileRewindApplyResult, String> {
    spawn_blocking(move || {
        let root = dunce::canonicalize(&project)
            .map_err(|_| pix_error("projectDirMissing", "项目目录不存在"))?;
        let plan = build_plan(&root, &artifacts);
        if !plan.preview.can_apply {
            return Ok(FileRewindApplyResult {
                applied: false,
                preview: plan.preview,
                response: "File rewind was not applied because at least one file is unsafe.".into(),
            });
        }
        apply_plan(&plan)?;
        let count = plan.preview.safe_files.len();
        Ok(FileRewindApplyResult {
            applied: true,
            preview: plan.preview,
            response: format!(
                "Rewound {count} file{} from summary checkpoints.",
                if count == 1 { "" } else { "s" }
            ),
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

#[tauri::command]
pub async fn session_file_rewind_state_mark(
    file: String,
    tool_call_ids: Vec<String>,
) -> Result<Vec<String>, String> {
    spawn_blocking(move || {
        let path = sessions::validate_session_path(&file)?;
        let _guard = REWIND_STATE_LOCK.lock().map_err(|e| e.to_string())?;
        let mut state = read_state(&path);
        state.version = 1;
        state
            .reverted
            .extend(tool_call_ids.into_iter().filter(|id| !id.trim().is_empty()));
        state.reverted.sort();
        state.reverted.dedup();
        write_state(&path, &state)?;
        Ok(state.reverted)
    })
    .await
    .map_err(|e| e.to_string())?
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
            tool_name: tool_name.into(),
            files: vec![FileRewindArtifactFile {
                path: path.into(),
                existed_before: before.is_some(),
                before_content: before.map(str::to_string),
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
        apply_plan(&plan).unwrap();
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
}
