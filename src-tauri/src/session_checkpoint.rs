//! 轮次级 Git 快照（checkpoint），移植自 zai-org/ZCode 的 gitCheckpointRepo 设计：
//! - 用临时 GIT_INDEX_FILE 把当前工作区固化成 commit（write-tree → commit-tree）；
//! - 快照对象写入 `.git/pix/checkpoint-objects/<workspace>`，不创建 Git ref，因此不会
//!   出现在 `git log --all`、分支图或 Git 工具的提交记录中；
//! - 恢复前先做 blob hash 冲突检测（当前磁盘必须仍等于声明基线），`git restore
//!   --worktree` 只恢复文件、不动暂存区，最后再校验落盘结果。

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use tokio::task::spawn_blocking;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use crate::data_dir;
use crate::errors::{pix_error, pix_error_detail, pix_error_with};
use crate::sessions::validate_session_path;

// 快照对象放在 .git 内的非标准目录：仍可按 OID 读取，但不是 ref，用户 Git 历史不可见。
const CHECKPOINT_OBJECT_DIR: &str = "pix/checkpoint-objects";
const LEGACY_CHECKPOINT_REF_PREFIX: &str = "refs/pix-internal/checkpoints";

#[derive(Serialize, Debug)]
pub struct CheckpointMeta {
    #[serde(rename = "commitOid")]
    pub commit_oid: String,
}

