//! 原子文件写入：先写同目录临时文件，再 rename 覆盖目标。
//!
//! Windows 上 `std::fs::rename` 使用 MoveFileExW(MOVEFILE_REPLACE_EXISTING)，
//! 可以直接覆盖已存在的目标文件；相比“先删后写”，rename 全程不存在目标
//! 文件缺失的窗口，进程中途崩溃时不会丢失旧内容。临时文件带随机后缀，
//! 避免并发写入同一目标时互相覆盖临时文件。

use std::io::Write;
use std::path::{Path, PathBuf};

fn temp_path(target: &Path) -> PathBuf {
    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    target.with_file_name(format!("{name}.{}.tmp", uuid::Uuid::new_v4()))
}

/// 原子地把 `contents` 写入 `target`：写同目录临时文件并落盘后 rename 覆盖。
/// 需要时自动创建父目录；失败时清理临时文件。
pub fn write(target: &Path, contents: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)?;
        }
    }
    let temporary = temp_path(target);
    let result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&temporary)?;
        file.write_all(contents)?;
        // rename 前落盘，避免断电后留下截断内容。
        file.sync_all()?;
        std::fs::rename(&temporary, target)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pix-atomic-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn leftover_temp_files(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.extension().is_some_and(|ext| ext == "tmp"))
            .collect()
    }

    #[test]
    fn writes_new_file_with_parents_and_exact_content() {
        let dir = temp_dir("new");
        let target = dir.join("nested").join("config.json");
        write(&target, b"{\"a\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "{\"a\":1}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn overwrites_existing_file_without_missing_window_or_leftovers() {
        let dir = temp_dir("overwrite");
        let target = dir.join("config.json");
        write(&target, b"old").unwrap();
        write(&target, b"new-content").unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new-content");
        // 原子替换不留临时文件，目录里只有目标本身。
        assert_eq!(leftover_temp_files(&dir), Vec::<PathBuf>::new());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn concurrent_writers_always_leave_a_complete_snapshot() {
        let dir = temp_dir("concurrent");
        let target = dir.join("config.json");
        let payload = |tag: &str| format!("payload-{tag}-{}", "x".repeat(4096));
        let handles: Vec<_> = ["a", "b", "c", "d"]
            .into_iter()
            .map(|tag| {
                let target = target.clone();
                let body = payload(tag);
                std::thread::spawn(move || write(&target, body.as_bytes()))
            })
            .collect();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
        let final_content = std::fs::read_to_string(&target).unwrap();
        assert!(["a", "b", "c", "d"].iter().any(|tag| final_content == payload(tag)));
        assert_eq!(leftover_temp_files(&dir), Vec::<PathBuf>::new());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
