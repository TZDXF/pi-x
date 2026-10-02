import { invoke } from "../transport"

export interface GitWorktree {
  path: string
  branch: string
  current: boolean
}
export interface WorkspaceSelection {
  project: string
  worktree: boolean
  branch: string
}
export const prepareWorkspaceGit = (selection: WorkspaceSelection) =>
  invoke<string>("workspace_git_prepare", { ...selection })

export interface WorkspaceGitInfo {
  branch: string
  branches: string[]
  unborn_branch: boolean
  worktree: boolean
  worktrees: GitWorktree[]
}
export const workspaceGitInfo = (project: string) => invoke<WorkspaceGitInfo>("workspace_git_info", { project })
export const createWorkspaceGit = (project: string, branch: string, worktree: boolean) =>
  invoke<string>("workspace_git_create", { project, branch, worktree })
