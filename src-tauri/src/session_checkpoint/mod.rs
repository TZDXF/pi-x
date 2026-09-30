//! 轮次级 Git 快照（checkpoint），移植自 zai-org/ZCode 的 gitCheckpointRepo 设计：
//! - 用临时 GIT_INDEX_FILE 把当前工作区固化成 commit（write-tree → commit-tree）；
//! - 快照对象写入 `.git/pix/checkpoint-objects/<workspace>`，不创建 Git ref，因此不会
//!   出现在 `git log --all`、分支图或 Git 工具的提交记录中；
//! - 恢复前先做 blob hash 冲突检测（当前磁盘必须仍等于声明基线），`git restore
//!   --worktree` 只恢复文件、不动暂存区，最后再校验落盘结果。

mod diff;
mod git;
mod manifest;
mod restore;

pub use diff::CheckpointFileDiff;

use serde::Serialize;
use tokio::task::spawn_blocking;

use crate::errors::pix_error_detail;

use git::{
    checkpoint_env, checkpoint_object_env, delete_legacy_checkpoint_refs, git_in, git_raw_bytes,
    resolve_repo,
};

#[derive(Serialize, Debug)]
pub struct CheckpointMeta {
    #[serde(rename = "commitOid")]
    pub commit_oid: String,
}

#[derive(Serialize, Debug)]
pub struct CheckpointConflict {
    pub path: String,
    pub reason: String,
}

#[derive(Serialize, Debug)]
pub struct CheckpointRestoreResult {
    pub restored: Vec<String>,
    pub conflicts: Vec<CheckpointConflict>,
}

