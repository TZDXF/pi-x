//! Read-only file preview inside a skill: list files and read one file.
//! Reads are confined by the discovery root check plus the shared
//! [`crate::preview_guard`] traversal guard.

use std::path::{Path, PathBuf};

use crate::errors::pix_error;
use crate::preview_guard::{reject_unsafe_rel_path, resolve_within_root, RootGuardSpec};

use super::discover::ensure_discovered_skill_root;
use super::dir_name;

const SKILL_ROOT_GUARD: RootGuardSpec = RootGuardSpec {
    read_failed_label: "读取技能文件失败",
    root_resolve_label: "解析技能路径失败",
    root_resolve_code: "skillNotFound",
    outside_message: "技能文件路径越界",
};

/// Preview root of a skill: the skill directory itself, or the parent for a
/// single-file skill.
pub(super) fn skill_preview_root(path: &str) -> PathBuf {
    let p = PathBuf::from(path);
    if p.is_file() {
        p.parent().map(Path::to_path_buf).unwrap_or(p)
    } else {
        p
    }
}

/// List files inside a skill for preview (relative posix paths): for a
/// directory skill, every file below the skill root (same ignore rules as
/// package file listing); for a single-file skill, the file itself.
#[tauri::command]
pub async fn skills_list_files(path: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || {
        let root = PathBuf::from(&path);
        if !root.exists() {
            return Err(pix_error("skillNotFound", "技能路径不存在"));
        }
        ensure_discovered_skill_root(&path)?;
        if root.is_file() {
            return Ok(vec![dir_name(&root)]);
        }
        let mut files = Vec::new();
        crate::packages::walk_files(&root, &root, &mut files);
        files.sort();
        Ok(files)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Read one file inside a skill for preview. `rel_path` is relative to the
/// skill root with forward slashes; binary content is rejected.
#[tauri::command]
pub async fn skills_read_file(path: String, rel_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        ensure_discovered_skill_root(&path)?;
        let (_, canonical) = skill_read_target(&path, &rel_path)?;
        let bytes = crate::preview_guard::read_preview_bytes(&canonical, canonical.display())?;
        crate::preview_guard::decode_preview_text(bytes)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Reject traversal and resolve the exact file to read inside a skill: the
/// canonical file must stay inside the canonical skill preview root. Split
/// from `skills_read_file` so the guard stays testable.
fn skill_read_target(path: &str, rel_path: &str) -> Result<(PathBuf, PathBuf), String> {
    reject_unsafe_rel_path(rel_path, "无效的技能文件路径")?;
    let root = skill_preview_root(path);
    if !root.exists() {
        return Err(pix_error("skillNotFound", "技能路径不存在"));
    }
    let canonical = resolve_within_root(&root, rel_path, &SKILL_ROOT_GUARD)?;
    Ok((root, canonical))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::test_util::{temp_root, SKILL_MD};

    #[test]
    fn preview_lists_skill_files() {
        let root = temp_root("preview-list");
        let skill = root.join("my-skill");
        std::fs::create_dir_all(skill.join("references")).unwrap();
        std::fs::write(skill.join("SKILL.md"), SKILL_MD).unwrap();
        std::fs::write(skill.join("references").join("guide.md"), "guide").unwrap();
        std::fs::write(skill.join("script.py"), "print()").unwrap();
        std::fs::write(skill.join(".hidden.md"), "x").unwrap();
        std::fs::create_dir_all(skill.join("node_modules")).unwrap();

        let mut files = Vec::new();
        crate::packages::walk_files(&skill, &skill, &mut files);
        files.sort();
        assert_eq!(files, vec!["SKILL.md", "references/guide.md", "script.py"]);

        // Single-file skills list only the file itself.
        let single = root.join("solo.md");
        std::fs::write(&single, "---\ndescription: Solo\n---\n").unwrap();
        assert_eq!(skill_preview_root(single.to_str().unwrap()), root);
        assert_eq!(skill_preview_root(skill.to_str().unwrap()), skill);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_read_rejects_traversal() {
        let root = temp_root("preview-read");
        let skill = root.join("my-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), SKILL_MD).unwrap();
        let skill_path = skill.to_str().unwrap();

        let (_, target) = skill_read_target(skill_path, "SKILL.md").unwrap();
        assert!(target.ends_with("SKILL.md"));
        for bad in ["../escape.md", "/abs.md", "\\abs.md", "C:evil.md"] {
            assert!(
                skill_read_target(skill_path, bad).is_err(),
                "rel path {bad} must be rejected"
            );
        }
        assert!(skill_read_target(root.join("missing").to_str().unwrap(), "SKILL.md").is_err());
        // `..` inside a file name is a normal component, not traversal.
        std::fs::write(skill.join("a..b.md"), "ok").unwrap();
        let (_, target) = skill_read_target(skill_path, "a..b.md").unwrap();
        assert!(target.ends_with("a..b.md"));
        std::fs::remove_dir_all(root).unwrap();
    }
}
