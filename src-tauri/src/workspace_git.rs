use serde::Serialize;
use std::path::Path;
use tokio::process::Command;

use crate::errors::{pix_error, pix_error_detail};

async fn git(project: &str, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new("git");
    command.arg("-C").arg(project).args(args);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().await.map_err(|e| pix_error_detail("gitRunFailed", format!("无法运行 Git: {e}"), e))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
#[derive(Debug, Serialize)]
pub struct GitWorktree { path: String, branch: String, current: bool }
#[derive(Serialize)]
pub struct GitInfo { branch: String, branches: Vec<String>, worktree: bool, worktrees: Vec<GitWorktree> }

/// `git worktree list --porcelain` always lists the current working tree first,
/// which is how the entries get flagged instead of comparing platform-dependent paths.
fn parse_worktrees(list: &str) -> Vec<GitWorktree> {
    let mut out: Vec<GitWorktree> = Vec::new();
    let mut path = String::new();
    let mut branch = String::new();
    let flush = |out: &mut Vec<GitWorktree>, path: &mut String, branch: &mut String| {
        if !path.is_empty() {
            out.push(GitWorktree { path: std::mem::take(path), branch: std::mem::take(branch), current: out.is_empty() });
        }
    };
    for line in list.lines() {
        if let Some(rest) = line.strip_prefix("worktree ") {
            flush(&mut out, &mut path, &mut branch);
            path = rest.to_string();
        } else if let Some(rest) = line.strip_prefix("branch ") {
            branch = rest.strip_prefix("refs/heads/").unwrap_or(rest).to_string();
        }
    }
    flush(&mut out, &mut path, &mut branch);
    out
}

#[tauri::command]
pub async fn workspace_git_info(project: String) -> Result<GitInfo, String> {
    let branch = git(&project, &["branch", "--show-current"]).await?;
    let branches = git(&project, &["for-each-ref", "--format=%(refname:short)", "refs/heads/"]).await?;
    let dir = git(&project, &["rev-parse", "--absolute-git-dir"]).await?;
    let common = git(&project, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await?;
    let list = git(&project, &["worktree", "list", "--porcelain"]).await?;
    Ok(GitInfo {
        branch: if branch.is_empty() { "HEAD (detached)".into() } else { branch },
        branches: branches.lines().map(String::from).collect(),
        worktree: dir != common,
        worktrees: parse_worktrees(&list),
    })
}
#[tauri::command]
pub async fn workspace_git_create(project: String, branch: String, worktree: bool) -> Result<String, String> {
    let branch = branch.trim();
    if branch.is_empty() || branch.starts_with('-') || branch.starts_with('@') {
        return Err(pix_error("branchNameInvalid", "请输入有效的分支名"));
    }
    git(&project, &["check-ref-format", "--branch", branch]).await?;
    let root = git(&project, &["rev-parse", "--show-toplevel"]).await?;
    if worktree {
        let parent = Path::new(&root).parent().ok_or_else(|| pix_error("worktreeParentUnknown", "无法确定工作树父目录"))?;
        let repo_name = Path::new(&root).file_name().unwrap_or_default().to_string_lossy();
        let slug: String = branch.chars().map(|c| if c.is_alphanumeric() || c == '-' { c } else { '-' }).take(48).collect();
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let path = parent.join(".pix-worktrees").join(format!("{repo_name}-{slug}-{}", &suffix[..8]));
        std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
        let target = path.to_string_lossy().to_string();
        git(&project, &["worktree", "add", "-b", branch, &target, "HEAD"]).await?;
        Ok(target)
    } else {
        git(&project, &["switch", "-c", branch]).await?;
        Ok(project)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Repo(std::path::PathBuf);
    impl Drop for Repo {
        fn drop(&mut self) {
            if let (Ok(path), Ok(temp)) = (dunce::canonicalize(&self.0), dunce::canonicalize(std::env::temp_dir())) {
                if path.parent() == Some(temp.as_path()) && path.file_name().unwrap().to_string_lossy().starts_with("pix-git-test-") {
                    let _ = std::fs::remove_dir_all(path);
                }
            }
        }
    }
    async fn repo() -> Repo {
        let root = std::env::temp_dir().join(format!("pix-git-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("repo");
        std::fs::create_dir_all(&path).unwrap();
        let p = path.to_str().unwrap();
        git(p, &["init", "-b", "main"]).await.unwrap();
        git(p, &["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial"]).await.unwrap();
        Repo(root)
    }
    #[tokio::test]
    async fn creates_branch_and_isolated_worktree() {
        let repo = repo().await;
        let project = repo.0.join("repo").to_string_lossy().to_string();
        std::fs::write(repo.0.join("repo/untracked.txt"), "keep").unwrap();
        workspace_git_create(project.clone(), "feature/local".into(), false).await.unwrap();
        assert_eq!(workspace_git_info(project.clone()).await.unwrap().branch, "feature/local");
        let tree = workspace_git_create(project.clone(), "feature/isolated".into(), true).await.unwrap();
        let info = workspace_git_info(tree.clone()).await.unwrap();
        assert_eq!(info.branch, "feature/isolated");
        assert!(info.worktree);
        assert!(!Path::new(&tree).join("untracked.txt").exists());
        let listed = workspace_git_info(project.clone()).await.unwrap().worktrees;
        assert_eq!(listed.len(), 2, "{listed:?}");
        assert_eq!(listed[0].branch, "feature/local");
        assert!(listed[0].current);
        assert_eq!(listed[1].path, tree.replace('\\', "/"));
        assert_eq!(listed[1].branch, "feature/isolated");
        assert!(!listed[1].current);
        assert_eq!(workspace_git_info(project.clone()).await.unwrap().branch, "feature/local");
        assert!(Path::new(&project).join("untracked.txt").exists());
        assert!(workspace_git_create(project, "feature/local".into(), false).await.is_err());
    }
    #[tokio::test]
    async fn rejects_invalid_branch_without_changes() {
        let repo = repo().await;
        let project = repo.0.join("repo").to_string_lossy().to_string();
        for name in ["", "--help", "../escape", "a b", "@{-1}"] {
            assert!(workspace_git_create(project.clone(), name.into(), true).await.is_err());
        }
        assert_eq!(workspace_git_info(project).await.unwrap().branch, "main");
        assert!(!repo.0.join(".pix-worktrees").exists());
    }
}
