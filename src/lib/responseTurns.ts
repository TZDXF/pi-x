import type {
  ErrorBlock,
  Block,
  CompactionEntry,
  ContextEditEntry,
  Entry,
  ModelChangeEntry,
  UserEntry,
} from "@/stores/session"

export interface AssistantTurn {
  kind: "assistant"
  id: number
  lastIndex: number
  blocks: Block[]
  process: Block[]
  summary: Block[]
  errors: ErrorBlock[]
  failed: boolean
  complete: boolean
  durationMs: number | null
  toolCallCount: number
  timestamp?: number
}

/** Group a turn without changing store entries or indices used for branching. */
export function responseTurns(
  entries: Entry[],
  streaming: boolean,
): (UserEntry | AssistantTurn | CompactionEntry | ContextEditEntry | ModelChangeEntry)[] {
  const result: (UserEntry | AssistantTurn | CompactionEntry | ContextEditEntry | ModelChangeEntry)[] = []
  let questionTime: number | undefined
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (entry.kind === "user") {
      const target = entry.modelChange?.to
      const previous = result[result.length - 1]
      // set_model / cycle_model annotate the next question even when pi
      // emits no entry_appended event. Reuse the history divider rendering,
      // but do not duplicate a matching divider already delivered live.
      if (target && !(previous?.kind === "model_change" && `${previous.provider}/${previous.modelId}` === target)) {
        const separator = target.indexOf("/")
        result.push({
          kind: "model_change",
          // Store IDs are positive; -1 is reserved for an uncommitted stream.
          id: -entry.id - 1,
          provider: separator < 0 ? "" : target.slice(0, separator),
          modelId: separator < 0 ? target : target.slice(separator + 1),
          timestamp: entry.timestamp,
          live: entry.live,
        })
      }
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
    if (entry.kind === "context_edit") {
      // pi writes a context_edit after every retried failed attempt; the
      // marker renders nowhere in the chat, so it must not split the
      // assistant turn into separate bubbles either.
      continue
    }
    // Extension entries never render. The Entry union has no custom kind
    // anymore, but runtime data (hand-built fixtures, stale stores) still
    // can; skipping here keeps surrounding assistant messages in one turn
    // instead of splitting the answer around an invisible marker.
    if ((entry as { kind?: string }).kind === "custom") continue
    if (entry.kind === "model_change") {
      // Model switches are rendered as dividers and break turn grouping;
      // no duration flows across them.
      result.push(entry)
      questionTime = undefined
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
            errors: [],
            failed: false,
            complete: true,
            durationMs: null,
            toolCallCount: 0,
          }
    if (turn !== previous) result.push(turn)
    turn.lastIndex = index
    turn.failed = entry.failed === true || entry.blocks.some(block => block.type === "error")
    const blocks = entry.blocks.filter(block => block.type !== "error")
    turn.errors.push(...entry.blocks.filter((block): block is ErrorBlock => block.type === "error"))
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
    let summaryStart = blocks.length
    while (summaryStart > 0 && blocks[summaryStart - 1]!.type === "text") summaryStart--
    // An error-only entry must not move earlier content into a reasoning fold.
    if (turn.failed) turn.summary = []
    else if (blocks.length) turn.summary = blocks.slice(summaryStart)
    turn.blocks.push(...blocks)
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
