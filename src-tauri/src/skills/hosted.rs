//! Hosted skills under `~/.pix/skills/`: scan, enable in Pi settings, delete.
//! All writes are confined by [`is_inside_root`], a component-level containment
//! check that canonicalizes both sides.

use dunce::canonicalize;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use super::discover::{pi_skill_paths, save_pi_skill_paths};
use super::frontmatter::read_frontmatter;
use super::{dir_name, skills_root, stem, HostedSkill};

/// List hosted skills in `root`. One top-level entry = one skill:
/// a directory containing `SKILL.md`, or a root Markdown file with
/// frontmatter. Anything else is ignored.
pub(super) fn scan_root(root: &Path) -> Result<Vec<(PathBuf, &'static str)>, String> {
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
        Err(e) => return Err(e.to_string()),
    };
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        if file_type.is_dir() {
            if path.join("SKILL.md").is_file() {
                out.push((path, "directory"));
            }
        } else if path
            .extension()
            .map(|e| e.to_ascii_lowercase() == "md")
            .unwrap_or(false)
        {
            out.push((path, "file"));
        }
    }
    out.sort_by_key(|(path, _)| {
        path.file_name()
            .map(|n| n.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    });
    Ok(out)
}

pub(super) fn hosted_entry(root: &Path, path: &Path, kind: &str) -> Result<HostedSkill, String> {
    let (fm_name, description) = match kind {
        "directory" => read_frontmatter(&path.join("SKILL.md"))?,
        _ => read_frontmatter(path)?,
    };
    Ok(HostedSkill {
        name: fm_name.unwrap_or_else(|| match kind {
            "directory" => dir_name(path),
            _ => stem(path),
        }),
        description: description.unwrap_or_default(),
        path: to_hosted_key(root, path),
        kind: kind.to_string(),
        enabled: false,
    })
}

/// Normalized comparison key: forward slashes, lowercase on Windows.
fn norm_key(p: &str) -> String {
    let lower = p.replace('\\', "/");
    #[cfg(windows)]
    {
        lower.to_lowercase()
    }
    #[cfg(not(windows))]
    {
        lower
    }
}

/// Absolute path without `\\?\` prefixes or symlink resolution, for stable
/// keys in Pi's settings array.
fn to_hosted_key(root: &Path, path: &Path) -> String {
    match path.strip_prefix(root) {
        Ok(rel) => root.join(rel),
        Err(_) => path.to_path_buf(),
    }
    .to_string_lossy()
    .into_owned()
}

/// Component-level containment after OS resolution: canonicalize the target
/// (or its deepest existing ancestor when the leaf does not exist yet) and
/// compare against the canonical root, so `..` segments, symlinks and casing
/// tricks cannot slip past a naive string prefix check.
fn is_inside_root(root: &Path, path: &str) -> bool {
    let Some(canonical_root) = canonicalize(root).ok() else {
        return false;
    };
    canonical_target(Path::new(path))
        .is_some_and(|canonical| canonical.starts_with(&canonical_root))
}

/// Canonical form of `target`; when it does not exist (yet), resolve the
/// deepest existing ancestor and re-append the remaining components verbatim.
fn canonical_target(target: &Path) -> Option<PathBuf> {
    if let Ok(canonical) = canonicalize(target) {
        return Some(canonical);
    }
    let mut ancestor = target.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    while let Some(name) = ancestor.file_name().map(|n| n.to_os_string()) {
        ancestor.pop();
        tail.push(name);
        if let Ok(canonical) = canonicalize(&ancestor) {
            let mut resolved = canonical;
            for part in tail.drain(..).rev() {
                resolved.push(part);
            }
            return Some(resolved);
        }
    }
    None
}

