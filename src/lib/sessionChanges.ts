import type { Block, Entry, ToolRun } from "@/stores/session"

export interface ChangeLine { kind: "add" | "remove" | "context"; text: string; oldLine?: number | null; newLine?: number | null }
export interface FileChange {
  id: string; path: string; tool: string; lines: ChangeLine[]
  added: number; removed: number; unknownBefore: boolean
}
const lines = (text: string): string[] => text ? text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n") : []

// Trim unchanged boundaries; use a bounded LCS table to preserve unchanged interior lines.
export function changedLines(before: string, after: string): ChangeLine[] {
  const a = lines(before), b = lines(after)
  let start = 0, endA = a.length, endB = b.length
  while (start < endA && start < endB && a[start] === b[start]) start++
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const middle: ChangeLine[] = []
  const n = endA - start, m = endB - start
  if (n * m <= 1_000_000 && n && m) {
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      table[i]![j] = a[start + i] === b[start + j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && a[start + i] === b[start + j]) { middle.push({ kind: "context", text: a[start + i]! }); i++; j++ }
      else if (i < n && (j === m || table[i + 1]![j]! >= table[i]![j + 1]!)) middle.push({ kind: "remove", text: a[start + i++]! })
      else middle.push({ kind: "add", text: b[start + j++]! })
    }
  } else {
    for (let i = start; i < endA; i++) middle.push({ kind: "remove", text: a[i]! })
    for (let i = start; i < endB; i++) middle.push({ kind: "add", text: b[i]! })
  }
  let oldLine = 0, newLine = 0
  const full: ChangeLine[] = [
    ...a.slice(0, start).map(text => ({ kind: "context" as const, text })),
    ...middle,
    ...b.slice(endB).map(text => ({ kind: "context" as const, text })),
  ]
  return full.map(line => ({ ...line, oldLine: line.kind === "add" ? null : ++oldLine, newLine: line.kind === "remove" ? null : ++newLine }))
}

export function sessionChanges(history: any[], entries: Entry[], partial: Block[] | null, runs: Record<string, ToolRun>): FileChange[] {
  const calls = new Map<string, { name: string; args: any }>()
  const results = new Map<string, boolean>()
  const remember = (block: Block) => {
    if (block.type !== "toolCall") return
    try { calls.set(block.callId, { name: block.name, args: JSON.parse(block.argsText) }) } catch { /* incomplete input */ }
  }
  for (const message of history) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "toolCall") {
        try { calls.set(block.id, { name: block.name, args: typeof block.arguments === "string" ? JSON.parse(block.arguments) : block.arguments }) } catch { /* malformed history */ }
      }
    }
    if (message.role === "toolResult") results.set(String(message.toolCallId ?? message.id ?? ""), !message.isError)
  }
  for (const entry of entries) if (entry.kind === "assistant") entry.blocks.forEach(remember)
  // No streaming assistant message exists while idle, after completion, or during history loading.
  partial?.forEach(remember)
  for (const run of Object.values(runs)) {
    if (!calls.has(run.id) && run.argsText) {
      try { calls.set(run.id, { name: run.name, args: JSON.parse(run.argsText) }) } catch { /* incomplete input */ }
    }
    results.set(run.id, run.state === "output-available")
  }
  const changes: FileChange[] = []
  for (const [id, call] of calls) {
    if (!results.get(id)) continue
    changes.push(...changeForCall(id, call.name, call.args))
  }
  return changes
}

/** Diff a single edit/write tool call into per-file change entries.
 *  Shared by the review panel and the chat tool cards. */
export function changeForCall(id: string, name: string, args: any): FileChange[] {
  const changes: FileChange[] = []
  if (!args || typeof args !== "object") return changes
  const tool = name.toLowerCase().split(/[.:/]/).pop()!
  const path = args.path ?? args.file_path ?? args.filePath
  if (typeof path !== "string" || !path.trim()) return changes
  const edit = ["edit", "edit_file", "str_replace", "str_replace_editor", "multiedit"].includes(tool)
  const write = ["write", "write_file", "create_file"].includes(tool)
  if (!edit && !write) return changes
  const edits = edit && Array.isArray(args.edits) ? args.edits : [args]
  for (const [index, item] of edits.entries()) {
    if (!item || typeof item !== "object") continue
    const before = item.oldText ?? item.old_string ?? item.old_str
    const after = edit ? item.newText ?? item.new_string ?? item.new_str : item.content ?? item.contents
    if (typeof after !== "string" || (edit && typeof before !== "string")) continue
    const unknownBefore = write && typeof before !== "string" && tool !== "create_file"
    const diff = changedLines(typeof before === "string" ? before : "", after)
    changes.push({ id: `${id}:${index}`, path: path.replace(/\\/g, "/"), tool: name, lines: diff,
      added: unknownBefore ? 0 : diff.filter(line => line.kind === "add").length,
      removed: diff.filter(line => line.kind === "remove").length, unknownBefore })
  }
  return changes
}