#[derive(Serialize, Clone)]
pub struct CheckpointFileDiff {
    /// 相对项目目录的路径（正斜杠）。
    pub path: String,
    /// added | deleted | modified | renamed
    pub kind: String,
    pub added: u64,
    pub removed: u64,
    #[serde(rename = "originalPath")]
    pub original_path: Option<String>,
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

struct RepoLayout {
    repo_root: PathBuf,
    /// 项目目录相对仓库根的路径，"." 表示项目即仓库根。
    workspace_in_repo: String,
    /// Git 默认对象库；快照对象通过 alternates 继续引用仓库内已有 blob。
    objects_dir: PathBuf,
    /// 本 workspace 专用的快照对象库（位于 .git/pix 下，非 refs）。
    checkpoint_objects_dir: PathBuf,
}

fn git_in(repo_root: &Path, args: &[&str], env: Option<&HashMap<&str, String>>) -> Result<String, String> {
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
type GitEnv<'a> = Option<&'a HashMap<&'static str, String>>;

fn git_raw_bytes(repo_root: &Path, args: &[&str], env: GitEnv<'_>) -> Result<Vec<u8>, String> {
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
fn fnv1a(text: &str) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

/// 解析项目对应的仓库与 workspace scope；非 Git 仓库返回专用错误码，前端据此降级。
fn resolve_repo(project: &str) -> Result<RepoLayout, String> {
    let root = dunce::canonicalize(project)
        .map_err(|_| pix_error("projectDirMissing", "项目目录不存在"))?;
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

fn checkpoint_env(layout: &RepoLayout, temp_index: &Path) -> HashMap<&'static str, String> {
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
fn checkpoint_object_env(layout: &RepoLayout) -> HashMap<&'static str, String> {
    HashMap::from([
        ("GIT_OBJECT_DIRECTORY", layout.checkpoint_objects_dir.to_string_lossy().to_string()),
        ("GIT_ALTERNATE_OBJECT_DIRECTORIES", layout.objects_dir.to_string_lossy().to_string()),
    ])
}

/// 旧实现曾把快照挂成 refs/pix-internal/checkpoints/...，但 `git log --all` 会展开
/// 该命名空间。删除遗留 ref 后快照仍可通过 manifest 中的 OID 读取；旧 ref 指向的对象
/// 在下一次 Git GC 前仍存在，必要时由 manifest 里的持久化 diff 继续兜底。
fn delete_legacy_checkpoint_refs(layout: &RepoLayout) -> Result<(), String> {
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

fn create_checkpoint(layout: &RepoLayout, checkpoint_id: &str) -> Result<CheckpointMeta, String> {
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
        if let Ok(index_rel) = git_in(&layout.repo_root, &["rev-parse", "--git-path", "index"], None) {
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

        git_in(&layout.repo_root, &["add", "-A", "--", &pathspec], Some(&env))?;
        let tree = git_in(&layout.repo_root, &["write-tree"], Some(&env))?;
        let commit = git_in(
            &layout.repo_root,
            &["commit-tree", tree.trim(), "-m", &format!("pix checkpoint {checkpoint_id}")],
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
pub async fn session_checkpoint_create(project: String, checkpoint_id: String) -> Result<CheckpointMeta, String> {
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
        let spec = format!("{oid}:{}", to_repo_relative(&layout, &path));
        let env = checkpoint_object_env(&layout);
        // 用 cat-file -e 检查存在性，避免 stderr 文本本地化误判
        if git_in(&layout.repo_root, &["cat-file", "-e", &spec], Some(&env)).is_err() {
            return Ok(None);
        }
        let size = git_in(&layout.repo_root, &["cat-file", "-s", &spec], Some(&env))?;
        if size.trim().parse::<u64>().unwrap_or(u64::MAX) > MAX_CONTENT_BYTES {
            return Err(pix_error_detail("checkpointContentTooLarge", "快照文件过大，无法展示差异: {detail}", path));
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
            &["diff", "--name-status", "--find-renames", "-z", &from, &to, "--", &pathspec],
            Some(&env),
        )?;
        let numstat = git_in(
            &layout.repo_root,
            &["diff", "--numstat", "--find-renames", "-z", &from, &to, "--", &pathspec],
            Some(&env),
        )?;
        let stats = parse_numstat(&numstat);
        Ok(merge_diff(&layout, &parse_name_status(&name_status), &stats))
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
        restore_between(&layout, &from, &to, paths.as_deref(), tool_touched_files.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 把工作区从 `from` 声明的基线恢复到 `to` 的状态。
/// `from`/`to` 为 commit oid；`paths` 为项目相对路径子集（缺省恢复全部差异路径）。
/// `tool_touched_files` 限定只恢复该列表内的文件，避免覆盖用户手改。
fn restore_between(
    layout: &RepoLayout,
    from: &str,
    to: &str,
    paths: Option<&[String]>,
    tool_touched_files: Option<&[String]>,
) -> Result<CheckpointRestoreResult, String> {
    let env = checkpoint_object_env(layout);
    let mut affected: Vec<String> = match paths {
        Some(list) if !list.is_empty() => {
            list.iter().map(|path| to_repo_relative(layout, path)).collect()
        }
        _ => diff_paths_between(layout, from, to, Some(&env))?,
    };
    // 只恢复 tool_touched_files 中的文件，避免覆盖用户手改
    if let Some(tool_files) = tool_touched_files {
        if !tool_files.is_empty() {
            let tool_set: std::collections::HashSet<String> = tool_files.iter().map(|p| to_repo_relative(layout, p)).collect();
            affected.retain(|p| tool_set.contains(p));
        }
    }
    if affected.is_empty() {
        return Ok(CheckpointRestoreResult { restored: vec![], conflicts: vec![] });
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
    let affected_set: std::collections::HashSet<&String> = affected.iter().collect();
    let entries: Vec<NameStatusEntry> = parse_name_status(&diff_name_status(layout, from, to, Some(&env))?)
        .into_iter()
        // 指定路径子集回滚时，差异必须收敛在受影响路径内，避免误恢复无关文件。
        .filter(|entry| {
            affected_set.contains(&entry.path)
                || entry.original_path.as_ref().map(|path| affected_set.contains(path)).unwrap_or(false)
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
        return Err(pix_error("checkpointRestoreVerifyFailed", "快照恢复后校验失败"));
    }
    Ok(CheckpointRestoreResult {
        restored: affected.iter().map(|path| to_workspace_relative(layout, path)).collect(),
        conflicts: vec![],
    })
}

fn diff_name_status(layout: &RepoLayout, from: &str, to: &str, env: GitEnv<'_>) -> Result<String, String> {
    git_in(
        &layout.repo_root,
        &["diff", "--name-status", "--find-renames", "-z", from, to],
        env,
    )
}

fn diff_paths_between(layout: &RepoLayout, from: &str, to: &str, env: GitEnv<'_>) -> Result<Vec<String>, String> {
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
fn collect_conflicts(layout: &RepoLayout, baseline: &str, repo_paths: &[String], env: GitEnv<'_>) -> Vec<(String, String)> {
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

struct NameStatusEntry {
    kind: String,
    path: String,
    original_path: Option<String>,
}

fn map_kind(status: &str) -> String {
    match status.chars().next().unwrap_or('M') {
        'A' => "added".into(),
        'D' => "deleted".into(),
        'R' | 'C' => "renamed".into(),
        _ => "modified".into(),
    }
}

/// 解析 `git diff --name-status -z`：记录间以 NUL 分隔，rename 占三个字段。
fn parse_name_status(stdout: &str) -> Vec<NameStatusEntry> {
    let records: Vec<&str> = stdout.split('\0').filter(|record| !record.is_empty()).collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let status = records[index];
        let kind = map_kind(status);
        if kind == "renamed" {
            let (Some(original), Some(path)) = (records.get(index + 1), records.get(index + 2)) else {
                break;
            };
            entries.push(NameStatusEntry {
                kind,
                path: (*path).to_string(),
                original_path: Some((*original).to_string()),
            });
            index += 3;
            continue;
        }
        let Some(path) = records.get(index + 1) else { break };
        entries.push(NameStatusEntry { kind, path: (*path).to_string(), original_path: None });
        index += 2;
    }
    entries
}

/// 解析 `git diff --numstat -z`：`added\tremoved\tpath`，rename 时路径拆成两段 NUL 记录。
fn parse_numstat(stdout: &str) -> HashMap<String, (u64, u64)> {
    let records: Vec<&str> = stdout.split('\0').filter(|record| !record.is_empty()).collect();
    let mut stats = HashMap::new();
    let mut index = 0;
    while index < records.len() {
        let fields: Vec<&str> = records[index].split('\t').collect();
        if fields.len() < 3 {
            index += 1;
            continue;
        }
        let parse = |value: &str| value.parse::<u64>().unwrap_or(0);
        let added = parse(fields[0]);
        let removed = parse(fields[1]);
        if !fields[2].is_empty() {
            stats.insert(fields[2].to_string(), (added, removed));
            index += 1;
            continue;
        }
        // rename：old/new 是紧随其后的两条 NUL 记录。
        let (Some(original), Some(path)) = (records.get(index + 1), records.get(index + 2)) else {
            break;
        };
        stats.insert((*path).to_string(), (added, removed));
        stats.insert((*original).to_string(), (added, removed));
        index += 3;
    }
    stats
}

fn parse_ls_tree(stdout: &str) -> HashMap<String, String> {
    let mut entries = HashMap::new();
    for record in stdout.split('\0').filter(|record| !record.is_empty()) {
        let Some(tab) = record.find('\t') else { continue };
        let path = &record[tab + 1..];
        let header: Vec<&str> = record[..tab].split(' ').collect();
        if header.len() < 3 {
            continue;
        }
        entries.insert(path.to_string(), header[2].to_string());
    }
    entries
}

/// 仓库相对路径 → 项目相对路径（前端展示与回传均使用项目相对路径）。
fn to_workspace_relative(layout: &RepoLayout, repo_relative: &str) -> String {
    if layout.workspace_in_repo == "." {
        return repo_relative.to_string();
    }
    repo_relative
        .strip_prefix(&format!("{}/", layout.workspace_in_repo))
        .unwrap_or(repo_relative)
        .to_string()
}

fn to_repo_relative(layout: &RepoLayout, workspace_relative: &str) -> String {
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

fn merge_diff(
    layout: &RepoLayout,
    entries: &[NameStatusEntry],
    stats: &HashMap<String, (u64, u64)>,
) -> Vec<CheckpointFileDiff> {
    entries
        .iter()
        .map(|entry| {
            let stat = stats
                .get(&entry.path)
                .or_else(|| entry.original_path.as_deref().and_then(|path| stats.get(path)))
                .copied()
                .unwrap_or((0, 0));
            CheckpointFileDiff {
                path: to_workspace_relative(layout, &entry.path),
                kind: entry.kind.clone(),
                added: stat.0,
                removed: stat.1,
                original_path: entry
                    .original_path
                    .as_deref()
                    .map(|path| to_workspace_relative(layout, path)),
            }
        })
        .collect()
}

/// 回滚状态清单：按会话文件存储（快照对象存于仓库 .git/pix 下的私有对象目录）。
fn manifest_path(file: &Path) -> PathBuf {
    data_dir::root()
        .join("checkpoints")
        .join(format!("{:016x}.json", fnv1a(&file.to_string_lossy())))
}

#[tauri::command]
pub async fn session_checkpoint_manifest_get(file: String) -> Result<serde_json::Value, String> {
    spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        match std::fs::read_to_string(manifest_path(&path)) {
            Ok(content) => serde_json::from_str(&content).map_err(|e| {
                pix_error_with("checkpointManifestInvalid", format!("快照清单损坏: {e}"), serde_json::json!({ "detail": e.to_string() }))
            }),
            Err(_) => Ok(serde_json::Value::Null),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_manifest_set(file: String, manifest: serde_json::Value) -> Result<(), String> {
    spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        let store = manifest_path(&path);
        std::fs::create_dir_all(store.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&store, serde_json::to_string(&manifest).map_err(|e| e.to_string())?)
            .map_err(|e| pix_error_detail("checkpointManifestWriteFailed", "写入快照清单失败: {detail}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除会话对应的快照清单文件（会话删除时调用）。
#[tauri::command]
pub async fn session_checkpoint_manifest_delete(file: String) -> Result<(), String> {
    spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        let store = manifest_path(&path);
        if store.exists() {
            std::fs::remove_file(&store).map_err(|e| {
                pix_error_detail("checkpointManifestDeleteFailed", "删除快照清单失败: {detail}", e)
            })?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(output.status.success(), "git {args:?} failed: {}", String::from_utf8_lossy(&output.stderr));
    }

    struct Repo(PathBuf);
    impl Drop for Repo {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn repo() -> Repo {
        let root = std::env::temp_dir().join(format!("pix-checkpoint-test-{}", uuid::Uuid::new_v4()));
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
        let mut pairs: Vec<(String, String)> =
            diffs.iter().map(|diff| (diff.path.clone(), diff.kind.clone())).collect();
        pairs.sort();
        pairs
    }

    #[tokio::test]
    async fn create_diff_and_restore_turn_changes() {
        let repo = repo();
        let project = repo.0.to_string_lossy().to_string();
        let start = session_checkpoint_create(project.clone(), "start".into()).await.unwrap();
        // 模拟一轮：修改已有文件 + 新建文件
        std::fs::write(repo.0.join("tracked.txt"), "a\nb\nc\n").unwrap();
        std::fs::write(repo.0.join("new.txt"), "hello\nworld\n").unwrap();
        let end = session_checkpoint_create(project.clone(), "end".into()).await.unwrap();

        // 快照内容读取：审查面板据此计算真实 diff。
        let before = session_checkpoint_content(project.clone(), start.commit_oid.clone(), "tracked.txt".into()).await.unwrap();
        assert_eq!(before.as_deref(), Some("a\nb\n"));
        let after = session_checkpoint_content(project.clone(), end.commit_oid.clone(), "tracked.txt".into()).await.unwrap();
        assert_eq!(after.as_deref(), Some("a\nb\nc\n"));
        // 快照中不存在的新文件、从未出现过的路径 → 均为 null。
        let absent = session_checkpoint_content(project.clone(), start.commit_oid.clone(), "new.txt".into()).await.unwrap();
        assert_eq!(absent, None);
        let missing = session_checkpoint_content(project.clone(), start.commit_oid.clone(), "missing.txt".into()).await.unwrap();
        assert_eq!(missing, None);

        let diffs = session_checkpoint_diff(project.clone(), start.commit_oid.clone(), end.commit_oid.clone()).await.unwrap();
        assert_eq!(diff_pairs(&diffs), vec![
            ("new.txt".into(), "added".into()),
            ("tracked.txt".into(), "modified".into()),
        ]);
        let tracked = diffs.iter().find(|diff| diff.path == "tracked.txt").unwrap();
        assert_eq!((tracked.added, tracked.removed), (1, 0));

        // 回滚：from=当前(end) → to=轮前(start)
        let result = session_checkpoint_restore(project.clone(), end.commit_oid.clone(), start.commit_oid.clone(), None, None).await.unwrap();
        assert!(result.conflicts.is_empty(), "unexpected conflicts: {:?}", result.conflicts);
        assert_eq!(std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(), "a\nb\n");
        assert!(!repo.0.join("new.txt").exists());
    }

    #[tokio::test]
    async fn restore_single_path_and_detect_conflicts() {
        let repo = repo();
        let project = repo.0.to_string_lossy().to_string();
        let start = session_checkpoint_create(project.clone(), "start".into()).await.unwrap();
        std::fs::write(repo.0.join("tracked.txt"), "changed\n").unwrap();
        std::fs::write(repo.0.join("other.txt"), "other\n").unwrap();
        let end = session_checkpoint_create(project.clone(), "end".into()).await.unwrap();

        // 单文件回滚只影响指定路径。
        let result = session_checkpoint_restore(project.clone(), end.commit_oid.clone(), start.commit_oid.clone(), Some(vec!["other.txt".into()]), None).await.unwrap();
        assert!(result.conflicts.is_empty());
        assert!(!repo.0.join("other.txt").exists());
        assert_eq!(std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(), "changed\n");

        // 用户在回滚前又改了 tracked.txt、且 other.txt 已被前一步删除 → 两个路径都报冲突，拒绝执行。
        std::fs::write(repo.0.join("tracked.txt"), "user edit\n").unwrap();
        let result = session_checkpoint_restore(project.clone(), end.commit_oid.clone(), start.commit_oid.clone(), None, None).await.unwrap();
        assert!(result.restored.is_empty());
        assert_eq!(result.conflicts.len(), 2);
        let tracked = result.conflicts.iter().find(|conflict| conflict.path == "tracked.txt").unwrap();
        assert_eq!(tracked.reason, "content-mismatch");
        assert_eq!(std::fs::read_to_string(repo.0.join("tracked.txt")).unwrap(), "user edit\n");
    }

    #[tokio::test]
    async fn rejects_projects_outside_git() {
        let root = std::env::temp_dir().join(format!("pix-checkpoint-nogit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let result = session_checkpoint_create(root.to_string_lossy().to_string(), "start".into()).await;
        let _ = std::fs::remove_dir_all(&root);
        let error = result.unwrap_err();
        assert!(error.starts_with("PIXERR:"));
        assert!(error.contains("gitRepoMissing"));
    }

    #[test]
    fn parses_name_status_and_numstat() {
        let entries = parse_name_status("M\0a.txt\0A\0b.txt\0R100\0c.txt\0d.txt\0");
        assert_eq!(entries.len(), 3);
        assert_eq!((entries[0].kind.as_str(), entries[0].path.as_str()), ("modified", "a.txt"));
        assert_eq!((entries[1].kind.as_str(), entries[1].path.as_str()), ("added", "b.txt"));
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
        assert_eq!(to_workspace_relative(&layout, "packages/app/src/a.ts"), "src/a.ts");
        assert_eq!(to_workspace_relative(&layout, "other/b.ts"), "other/b.ts");
        assert_eq!(to_repo_relative(&layout, "src/a.ts"), "packages/app/src/a.ts");
    }
}