/// Paths currently registered in Pi settings, normalized for comparison.
fn enabled_keys() -> Result<Vec<String>, String> {
    Ok(pi_skill_paths()?.iter().map(|p| norm_key(p)).collect())
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn skills_hosted_list() -> Result<Vec<HostedSkill>, String> {
    tokio::task::spawn_blocking(|| {
        let root = skills_root();
        let enabled = enabled_keys()?;
        scan_root(&root)?
            .iter()
            .map(|(path, kind)| {
                let mut skill = hosted_entry(&root, path, kind)?;
                skill.enabled = enabled.contains(&norm_key(&skill.path));
                Ok(skill)
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Create and open the hosted skills directory in the system file manager.
#[tauri::command]
pub fn skills_hosted_open_dir(app: AppHandle) -> Result<(), String> {
    let root = skills_root();
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(root.to_string_lossy(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Delete a hosted skill from `~/.pix/skills/` and unregister it from Pi
/// settings. The path must live inside the skills root.
#[tauri::command]
pub async fn skills_hosted_delete(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || skills_delete(&skills_root(), &path))
        .await
        .map_err(|e| e.to_string())?
}

/// Reject paths outside the hosted skills root and return the delete target.
/// Split from `skills_delete` so the guard stays testable without an installed
/// Pi SDK (`skills_delete` also syncs Pi settings, which shells out to Pi).
fn hosted_delete_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    if !is_inside_root(root, path) {
        return Err(format!("Not a hosted skill path: {path}"));
    }
    Ok(PathBuf::from(path))
}

fn skills_delete(root: &Path, path: &str) -> Result<(), String> {
    let target = hosted_delete_target(root, path)?;
    if target.exists() {
        remove_path(&target)?;
    }
    let key = norm_key(path);
    let mut paths = pi_skill_paths()?;
    paths.retain(|p| norm_key(p) != key);
    save_pi_skill_paths(paths)
}

/// Overwrite the enabled hosted skills: `paths` are the absolute hosted skill
/// paths that should be registered in Pi settings. Entries in Pi settings
/// that point outside `~/.pix/skills/` (manually added paths) are preserved.
#[tauri::command]
pub async fn skills_hosted_set_enabled(paths: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || skills_set_enabled(&skills_root(), &paths))
        .await
        .map_err(|e| e.to_string())?
}

fn skills_set_enabled(root: &Path, paths: &[String]) -> Result<(), String> {
    let mut hosted = Vec::new();
    for path in paths {
        if !is_inside_root(root, path) {
            return Err(format!("Not a hosted skill path: {path}"));
        }
        if !Path::new(path).exists() {
            return Err(format!("Skill path does not exist: {path}"));
        }
        hosted.push(path.clone());
    }
    let external: Vec<String> = pi_skill_paths()?
        .into_iter()
        .filter(|p| !is_inside_root(root, p))
        .collect();
    save_pi_skill_paths([external, hosted].concat())
}

fn remove_path(path: &Path) -> Result<(), String> {
    let result = if path.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    };
    result.map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::test_util::{temp_root, SKILL_MD};

    #[test]
    fn scans_directories_and_files() {
        let root = temp_root("scan");
        let dir = root.join("packaged");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("SKILL.md"), SKILL_MD).unwrap();
        std::fs::write(root.join("single.md"), "---\ndescription: Single\n---\n").unwrap();
        std::fs::write(root.join("not-a-skill.txt"), "x").unwrap();
        std::fs::create_dir_all(root.join("empty-dir")).unwrap();

        let scanned = scan_root(&root).unwrap();
        assert_eq!(scanned.len(), 2);
        assert_eq!(scanned[0].1, "directory");
        assert_eq!(scanned[1].1, "file");

        let entry = hosted_entry(&root, &scanned[0].0, scanned[0].1).unwrap();
        assert_eq!(entry.name, "my-skill");
        assert_eq!(entry.description, "Does things.");
        assert_eq!(entry.kind, "directory");
        assert!(!entry.enabled);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_only_allows_hosted_paths() {
        let root = temp_root("delete");
        let outside = temp_root("outside");
        std::fs::write(outside.join("x.md"), "x").unwrap();
        assert!(hosted_delete_target(&root, outside.join("x.md").to_str().unwrap()).is_err());
        assert!(outside.join("x.md").exists());
        std::fs::write(root.join("y.md"), "y").unwrap();
        let target = hosted_delete_target(&root, root.join("y.md").to_str().unwrap()).unwrap();
        remove_path(&target).unwrap();
        assert!(!root.join("y.md").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn delete_rejects_parent_dir_traversal() {
        let root = temp_root("traversal");
        let outside = temp_root("traversal-outside");
        std::fs::write(outside.join("secret.md"), "x").unwrap();
        // `root/../../<outside-parent>/<outside-name>/secret.md` matches a
        // naive string prefix of `root` but resolves outside the skills root
        // once `..` is handled by the OS.
        let escape = root
            .join("..")
            .join("..")
            .join(dir_name(outside.parent().unwrap()))
            .join(dir_name(&outside))
            .join("secret.md");
        assert!(hosted_delete_target(&root, escape.to_str().unwrap()).is_err());
        assert!(skills_set_enabled(&root, &[escape.to_str().unwrap().to_string()]).is_err());
        assert!(outside.join("secret.md").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn delete_accepts_dotdot_paths_resolving_inside_root() {
        let root = temp_root("dotdot-inside");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("y.md"), "y").unwrap();
        let inner = root.join("sub").join("..").join("y.md");
        let target = hosted_delete_target(&root, inner.to_str().unwrap()).unwrap();
        remove_path(&target).unwrap();
        assert!(!root.join("y.md").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
