import type { Block, ToolRun } from "@/stores/session"
import { changeForCall, EDIT_TOOLS, WRITE_TOOLS } from "@/lib/sessionChanges"

/** 单文件的撤销操作，按工具调用时间顺序排列，后端按逆序回放。 */
export type RevertOp =
  | { kind: "replace"; before: string; after: string }
  | { kind: "restore"; before: string; after: string }
  | { kind: "delete"; content: string }

export interface TurnFileChange {
  path: string
  added: number
  removed: number
  /** 写入时未记录原内容，无法自动撤销 */
  unknown: boolean
  ops: RevertOp[]
  revertible: boolean
}

/** 从一轮对话的工具调用中提取按文件分组的修改（仅统计成功的编辑/写入）。 */
export function turnFileChanges(blocks: Block[], runs: Record<string, ToolRun>): TurnFileChange[] {
  const files = new Map<string, TurnFileChange>()
  for (const block of blocks) {
    if (block.type !== "toolCall") continue
    // 与会话级统计同一口径：只计入成功完成的调用。
    if (runs[block.callId]?.state !== "output-available") continue
    let args: any
    try {
      args = JSON.parse(block.argsText)
    } catch {
      /* 参数仍在流式生成 */ continue
    }
    const changes = changeForCall(block.callId, block.name, args)
    if (!changes.length) continue
    const ops = revertOpsForCall(block.name, args)
    const path = changes[0]!.path
    const file = files.get(path) ?? {
      path,
      added: 0,
      removed: 0,
      unknown: false,
      ops: [] as RevertOp[],
      revertible: true,
    }
    files.set(path, file)
    file.added += changes.reduce((sum, change) => sum + change.added, 0)
    file.removed += changes.reduce((sum, change) => sum + change.removed, 0)
    file.unknown ||= changes.some(change => change.unknownBefore)
    if (ops) file.ops.push(...ops)
    else file.revertible = false
  }
  return [...files.values()]
}

/** 从一次编辑/写入调用的参数推导撤销操作；存在无法还原的项时返回 null。 */
function revertOpsForCall(name: string, args: any): RevertOp[] | null {
  if (!args || typeof args !== "object") return null
  const tool = name.toLowerCase().split(/[.:/]/).pop()!
  const edit = EDIT_TOOLS.has(tool)
  const write = WRITE_TOOLS.has(tool)
  if (!edit && !write) return null
  const edits = edit && Array.isArray(args.edits) ? args.edits : [args]
  const ops: RevertOp[] = []
  for (const item of edits) {
    if (!item || typeof item !== "object") return null
    const before = item.oldText ?? item.old_string ?? item.old_str
    const after = edit ? (item.newText ?? item.new_string ?? item.new_str) : (item.content ?? item.contents)
    if (typeof after !== "string") return null
    if (edit || typeof before === "string") {
      if (typeof before !== "string") return null
      ops.push({ kind: "replace", before, after })
    } else if (tool === "create_file") {
      // 新建的文件：内容未变时直接删除。
      ops.push({ kind: "delete", content: after })
    } else {
      return null // 覆盖写入且未记录原内容
    }
  }
  return ops
}
