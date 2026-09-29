//! Git 命令运行器、仓库布局解析与路径换算。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::errors::{pix_error, pix_error_detail};

// 快照对象放在 .git 内的非标准目录：仍可按 OID 读取，但不是 ref，用户 Git 历史不可见。
const CHECKPOINT_OBJECT_DIR: &str = "pix/checkpoint-objects";
const LEGACY_CHECKPOINT_REF_PREFIX: &str = "refs/pix-internal/checkpoints";

#[derive(Debug)]
pub(super) struct RepoLayout {
    pub(super) repo_root: PathBuf,
    /// 项目目录相对仓库根的路径，"." 表示项目即仓库根。
    pub(super) workspace_in_repo: String,
    /// Git 默认对象库；快照对象通过 alternates 继续引用仓库内已有 blob。
    pub(super) objects_dir: PathBuf,
    /// 本 workspace 专用的快照对象库（位于 .git/pix 下，非 refs）。
    pub(super) checkpoint_objects_dir: PathBuf,
}

pub(super) type GitEnv<'a> = Option<&'a HashMap<&'static str, String>>;

pub(super) fn git_in(repo_root: &Path, args: &[&str], env: GitEnv<'_>) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo_root).args(args);
    if let Some(env) = env {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|e| pix_error_detail("gitRunFailed", "无法运行 Git: {detail}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// 与 git_in 相同，但返回原始字节：cat-file blob 的内容必须逐字节保留。
pub(super) fn git_raw_bytes(repo_root: &Path, args: &[&str], env: GitEnv<'_>) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo_root).args(args);
    if let Some(env) = env {
        for (key, value) in env {
            command.env(key, value);
        }
    }
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command
        .output()
        .map_err(|e| pix_error_detail("gitRunFailed", "无法运行 Git: {detail}", e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

/// FNV-1a 64：给 workspace 命名空间与 manifest 文件名生成稳定短哈希，无需额外依赖。
pub(super) fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 解析项目对应的仓库与 workspace scope；非 Git 仓库返回专用错误码，前端据此降级。
pub(super) fn resolve_repo(project: &str) -> Result<RepoLayout, String> {
    let root = dunce::canonicalize(project).map_err(|_| pix_error("projectDirMissing", "项目目录不存在"))?;
    if !root.is_dir() {
        return Err(pix_error("projectDirMissing", "项目目录不存在"));
    }
    let toplevel = match git_in(&root, &["rev-parse", "--show-toplevel"], None) {
        Ok(path) => PathBuf::from(path),
        Err(_) => return Err(pix_error("gitRepoMissing", "项目不是 Git 仓库，无法创建快照")),
    };
    let repo_root = dunce::canonicalize(&toplevel).map_err(|e| e.to_string())?;
    let workspace_in_repo = root
        .strip_prefix(&repo_root)
        .ok()
        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
        .filter(|relative| !relative.is_empty())
        .unwrap_or_else(|| ".".into());
    let objects_dir = git_in(&repo_root, &["rev-parse", "--git-path", "objects"], None)?;
    let objects_dir = dunce::canonicalize(repo_root.join(objects_dir)).map_err(|e| e.to_string())?;
    let checkpoint_objects_dir = git_in(
        &repo_root,
        &["rev-parse", "--git-path", &format!("{CHECKPOINT_OBJECT_DIR}/{}", fnv1a(&workspace_in_repo))],
        None,
    )?;
    let checkpoint_objects_dir = repo_root.join(checkpoint_objects_dir);
    Ok(RepoLayout { repo_root, workspace_in_repo, objects_dir, checkpoint_objects_dir })
}

pub(super) fn checkpoint_env(layout: &RepoLayout, temp_index: &Path) -> HashMap<&'static str, String> {
    HashMap::from([
        ("GIT_INDEX_FILE", temp_index.to_string_lossy().to_string()),
        ("GIT_OBJECT_DIRECTORY", layout.checkpoint_objects_dir.to_string_lossy().to_string()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", layout.objects_dir.to_string_lossy().to_string()),
        ("GIT_AUTHOR_NAME", "PiX Checkpoint".into()),
        ("GIT_AUTHOR_EMAIL", "checkpoint@pix.local".into()),
        ("GIT_COMMITTER_NAME", "PiX Checkpoint".into()),
        ("GIT_COMMITTER_EMAIL", "checkpoint@pix.local".into()),
    ])
}

/// 读取快照 commit 时必须显式挂载非标准对象库；alternates 提供仓库既有对象。
pub(super) fn checkpoint_object_env(layout: &RepoLayout) -> HashMap<&'static str, String> {
    HashMap::from([
        ("GIT_OBJECT_DIRECTORY", layout.checkpoint_objects_dir.to_string_lossy().to_string()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", layout.objects_dir.to_string_lossy().to_string()),
    ])
}

/// 旧实现曾把快照挂成 refs/pix-internal/checkpoints/...，但 `git log --all` 会展开
/// 该命名空间。删除遗留 ref 后快照仍可通过 manifest 中的 OID 读取；旧 ref 指向的对象
/// 在下一次 Git GC 前仍存在，必要时由 manifest 里的持久化 diff 继续兜底。
pub(super) fn delete_legacy_checkpoint_refs(layout: &RepoLayout) -> Result<(), String> {
    let refs = git_in(
        &layout.repo_root,
        &["for-each-ref", "--format=%(refname)", &format!("{LEGACY_CHECKPOINT_REF_PREFIX}/")],
        None,
    )?;
    for ref_name in refs.lines().filter(|line| !line.is_empty()) {
        git_in(&layout.repo_root, &["update-ref", "-d", ref_name], None)?;
    }
    Ok(())
}

/// 仓库相对路径 → 项目相对路径（前端展示与回传均使用项目相对路径）。
pub(super) fn to_workspace_relative(layout: &RepoLayout, repo_relative: &str) -> String {
    if layout.workspace_in_repo == "." {
        return repo_relative.to_string();
    }
    repo_relative
        .strip_prefix(&format!("{}/", layout.workspace_in_repo))
        .unwrap_or(repo_relative)
        .to_string()
}

pub(super) fn to_repo_relative(layout: &RepoLayout, workspace_relative: &str) -> String {
    let normalized = workspace_relative.replace('\\', "/");
    // pi 工具可能传入绝对路径（如 C:/code/pi-x/src/...），转为仓库相对路径
    if Path::new(&normalized).is_absolute() {
        if let Ok(stripped) = Path::new(&normalized).strip_prefix(&layout.repo_root) {
            let relative = stripped.to_string_lossy().replace('\\', "/");
            if !relative.is_empty() {
                return relative;
            }
        }
        return normalized;
    }
    if layout.workspace_in_repo == "." {
        return normalized;
    }
    format!("{}/{}", layout.workspace_in_repo, normalized)
}
