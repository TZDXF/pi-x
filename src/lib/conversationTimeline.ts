import { contentText } from "@/lib/content"
import type { Block, Entry, UserEntry } from "@/stores/session"

export interface ConversationTurn {
  id: number
  question: string
  answer: string
}
/** Turn with the id of its materialized user entry (null while history pages
 * are not loaded yet). Unmaterialized turns use a synthetic negative id
 * derived from their raw-message index: -(msgIndex + 1). Compaction nodes
 * (compaction set) mark where history was collapsed and are not questions;
 * contextEdit nodes mark an append-only model-context edit. */
export interface TimelineTurn extends ConversationTurn {
  entryId: number | null
  compaction?: { tokensBefore?: number; tokensAfter?: number }
  contextEdit?: { replaced: boolean }
}

const excerpt = (text: string) => {
  const normalized = text.replace(/\s+/g, " ").trim()
  return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized
}

/** Keep only text after the last tool call: earlier text is tool-run commentary, not the answer. */
function appendBlockText(turn: { answer: string }, blocks: Block[]) {
  let text = ""
  for (const block of blocks) {
    if (block.type === "toolCall") text = ""
    else if (block.type === "text") text = [text, block.text].filter(Boolean).join(" ")
  }
  if (text) turn.answer = excerpt([turn.answer, text].filter(Boolean).join(" "))
}

/** Append the in-flight streaming blocks to the last turn. */
export function appendPartial(turn: { answer: string }, partial: Block[]) {
  appendBlockText(turn, partial)
}

/** Group all assistant text until the next question; omit reasoning and tool output. */
export function conversationTurns(entries: Entry[], partial: Block[] | null = null): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const entry of entries) {
    if (entry.kind === "user") turns.push({ id: entry.id, question: excerpt(entry.text), answer: "" })
    else if (entry.kind === "assistant" && turns.length) appendBlockText(turns[turns.length - 1], entry.blocks)
  }
  if (partial?.length && turns.length) appendBlockText(turns[turns.length - 1], partial)
  return turns
}

const rawHasImage = (content: unknown) =>
  Array.isArray(content) && content.some((c: any) => c?.type === "image" && c.data && c.mimeType)

const rawAssistantText = (content: unknown): string => {
  let text = ""
  for (const c of Array.isArray(content) ? content : []) {
    if (c?.type === "toolCall") text = ""
    else if (c?.type === "text" && c.text) text = [text, c.text].filter(Boolean).join(" ")
  }
  return text
}

/** Timeline across the WHOLE session, not just the materialized page.
 *
 * `messages` is the raw history snapshot and `cursor` the index from which it
 * has been materialized into `entries` (which also holds live entries appended
 * after the snapshot). Unmaterialized turns still show up; materialized ones
 * resolve to their user entry id, matched in order (k-th materialized turn ↔
 * k-th non-live user entry). */
export function buildTimelineTurns(messages: any[], cursor: number, entries: Entry[]): TimelineTurn[] {
  const turns: TimelineTurn[] = []
  const compactionNode = (
    id: number,
    entryId: number | null,
    tokensBefore?: number,
    tokensAfter?: number,
  ): TimelineTurn => ({ id, question: "", answer: "", entryId, compaction: { tokensBefore, tokensAfter } })
  const contextEditNode = (id: number, entryId: number | null, replaced: boolean): TimelineTurn => ({
    id,
    question: "",
    answer: "",
    entryId,
    contextEdit: { replaced },
  })
  if (!messages.length) {
    // Snapshot released: everything is materialized (or live) in entries.
    for (const entry of entries) {
      if (entry.kind === "user")
        turns.push({ id: entry.id, question: excerpt(entry.text), answer: "", entryId: entry.id })
      else if (entry.kind === "compaction")
        turns.push(compactionNode(entry.id, entry.id, entry.tokensBefore, entry.tokensAfter))
      else if (entry.kind === "context_edit")
        turns.push(contextEditNode(entry.id, entry.id, entry.replaced))
      else if (entry.kind === "assistant" && turns.length) appendBlockText(turns[turns.length - 1], entry.blocks)
    }
    return turns
  }
  const userEntries = entries.filter(e => e.kind === "user" && !e.live) as UserEntry[]
  const compactionEntries = entries.filter(e => e.kind === "compaction" && !e.live)
  let materialized = 0
  let materializedCompactions = 0
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]
    if (msg?.role === "user") {
      const text = contentText(msg.content)
      if (!text.trim() && !rawHasImage(msg.content)) continue
      // Same acceptance rule as page materialization, so ranks stay aligned.
      const entryId = i >= cursor ? (userEntries[materialized++]?.id ?? null) : null
      turns.push({ id: entryId ?? -(i + 1), question: excerpt(text), answer: "", entryId })
    } else if (msg?.role === "compactionSummary" && typeof msg.summary === "string") {
      // Materialized compaction entries line up with compactionSummary
      // messages in order, the same way user entries line up with turns.
      const entryId = i >= cursor ? (compactionEntries[materializedCompactions++]?.id ?? null) : null
      turns.push(compactionNode(entryId ?? -(i + 1), entryId, msg.tokensBefore, msg.estimatedTokensAfter))
    } else if (msg?.role === "assistant" && turns.length) {
      const text = rawAssistantText(msg.content)
      if (text) {
        const turn = turns[turns.length - 1]
        turn.answer = excerpt([turn.answer, text].filter(Boolean).join(" "))
      }
    }
  }
  // Live entries arrived after the snapshot was taken.
  for (const entry of entries) {
    if (!entry.live) continue
    if (entry.kind === "user")
      turns.push({ id: entry.id, question: excerpt(entry.text), answer: "", entryId: entry.id })
    else if (entry.kind === "compaction")
      turns.push(compactionNode(entry.id, entry.id, entry.tokensBefore, entry.tokensAfter))
    else if (entry.kind === "context_edit") turns.push(contextEditNode(entry.id, entry.id, entry.replaced))
    else if (entry.kind === "assistant" && turns.length) appendBlockText(turns[turns.length - 1], entry.blocks)
  }
  return turns
}
