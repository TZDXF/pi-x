//! Editor opening adapted from RepoMeow. No shell interpolation: file paths are
//! always individual arguments, including paths containing spaces or metacharacters.
use std::{collections::HashMap, path::{Path, PathBuf}, process::Command};

pub(crate) const EDITORS: &[(&str, &str, &str)] = &[
    ("vscode", "code", "Code.exe"),
    ("cursor", "cursor", "Cursor.exe"),
    ("windsurf", "windsurf", "Windsurf.exe"),
    ("trae", "trae", "Trae.exe"),
    ("vscodium", "codium", "VSCodium.exe"),
    ("zed", "zed", "zed.exe"),
    ("sublime", "subl", "sublime_text.exe"),
    ("idea", "idea", "idea64.exe"),
    ("webstorm", "webstorm", "webstorm64.exe"),
    ("pycharm", "pycharm", "pycharm64.exe"),
    ("goland", "goland", "goland64.exe"),
    ("clion", "clion", "clion64.exe"),
    ("rustrover", "rustrover", "rustrover64.exe"),
];

pub(crate) fn editor_binary(kind: &str) -> Option<PathBuf> {
    let (_, cli, binary) = EDITORS.iter().find(|(id, _, _)| *id == kind)?;
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            if cfg!(windows) {
                candidates.push(dir.join(binary));
                candidates.push(dir.join(format!("{cli}.exe")));
                // VS Code family installs CLI .cmd shims in bin. Launch the
                // native executable next to bin instead of routing through cmd.
                if let Some(parent) = dir.parent() { candidates.push(parent.join(binary)); }
            } else {
                candidates.push(dir.join(cli));
            }
        }
    }
    #[cfg(windows)]
    {
        let folder = match kind {
            "vscode" => "Microsoft VS Code", "cursor" => "cursor",
            "windsurf" => "Windsurf", "trae" => "Trae", "vscodium" => "VSCodium",
            "zed" => "Zed", "sublime" => "Sublime Text", _ => "",
        };
        if !folder.is_empty() {
            for variable in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(root) = std::env::var_os(variable) {
                    let root = PathBuf::from(root);
                    candidates.push(root.join(folder).join(binary));
                    candidates.push(root.join("Programs").join(folder).join(binary));
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.is_absolute() && p.is_file())
}

#[tauri::command]
pub fn detect_editors() -> HashMap<String, bool> {
    EDITORS.iter().map(|(id, _, _)| (id.to_string(), editor_binary(id).is_some())).collect()
}

fn resolve_file(path: &str, project: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() { return Err("File path is empty".into()); }
    let path = Path::new(path);
    let target = if path.is_absolute() { path.to_path_buf() } else {
        let base = Path::new(project);
        if !base.is_absolute() { return Err("Project path must be absolute".into()); }
        base.join(path)
    };
    let target = dunce::canonicalize(target).map_err(|e| format!("Cannot open file: {e}"))?;
    if !target.is_file() { return Err("The target is not a file".into()); }
    Ok(target)
}

#[tauri::command]
pub fn open_in_editor(app: tauri::AppHandle, path: String, project: String, kind: String, executable: Option<String>) -> Result<(), String> {
    let target = resolve_file(&path, &project)?;
    if kind == "system" {
        use tauri_plugin_opener::OpenerExt;
        return app.opener().open_path(target.to_string_lossy(), None::<&str>).map_err(|e| e.to_string());
    }
    let binary = if kind == "custom" {
        let candidate = PathBuf::from(executable.unwrap_or_default());
        if !candidate.is_absolute() || !candidate.is_file() {
            return Err("Choose an existing absolute editor executable path in Settings".into());
        }
        #[cfg(windows)]
        if !candidate.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe")) {
            return Err("The editor must be an .exe file, not a shell command or script".into());
        }
        candidate
    } else {
        editor_binary(&kind).ok_or_else(|| "Editor not found. Install its command-line launcher or configure a custom executable in Settings".to_string())?
    };
    let mut command = Command::new(binary);
    command.arg(&target);
    if let Some(parent) = target.parent() { command.current_dir(parent); }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("Cannot launch editor: {e}"))?;
    std::thread::spawn(move || { let _ = child.wait(); });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resolves_relative_absolute_and_special_character_paths() {
        let dir = std::env::temp_dir().join(format!("pix-editor-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("space & percent% 中文.ts");
        std::fs::write(&file, "test").unwrap();
        let base = dir.to_str().unwrap();
        let expected = dunce::canonicalize(&file).unwrap();
        assert_eq!(resolve_file(file.file_name().unwrap().to_str().unwrap(), base).unwrap(), expected);
        assert_eq!(resolve_file(file.to_str().unwrap(), "").unwrap(), expected);
        assert!(resolve_file("missing.ts", base).is_err());
        assert!(resolve_file(base, base).is_err());
        assert!(resolve_file("", base).is_err());
        assert!(resolve_file("a.ts", "relative").is_err());
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn unknown_editors_are_not_commands() {
        assert!(editor_binary("code & whoami").is_none());
    }
}
