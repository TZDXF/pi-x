import type { Block, Entry } from '@/stores/session'

export interface ConversationTurn { id: number; question: string; answer: string }
const excerpt = (text: string) => {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > 180 ? `${normalized.slice(0, 180)}…` : normalized
}

/** Group all assistant text until the next question; omit reasoning and tool output. */
export function conversationTurns(entries: Entry[], partial: Block[] | null = null): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  const append = (blocks: Block[]) => {
    const turn = turns[turns.length - 1]
    if (!turn) return
    // Keep only text after the last tool call: earlier text is tool-run commentary, not the answer.
    let text = ''
    for (const block of blocks) {
      if (block.type === 'toolCall') text = ''
      else if (block.type === 'text') text = [text, block.text].filter(Boolean).join(' ')
    }
    if (text) turn.answer = excerpt([turn.answer, text].filter(Boolean).join(' '))
  }
  for (const entry of entries) {
    if (entry.kind === 'user') turns.push({ id: entry.id, question: excerpt(entry.text), answer: '' })
    else append(entry.blocks)
  }
  if (partial) append(partial)
  return turns
}
