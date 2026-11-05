use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use crate::errors::pix_error;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StorageCategory {
    pub id: String,
    pub bytes: u64,
    pub file_count: u64,
    /// Sessions for the two session categories; files for workspaces.
    pub item_count: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageSummary {
    pub total_bytes: u64,
    pub categories: Vec<StorageCategory>,
    pub sessions_directory: String,
    pub scanned_at: i64,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageCleanupResult {
    pub freed_bytes: u64,
    pub deleted_items: u64,
    pub failed: u64,
}

fn category(id: &str) -> StorageCategory {
    StorageCategory {
        id: id.to_owned(),
        bytes: 0,
        file_count: 0,
        item_count: 0,
    }
}

fn add_file(category: &mut StorageCategory, path: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    // Never account for data reached through a symlink or junction.
    if !metadata.file_type().is_file() {
        return false;
    }
    category.bytes = category.bytes.saturating_add(metadata.len());
    category.file_count = category.file_count.saturating_add(1);
    true
}

fn is_jsonl(path: &Path) -> bool {
    path.extension().and_then(|s| s.to_str()) == Some("jsonl")
}

/// Session usage includes each JSONL and its optional PiX presentation sidecar.
/// Malformed metadata is conservatively treated as active and is never cleaned.
fn scan_sessions(root: &Path) -> [StorageCategory; 2] {
    let mut active = category("sessions");
    let mut archived = category("archivedSessions");
    let Ok(projects) = std::fs::read_dir(root) else {
        return [active, archived];
    };
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(project.path()) else {
            continue;
        };
        for file in files.flatten() {
            if !file.file_type().is_ok_and(|kind| kind.is_file()) || !is_jsonl(&file.path()) {
                continue;
            }
            let path = file.path();
            let is_archived = crate::sessions::read_presentation(&path)
                .map(|presentation| presentation.archived)
                .unwrap_or(false);
            let target = if is_archived {
                &mut archived
            } else {
                &mut active
            };
            if add_file(target, &path) {
                target.item_count = target.item_count.saturating_add(1);
                add_file(target, &path.with_extension("pix.json"));
            }
        }
    }
    [active, archived]
}

/// Recursively measure regular files without following directory links.
fn path_usage(target: &Path, category: &mut StorageCategory) {
    let mut pending = vec![target.to_path_buf()];
    while let Some(path) = pending.pop() {
        let Ok(metadata) = std::fs::symlink_metadata(&path) else {
            continue;
        };
        if metadata.file_type().is_dir() {
            if let Ok(entries) = std::fs::read_dir(&path) {
                pending.extend(entries.flatten().map(|entry| entry.path()));
            }
        } else if add_file(category, &path) {
            category.item_count = category.item_count.saturating_add(1);
        }
    }
}

fn scan_workspaces(roots: &[PathBuf]) -> StorageCategory {
    let mut workspaces = category("workspaces");
    let mut scanned: Vec<&PathBuf> = Vec::new();
    for root in roots {
        if scanned
            .iter()
            .any(|previous| crate::paths::eq_norm_path(previous, root))
        {
            continue;
        }
        scanned.push(root);
        path_usage(root, &mut workspaces);
    }
    workspaces
}

fn summary_at(sessions_root: &Path, workspace_roots: &[PathBuf]) -> StorageSummary {
    let [sessions, archived_sessions] = scan_sessions(sessions_root);
    let workspaces = scan_workspaces(workspace_roots);
    let categories = vec![sessions, archived_sessions, workspaces];
    let total_bytes = categories
        .iter()
        .fold(0u64, |total, row| total.saturating_add(row.bytes));
    StorageSummary {
        total_bytes,
        categories,
        sessions_directory: sessions_root.to_string_lossy().into_owned(),
        scanned_at: chrono::Utc::now().timestamp_millis(),
    }
}

fn clean_archived(root: &Path) -> StorageCleanupResult {
    let mut result = StorageCleanupResult::default();
    let Ok(projects) = std::fs::read_dir(root) else {
        return result;
    };
    let _guard = match crate::sessions::PRESENTATION_LOCK.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    };
    for project in projects.flatten() {
        if !project.file_type().is_ok_and(|kind| kind.is_dir()) {
            continue;
        }
        let Ok(files) = std::fs::read_dir(project.path()) else {
            result.failed = result.failed.saturating_add(1);
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if !file.file_type().is_ok_and(|kind| kind.is_file()) || !is_jsonl(&path) {
                continue;
            }
            // Re-check under the same lock used by archive/restore operations.
            if !crate::sessions::read_presentation(&path)
                .map(|presentation| presentation.archived)
                .unwrap_or(false)
            {
                continue;
            }
            let session_bytes = std::fs::symlink_metadata(&path)
                .map(|m| m.len())
                .unwrap_or(0);
            match std::fs::remove_file(&path) {
                Ok(()) => {
                    result.freed_bytes = result.freed_bytes.saturating_add(session_bytes);
                    result.deleted_items = result.deleted_items.saturating_add(1);
                }
                Err(_) => {
                    result.failed = result.failed.saturating_add(1);
                    continue;
                }
            }
            let sidecar = path.with_extension("pix.json");
            let sidecar_bytes = std::fs::symlink_metadata(&sidecar)
                .map(|m| m.len())
                .unwrap_or(0);
            match std::fs::remove_file(&sidecar) {
                Ok(()) => result.freed_bytes = result.freed_bytes.saturating_add(sidecar_bytes),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => result.failed = result.failed.saturating_add(1),
            }
            let _ = crate::session_file_rewind::delete_state_for_session(&path);
            crate::sessions::invalidate_meta_cache(&path);
        }
    }
    result
}

