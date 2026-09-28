//! PiX-owned pi extensions shipped with the desktop app.

use std::path::PathBuf;

use tauri::AppHandle;

use crate::{commands, data_dir, errors::pix_error_detail};

const FILE_CHANGES_SOURCE: &str = include_str!("../extensions/pix-file-changes.js");
const FILE_CHANGES_NAME: &str = "pix-file-changes.js";

fn materialize_in(dir: &std::path::Path, name: &str, source: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| pix_error_detail("builtinExtensionDirCreateFailed", "无法创建内置插件目录: {detail}", e))?;
    let path = dir.join(name);
    let current = std::fs::read_to_string(&path).ok();
    if current.as_deref() != Some(source) {
        let temporary = dir.join(format!("{name}.{}.tmp", uuid::Uuid::new_v4()));
        std::fs::write(&temporary, source)
            .map_err(|e| pix_error_detail("builtinExtensionWriteFailed", "无法写入内置插件: {detail}", e))?;
        if path.exists() {
            std::fs::remove_file(&path)
                .map_err(|e| pix_error_detail("builtinExtensionWriteFailed", "无法写入内置插件: {detail}", e))?;
        }
        std::fs::rename(&temporary, &path)
            .map_err(|e| pix_error_detail("builtinExtensionWriteFailed", "无法写入内置插件: {detail}", e))?;
    }
    Ok(path)
}

/// Materialize an app-owned extension under ~/.pix/extensions and return its path.
fn materialize(name: &str, source: &str) -> Result<PathBuf, String> {
    materialize_in(&data_dir::root().join("extensions"), name, source)
}

/// CLI arguments for enabled built-in extensions. Disabled plugins are omitted
/// entirely so pi never discovers or executes them.
pub fn rpc_args(app: &AppHandle) -> Result<Vec<String>, String> {
    let enabled = commands::app_config_get(app.clone())?
        .builtin_file_changes
        .unwrap_or(true);
    if !enabled {
        return Ok(Vec::new());
    }
    let path = materialize(FILE_CHANGES_NAME, FILE_CHANGES_SOURCE)?;
    Ok(vec!["--extension".into(), path.to_string_lossy().into_owned()])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_extension_is_self_contained_and_named() {
        assert!(FILE_CHANGES_SOURCE.contains("pix-file-change"));
        assert!(FILE_CHANGES_SOURCE.contains("tool_call"));
        assert!(FILE_CHANGES_NAME.ends_with(".js"));
    }

    #[test]
    fn materialize_updates_stale_extension_bytes() {
        let dir = std::env::temp_dir().join(format!("pix-builtin-{}", uuid::Uuid::new_v4()));
        let first = materialize_in(&dir, "plugin.js", "one").unwrap();
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "one");
        materialize_in(&dir, "plugin.js", "two").unwrap();
        assert_eq!(std::fs::read_to_string(&first).unwrap(), "two");
        let _ = std::fs::remove_dir_all(dir);
    }
}
