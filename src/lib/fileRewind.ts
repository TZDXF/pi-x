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
  revertedToolCallIds: string[]
}

export function previewFileRewind(project: string, artifacts: FileChangeArtifact[]): Promise<FileRewindPreview> {
  return invoke<FileRewindPreview>("session_file_rewind_preview", { project, artifacts })
}

/** 文件恢复与已撤销标记由后端一起提交，失败时补偿文件写入。 */
export function applyFileRewind(
  project: string,
  artifacts: FileChangeArtifact[],
  file?: string | null,
): Promise<FileRewindApplyResult> {
  return invoke<FileRewindApplyResult>("session_file_rewind_apply", { project, artifacts, file: file ?? null })
}

export function fileRewindState(file: string): Promise<string[]> {
  return invoke<string[]>("session_file_rewind_state_get", { file })
}

export interface FileRewindFileResult {
  path: string
  ok: boolean
  error?: string
}
