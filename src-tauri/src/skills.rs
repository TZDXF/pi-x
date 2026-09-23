//! Hosted skill management: complete skills stored under `~/.pix/skills/`.
//!
//! A hosted skill is either a directory containing `SKILL.md` (the full skill:
//! instructions, scripts, references, assets) or a single skill Markdown file
//! with frontmatter. Enabling a skill registers its absolute path in Pi's
//! global settings `skills` array — Pi stays the single source of truth for
//! what is loaded; `.pix` only stores the skill files themselves. Disabling
//! removes the path from Pi's settings but keeps the files on disk.

use dunce::canonicalize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

pub fn skills_root() -> PathBuf {
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

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/// Extract `name` / `description` from a skill Markdown frontmatter block.
fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let clean = |s: &str| {
        s.trim().trim_matches('"').trim_matches('\'').trim().to_string()
    };
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let (mut name, mut description) = (None, None);
    for line in lines {
        let line = line.trim();
        if line == "---" || line == "..." {
            break;
        }
        if let Some(rest) = line.strip_prefix("name:") {
            let v = clean(rest);
            if !v.is_empty() {
                name = Some(v);
            }
        } else if let Some(rest) = line.strip_prefix("description:") {
            let v = clean(rest);
            if !v.is_empty() {
                description = Some(v);
            }
        }
    }
    (name, description)
}

/// Read a skill Markdown file and return its frontmatter values.
fn read_frontmatter(file: &Path) -> Result<(Option<String>, Option<String>), String> {
    let raw = std::fs::read_to_string(file).map_err(|e| format!("{}: {e}", file.display()))?;
    Ok(parse_frontmatter(&raw))
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/// List hosted skills in `root`. One top-level entry = one skill:
/// a directory containing `SKILL.md`, or a root Markdown file with
/// frontmatter. Anything else is ignored.
fn scan_root(root: &Path) -> Result<Vec<(PathBuf, &'static str)>, String> {
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
        } else if path.extension().map(|e| e.to_ascii_lowercase() == "md").unwrap_or(false) {
            out.push((path, "file"));
        }
    }
    out.sort_by_key(|(path, _)| {
        path.file_name().map(|n| n.to_string_lossy().to_lowercase()).unwrap_or_default()
    });
    Ok(out)
}

