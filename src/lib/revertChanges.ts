import { invoke } from "@/api/transport"
import type { RevertOp } from "@/lib/turnChanges"

export interface RevertFileInput { path: string; ops: RevertOp[] }
export interface RevertFileResult { path: string; ok: boolean; error?: string }

/** 撤销一轮对话对文件的修改；后端逐文件回放并校验内容未漂移。 */
export function revertTurnFiles(project: string, files: RevertFileInput[]): Promise<RevertFileResult[]> {
  return invoke<RevertFileResult[]>("session_revert_changes", { project, files })
}