fn create_checkpoint(
    layout: &git::RepoLayout,
    checkpoint_id: &str,
) -> Result<CheckpointMeta, String> {
    std::fs::create_dir_all(&layout.checkpoint_objects_dir).map_err(|e| e.to_string())?;
    let temp_root = std::env::temp_dir().join("pix-checkpoint-index");
    std::fs::create_dir_all(&temp_root).map_err(|e| e.to_string())?;
    let temp_dir = temp_root.join(format!("index-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&temp_dir).map_err(|e| e.to_string())?;
    let temp_index = temp_dir.join("index");
    let env = checkpoint_env(layout, &temp_index);
    let pathspec = layout.workspace_in_repo.clone();

    let result = (|| {
        // 预热临时 index：优先复制用户真实 index（未改动文件走 stat-match 快速路径），
        // 降级 read-tree HEAD，最差空 index。避免大仓库全量 hash 超时（ZCode 的关键优化）。
        let mut primed = false;
        if let Ok(index_rel) = git_in(
            &layout.repo_root,
            &["rev-parse", "--git-path", "index"],
            None,
        ) {
            if !index_rel.is_empty() {
                let user_index = layout.repo_root.join(index_rel);
                if std::fs::copy(&user_index, &temp_index).is_ok() {
                    primed = true;
                }
            }
        }
        if !primed && git_in(&layout.repo_root, &["read-tree", "HEAD"], Some(&env)).is_ok() {
            primed = true;
        }
        let _ = primed;

        git_in(
            &layout.repo_root,
            &["add", "-A", "--", &pathspec],
            Some(&env),
        )?;
        let tree = git_in(&layout.repo_root, &["write-tree"], Some(&env))?;
        let commit = git_in(
            &layout.repo_root,
            &[
                "commit-tree",
                tree.trim(),
                "-m",
                &format!("pix checkpoint {checkpoint_id}"),
            ],
            Some(&env),
        )?;
        let commit_oid = commit.trim().to_string();
        // 只保存 commit OID，不创建 ref；快照对象位于非标准对象库，不会进入用户 Git 历史。
        Ok(CheckpointMeta { commit_oid })
    })();

    let _ = std::fs::remove_dir_all(&temp_dir);
    result
}

#[tauri::command]
pub async fn session_checkpoint_create(
    project: String,
    checkpoint_id: String,
) -> Result<CheckpointMeta, String> {
    spawn_blocking(move || {
        let layout = resolve_repo(&project)?;
        // 清理旧版本写入的 refs，避免历史会话遗留后仍出现在 git log --all 中。
        let _ = delete_legacy_checkpoint_refs(&layout);
        create_checkpoint(&layout, &checkpoint_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 快照中某个文件的内容（`oid` 为快照 commit）；文件在该快照中不存在时返回 null。
/// 供审查面板用快照前后的真实内容计算 diff（对齐 ZCode 的 before/after 能力）。
#[tauri::command]
pub async fn session_checkpoint_content(
    project: String,
    oid: String,
    path: String,
) -> Result<Option<String>, String> {
    const MAX_CONTENT_BYTES: u64 = 8 * 1024 * 1024;
    spawn_blocking(move || {
        let layout = resolve_repo(&project)?;
        let spec = format!("{oid}:{}", git::to_repo_relative(&layout, &path));
        let env = checkpoint_object_env(&layout);
        // 用 cat-file -e 检查存在性，避免 stderr 文本本地化误判
        if git_in(&layout.repo_root, &["cat-file", "-e", &spec], Some(&env)).is_err() {
            return Ok(None);
        }
        let size = git_in(&layout.repo_root, &["cat-file", "-s", &spec], Some(&env))?;
        if size.trim().parse::<u64>().unwrap_or(u64::MAX) > MAX_CONTENT_BYTES {
            return Err(pix_error_detail(
                "checkpointContentTooLarge",
                "快照文件过大，无法展示差异: {detail}",
                path,
            ));
        }
        match git_raw_bytes(&layout.repo_root, &["cat-file", "blob", &spec], Some(&env)) {
            Ok(bytes) => match String::from_utf8(bytes) {
                Ok(content) => Ok(Some(content)),
                // 非 UTF-8 内容（二进制文件）返回 null
                Err(_) => Ok(None),
            },
            Err(_) => Ok(None),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_diff(
    project: String,
    from: String,
    to: String,
) -> Result<Vec<CheckpointFileDiff>, String> {
    spawn_blocking(move || {
        let layout = resolve_repo(&project)?;
        let pathspec = layout.workspace_in_repo.clone();
        let env = checkpoint_object_env(&layout);
        let name_status = git_in(
            &layout.repo_root,
            &[
                "diff",
                "--name-status",
                "--find-renames",
                "-z",
                &from,
                &to,
                "--",
                &pathspec,
            ],
            Some(&env),
        )?;
        let numstat = git_in(
            &layout.repo_root,
            &[
                "diff",
                "--numstat",
                "--find-renames",
                "-z",
                &from,
                &to,
                "--",
                &pathspec,
            ],
            Some(&env),
        )?;
        let stats = diff::parse_numstat(&numstat);
        Ok(diff::merge_diff(
            &layout,
            &diff::parse_name_status(&name_status),
            &stats,
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_restore(
    project: String,
    from: String,
    to: String,
    paths: Option<Vec<String>>,
    tool_touched_files: Option<Vec<String>>,
) -> Result<CheckpointRestoreResult, String> {
    spawn_blocking(move || {
        let layout = resolve_repo(&project)?;
        restore::restore_between(
            &layout,
            &from,
            &to,
            paths.as_deref(),
            tool_touched_files.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

pub use manifest::{
    session_checkpoint_manifest_delete, session_checkpoint_manifest_get,
    session_checkpoint_manifest_set,
};

// Re-export the command wrapper macros so `generate_handler![session_checkpoint::<cmd>]`
// resolves them under the same path as the command functions.
#[doc(hidden)]
pub use manifest::{
    __cmd__session_checkpoint_manifest_delete, __cmd__session_checkpoint_manifest_get,
    __cmd__session_checkpoint_manifest_set,
    __tauri_command_name_session_checkpoint_manifest_delete,
    __tauri_command_name_session_checkpoint_manifest_get,
    __tauri_command_name_session_checkpoint_manifest_set,
};

#[cfg(test)]
mod tests {
    use super::diff::{parse_name_status, parse_numstat};
    use super::git::{to_repo_relative, to_workspace_relative, RepoLayout};
    use super::*;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn git_sync(project: &Path, args: &[&str]) {
        let output = Command::new("git")
            .arg("-C")
            .arg(project)
            .args(args)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.invalid")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.invalid")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    struct Repo(PathBuf);
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repo() -> Repo {
        let root =
            std::env::temp_dir().join(format!("pix-checkpoint-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        git_sync(&root, &["init", "-b", "main"]);
        // 固定行尾语义，保证测试在不同全局 autocrlf 配置下行为一致。
        git_sync(&root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("tracked.txt"), "a\nb\n").unwrap();
        git_sync(&root, &["add", "."]);
        git_sync(&root, &["commit", "-m", "initial"]);
        Repo(root)
    }

    fn diff_pairs(diffs: &[CheckpointFileDiff]) -> Vec<(String, String)> {
        let mut pairs: Vec<(String, String)> = diffs
            .iter()
            .map(|diff| (diff.path.clone(), diff.kind.clone()))
            .collect();
        pairs.sort();
        pairs
    }

    #[tokio::test]
    async fn create_diff_and_restore_turn_changes() {
        let repo = repo();
        let project = repo.0.to_string_lossy().to_string();
        let start = session_checkpoint_create(project.clone(), "start".into())
            .await
            .unwrap();
        // 模拟一轮：修改已有文件 + 新建文件
        std::fs::write(repo.0.join("tracked.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), "hello\nworld\n").unwrap();
        let end = session_checkpoint_create(project.clone(), "end".into())
            .await
            .unwrap();

        // 快照内容读取：审查面板据此计算真实 diff。
        let before = session_checkpoint_content(
            project.clone(),
            start.commit_oid.clone(),
            "tracked.txt".into(),
        )
        .await
        .unwrap();
        assert_eq!(before.as_deref(), Some("a\nb\n"));
        let after = session_checkpoint_content(
            project.clone(),
            end.commit_oid.clone(),
            "tracked.txt".into(),
        )
        .await
        .unwrap();
        assert_eq!(after.as_deref(), Some("a\nb\nc\n"));
        // 快照中不存在的新文件、从未出现过的路径 → 均为 null。
        let absent =
            session_checkpoint_content(project.clone(), start.commit_oid.clone(), "new.txt".into())
                .await
                .unwrap();
        assert_eq!(absent, None);
        let missing = session_checkpoint_content(
            project.clone(),
            start.commit_oid.clone(),
            "missing.txt".into(),
        )
        .await
        .unwrap();
        assert_eq!(missing, None);

        let diffs = session_checkpoint_diff(
            project.clone(),
            start.commit_oid.clone(),
            end.commit_oid.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            diff_pairs(&diffs),
            vec![
                ("new.txt".into(), "added".into()),
                ("tracked.txt".into(), "modified".into()),
            ]
        );
        let tracked = diffs
            .iter()
            .find(|diff| diff.path == "tracked.txt")
            .unwrap();
        assert_eq!((tracked.added, tracked.removed), (1, 0));

        // 回滚：from=当前(end) → to=轮前(start)
        let result = session_checkpoint_restore(
            project.clone(),
            end.commit_oid.clone(),
            start.commit_oid.clone(),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(
            result.conflicts.is_empty(),
            "unexpected conflicts: {:?}",
            result.conflicts
        );
        assert_eq!(
            std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "a\nb\n"
        );
        assert!(!repo.0.join("new.txt").exists());
    }

    #[tokio::test]
    async fn restore_single_path_and_detect_conflicts() {
        let repo = repo();
        let project = repo.0.to_string_lossy().to_string();
        let start = session_checkpoint_create(project.clone(), "start".into())
            .await
            .unwrap();
        std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
        std::fs::write(repo.0.join("other.txt"), "other\n").unwrap();
        let end = session_checkpoint_create(project.clone(), "end".into())
            .await
            .unwrap();

        // 单文件回滚只影响指定路径。
        let result = session_checkpoint_restore(
            project.clone(),
            end.commit_oid.clone(),
            start.commit_oid.clone(),
            Some(vec!["other.txt".into()]),
            None,
        )
        .await
        .unwrap();
        assert!(result.conflicts.is_empty());
        assert!(!repo.0.join("other.txt").exists());
        assert_eq!(
            std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "changed\n"
        );

        // 用户在回滚前又改了 tracked.txt、且 other.txt 已被前一步删除 → 两个路径都报冲突，拒绝执行。
        std::fs::write(repo.0.join("tracked.txt"), "user edit\n").unwrap();
        let result = session_checkpoint_restore(
            project.clone(),
            end.commit_oid.clone(),
            start.commit_oid.clone(),
            None,
            None,
        )
        .await
        .unwrap();
        assert!(result.restored.is_empty());
        assert_eq!(result.conflicts.len(), 2);
        let tracked = result
            .conflicts
            .iter()
            .find(|conflict| conflict.path == "tracked.txt")
            .unwrap();
        assert_eq!(tracked.reason, "content-mismatch");
        assert_eq!(
            std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(),
            "user edit\n"
        );
    }

    #[tokio::test]
    async fn rejects_projects_outside_git() {
        let root =
            std::env::temp_dir().join(format!("pix-checkpoint-nogit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let result =
            session_checkpoint_create(root.to_string_lossy().to_string(), "start".into()).await;
        let _ = std::fs::remove_dir_all(&root);
        let error = result.unwrap_err();
        assert!(error.starts_with("PIXERR:"));
        assert!(error.contains("gitRepoMissing"));
    }

    #[test]
    fn parses_name_status_and_numstat() {
        let entries = parse_name_status("M\0a.txt\0A\0b.txt\0R100\0c.txt\0d.txt\0");
        assert_eq!(entries.len(), 3);
        assert_eq!(
            (entries[0].kind.as_str(), entries[0].path.as_str()),
            ("modified", "a.txt")
        );
        assert_eq!(
            (entries[1].kind.as_str(), entries[1].path.as_str()),
            ("added", "b.txt")
        );
        assert_eq!(entries[2].kind, "renamed");
        assert_eq!(entries[2].path, "d.txt");
        assert_eq!(entries[2].original_path.as_deref(), Some("c.txt"));

        // rename 的 numstat：路径字段为空，old/new 是紧随其后的两条 NUL 记录；
        // 二进制文件以 "-" 表示无行数统计。
        let stats = parse_numstat("3\t1\ta.txt\0-\t-\tb.bin\05\t0\t\0c.txt\0d.txt\0");
        assert_eq!(stats.get("a.txt"), Some(&(3, 1)));
        assert_eq!(stats.get("b.bin"), Some(&(0, 0)));
        assert_eq!(stats.get("c.txt"), Some(&(5, 0)));
        assert_eq!(stats.get("d.txt"), Some(&(5, 0)));
    }

    #[test]
    fn workspace_relative_paths_strip_subdirectory_scope() {
        let layout = RepoLayout {
            repo_root: PathBuf::from("/repo"),
            workspace_in_repo: "packages/app".into(),
            objects_dir: PathBuf::new(),
            checkpoint_objects_dir: PathBuf::new(),
        };
        assert_eq!(
            to_workspace_relative(&layout, "packages/app/src/a.ts"),
            "src/a.ts"
        );
        assert_eq!(to_workspace_relative(&layout, "other/b.ts"), "other/b.ts");
        assert_eq!(
            to_repo_relative(&layout, "src/a.ts"),
            "packages/app/src/a.ts"
        );
    }
}
