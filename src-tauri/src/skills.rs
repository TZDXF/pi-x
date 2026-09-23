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

/// Import complete skills into `~/.pix/skills/`. Sources may be skill
/// directories (copied whole) or skill Markdown files; a `SKILL.md` source
/// imports its parent directory. Existing entries are reported as conflicts
/// unless `overwrite` is set. Imported skills start disabled.
#[tauri::command]
pub async fn skills_hosted_import(sources: Vec<String>, overwrite: bool) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || skills_import(&skills_root(), &sources, overwrite))
        .await
        .map_err(|e| e.to_string())?
}

fn skills_import(root: &Path, sources: &[String], overwrite: bool) -> Result<Value, String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut imported = Vec::new();
    let mut conflicts = Vec::new();
    for source in sources {
        let source = canonicalize(source).map_err(|e| format!("{source}: {e}"))?;
        // A selected SKILL.md stands for its complete parent directory.
        let (src_dir, src_file) = if source.is_dir() {
            (source.clone(), None)
        } else if source.file_name().map(|n| n == "SKILL.md").unwrap_or(false) {
            let parent = source.parent().ok_or("Invalid SKILL.md path")?.to_path_buf();
            (parent, None)
        } else {
            (source.clone(), Some(source.clone()))
        };
        if src_file.is_none() && !src_dir.join("SKILL.md").is_file() {
            return Err(format!("not a skill (missing SKILL.md): {}", src_dir.display()));
        }
        if let Some(file) = &src_file {
            let (_, description) = read_frontmatter(file)?;
            if description.as_deref().unwrap_or_default().is_empty() {
                return Err(format!(
                    "not a skill (frontmatter description required): {}",
                    file.display()
                ));
            }
        }
        let name = if src_file.is_some() { stem(&source) } else { dir_name(&src_dir) };
        if name.is_empty() || name.starts_with('.') {
            return Err(format!("invalid skill name: {name}"));
        }
        let target = root.join(&name);
        if target.exists() {
            if !overwrite {
                conflicts.push(name);
                continue;
            }
            remove_path(&target)?;
        }
        match &src_file {
            Some(file) => {
                std::fs::copy(file, &target).map_err(|e| e.to_string())?;
            }
            None => copy_dir(&src_dir, &target).map_err(|e| e.to_string())?,
        }
        imported.push(name);
    }
    Ok(serde_json::json!({ "imported": imported, "conflicts": conflicts }))
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

/// A skill Pi auto-discovers outside the hosted root: `~/.pi/agent/skills`,
/// `~/.agents/skills`, and the project's `.pi/skills` / `.agents/skills`.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    /// Absolute path of the skill directory or Markdown file.
    pub path: String,
    /// `user` or `project`, matching Pi's scopes.
    pub scope: String,
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
pub async fn skills_discovered_list(project: Option<String>) -> Result<Vec<DiscoveredSkill>, String> {
    tokio::task::spawn_blocking(move || skills_discovered(project.as_deref())).await.map_err(|e| e.to_string())?
}

fn skills_discovered(project: Option<&str>) -> Result<Vec<DiscoveredSkill>, String> {
    let home = dirs::home_dir().ok_or("Cannot locate home directory")?;
    let mut roots: Vec<(PathBuf, &str)> = vec![
        (home.join(".pi").join("agent").join("skills"), "user"),
        (home.join(".agents").join("skills"), "user"),
    ];
    if let Some(project) = project {
        let project = PathBuf::from(project);
        if project.is_dir() {
            roots.push((project.join(".pi").join("skills"), "project"));
            roots.push((project.join(".agents").join("skills"), "project"));
        }
    }

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
    for (root, scope) in roots {
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
                scope: scope.to_string(),
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

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
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
    fn imports_directory_and_skmd_and_reports_conflicts() {
        let root = temp_root("import");
        let source = temp_root("src");
        std::fs::create_dir_all(source.join("my-skill/scripts")).unwrap();
        std::fs::write(source.join("my-skill/SKILL.md"), SKILL_MD).unwrap();
        std::fs::write(source.join("my-skill/scripts/run.sh"), "#!/bin/sh\n").unwrap();
        let src = source.join("my-skill").to_string_lossy().into_owned();

        let result = skills_import(&root, &[src.clone()], false).unwrap();
        assert_eq!(result["imported"], serde_json::json!(["my-skill"]));
        assert!(root.join("my-skill/scripts/run.sh").is_file());

        // Same source again without overwrite → conflict; with overwrite → replaced.
        let result = skills_import(&root, &[src.clone()], false).unwrap();
        assert_eq!(result["conflicts"], serde_json::json!(["my-skill"]));
        std::fs::write(source.join("my-skill/SKILL.md"), "---\nname: my-skill\ndescription: v2\n---\n").unwrap();
        let result = skills_import(&root, &[src.clone()], true).unwrap();
        assert_eq!(result["imported"], serde_json::json!(["my-skill"]));
        assert_eq!(hosted_entry(&root, &root.join("my-skill"), "directory").unwrap().description, "v2");

        // A lone SKILL.md imports its parent directory.
        let skmd = source.join("my-skill").join("SKILL.md").to_string_lossy().into_owned();
        let result = skills_import(&root, &[skmd], false).unwrap();
        assert_eq!(result["conflicts"], serde_json::json!(["my-skill"]));

        // Directories without SKILL.md are rejected.
        let empty = source.join("scripts").to_string_lossy().into_owned();
        assert!(skills_import(&root, &[empty], false).is_err());
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(source).unwrap();
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