fn stem(path: &Path) -> String {
    path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn dir_name(path: &Path) -> String {
    path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

fn hosted_entry(root: &Path, path: &Path, kind: &str) -> Result<HostedSkill, String> {
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

// ---------------------------------------------------------------------------
// Pi settings `skills` array (single source of truth for enabled state)
// ---------------------------------------------------------------------------

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

fn is_inside_root(root: &Path, path: &str) -> bool {
    let key = norm_key(path);
    let prefix = norm_key(&root.to_string_lossy());
    key.starts_with(&format!("{prefix}/"))
}

fn pi_skill_paths() -> Result<Vec<String>, String> {
    let value = crate::pi_data::call(serde_json::json!({ "op": "settings_get" }))?;
    Ok(value
        .get("skills")
        .and_then(Value::as_array)
        .map(|array| {
            array.iter().filter_map(Value::as_str).map(str::to_string).collect()
        })
        .unwrap_or_default())
}

fn save_pi_skill_paths(paths: Vec<String>) -> Result<(), String> {
    crate::pi_data::call(serde_json::json!({ "op": "settings_save", "settings": { "skills": paths } }))?;
    Ok(())
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
    app.opener().open_path(root.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

/// Delete a hosted skill from `~/.pix/skills/` and unregister it from Pi
/// settings. The path must live inside the skills root.
#[tauri::command]
pub async fn skills_hosted_delete(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || skills_delete(&skills_root(), &path))
        .await
        .map_err(|e| e.to_string())?
}

fn skills_delete(root: &Path, path: &str) -> Result<(), String> {
    if !is_inside_root(root, path) {
        return Err(format!("Not a hosted skill path: {path}"));
    }
    let target = PathBuf::from(path);
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

// ---------------------------------------------------------------------------
// Auto-discovered skills (Pi's own discovery dirs, read-only)
// ---------------------------------------------------------------------------

/// A user-level skill Pi auto-discovers outside the hosted root.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    /// Absolute path of the skill directory or Markdown file.
    pub path: String,
    /// Whether a skill with the same name is already hosted in `~/.pix/skills`.
    pub hosted: bool,
}

/// Pi's discovery rules: if `dir` contains `SKILL.md` it is a skill root and
/// recursion stops; otherwise recurse into non-dot, non-node_modules
/// subdirectories; root-level `.md` files only count at the scan root.
fn collect_skill_entries(dir: &Path, include_root_files: bool, out: &mut Vec<(PathBuf, &'static str)>) {
    if dir.join("SKILL.md").is_file() {
        out.push((dir.to_path_buf(), "directory"));
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        // `is_dir` follows symlinks/junctions, matching Pi's behavior.
        if path.is_dir() {
            collect_skill_entries(&path, false, out);
        } else if include_root_files
            && path.extension().map(|e| e.to_ascii_lowercase() == "md").unwrap_or(false)
        {
            out.push((path, "file"));
        }
    }
}

#[tauri::command]
pub async fn skills_discovered_list() -> Result<Vec<DiscoveredSkill>, String> {
    tokio::task::spawn_blocking(skills_discovered).await.map_err(|e| e.to_string())?
}

fn skills_discovered() -> Result<Vec<DiscoveredSkill>, String> {
    let home = dirs::home_dir().ok_or("Cannot locate home directory")?;
    let roots = [
        home.join(".pi").join("agent").join("skills"),
        home.join(".agents").join("skills"),
    ];

    // Names already managed under ~/.pix/skills, to flag duplicates.
    let hosted_root = skills_root();
    let hosted_names: HashSet<String> = scan_root(&hosted_root)
        .unwrap_or_default()
        .iter()
        .filter_map(|(path, kind)| hosted_entry(&hosted_root, path, kind).ok().map(|s| s.name))
        .collect();

    let mut out: Vec<DiscoveredSkill> = Vec::new();
    let mut seen_paths: HashSet<PathBuf> = HashSet::new();
    let mut seen_names: HashSet<String> = HashSet::new();
    for root in roots {
        let mut found = Vec::new();
        collect_skill_entries(&root, true, &mut found);
        for (path, kind) in found {
            // Dedupe skills reachable through several roots (e.g. symlinks).
            let canonical = canonicalize(&path).unwrap_or_else(|_| path.clone());
            if !seen_paths.insert(canonical) {
                continue;
            }
            let Ok(entry) = hosted_entry(&root, &path, kind) else { continue };
            // Pi only loads skills with a non-empty description.
            if entry.description.is_empty() || !seen_names.insert(entry.name.clone()) {
                continue;
            }
            out.push(DiscoveredSkill {
                hosted: hosted_names.contains(&entry.name),
                name: entry.name,
                description: entry.description,
                path: entry.path,
            });
        }
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(out)
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

fn remove_path(path: &Path) -> Result<(), String> {
    let result = if path.is_dir() { std::fs::remove_dir_all(path) } else { std::fs::remove_file(path) };
    result.map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir()
            .join(format!("pix-skills-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    const SKILL_MD: &str = "---\nname: my-skill\ndescription: \"Does things.\"\n---\n\n# My Skill\n";

    #[test]
    fn parses_frontmatter() {
        let (name, description) = parse_frontmatter(SKILL_MD);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(description.as_deref(), Some("Does things."));
        let (name, description) = parse_frontmatter("# no frontmatter\n");
        assert_eq!(name, None);
        assert_eq!(description, None);
    }

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
    fn collect_entries_follows_pi_discovery_rules() {
        let root = temp_root("discover");
        // Skill root with SKILL.md: found, not recursed into.
        let a = root.join("a-skill");
        std::fs::create_dir_all(a.join("nested")).unwrap();
        std::fs::write(a.join("SKILL.md"), SKILL_MD).unwrap();
        std::fs::write(a.join("nested").join("SKILL.md"), SKILL_MD).unwrap();
        // Nested skill: found via recursion.
        let b = root.join("group").join("b-skill");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join("SKILL.md"), SKILL_MD).unwrap();
        // Root-level .md counts only at the scan root.
        std::fs::write(root.join("single.md"), "---\ndescription: Single\n---\n").unwrap();
        std::fs::write(root.join("group").join("deep.md"), "x").unwrap();
        // Skipped: dot-dirs, node_modules, non-md files.
        std::fs::create_dir_all(root.join(".hidden")).unwrap();
        std::fs::write(root.join(".hidden").join("SKILL.md"), SKILL_MD).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("SKILL.md"), SKILL_MD).unwrap();
        std::fs::write(root.join("notes.txt"), "x").unwrap();

        let mut found = Vec::new();
        collect_skill_entries(&root, true, &mut found);
        let mut names: Vec<String> = found.iter().map(|(p, _)| dir_name(p)).collect();
        names.sort();
        assert_eq!(names, vec!["a-skill", "b-skill", "single.md"]);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn delete_only_allows_hosted_paths() {
        let root = temp_root("delete");
        let outside = temp_root("outside");
        std::fs::write(outside.join("x.md"), "x").unwrap();
        assert!(skills_delete(&root, outside.join("x.md").to_str().unwrap()).is_err());
        assert!(outside.join("x.md").exists());
        std::fs::write(root.join("y.md"), "y").unwrap();
        assert!(skills_delete(&root, root.join("y.md").to_str().unwrap()).is_ok());
        assert!(!root.join("y.md").exists());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
