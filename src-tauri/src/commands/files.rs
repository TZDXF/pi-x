//! Project file browsing (search, directory listing, in-app preview),
//! stored-session listing/export and opening files with the system handler.

use serde_json::json;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::errors::{pix_error, pix_error_detail};
use crate::{file_preview, fs_search, sessions};

/// List recent stored sessions for a project (newest first).
#[tauri::command]
pub async fn session_list(project: String) -> Result<Vec<sessions::SessionMeta>, String> {
    sessions::list(project).await
}

/// Search project files for @file mention completion.
#[tauri::command]
pub async fn search_files(
    project: String,
    query: String,
) -> Result<Vec<fs_search::FileHit>, String> {
    fs_search::search(project, query).await
}

#[tauri::command]
pub async fn list_project_directory(
    project: String,
    path: String,
) -> Result<Vec<fs_search::ProjectEntry>, String> {
    fs_search::list_directory(project, path).await
}

/// Read a project file for the in-app preview (text / image / binary).
#[tauri::command]
pub async fn read_file_preview(
    project: String,
    path: String,
) -> Result<file_preview::FilePreview, String> {
    file_preview::read_file_preview(project, path).await
}

/// Export a stored Pi session without activating or switching any runtime.
/// When no output path is supplied (remote browser download), use a temporary
/// HTML file which the remote handler removes after reading it.
#[tauri::command]
pub async fn session_export_file(
    file: String,
    output_path: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        let source = sessions::validate_session_path(&file)?;
        let target = match output_path {
            Some(path) => {
                let path = std::path::PathBuf::from(path);
                if !valid_export_target(&path) {
                    return Err(pix_error("exportDirInvalid", "无效的导出目录"));
                }
                path
            }
            None => std::env::temp_dir()
                .join(format!("pix-session-export-{}.html", uuid::Uuid::new_v4())),
        };
        let result = crate::pi_data::call(json!({
            "op": "session_export_html", "file": source, "outputPath": target
        }))?;
        let exported = result
            .as_str()
            .ok_or_else(|| pix_error("exportPathMissing", "Pi 未返回导出路径"))?;
        dunce::canonicalize(exported)
            .map(|p| p.to_string_lossy().to_string())
            .map_err(|e| {
                pix_error_detail("exportPathUnreachable", "无法定位导出的 HTML: {detail}", e)
            })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Exports use HTML; never pass an arbitrary extension or an existing symlink
/// to the SDK writer. The directory is chosen by the desktop user.
fn valid_export_target(path: &std::path::Path) -> bool {
    path.is_absolute()
        && path.parent().is_some_and(|parent| parent.is_dir())
        && path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("html"))
        && match std::fs::symlink_metadata(path) {
            Ok(metadata) => metadata.is_file() && !metadata.file_type().is_symlink(),
            Err(error) => error.kind() == std::io::ErrorKind::NotFound,
        }
}

#[cfg(test)]
mod export_tests {
    use super::valid_export_target;

    #[test]
    fn export_target_must_be_an_html_file_in_an_existing_directory() {
        let dir = std::env::temp_dir().join(format!("pix-export-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        assert!(valid_export_target(&dir.join("session.html")));
        assert!(valid_export_target(&dir.join("session.HTML")));
        assert!(!valid_export_target(&dir.join("session.jsonl")));
        assert!(!valid_export_target(&dir.join("missing").join("session.html")));
        assert!(!valid_export_target(std::path::Path::new("session.html")));
        std::fs::create_dir(dir.join("folder.html")).unwrap();
        assert!(!valid_export_target(&dir.join("folder.html")));
        std::fs::remove_dir_all(dir).unwrap();
    }
}

/// Open a file or directory with the system default handler.
#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}
