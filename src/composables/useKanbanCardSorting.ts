import { ref, watch } from "vue"
import { moveKanbanCard, type KanbanCard, type KanbanStatus } from "@/lib/kanban"

/** Native drag/drop keeps navigation clicks intact; only a todo dropped on running may start a draft. */
export function useKanbanCardSorting(
  groups: () => Record<KanbanStatus, KanbanCard[]>,
  scope: () => string,
  blocked: () => boolean,
  reorder: (column: KanbanStatus, ids: string[]) => void,
  startDraft?: (card: KanbanCard) => void,
) {
  const source = ref<{ id: string; status: KanbanStatus } | null>(null)
  const target = ref<{ id: string; after: boolean } | null>(null)

  function endDrag() {
    source.value = null
    target.value = null
  }
  watch(scope, endDrag)
  watch(blocked, value => {
    if (value) endDrag()
  })

  function startDrag(event: DragEvent, card: KanbanCard) {
    if (blocked() || !event.dataTransfer) {
      event.preventDefault()
      return
    }
    source.value = { id: card.id, status: card.status }
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", card.id)
  }

  function sourceCard(status: KanbanStatus) {
    const start = source.value
    if (blocked() || !start || start.status !== status) return null
    return groups()[status].find(card => card.id === start.id) ?? null
  }

  function canDrop(column: KanbanStatus) {
    return !!sourceCard(column)
  }

  function draftToStart(column: KanbanStatus) {
    if (column !== "running") return null
    const card = sourceCard("todo")
    return card?.draftId ? card : null
  }

  function overCard(event: DragEvent, card: KanbanCard) {
    const starting = draftToStart(card.status)
    if ((!canDrop(card.status) && !starting) || source.value?.id === card.id) {
      target.value = null
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    if (starting) {
      target.value = null
      return
    }
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    target.value = { id: card.id, after: event.clientY > rect.top + rect.height / 2 }
  }

  function drop(event: DragEvent, column: KanbanStatus) {
    event.preventDefault()
    const draft = draftToStart(column)
    if (draft) startDraft?.(draft)
    else if (canDrop(column) && source.value && target.value) {
      const ids = moveKanbanCard(groups()[column], source.value.id, target.value.id, target.value.after)
      if (ids) reorder(column, ids)
    }
    endDrag()
  }

  function overColumn(event: DragEvent, column: KanbanStatus) {
    if ((event.target as Element).closest("[data-kanban-card]")) return
    const starting = draftToStart(column)
    if (!canDrop(column) && !starting) {
      target.value = null
      return
    }
    event.preventDefault()
    if (starting) {
      target.value = null
      return
    }
    const peers = groups()[column]
    const last = peers[peers.length - 1]
    target.value = last ? { id: last.id, after: true } : null
  }

  function moveWithKeyboard(event: KeyboardEvent, card: KanbanCard) {
    if (blocked() || !event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return
    event.preventDefault()
    const peers = groups()[card.status]
    const index = peers.findIndex(peer => peer.id === card.id)
    const after = event.key === "ArrowDown"
    const next = peers[index + (after ? 1 : -1)]
    if (!next) return
    const ids = moveKanbanCard(peers, card.id, next.id, after)
    if (ids) reorder(card.status, ids)
  }

  return { source, target, startDrag, overCard, overColumn, drop, endDrag, moveWithKeyboard }
}
