//! Search project files for the `@file` mention completion.
//!
//! Walks the project directory (skipping dependency/build dirs), scores
//! matches against the query (basename prefix > basename contains > path
//! contains) and returns the top hits as project-relative paths.

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_WALK_ENTRIES: usize = 30_000;
const MAX_HITS: usize = 50;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".hg",
    ".svn",
    "dist",
    "build",
    "out",
    "target",
    "coverage",
    ".next",
    ".nuxt",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".pi",
    ".idea",
    ".vscode",
];

#[derive(Serialize, Clone)]
pub struct FileHit {
    /// Project-relative path, forward slashes (e.g. `src/stores/session.ts`)
    pub path: String,
    pub name: String,
    pub dir: String,
}

fn score(path_lower: &str, name_lower: &str, q: &str) -> Option<u8> {
    if name_lower.starts_with(q) {
        Some(0)
    }
    else if name_lower.contains(q) {
        Some(1)
    }
    else if path_lower.contains(q) {
        Some(2)
    }
    else {
        None
    }
}


/// One directory at a time for the project-files sidebar. Never follow links or
/// allow a relative path to escape the selected workspace.
#[derive(Serialize)]
pub struct ProjectEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

pub async fn list_directory(project: String, path: String) -> Result<Vec<ProjectEntry>, String> {
    tokio::task::spawn_blocking(move || {
        let root = dunce::canonicalize(&project).map_err(|e| e.to_string())?;
        if !root.is_dir() { return Err("Project is not a directory".into()); }
        let relative = Path::new(&path);
        if relative.is_absolute() || (!path.is_empty() && relative.components().any(|part| !matches!(part, std::path::Component::Normal(_)))) {
            return Err("Invalid project-relative path".into());
        }
        let directory = dunce::canonicalize(root.join(relative)).map_err(|e| e.to_string())?;
        if !directory.starts_with(&root) || !directory.is_dir() {
            return Err("Directory is outside the project".into());
        }
        let mut entries = Vec::new();
        for entry in std::fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || !(kind.is_dir() || kind.is_file()) { continue; }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                if entry.metadata().map_err(|e| e.to_string())?.file_attributes() & 0x400 != 0 { continue; }
            }
            let name = entry.file_name().to_string_lossy().to_string();
            entries.push(ProjectEntry {
                path: if path.is_empty() { name.clone() } else { format!("{path}/{name}") },
                name,
                is_dir: kind.is_dir(),
            });
            if entries.len() >= 2000 { break; }
        }
        entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
        Ok(entries)
    }).await.map_err(|e| e.to_string())?
}

