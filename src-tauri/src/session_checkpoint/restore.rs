//! 把工作区从声明基线恢复到目标快照，恢复前后做 blob hash 级安全校验。

use std::collections::HashSet;

use crate::errors::{pix_error, pix_error_detail};

use super::diff::{parse_ls_tree, parse_name_status};
use super::git::{
    checkpoint_object_env, git_in, to_repo_relative, to_workspace_relative, GitEnv, RepoLayout,
};
use super::{CheckpointConflict, CheckpointRestoreResult};

fn diff_name_status(
    layout: &RepoLayout,
    from: &str,
    to: &str,
    env: GitEnv<'_>,
) -> Result<String, String> {
    git_in(
        &layout.repo_root,
        &["diff", "--name-status", "--find-renames", "-z", from, to],
        env,
    )
}

fn diff_paths_between(
    layout: &RepoLayout,
    from: &str,
    to: &str,
    env: GitEnv<'_>,
) -> Result<Vec<String>, String> {
    let mut set = Vec::new();
    for entry in parse_name_status(&diff_name_status(layout, from, to, env)?) {
        set.push(entry.path);
        if let Some(original) = entry.original_path {
            set.push(original);
        }
    }
    Ok(set)
}

/// 当前磁盘在 `baseline` 的受影响路径上是否仍与基线一致（blob hash 级比较）。
/// 分批处理避免超出 Windows 命令行 32K 上限。
fn collect_conflicts(
    layout: &RepoLayout,
    baseline: &str,
    repo_paths: &[String],
    env: GitEnv<'_>,
) -> Vec<(String, String)> {
    const BATCH_SIZE: usize = 100;
    let mut conflicts = Vec::new();
    for chunk in repo_paths.chunks(BATCH_SIZE) {
        let mut args: Vec<&str> = vec!["ls-tree", "-r", "-z", baseline, "--"];
        args.extend(chunk.iter().map(String::as_str));
        let tree = match git_in(&layout.repo_root, &args, env) {
            Ok(output) => parse_ls_tree(&output),
            Err(_) => {
                for path in chunk {
                    conflicts.push((path.clone(), "tree-read-failed".into()));
                }
                continue;
            }
        };
        for repo_path in chunk {
            let absolute = layout.repo_root.join(repo_path);
            let Some(expected) = tree.get(repo_path) else {
                // 基线里不存在该路径：磁盘上也不应存在；存在即用户新增，视为冲突。
                if !absolute.exists() {
                    continue;
                }
                conflicts.push((repo_path.clone(), "unexpected-file-in-worktree".into()));
                continue;
            };
            let Ok(metadata) = std::fs::symlink_metadata(&absolute) else {
                conflicts.push((repo_path.clone(), "missing-in-worktree".into()));
                continue;
            };
            if metadata.is_dir() {
                conflicts.push((repo_path.clone(), "type-mismatch".into()));
                continue;
            }
            // 带过滤的 hash-object：与 add/restore 走同一套行尾转换语义，
            // 避免 autocrlf 工作区里 CRLF 文件被误判为内容漂移。
            let hash = git_in(&layout.repo_root, &["hash-object", "--", repo_path], None)
                .unwrap_or_default();
            if hash.trim() != expected {
                conflicts.push((repo_path.clone(), "content-mismatch".into()));
            }
        }
    }
    conflicts
}

/// 把工作区从 `from` 声明的基线恢复到 `to` 的状态。
/// `from`/`to` 为 commit oid；`paths` 为项目相对路径子集（缺省恢复全部差异路径）。
/// `tool_touched_files` 限定只恢复该列表内的文件，避免覆盖用户手改。
pub(super) fn restore_between(
    layout: &RepoLayout,
    from: &str,
    to: &str,
    paths: Option<&[String]>,
    tool_touched_files: Option<&[String]>,
) -> Result<CheckpointRestoreResult, String> {
    let env = checkpoint_object_env(layout);
    let mut affected: Vec<String> = match paths {
        Some(list) if !list.is_empty() => list
            .iter()
            .map(|path| to_repo_relative(layout, path))
            .collect(),
        _ => diff_paths_between(layout, from, to, Some(&env))?,
    };
    // 只恢复 tool_touched_files 中的文件，避免覆盖用户手改
    if let Some(tool_files) = tool_touched_files {
        if !tool_files.is_empty() {
            let tool_set: HashSet<String> = tool_files
                .iter()
                .map(|p| to_repo_relative(layout, p))
                .collect();
            affected.retain(|p| tool_set.contains(p));
        }
    }
    if affected.is_empty() {
        return Ok(CheckpointRestoreResult {
            restored: vec![],
            conflicts: vec![],
        });
    }

    // 三方安全检查：当前磁盘必须仍停留在 from 基线，否则拒绝写入。
    let conflicts = collect_conflicts(layout, from, &affected, Some(&env));
    if !conflicts.is_empty() {
        return Ok(CheckpointRestoreResult {
            restored: vec![],
            conflicts: conflicts
                .into_iter()
                .map(|(path, reason)| CheckpointConflict {
                    path: to_workspace_relative(layout, &path),
                    reason,
                })
                .collect(),
        });
    }

    let mut restore_paths = Vec::new();
    let mut delete_paths = Vec::new();
    let affected_set: HashSet<&String> = affected.iter().collect();
    let entries: Vec<_> = parse_name_status(&diff_name_status(layout, from, to, Some(&env))?)
        .into_iter()
        // 指定路径子集回滚时，差异必须收敛在受影响路径内，避免误恢复无关文件。
        .filter(|entry| {
            affected_set.contains(&entry.path)
                || entry
                    .original_path
                    .as_ref()
                    .map(|path| affected_set.contains(path))
                    .unwrap_or(false)
        })
        .collect();
    for entry in entries {
        if entry.kind == "deleted" {
            delete_paths.push(entry.path);
            continue;
        }
        restore_paths.push(entry.path.clone());
        if entry.kind == "renamed" {
            if let Some(original) = &entry.original_path {
                delete_paths.push(original.clone());
            }
        }
    }
    if !restore_paths.is_empty() {
        // 只恢复 worktree，不动用户暂存区。分批处理避免超出 Windows 命令行 32K 上限。
        let source = format!("--source={to}");
        const BATCH_SIZE: usize = 100;
        for chunk in restore_paths.chunks(BATCH_SIZE) {
            let mut args: Vec<&str> = vec!["restore", &source, "--worktree", "--"];
            args.extend(chunk.iter().map(String::as_str));
            git_in(&layout.repo_root, &args, Some(&env))?;
        }
    }
    for path in &delete_paths {
        let target = layout.repo_root.join(path);
        if let Err(e) = std::fs::remove_file(&target) {
            // 不存在的文件视为已删除（幂等）
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(pix_error_detail(
                    "checkpointDeleteFailed",
                    "无法删除文件 {path}: {detail}",
                    target.display(),
                ));
            }
        }
    }

    // 恢复后再校验一次，确保磁盘确实到达目标基线。
    if !collect_conflicts(layout, to, &affected, Some(&env)).is_empty() {
        return Err(pix_error(
            "checkpointRestoreVerifyFailed",
            "快照恢复后校验失败",
        ));
    }
    Ok(CheckpointRestoreResult {
        restored: affected
            .iter()
            .map(|path| to_workspace_relative(layout, path))
            .collect(),
        conflicts: vec![],
    })
}
