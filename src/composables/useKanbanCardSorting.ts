import { ref, watch } from "vue"
import { moveKanbanCard, type KanbanCard, type KanbanStatus } from "@/lib/kanban"

/** Native drag/drop keeps navigation clicks intact and never changes a conversation's lifecycle. */
export function useKanbanCardSorting(
  groups: () => Record<KanbanStatus, KanbanCard[]>,
  scope: () => string,
  blocked: () => boolean,
  reorder: (column: KanbanStatus, ids: string[]) => void,
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

  function canDrop(column: KanbanStatus) {
    const start = source.value
    return !blocked() && !!start && start.status === column && groups()[column].some(card => card.id === start.id)
  }

  function overCard(event: DragEvent, card: KanbanCard) {
    if (!canDrop(card.status) || source.value?.id === card.id) {
      target.value = null
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    target.value = { id: card.id, after: event.clientY > rect.top + rect.height / 2 }
  }

  function drop(event: DragEvent, column: KanbanStatus) {
    event.preventDefault()
    if (canDrop(column) && source.value && target.value) {
      const ids = moveKanbanCard(groups()[column], source.value.id, target.value.id, target.value.after)
      if (ids) reorder(column, ids)
    }
    endDrag()
  }

  function overColumn(event: DragEvent, column: KanbanStatus) {
    if ((event.target as Element).closest("[data-kanban-card]")) return
    if (!canDrop(column)) {
      target.value = null
      return
    }
    event.preventDefault()
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
