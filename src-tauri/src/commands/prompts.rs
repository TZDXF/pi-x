//! Global prompt files (`AGENTS.md` / `SYSTEM.md` / `APPEND_SYSTEM.md`) under
//! pi's agent dir, edited from the settings page.

use serde::Serialize;
use std::path::Path;

use crate::trust;

const GLOBAL_PROMPT_FILES: [&str; 3] = ["AGENTS.md", "SYSTEM.md", "APPEND_SYSTEM.md"];

fn global_prompt_path(file_name: &str) -> Result<std::path::PathBuf, String> {
    if !GLOBAL_PROMPT_FILES.contains(&file_name) {
        return Err(format!("Unsupported global prompt file: {file_name}"));
    }
    Ok(trust::agent_dir().join(file_name))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GlobalPromptFile {
    file_name: String,
    content: String,
    exists: bool,
}

fn list_global_prompts(dir: &Path) -> Result<Vec<GlobalPromptFile>, String> {
    GLOBAL_PROMPT_FILES
        .iter()
        .map(|file_name| {
            let path = dir.join(file_name);
            Ok(GlobalPromptFile {
                file_name: (*file_name).to_string(),
                content: read_global_prompt(&path)?,
                exists: path.exists(),
            })
        })
        .collect()
}

#[tauri::command]
pub fn global_prompt_list() -> Result<Vec<GlobalPromptFile>, String> {
    list_global_prompts(&trust::agent_dir())
}

fn read_global_prompt(path: &std::path::Path) -> Result<String, String> {
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(path)
        .map(|s| s.trim_start_matches('\u{feff}').to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn global_prompt_save(file_name: String, prompt: String) -> Result<(), String> {
    save_global_prompt(&global_prompt_path(&file_name)?, &prompt)
}

fn save_global_prompt(path: &std::path::Path, prompt: &str) -> Result<(), String> {
    if prompt.trim().is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, prompt).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn global_prompt_list_includes_missing_files_and_reads_existing_content() {
        let root = std::env::temp_dir().join(format!("pix-prompts-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let missing = list_global_prompts(&root).unwrap();
        assert_eq!(missing.len(), GLOBAL_PROMPT_FILES.len());
        assert!(missing
            .iter()
            .all(|file| !file.exists && file.content.is_empty()));
        assert_eq!(missing[0].file_name, "AGENTS.md");
        assert_eq!(missing[1].file_name, "SYSTEM.md");
        assert_eq!(missing[2].file_name, "APPEND_SYSTEM.md");

        save_global_prompt(&root.join("APPEND_SYSTEM.md"), "additional instructions").unwrap();
        let files = list_global_prompts(&root).unwrap();
        assert!(files[2].exists);
        assert_eq!(files[2].content, "additional instructions");
        assert!(!files[0].exists);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn global_prompt_path_rejects_arbitrary_files() {
        assert!(global_prompt_path("../auth.json").is_err());
        assert!(global_prompt_path("settings.json").is_err());
    }

    #[test]
    fn saving_blank_global_prompt_removes_pi_file() {
        let root = std::env::temp_dir().join(format!("pix-prompt-{}", uuid::Uuid::new_v4()));
        let path = root.join("SYSTEM.md");
        save_global_prompt(&path, " 中文 ").unwrap();
        assert_eq!(read_global_prompt(&path).unwrap(), " 中文 ");
        save_global_prompt(&path, " \n").unwrap();
        assert!(!path.exists());
        std::fs::remove_dir(root).unwrap();
    }
}
