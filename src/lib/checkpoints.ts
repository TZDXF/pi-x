import { invoke } from "@/api/transport"

export interface CheckpointMeta { refName: string; commitOid: string }
export type CheckpointDiffKind = "added" | "deleted" | "modified" | "renamed"
export interface CheckpointFileDiff {
  path: string
  kind: CheckpointDiffKind
  added: number
  removed: number
  originalPath: string | null
}
export interface CheckpointConflict { path: string; reason: string }
export interface CheckpointRestoreResult { restored: string[]; conflicts: CheckpointConflict[] }

/** 单轮回滚记录；快照本体存于项目 Git 仓库的隐藏 ref，清单存桌面端数据目录。 */
export interface TurnCheckpointRecord {
  turnIndex: number
  /** 本轮用户消息在会话文件中的时间戳；重开会话后据此精确匹配渲染的轮次。 */
  userTimestamp?: number
  startOid: string
  endOid: string
  state: "active" | "reverted"
  /** 本轮的文件差异（结算时计算并持久化，避免重开会话重新 diff）。 */
  files: CheckpointFileDiff[]
}
export interface CheckpointManifest { version: 1; turns: TurnCheckpointRecord[] }

export function createCheckpoint(project: string, checkpointId: string): Promise<CheckpointMeta> {
  return invoke<CheckpointMeta>("session_checkpoint_create", { project, checkpointId })
}

export function diffCheckpoints(project: string, from: string, to: string): Promise<CheckpointFileDiff[]> {
  return invoke<CheckpointFileDiff[]>("session_checkpoint_diff", { project, from, to })
}

/** 回滚到 baseline 快照；paths 缺省回滚全部差异路径。 */
export function restoreCheckpoints(project: string, from: string, to: string, paths?: string[]): Promise<CheckpointRestoreResult> {
  return invoke<CheckpointRestoreResult>("session_checkpoint_restore", { project, from, to, paths })
}

export async function loadCheckpointManifest(file: string): Promise<CheckpointManifest | null> {
  const manifest = await invoke<CheckpointManifest | null>("session_checkpoint_manifest_get", { file })
  return manifest && Array.isArray(manifest.turns) ? manifest : null
}

export function saveCheckpointManifest(file: string, manifest: CheckpointManifest): Promise<void> {
  return invoke<void>("session_checkpoint_manifest_set", { file, manifest })
}

/** 快照中某个文件的内容；不存在时为 null。用于审查面板计算真实 diff。 */
export function checkpointFileContent(project: string, oid: string, path: string): Promise<string | null> {
  return invoke<string | null>("session_checkpoint_content", { project, oid, path })
}
