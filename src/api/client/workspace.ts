import { invoke, listen } from "../transport"
import type { WorkspaceState, WorkspaceStatePatch } from "@/lib/workspaceState"

export const getWorkspaceState = () => invoke<WorkspaceState>("workspace_state_get")
export const updateWorkspaceState = (patch: WorkspaceStatePatch) =>
  invoke<WorkspaceState>("workspace_state_update", { patch })
export const onWorkspaceStateChanged = (handler: (state: WorkspaceState) => void) =>
  listen<WorkspaceState>("pi://workspace-state-changed", event => handler(event.payload))

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
