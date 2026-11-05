import type { KanbanLivePreview } from "@/lib/kanbanLivePreview"
import type { BoardDraft } from "@/lib/workspaceState"

export const KANBAN_COLUMNS = [
  { id: "todo", labelKey: "kanban.todo" },
  { id: "running", labelKey: "kanban.running" },
  { id: "waiting", labelKey: "kanban.waiting" },
  { id: "completed", labelKey: "kanban.completed" },
  { id: "idle", labelKey: "kanban.idle" },
] as const

export type KanbanStatus = (typeof KANBAN_COLUMNS)[number]["id"]

/** Separate ordering for all projects and each project filter. Keys are opaque to persistence. */
export const kanbanColumnOrderKey = (project: string, status: KanbanStatus) => JSON.stringify([project, status])

/** Drafts keep their manual position after their first message receives a session filename. */
export const kanbanCardOrderId = (card: KanbanCard) => (card.draftId ? `draft:${card.draftId}` : card.id)

export interface KanbanCard {
  id: string
  project: string
  projectName: string
  projectless?: boolean
  title: string
  preview: string
  activity?: KanbanLivePreview
  /** Unix timestamp in milliseconds. */
  updatedAt: number
  status: KanbanStatus
  failed?: boolean
  /** Actual session directory; project remains the grouping/filtering root. */
  cwd?: string
  file?: string
  runtimeId?: string
  draftId?: string
}

/** The parent resolves runtime status and identity; projection never reads stores or starts tasks. */
export interface KanbanCardSource extends Omit<KanbanCard, "title" | "preview"> {
  title?: string | null
  preview?: string | null
  message?: string | null
  archived?: boolean
}

export interface KanbanCreatePayload extends Pick<BoardDraft, "modelKey" | "thinkingLevel" | "attachments"> {
  project: string
  message: string
  startImmediately?: boolean
}

/** Keep full titles/messages in data; visual truncation belongs to the card. Empty drafts stay empty. */
export function kanbanCardTitle(title?: string | null, message?: string | null): string {
  return title?.trim() || message?.trim().replace(/\s+/g, " ") || ""
}

/** An empty selection includes every project, including sessions without a project. */
export function filterKanbanCards(cards: readonly KanbanCard[], selectedProject = ""): KanbanCard[] {
  return cards.filter(card => !selectedProject || card.project === selectedProject)
}

/** Newest first; equal timestamps preserve input order. Invalid timestamps sort last. */
export function sortKanbanCards(cards: readonly KanbanCard[]): KanbanCard[] {
  const time = (value: number) => (Number.isFinite(value) ? value : -Infinity)
  return [...cards].sort((a, b) => {
    const aTime = time(a.updatedAt)
    const bTime = time(b.updatedAt)
    return aTime === bTime ? 0 : aTime > bTime ? -1 : 1
  })
}

/** Every column is present, even for an empty input. Neither the input nor its cards are mutated. */
export function groupKanbanCards(
  cards: readonly KanbanCard[],
  columnOrder: Readonly<Record<string, readonly string[]>> = {},
  project = "",
): Record<KanbanStatus, KanbanCard[]> {
  const groups: Record<KanbanStatus, KanbanCard[]> = {
    todo: [],
    running: [],
    waiting: [],
    completed: [],
    idle: [],
  }
  for (const card of sortKanbanCards(cards)) groups[card.status].push(card)
  for (const { id } of KANBAN_COLUMNS) {
    const order = columnOrder[kanbanColumnOrderKey(project, id)]
    if (!order?.length) continue
    const rank = new Map(order.map((key, index) => [key, index]))
    // New arrivals stay visible at the top; explicitly ordered cards retain their relative positions.
    groups[id].sort((a, b) => (rank.get(kanbanCardOrderId(a)) ?? -1) - (rank.get(kanbanCardOrderId(b)) ?? -1))
  }
  return groups
}

/** Reorder only current peers, preserving cards hidden by idle pagination. */
export function moveKanbanCard(
  cards: readonly KanbanCard[],
  sourceId: string,
  targetId: string,
  after: boolean,
): string[] | null {
  const source = cards.find(card => card.id === sourceId)
  const target = cards.find(card => card.id === targetId)
  if (!source || !target || source.id === target.id || source.status !== target.status) return null
  const remaining = cards.filter(card => card.id !== sourceId)
  remaining.splice(remaining.findIndex(card => card.id === targetId) + Number(after), 0, source)
  const next = remaining.map(kanbanCardOrderId)
  return next.every((id, index) => id === kanbanCardOrderId(cards[index]!)) ? null : next
}

/** Drop archived sources, prefer session titles, and fall back to a message/preview summary. */
export function projectKanbanCards(sources: readonly KanbanCardSource[], selectedProject = ""): KanbanCard[] {
  const cards = sources
    .filter(source => !source.archived)
    .map(source => {
      const { title, preview, message, archived: _archived, ...card } = source
      const text = preview?.trim() || message?.trim() || ""
      return { ...card, title: kanbanCardTitle(title, text), preview: text }
    })
  return sortKanbanCards(filterKanbanCards(cards, selectedProject))
}
