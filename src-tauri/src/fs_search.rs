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
            let Ok(entries) = std::fs::read_dir(&dir) else { continue };
            // deterministic-ish order: push entries so files get visited before
            // descending (order within a dir doesn't matter much, scoring does)
            let mut subdirs: Vec<PathBuf> = Vec::new();
            for entry in entries.flatten() {
                visited += 1;
                if visited >= MAX_WALK_ENTRIES {
                    break;
                }
                let p = entry.path();
                let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else {
                    continue;
                };
                let is_dir = p.is_dir();
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
}
