//! Read-only discovery of skills Pi finds outside the hosted root (global
//! agent directories, installed packages, explicit Pi settings paths), plus
//! the Pi settings `skills` array access behind a short TTL cache.

use dunce::canonicalize;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::errors::pix_error;

use super::hosted::{hosted_entry, scan_root};
use super::preview::skill_preview_root;
use super::skills_root;

pub(super) fn pi_skill_paths() -> Result<Vec<String>, String> {
    let value = crate::pi_data::call(serde_json::json!({ "op": "settings_get" }))?;
    Ok(value
        .get("skills")
        .and_then(Value::as_array)
        .map(|array| {
            array
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default())
}

/// TTL for the cached Pi settings skill paths: each uncached read shells out
/// to a fresh Node process (hundreds of ms), which made the per-file preview
/// guards pay a cold start for every listed or read file.
const PI_SKILL_PATHS_TTL: Duration = Duration::from_secs(10);

fn pi_skill_paths_cache() -> &'static Mutex<Option<(Instant, Vec<String>)>> {
    static CACHE: OnceLock<Mutex<Option<(Instant, Vec<String>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

/// [`pi_skill_paths`] behind a short TTL cache, used by the per-file preview
/// guards (`skills_list_files` / `skills_read_file`). App-side writes refresh
/// the cache eagerly in [`save_pi_skill_paths`], so only edits made outside
/// this app (e.g. `pi config` in a terminal) become visible with a delay of
/// up to [`PI_SKILL_PATHS_TTL`].
pub(super) fn cached_pi_skill_paths() -> Result<Vec<String>, String> {
    let mut cache = pi_skill_paths_cache()
        .lock()
        .map_err(|e| e.to_string())?;
    if let Some((at, paths)) = cache.as_ref() {
        if at.elapsed() < PI_SKILL_PATHS_TTL {
            return Ok(paths.clone());
        }
    }
    let paths = pi_skill_paths()?;
    *cache = Some((Instant::now(), paths.clone()));
    Ok(paths)
}

pub(super) fn save_pi_skill_paths(paths: Vec<String>) -> Result<(), String> {
    crate::pi_data::call(serde_json::json!({
        "op": "settings_save",
        "settings": { "skills": paths.clone() }
    }))?;
    // Write-through: the preview guard's cache must not serve stale paths.
    if let Ok(mut cache) = pi_skill_paths_cache().lock() {
        *cache = Some((Instant::now(), paths));
    }
    Ok(())
}

/// A skill Pi discovers outside the hosted root.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredSkill {
    pub name: String,
    pub description: String,
    /// Absolute path of the skill directory or Markdown file.
    pub path: String,
    /// Whether this exact path is already managed under `~/.pix/skills`.
    pub hosted: bool,
    /// globalPi | globalAgents | packageGlobal | settingsGlobal.
    pub source_kind: String,
    /// Package source when source_kind is package.
    pub source_name: Option<String>,
}

/// Pi's discovery rules: if `dir` contains `SKILL.md` it is a skill root and
/// recursion stops; otherwise recurse into non-dot, non-node_modules
/// subdirectories; root-level `.md` files only count at the scan root.
pub(super) fn collect_skill_entries(
    dir: &Path,
    include_root_files: bool,
    out: &mut Vec<(PathBuf, &'static str)>,
) {
    let mut visited = HashSet::new();
    collect_skill_entries_inner(dir, include_root_files, 0, &mut visited, out);
}

/// Max recursion depth for discovery scans; guards against pathological nests.
const MAX_SKILL_SCAN_DEPTH: usize = 16;

fn collect_skill_entries_inner(
    dir: &Path,
    include_root_files: bool,
    depth: usize,
    visited: &mut HashSet<PathBuf>,
    out: &mut Vec<(PathBuf, &'static str)>,
) {
    if depth >= MAX_SKILL_SCAN_DEPTH {
        return;
    }
    // The recursion below follows symlinks/junctions (matching Pi's behavior),
    // so track canonical paths to break cycles instead of recursing forever.
    if !visited.insert(canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf())) {
        return;
    }
    if dir.join("SKILL.md").is_file() {
        out.push((dir.to_path_buf(), "directory"));
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        // `is_dir` follows symlinks/junctions, matching Pi's behavior.
        if path.is_dir() {
            collect_skill_entries_inner(&path, false, depth + 1, visited, out);
        } else if include_root_files
            && path
                .extension()
                .map(|e| e.to_ascii_lowercase() == "md")
                .unwrap_or(false)
        {
            out.push((path, "file"));
        }
    }
}

#[tauri::command]
pub async fn skills_discovered_list() -> Result<Vec<DiscoveredSkill>, String> {
    tokio::task::spawn_blocking(skills_discovered)
        .await
        .map_err(|e| e.to_string())?
}

type SkillLocation = (PathBuf, PathBuf, &'static str, &'static str, Option<String>);

fn add_root_locations(locations: &mut Vec<SkillLocation>, root: &Path, source: &'static str) {
    let mut found = Vec::new();
    collect_skill_entries(root, true, &mut found);
    for (path, kind) in found {
        locations.push((root.to_path_buf(), path, kind, source, None));
    }
}

pub(super) fn add_explicit_locations(
    locations: &mut Vec<SkillLocation>,
    raw: &str,
    base: &Path,
    home: &Path,
    source: &'static str,
) {
    let expanded = if raw == "~" {
        home.to_path_buf()
    } else if raw.starts_with("~/") || raw.starts_with("~\\") {
        home.join(&raw[2..])
    } else {
        PathBuf::from(raw)
    };
    let path = if expanded.is_absolute() {
        expanded
    } else {
        base.join(expanded)
    };
    if path.is_dir() {
        add_root_locations(locations, &path, source);
    } else if path.is_file()
        && path
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("md"))
    {
        locations.push((path.clone(), path, "file", source, None));
    }
}

fn skills_discovered() -> Result<Vec<DiscoveredSkill>, String> {
    let hosted_root = skills_root();
    let hosted_paths: HashSet<PathBuf> = scan_root(&hosted_root)
        .unwrap_or_default()
        .iter()
        .map(|(path, _)| canonicalize(path).unwrap_or_else(|_| path.clone()))
        .collect();

    // Only global skills are auto-discovered; project-scoped sources (project
    // .pi/.agents directories, project packages, project settings paths) are
    // intentionally excluded.
    let mut out = Vec::new();
    let mut seen_paths = HashSet::new();
    for (root, path, kind, source_kind, source_name) in discovered_locations()? {
        let canonical = canonicalize(&path).unwrap_or_else(|_| path.clone());
        if !seen_paths.insert(canonical.clone()) {
            continue;
        }
        let Ok(entry) = hosted_entry(&root, &path, kind) else {
            continue;
        };
        if entry.description.trim().is_empty() {
            continue;
        }
        out.push(DiscoveredSkill {
            hosted: hosted_paths.contains(&canonical),
            name: entry.name,
            description: entry.description,
            path: entry.path,
            source_kind: source_kind.to_string(),
            source_name,
        });
    }
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then(a.path.cmp(&b.path))
    });
    Ok(out)
}

