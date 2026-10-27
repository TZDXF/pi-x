use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Copy, Debug, Default)]
pub struct WalkOptions {
    pub follow_links: bool,
    pub sort_entries: bool,
    pub ignore_read_errors: bool,
    pub ignore_root_errors: bool,
    pub max_depth: Option<usize>,
    pub max_entries: Option<usize>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WalkControl {
    Continue,
    Skip,
    Stop,
}

#[derive(Debug)]
pub struct WalkEntry {
    pub path: PathBuf,
    pub name: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub depth: usize,
}

/// Depth-first directory walking with caller-controlled filtering and limits.
/// The visitor returns `Skip` to avoid descending into a directory or `Stop` to
/// end the whole walk. Symlink cycles are detected when links are followed.
pub fn fs_walk(
    root: &Path,
    options: WalkOptions,
    mut visit: impl FnMut(WalkEntry) -> Result<WalkControl, String>,
) -> Result<(), String> {
    let mut visited_dirs = HashSet::new();
    let mut entries_seen = 0usize;
    walk_dir(
        root,
        0,
        options,
        &mut visited_dirs,
        &mut entries_seen,
        &mut visit,
    )
    .map(|_| ())
}

fn walk_dir(
    dir: &Path,
    depth: usize,
    options: WalkOptions,
    visited_dirs: &mut HashSet<PathBuf>,
    entries_seen: &mut usize,
    visit: &mut impl FnMut(WalkEntry) -> Result<WalkControl, String>,
) -> Result<bool, String> {
    if options.max_depth.is_some_and(|max| depth >= max) {
        return Ok(false);
    }
    if options.follow_links {
        let key = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
        if !visited_dirs.insert(key) {
            return Ok(false);
        }
    }
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) if options.ignore_read_errors && (depth > 0 || options.ignore_root_errors) => {
            return Ok(false);
        }
        Err(error) => return Err(error.to_string()),
    };
    let mut entries = if options.ignore_read_errors {
        entries.flatten().collect::<Vec<_>>()
    } else {
        entries
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    if options.sort_entries {
        entries.sort_by_key(|entry| entry.file_name());
    }
    for entry in entries {
        *entries_seen += 1;
        if options.max_entries.is_some_and(|max| *entries_seen >= max) {
            return Ok(true);
        }
        let path = entry.path();
        let Some(name) = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
        else {
            continue;
        };
        let (is_dir, is_file) = if options.follow_links {
            (path.is_dir(), path.is_file())
        } else {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                if metadata.file_attributes() & 0x400 != 0 {
                    continue;
                }
            }
            (kind.is_dir(), kind.is_file())
        };
        if !is_dir && !is_file {
            continue;
        }
        let control = visit(WalkEntry {
            path: path.clone(),
            name,
            is_dir,
            is_file,
            depth,
        })?;
        if control == WalkControl::Stop {
            return Ok(true);
        }
        if is_dir && control == WalkControl::Continue {
            if walk_dir(&path, depth + 1, options, visited_dirs, entries_seen, visit)? {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supports_filtering_depth_and_early_stop() {
        let root = std::env::temp_dir().join(format!("pix-walk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src/nested")).unwrap();
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("src/a.ts"), b"").unwrap();
        std::fs::write(root.join("src/nested/b.ts"), b"").unwrap();
        std::fs::write(root.join("node_modules/c.ts"), b"").unwrap();

        let mut files = Vec::new();
        fs_walk(
            &root,
            WalkOptions {
                max_depth: Some(2),
                sort_entries: true,
                ..WalkOptions::default()
            },
            |entry| {
                if entry.is_dir && entry.name == "node_modules" {
                    return Ok(WalkControl::Skip);
                }
                if entry.is_file {
                    files.push(
                        entry
                            .path
                            .strip_prefix(&root)
                            .unwrap()
                            .to_string_lossy()
                            .replace('\\', "/"),
                    );
                }
                Ok(WalkControl::Continue)
            },
        )
        .unwrap();
        assert_eq!(files, ["src/a.ts"]);

        let mut visited = 0;
        fs_walk(&root, WalkOptions::default(), |_| {
            visited += 1;
            Ok(WalkControl::Stop)
        })
        .unwrap();
        assert_eq!(visited, 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
