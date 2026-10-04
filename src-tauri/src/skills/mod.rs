//! Hosted skill management: complete skills stored under `~/.pix/skills/`.
//!
//! A hosted skill is either a directory containing `SKILL.md` (the full skill:
//! instructions, scripts, references, assets) or a single skill Markdown file
//! with frontmatter. Enabling a skill registers its absolute path in Pi's
//! global settings `skills` array — Pi stays the single source of truth for
//! what is loaded; `.pix` only stores the skill files themselves. Disabling
//! removes the path from Pi's settings but keeps the files on disk.
//!
//! - [`frontmatter`]: pure SKILL.md frontmatter parsing.
//! - [`hosted`]: hosted skill scan / enable / delete, including the
//!   canonicalize-based `is_inside_root` containment guard.
//! - [`discover`]: read-only auto-discovery of skills outside the hosted root,
//!   plus the Pi settings `skills` array access and its TTL cache.
//! - [`preview`]: read-only file preview inside a skill.

mod discover;
mod frontmatter;
mod hosted;
mod preview;

pub use discover::skills_discovered_list;
pub use hosted::{
    skills_hosted_delete, skills_hosted_list, skills_hosted_open_dir, skills_hosted_set_enabled,
};
pub use preview::{skills_list_files, skills_read_file};

pub(crate) use frontmatter::valid_skill_markdown;

// 命令实现位于子模块，tauri 的 generate_handler 以 `skills::<cmd>` 路径解析
// 命令名与其包装宏；这里把生成的隐藏宏一并重导出，保证 `skills::skills_list_files`
// 等对外路径与拆分前完全一致。
#[doc(hidden)]
pub use discover::__cmd__skills_discovered_list;
#[doc(hidden)]
pub use discover::__tauri_command_name_skills_discovered_list;
#[doc(hidden)]
pub use hosted::{
    __cmd__skills_hosted_delete, __cmd__skills_hosted_list, __cmd__skills_hosted_open_dir,
    __cmd__skills_hosted_set_enabled, __tauri_command_name_skills_hosted_delete,
    __tauri_command_name_skills_hosted_list, __tauri_command_name_skills_hosted_open_dir,
    __tauri_command_name_skills_hosted_set_enabled,
};
#[doc(hidden)]
pub use preview::{
    __cmd__skills_list_files, __cmd__skills_read_file, __tauri_command_name_skills_list_files,
    __tauri_command_name_skills_read_file,
};

use serde::Serialize;
use std::path::PathBuf;

pub(crate) fn skills_root() -> PathBuf {
    crate::data_dir::root().join("skills")
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostedSkill {
    /// Frontmatter `name`, falling back to the directory / file stem.
    pub name: String,
    /// Frontmatter `description` (may be empty).
    pub description: String,
    /// Absolute path of the skill directory or Markdown file.
    pub path: String,
    /// `directory` (with SKILL.md) or `file` (single Markdown).
    pub kind: String,
    /// Whether the path is currently registered in Pi's settings.
    pub enabled: bool,
}

pub(crate) fn stem(path: &std::path::Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

pub(crate) fn dir_name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

#[cfg(test)]
pub(crate) mod test_util {
    use std::path::PathBuf;

    pub(crate) fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("pix-skills-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    pub(crate) const SKILL_MD: &str =
        "---\nname: my-skill\ndescription: \"Does things.\"\n---\n\n# My Skill\n";

    /// Create a directory symlink; returns false when the platform or
    /// privileges do not allow it (tests skip instead of failing).
    pub(crate) fn create_dir_symlink(target: &std::path::Path, link: &std::path::Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }
}
