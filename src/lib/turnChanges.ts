import type { Block, ToolRun } from "@/stores/session"
import { changeForCall } from "@/lib/sessionChanges"

export interface TurnFileChange {
  path: string
  added: number
  removed: number
  /** 原内容或完整文件记录缺失；摘要不能用来推导撤销操作。 */
  unknown: boolean
  revertible: boolean
}

/** 旧会话只保留参数片段摘要，不根据 oldText/newText 猜测磁盘状态。 */
export function turnFileChanges(blocks: Block[], runs: Record<string, ToolRun>): TurnFileChange[] {
  const files = new Map<string, TurnFileChange>()
  for (const block of blocks) {
    if (block.type !== "toolCall" || runs[block.callId]?.state !== "output-available") continue
    let args: unknown
    try {
      args = JSON.parse(block.argsText)
    } catch {
      continue
    }
    for (const change of changeForCall(block.callId, block.name, args)) {
      const file = files.get(change.path) ?? {
        path: change.path,
        added: 0,
        removed: 0,
        unknown: false,
        revertible: false,
      }
      file.added += change.added
      file.removed += change.removed
      file.unknown ||= change.unknownBefore
      files.set(change.path, file)
    }
  }
  return [...files.values()]
}
