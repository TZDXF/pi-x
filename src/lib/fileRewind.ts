import { invoke } from "@/api/transport"
import type { FileChangeArtifact } from "@/lib/fileChangeArtifacts"

export interface FileRewindFile {
  path: string
  operationCount: number
  toolNames: string[]
  reason?: string
  expectedHash?: string
  currentHash?: string
  message?: string
}

export interface FileRewindPreview {
  canApply: boolean
  safeFiles: FileRewindFile[]
  unsafeFiles: FileRewindFile[]
  ignoredFiles: FileRewindFile[]
}

export interface FileRewindApplyResult {
  applied: boolean
  preview: FileRewindPreview
  response: string
}

export function previewFileRewind(project: string, artifacts: FileChangeArtifact[]): Promise<FileRewindPreview> {
  return invoke<FileRewindPreview>("session_file_rewind_preview", { project, artifacts })
}

export function applyFileRewind(project: string, artifacts: FileChangeArtifact[]): Promise<FileRewindApplyResult> {
  return invoke<FileRewindApplyResult>("session_file_rewind_apply", { project, artifacts })
}

export function fileRewindState(file: string): Promise<string[]> {
  return invoke<string[]>("session_file_rewind_state_get", { file })
}

export function markFileRewindState(file: string, toolCallIds: string[]): Promise<string[]> {
  return invoke<string[]>("session_file_rewind_state_mark", { file, toolCallIds })
}