/// Candidate skill locations shared by discovery listing and the preview root
/// check in [`ensure_discovered_skill_root`].
fn discovered_locations() -> Result<Vec<SkillLocation>, String> {
    discovered_locations_from(&pi_skill_paths()?)
}

/// [`discovered_locations`] with the Pi settings skill paths supplied by the
/// caller, letting the per-file preview guard use [`cached_pi_skill_paths`]
/// without caching anything for the other callers.
fn discovered_locations_from(settings_paths: &[String]) -> Result<Vec<SkillLocation>, String> {
    let home = dirs::home_dir().ok_or("Cannot locate home directory")?;
    let agent_dir = crate::trust::agent_dir();
    let mut locations: Vec<SkillLocation> = Vec::new();
    add_root_locations(&mut locations, &agent_dir.join("skills"), "globalPi");
    add_root_locations(
        &mut locations,
        &home.join(".agents").join("skills"),
        "globalAgents",
    );
    for package in crate::packages::package_skill_paths(None) {
        let path = package.path;
        let kind = if path.join("SKILL.md").is_file() {
            Some("directory")
        } else if path.is_file()
            && path
                .extension()
                .is_some_and(|e| e.eq_ignore_ascii_case("md"))
        {
            Some("file")
        } else {
            None
        };
        if let Some(kind) = kind {
            locations.push((
                path.clone(),
                path,
                kind,
                "packageGlobal",
                Some(package.source),
            ));
        }
    }
    // Pi's explicit settings paths can point outside all discovery directories.
    // Keep hosted paths out of this list; they already have editable controls above.
    for raw in settings_paths {
        add_explicit_locations(&mut locations, raw, &agent_dir, &home, "settingsGlobal");
    }
    Ok(locations)
}

/// Whether a preview root is one of the discovered skill roots: a directory
/// skill itself, or the parent directory of a single-file skill.
fn skill_root_allowed(root: &Path, locations: &[PathBuf]) -> bool {
    let Ok(canonical_root) = canonicalize(root) else {
        return false;
    };
    locations.iter().any(|loc| {
        let loc = if loc.is_file() {
            match loc.parent() {
                Some(parent) => parent.to_path_buf(),
                None => return false,
            }
        } else {
            loc.clone()
        };
        canonicalize(&loc)
            .map(|c| c == canonical_root)
            .unwrap_or(false)
    })
}

