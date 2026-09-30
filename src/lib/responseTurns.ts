import type { Block, CompactionEntry, ContextEditEntry, CustomEntry, Entry, UserEntry } from "@/stores/session"

export interface AssistantTurn {
  kind: "assistant"
  id: number
  lastIndex: number
  blocks: Block[]
  process: Block[]
  summary: Block[]
  complete: boolean
  durationMs: number | null
  toolCallCount: number
  timestamp?: number
}

/** Group a turn without changing store entries or indices used for branching. */
export function responseTurns(
  entries: Entry[],
  streaming: boolean,
): (UserEntry | AssistantTurn | CompactionEntry | ContextEditEntry | CustomEntry)[] {
  const result: (UserEntry | AssistantTurn | CompactionEntry | ContextEditEntry | CustomEntry)[] = []
  let questionTime: number | undefined
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.kind === "user") {
      result.push(entry)
      questionTime = entry.timestamp
      continue
    }
    if (entry.kind === "compaction") {
      // Compaction markers break turn grouping and cross it no duration flows.
      result.push(entry)
      questionTime = undefined
      continue
    }
    if (entry.kind === "context_edit" || entry.kind === "custom") {
      // Light markers (context edits, extension entries) render in place and
      // must not be swallowed by the assistant-turn grouping. They change no
      // conversation content, so the question stays the duration anchor; the
      // next assistant message simply starts a fresh turn after the marker.
      result.push(entry)
      continue
    }
    const previous = result[result.length - 1]
    const turn: AssistantTurn =
      previous?.kind === "assistant"
        ? previous
        : {
            kind: "assistant",
            id: entry.id,
            lastIndex: index,
            blocks: [],
            process: [],
            summary: [],
            complete: true,
            durationMs: null,
            toolCallCount: 0,
          }
    if (turn !== previous) result.push(turn)
    turn.lastIndex = index
    // Live messages have an observed completion time; history retains the
    // recorded message timestamp. Never substitute the history loading time.
    const start = questionTime ?? entry.startedAt
    const end = entry.completedAt ?? entry.timestamp
    turn.timestamp = end ?? turn.timestamp
    turn.durationMs =
      typeof start === "number" &&
      Number.isFinite(start) &&
      typeof end === "number" &&
      Number.isFinite(end) &&
      end >= start
        ? end - start
        : null
    // Only trailing text from the final assistant entry is a final answer.
    // Commentary before a tool call must never be mistaken for a summary.
    let summaryStart = entry.blocks.length
    while (summaryStart > 0 && entry.blocks[summaryStart - 1]!.type === "text") summaryStart--
    turn.summary = entry.blocks.slice(summaryStart)
    turn.blocks.push(...entry.blocks)
  }
  for (const entry of result) {
    if (entry.kind === "assistant") {
      entry.process = entry.blocks.slice(0, entry.blocks.length - entry.summary.length)
      entry.toolCallCount = new Set(
        entry.blocks.flatMap(block => (block.type === "toolCall" ? [block.callId] : [])),
      ).size
    }
  }
  const last = result[result.length - 1]
  if (last?.kind === "assistant") last.complete = !streaming
  return result
}
