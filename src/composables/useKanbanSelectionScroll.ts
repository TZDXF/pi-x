import { onBeforeUnmount, onMounted, watch, type Ref } from "vue"

/** Keep the selected card visible as the details panel takes space from the board. */
export function useKanbanSelectionScroll(scroller: Ref<HTMLElement | null>, selectedId: () => string | undefined) {
  let observer: ResizeObserver | undefined

  function revealSelection() {
    const viewport = scroller.value
    if (!viewport || !selectedId() || !viewport.clientWidth) return
    const card = viewport.querySelector<HTMLElement>('[data-kanban-card][aria-pressed="true"]')
    if (!card) return

    const bounds = viewport.getBoundingClientRect()
    const cardBounds = card.getBoundingClientRect()
    const left = bounds.left + viewport.clientLeft + 16
    const right = bounds.left + viewport.clientLeft + viewport.clientWidth - 16
    const offset =
      cardBounds.left < left || cardBounds.width > right - left
        ? cardBounds.left - left
        : Math.max(0, cardBounds.right - right)
    // Adjust only this horizontal scroller, without moving the column's history.
    if (offset) viewport.scrollLeft += offset
  }

  watch(selectedId, revealSelection, { flush: "post" })
  onMounted(() => {
    const viewport = scroller.value
    if (!viewport) return
    let previousWidth = viewport.clientWidth
    observer = new ResizeObserver(() => {
      const width = viewport.clientWidth
      if (width < previousWidth || previousWidth === 0) revealSelection()
      previousWidth = width
    })
    observer.observe(viewport)
    revealSelection()
  })
  onBeforeUnmount(() => observer?.disconnect())
}