/// Restrict skill preview to skills actually found by discovery. Without this
/// the list/read commands would accept any absolute path and become an
/// arbitrary-file-read primitive.
pub(super) fn ensure_discovered_skill_root(path: &str) -> Result<(), String> {
    let root = skill_preview_root(path);
    let settings_paths = cached_pi_skill_paths()?;
    let locations = discovered_locations_from(&settings_paths)?;
    let allowed: Vec<PathBuf> = locations.into_iter().map(|(_, p, ..)| p).collect();
    if skill_root_allowed(&root, &allowed) {
        Ok(())
    } else {
        Err(pix_error(
            "invalidResourcePath",
            "技能路径不在已发现的技能列表中",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::skills::dir_name;
    use crate::skills::test_util::{create_dir_symlink, temp_root, SKILL_MD};

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
    fn explicit_settings_paths_keep_their_source() {
        let root = temp_root("configured");
        let skill = root.join("custom").join("my-skill");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::write(skill.join("SKILL.md"), SKILL_MD).unwrap();
        let mut locations = Vec::new();
        add_explicit_locations(
            &mut locations,
            "custom/my-skill",
            &root,
            &root,
            "settingsGlobal",
        );
        assert_eq!(locations.len(), 1);
        assert_eq!(locations[0].1, skill);
        assert_eq!(locations[0].3, "settingsGlobal");
        let entry = hosted_entry(&locations[0].0, &locations[0].1, locations[0].2).unwrap();
        assert_eq!(entry.name, "my-skill");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collect_entries_survive_symlink_cycles() {
        let root = temp_root("cycle");
        if !create_dir_symlink(&root, &root.join("loop")) {
            return; // symlink/junction creation unavailable; nothing to test
        }
        let mut found = Vec::new();
        collect_skill_entries(&root, true, &mut found);
        assert!(found.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn collect_entries_respect_depth_limit() {
        let root = temp_root("depth");
        // A skill nested beyond MAX_SKILL_SCAN_DEPTH is not found...
        let mut deep = root.join("deep");
        for _ in 0..15 {
            deep = deep.join("n");
        }
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::write(deep.join("SKILL.md"), SKILL_MD).unwrap();
        // ...while one within the limit still is.
        let shallow = root.join("shallow").join("n").join("n");
        std::fs::create_dir_all(&shallow).unwrap();
        std::fs::write(shallow.join("SKILL.md"), SKILL_MD).unwrap();

        let mut found = Vec::new();
        collect_skill_entries(&root, true, &mut found);
        assert!(found.iter().any(|(p, _)| p == &shallow));
        assert!(!found.iter().any(|(p, _)| p == &deep));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_root_allowed_matches_discovered_locations() {
        let root = temp_root("root-allowed");
        let skill = root.join("my-skill");
        std::fs::create_dir_all(&skill).unwrap();
        let file_skill = root.join("single.md");
        std::fs::write(&file_skill, SKILL_MD).unwrap();

        // A directory skill's own path is allowed...
        assert!(skill_root_allowed(&skill, &[skill.clone()]));
        // ...and so is the parent dir of a single-file skill.
        assert!(skill_root_allowed(&root, &[file_skill.clone()]));
        // Unrelated or nonexistent roots are rejected.
        let other = temp_root("root-other");
        assert!(!skill_root_allowed(&skill, &[other]));
        assert!(!skill_root_allowed(&root.join("missing"), &[skill]));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pi_skill_paths_cache_serves_fresh_entries_without_a_pi_process() {
        let paths = vec!["/tmp/cached-skill".to_string()];
        *pi_skill_paths_cache().lock().unwrap() = Some((Instant::now(), paths.clone()));
        // A fresh cache entry answers from memory; no Node cold start happens.
        assert_eq!(cached_pi_skill_paths().unwrap(), paths);
        // Entries past the TTL are no longer treated as fresh (the next
        // cached_pi_skill_paths call would re-query pi instead of serving
        // the stale value).
        let stale = Instant::now()
            .checked_sub(PI_SKILL_PATHS_TTL + Duration::from_secs(1))
            .unwrap();
        *pi_skill_paths_cache().lock().unwrap() = Some((stale, Vec::new()));
        let guard = pi_skill_paths_cache().lock().unwrap();
        assert!(!guard
            .as_ref()
            .is_some_and(|(at, _)| at.elapsed() < PI_SKILL_PATHS_TTL));
    }
}