pub async fn search(project: String, query: String) -> Result<Vec<FileHit>, String> {
    let root = PathBuf::from(&project);
    if !root.is_dir() {
        return Err(format!("not a directory: {project}"));
    }
    tokio::task::spawn_blocking(move || {
        let q = query.to_lowercase().replace('\\', "/");
        let q = q.trim_start_matches('/').to_string();

        let mut hits: Vec<(u8, String, String, String)> = Vec::new();
        let mut visited = 0usize;
        let mut stack = vec![root.clone()];

        while let Some(dir) = stack.pop() {
            if visited >= MAX_WALK_ENTRIES || hits.len() >= MAX_HITS * 8 {
                break;
            }
            let entries = match std::fs::read_dir(&dir) {
                Ok(entries) => entries,
                Err(e) if dir == root => return Err(format!("cannot search project: {e}")),
                Err(_) => continue,
            };
            let mut entries: Vec<_> = entries.flatten().collect();
            entries.sort_by_key(|entry| entry.file_name());
            // deterministic-ish order: push entries so files get visited before
            // descending (order within a dir doesn't matter much, scoring does)
            let mut subdirs: Vec<PathBuf> = Vec::new();
            for entry in entries {
                visited += 1;
                if visited >= MAX_WALK_ENTRIES {
                    break;
                }
                let p = entry.path();
                let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else {
                    continue;
                };
                // Do not traverse symlinks/junctions or suggest files outside the project.
                let Ok(kind) = entry.file_type() else { continue };
                if kind.is_symlink() { continue; }
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    let Ok(metadata) = entry.metadata() else { continue };
                    if metadata.file_attributes() & 0x400 != 0 { continue; }
                }
                let is_dir = kind.is_dir();
                if !is_dir && !kind.is_file() { continue; }
                if is_dir {
                    if SKIP_DIRS.contains(&name.as_str()) || name.starts_with('.') {
                        continue;
                    }
                    subdirs.push(p);
                    continue;
                }
                if q.is_empty() {
                    // no query: only suggest top-level-ish entries to keep the list sane
                    if hits.len() < MAX_HITS {
                        let rel = match p.strip_prefix(&root) {
                            Ok(r) => r.to_string_lossy().replace('\\', "/"),
                            Err(_) => continue,
                        };
                        let name_l = name.to_lowercase();
                        if let Some(s) = score(&rel.to_lowercase(), &name_l, "") {
                            let dir_part = Path::new(&rel)
                                .parent()
                                .map(|d| d.to_string_lossy().replace('\\', "/"))
                                .unwrap_or_default();
                            hits.push((s, rel, name, dir_part));
                        }
                    }
                    continue;
                }
                let rel = match p.strip_prefix(&root) {
                    Ok(r) => r.to_string_lossy().replace('\\', "/"),
                    Err(_) => continue,
                };
                let name_l = name.to_lowercase();
                if let Some(s) = score(&rel.to_lowercase(), &name_l, &q) {
                    let dir_part = Path::new(&rel)
                        .parent()
                        .map(|d| d.to_string_lossy().replace('\\', "/"))
                        .unwrap_or_default();
                    hits.push((s, rel, name, dir_part));
                }
            }
            // push dirs in reverse so traversal is roughly alphabetical
            subdirs.sort_by(|a, b| b.cmp(a));
            for d in subdirs {
                stack.push(d);
            }
        }

        hits.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        hits.truncate(MAX_HITS);
        Ok(hits
            .into_iter()
            .map(|(_, path, name, dir)| FileHit { path, name, dir })
            .collect())
    })
    .await
    .map_err(|e| format!("file search failed: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn finds_and_skips_dependency_dirs() {
        let root = std::env::temp_dir().join("pix-fssearch-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("src").join("session.ts"), "").unwrap();
        std::fs::write(root.join("node_modules").join("evil.ts"), "").unwrap();

        let hits = search(root.to_string_lossy().to_string(), "session".into()).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path.replace('\\', "/"), "src/session.ts");

        let empty = search(root.to_string_lossy().to_string(), "evil".into()).await.unwrap();
        assert!(empty.is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }
    #[tokio::test]
    async fn unicode_spaces_separators_and_result_limit() {
        let root = std::env::temp_dir().join(format!("pix-fssearch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("中文 file.ts"), "").unwrap();
        for index in 0..70 {
            std::fs::write(root.join(format!("file-{index:03}.ts")), "").unwrap();
        }
        let project = root.to_string_lossy().to_string();
        let hits = search(project.clone(), "src\\中文".into()).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "src/中文 file.ts");
        let hits = search(project.clone(), "file".into()).await.unwrap();
        assert_eq!(hits.len(), MAX_HITS);
        assert_eq!(hits[0].path, "file-000.ts");
        let again = search(project, "file".into()).await.unwrap();
        assert_eq!(hits.iter().map(|h| &h.path).collect::<Vec<_>>(), again.iter().map(|h| &h.path).collect::<Vec<_>>());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn project_directory_stays_inside_root_and_lists_children() {
        let root = std::env::temp_dir().join(format!("pix-files-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("main.ts"), "").unwrap();
        let project = root.to_string_lossy().to_string();
        let top = list_directory(project.clone(), "".into()).await.unwrap();
        assert_eq!(top.len(), 1);
        assert!(top[0].is_dir);
        assert_eq!(top[0].path, "src");
        let nested = list_directory(project.clone(), "src".into()).await.unwrap();
        assert_eq!(nested[0].path, "src/main.ts");
        assert!(!nested[0].is_dir);
        assert!(list_directory(project.clone(), "../".into()).await.is_err());
        assert!(list_directory(project, root.to_string_lossy().to_string()).await.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn missing_project_reports_error_instead_of_empty_results() {
        let root = std::env::temp_dir().join(format!("pix-missing-{}", uuid::Uuid::new_v4()));
        assert!(search(root.to_string_lossy().to_string(), "".into()).await.is_err());
    }

}
