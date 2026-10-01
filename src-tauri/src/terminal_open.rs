//! Opening a system terminal in a directory, e.g. from the title bar dropdown.
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::editor::{resolve_dir, spawn_detached};

fn find_in_path(name: &str) -> Option<PathBuf> {
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(windows)]
fn windows_terminal() -> Option<Command> {
    let wt = find_in_path("wt.exe").or_else(|| {
        std::env::var_os("LOCALAPPDATA")
            .map(|root| PathBuf::from(root).join("Microsoft").join("WindowsApps").join("wt.exe"))
            .filter(|p| p.is_file())
    })?;
    Some(Command::new(wt))
}

fn terminal_command(target: &Path) -> Option<Command> {
    #[cfg(windows)]
    {
        // Prefer Windows Terminal; without it, cmd /K with the working
        // directory set opens a console window in the folder directly.
        if let Some(mut command) = windows_terminal() {
            command.arg("-d").arg(target);
            return Some(command);
        }
        let mut command = Command::new("cmd");
        command.arg("/K").current_dir(target);
        return Some(command);
    }
    #[cfg(target_os = "macos")]
    {
        let mut command = Command::new("open");
        command.args(["-a", "Terminal"]).arg(target);
        return Some(command);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        const TERMINALS: &[(&str, &str)] = &[
            ("gnome-terminal", "--working-directory"),
            ("konsole", "--workdir"),
            ("xfce4-terminal", "--working-directory"),
            ("alacritty", "--working-directory"),
            ("kitty", "--directory"),
        ];
        for (bin, flag) in TERMINALS {
            if let Some(path) = find_in_path(bin) {
                let mut command = Command::new(path);
                command.arg(flag).arg(target);
                return Some(command);
            }
        }
        let mut command = Command::new("x-terminal-emulator");
        command.current_dir(target);
        Some(command)
    }
}

/// Opens a terminal emulator in the directory, e.g. from the title bar dropdown.
#[tauri::command]
pub fn open_terminal_in_dir(dir: String) -> Result<(), String> {
    let target = resolve_dir(&dir)?;
    let command = terminal_command(&target).ok_or_else(|| "No terminal emulator found".to_string())?;
    spawn_detached(command)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_or_missing_directories_are_rejected() {
        assert!(open_terminal_in_dir("relative".into()).is_err());
        assert!(open_terminal_in_dir(String::new()).is_err());
        let missing = std::env::temp_dir().join(format!("pix-terminal-{}", uuid::Uuid::new_v4()));
        assert!(open_terminal_in_dir(missing.to_str().unwrap().to_string()).is_err());
    }
}
