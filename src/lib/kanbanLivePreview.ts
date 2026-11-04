import type { Block, Entry, ToolRun } from "@/stores/session/types"

export type KanbanLivePreview =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "thinking" | "compacting" | "retrying" }

interface LiveSession {
  entries: readonly Entry[]
  partialBlocks: readonly Block[] | null
  runs: Record<string, ToolRun>
  isStreaming: boolean
  isCompacting: boolean
  retryInfo: unknown
}

/** Keep the newest two output lines, bounding work even for long terminal buffers. */
function tail(text: string, lines = 2) {
  return text
    .slice(-400)
    .trim()
    .split(/\r?\n/)
    .filter(line => line.trim())
    .slice(-lines)
    .join("\n")
}

function toolDetail(argsText: string) {
  try {
    const args = JSON.parse(argsText)
    const value = args?.command ?? args?.cmd ?? args?.path ?? args?.file_path
    return typeof value === "string" ? tail(value) : ""
  } catch {
    return ""
  }
}

function previewBlocks(blocks: readonly Block[], runs: Record<string, ToolRun>): KanbanLivePreview | null {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]!
    if (block.type === "text" && block.text.trim()) return { kind: "text", text: tail(block.text) }
    if (block.type === "thinking") return { kind: "thinking" }
    if (block.type === "toolCall") {
      const run = runs[block.callId]
      return {
        kind: "tool",
        name: block.name,
        detail: run?.outputText.trim() ? tail(run.outputText, 1) : toolDetail(run?.argsText || block.argsText),
      }
    }
  }
  return null
}

/** Read only this prompt's live tail; previous prompts must not masquerade as current activity. */
export function kanbanLivePreview(session: LiveSession): KanbanLivePreview | null {
  if (session.isCompacting) return { kind: "compacting" }
  if (session.retryInfo) return { kind: "retrying" }
  if (!session.isStreaming) return null
  if (session.partialBlocks !== null) return previewBlocks(session.partialBlocks, session.runs) ?? { kind: "thinking" }
  for (let index = session.entries.length - 1; index >= 0; index--) {
    const entry = session.entries[index]!
    if (entry.kind === "user") break
    if (entry.kind === "assistant") {
      const preview = previewBlocks(entry.blocks, session.runs)
      if (preview) return preview
    }
  }
  return { kind: "thinking" }
}
