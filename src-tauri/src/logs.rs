//! Diagnostic logs for pi process lifecycle events and stderr output.
//!
//! One file per local date at `~/.pix/logs/YYYY-MM-DD.log`. Files older than
//! 7 days are pruned at startup and again when the date rolls over while the
//! app keeps running. All writes are best-effort: logging must never fail or
//! block the caller's actual work.

use std::sync::Mutex;

const RETENTION_DAYS: i64 = 7;

static LAST_PRUNE_DAY: Mutex<Option<chrono::NaiveDate>> = Mutex::new(None);
static WRITE_LOCK: Mutex<()> = Mutex::new(());

fn dir() -> std::path::PathBuf {
    crate::data_dir::root().join("logs")
}

pub fn initialize() {
    let _ = std::fs::create_dir_all(dir());
    prune(chrono::Local::now().date_naive());
}

fn prune(today: chrono::NaiveDate) {
    prune_dir(&dir(), today);
}

fn prune_dir(dir: &std::path::Path, today: chrono::NaiveDate) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(date) = name
            .strip_suffix(".log")
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        else { continue };
        if (today - date).num_days() >= RETENTION_DAYS {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Append one timestamped line to today's log file.
pub fn write(runtime_id: &str, message: &str) {
    let now = chrono::Local::now();
    let today = now.date_naive();
    {
        let mut last = LAST_PRUNE_DAY.lock().unwrap();
        if *last != Some(today) {
            *last = Some(today);
            prune(today);
        }
    }
    let path = dir().join(format!("{today}.log"));
    let line = format!("[{}] [{runtime_id}] {message}\n", now.format("%H:%M:%S%.3f"));
    let _guard = WRITE_LOCK.lock();
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prune_removes_logs_older_than_seven_days() {
        let dir = std::env::temp_dir().join(format!("pix-logs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for name in ["2026-09-18.log", "2026-09-19.log", "2026-09-20.log", "2026-09-26.log", "notes.txt"] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let today = chrono::NaiveDate::from_ymd_opt(2026, 9, 26).unwrap();
        prune_dir(&dir, today);
        assert!(!dir.join("2026-09-18.log").exists());
        assert!(!dir.join("2026-09-19.log").exists(), "today-7: pruned");
        assert!(dir.join("2026-09-20.log").exists(), "today-6: kept, 7 days total");
        assert!(dir.join("2026-09-26.log").exists(), "today: kept");
        assert!(dir.join("notes.txt").exists(), "non-log files untouched");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}