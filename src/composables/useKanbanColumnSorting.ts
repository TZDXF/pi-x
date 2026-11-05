import { ref, watch } from "vue"
import { moveKanbanColumn, type KanbanStatus } from "@/lib/kanban"

/** Reorder status columns by their headings without involving card drag/drop. */
export function useKanbanColumnSorting(
  columns: () => readonly KanbanStatus[],
  blocked: () => boolean,
  reorder: (columns: KanbanStatus[]) => void,
) {
  const source = ref<KanbanStatus | null>(null)
  const target = ref<{ id: KanbanStatus; after: boolean } | null>(null)

  function endDrag() {
    source.value = null
    target.value = null
  }
  watch(blocked, value => {
    if (value) endDrag()
  })

  function startDrag(event: DragEvent, column: KanbanStatus) {
    if (blocked() || !event.dataTransfer || !columns().includes(column)) {
      event.preventDefault()
      return
    }
    source.value = column
    event.dataTransfer.effectAllowed = "move"
    event.dataTransfer.setData("text/plain", column)
  }

  function overColumn(event: DragEvent, column: KanbanStatus) {
    if (blocked() || !source.value || source.value === column || !columns().includes(column)) {
      target.value = null
      return
    }
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    target.value = { id: column, after: event.clientX > rect.left + rect.width / 2 }
  }

  function drop(event: DragEvent, column: KanbanStatus) {
    event.preventDefault()
    if (!blocked() && source.value && target.value?.id === column) {
      const next = moveKanbanColumn(columns(), source.value, column, target.value.after)
      if (next) reorder(next)
    }
    endDrag()
  }

  function moveWithKeyboard(event: KeyboardEvent, column: KanbanStatus) {
    if (blocked() || !event.altKey || !["ArrowLeft", "ArrowRight"].includes(event.key)) return
    event.preventDefault()
    const current = columns()
    const index = current.indexOf(column)
    const after = event.key === "ArrowRight"
    const next = current[index + (after ? 1 : -1)]
    if (!next) return
    const ordered = moveKanbanColumn(current, column, next, after)
    if (ordered) reorder(ordered)
  }

  return { source, target, startDrag, overColumn, drop, endDrag, moveWithKeyboard }
}