fn cleanup_at(sessions_root: &Path, kind: &str) -> Result<StorageCleanupResult, String> {
    if kind == "archivedSessions" {
        return Ok(clean_archived(sessions_root));
    }
    Err(pix_error(
        "storageCategoryNotCleanable",
        "此存储分类不可清理",
    ))
}

#[tauri::command]
pub async fn storage_summary(app: AppHandle) -> Result<StorageSummary, String> {
    let config = crate::commands::app_config_get(app)?;
    let mut workspace_roots = crate::commands::workspace_state::storage_roots()?;
    let projectless = crate::data_dir::resolve_projectless_dir(config.projectless_dir.as_deref());
    if !workspace_roots
        .iter()
        .any(|root| crate::paths::eq_norm_path(root, &projectless))
    {
        workspace_roots.push(projectless);
    }
    tokio::task::spawn_blocking(move || {
        summary_at(
            &crate::trust::agent_dir().join("sessions"),
            &workspace_roots,
        )
    })
    .await
    .map_err(|e| format!("storage scan failed: {e}"))
}

#[tauri::command]
pub async fn storage_cleanup(kind: String) -> Result<StorageCleanupResult, String> {
    tokio::task::spawn_blocking(move || {
        cleanup_at(&crate::trust::agent_dir().join("sessions"), &kind)
    })
    .await
    .map_err(|e| format!("storage cleanup failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("pix-storage-{name}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn write(path: &Path, contents: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    fn session(root: &Path, name: &str, archived: Option<bool>, bytes: usize) {
        let file = root.join("project").join(format!("{name}.jsonl"));
        write(&file, &vec![b'x'; bytes]);
        if let Some(archived) = archived {
            write(
                &file.with_extension("pix.json"),
                format!("{{\"archived\":{archived}}}").as_bytes(),
            );
        }
    }

    fn row<'a>(summary: &'a StorageSummary, id: &str) -> &'a StorageCategory {
        summary.categories.iter().find(|row| row.id == id).unwrap()
    }

    #[test]
    fn summary_only_counts_sessions_and_unique_workspace_roots() {
        let temp = TestDir::new("summary");
        let data = temp.0.join("data");
        let sessions = temp.0.join("sessions");
        let workspace = temp.0.join("workspace");
        let projectless = temp.0.join("projectless");
        session(&sessions, "active", Some(false), 10);
        session(&sessions, "archived", Some(true), 20);
        session(&sessions, "unmanaged", None, 30);
        write(&workspace.join("src/main.ts"), b"1234");
        write(&workspace.join("README.md"), b"1234567");
        write(&projectless.join("notes.txt"), b"123");
        write(&data.join("icons/editor.png"), b"not-counted");
        write(&data.join("logs/today.log"), b"not-counted");
        write(&data.join("config.json"), b"not-counted");

        let summary = summary_at(
            &sessions,
            &[workspace.clone(), workspace, projectless],
        );
        assert_eq!(summary.categories.len(), 3);
        let active = row(&summary, "sessions");
        assert_eq!(active.item_count, 2);
        assert_eq!(active.bytes, 40 + "{\"archived\":false}".len() as u64);
        let archived = row(&summary, "archivedSessions");
        assert_eq!(archived.item_count, 1);
        assert_eq!(archived.bytes, 20 + "{\"archived\":true}".len() as u64);
        let workspaces = row(&summary, "workspaces");
        assert_eq!(workspaces.item_count, 3);
        assert_eq!(workspaces.bytes, 14);
        assert_eq!(
            summary.total_bytes,
            summary.categories.iter().map(|row| row.bytes).sum::<u64>()
        );
    }

    #[test]
    fn archived_cleanup_leaves_active_unmanaged_and_malformed_sessions() {
        let temp = TestDir::new("archived");
        let sessions = temp.0.join("sessions");
        session(&sessions, "active", Some(false), 10);
        session(&sessions, "archived", Some(true), 20);
        session(&sessions, "unmanaged", None, 30);
        session(&sessions, "malformed", None, 40);
        write(&sessions.join("project/malformed.pix.json"), b"not-json");

        let result = cleanup_at(&sessions, "archivedSessions").unwrap();
        assert_eq!(result.deleted_items, 1);
        assert_eq!(result.failed, 0);
        assert!(!sessions.join("project/archived.jsonl").exists());
        assert!(!sessions.join("project/archived.pix.json").exists());
        for name in ["active", "unmanaged", "malformed"] {
            assert!(sessions.join(format!("project/{name}.jsonl")).exists());
        }
    }

    #[test]
    fn only_archived_sessions_can_be_bulk_cleaned() {
        let temp = TestDir::new("rejected");
        for kind in [
            "sessions",
            "workspaces",
            "cache",
            "logs",
            "appData",
            "unknown",
        ] {
            assert!(cleanup_at(&temp.0.join("sessions"), kind).is_err());
        }
    }
}
