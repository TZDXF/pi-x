use std::path::{Path, PathBuf};
use tauri::Manager;

pub fn root() -> PathBuf {
    dirs::home_dir()
        .expect("Cannot locate user home directory")
        .join(".pix")
}

// Copy only missing files. Never follow symlinks or remove the original data.
fn copy_missing(source: &Path, target: &Path) -> std::io::Result<()> {
    if !source.exists() {
        return Ok(());
    }
    if std::fs::symlink_metadata(source)?.file_type().is_symlink() {
        return Ok(());
    }
    std::fs::create_dir_all(target)?;
    let source = dunce::canonicalize(source)?;
    let canonical_target = dunce::canonicalize(target)?;
    if canonical_target.starts_with(&source) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Migration destination must not be inside its source",
        ));
    }
    for entry in std::fs::read_dir(&source)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_missing(&entry.path(), &destination)?;
        } else if kind.is_file() && !destination.exists() {
            std::fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let root = root();
    std::fs::create_dir_all(&root)?;
    if !root.join(".migration-v1").exists() {
        let old = app.path().app_config_dir()?;
        for name in ["config.json", "remote.json"] {
            if old.join(name).is_file() && !root.join(name).exists() {
                std::fs::copy(old.join(name), root.join(name))?;
            }
        }
        let old_agent = std::env::var_os("PI_CODING_AGENT_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| dirs::home_dir().unwrap().join(".pi/agent"));
        if old_agent != root.join("agent") {
            copy_missing(&old_agent, &root.join("agent"))?;
        }
        #[cfg(target_os = "windows")]
        copy_missing(
            &app.path().app_local_data_dir()?.join("EBWebView"),
            &root.join("webview/EBWebView"),
        )?;
        std::fs::write(root.join(".migration-v1"), "1")?;
    }
    std::fs::create_dir_all(root.join("agent"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_copies_nested_files_without_overwriting_or_deleting() {
        let base = std::env::temp_dir().join(format!("pix-migration-{}", uuid::Uuid::new_v4()));
        let source = base.join("old");
        let target = base.join("new");
        std::fs::create_dir_all(source.join("sessions")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("config.json"), "old").unwrap();
        std::fs::write(target.join("config.json"), "new").unwrap();
        std::fs::write(source.join("sessions/test.jsonl"), "session").unwrap();
        copy_missing(&source, &target).unwrap();
        copy_missing(&source, &target).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("config.json")).unwrap(),
            "new"
        );
        assert_eq!(
            std::fs::read_to_string(target.join("sessions/test.jsonl")).unwrap(),
            "session"
        );
        assert!(source.join("sessions/test.jsonl").exists());
        assert!(copy_missing(&source, &source.join("nested")).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn legacy_config_defaults_and_tray_preferences_roundtrip() {
        let mut config: crate::commands::AppConfig = serde_json::from_str("{}").unwrap();
        assert!(!config.close_notice_shown);
        assert!(!config.close_to_tray);
        assert!(!config.minimize_to_tray);
        config.close_notice_shown = true;
        config.close_to_tray = true;
        config.minimize_to_tray = true;
        let json = serde_json::to_value(&config).unwrap();
        assert_eq!(json["closeNoticeShown"], true);
        assert_eq!(json["closeToTray"], true);
        assert_eq!(json["minimizeToTray"], true);
        let restored: crate::commands::AppConfig = serde_json::from_value(json).unwrap();
        assert!(restored.close_notice_shown && restored.close_to_tray && restored.minimize_to_tray);
    }
}
