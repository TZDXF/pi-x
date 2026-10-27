import { onScopeDispose } from "vue"

interface PointerDragOptions<T> {
  onMove: (data: T, event: PointerEvent) => void
  onEnd?: (data: T) => void
  onCancel?: () => void
  cursor?: string
  capture?: boolean
  windowListeners?: boolean
}

/** Shared pointer drag lifecycle for mouse, touch and pen input. */
export function usePointerDrag<T>(options: PointerDragOptions<T>) {
  let active: { id: number; target: HTMLElement; data: T } | null = null
  let previousCursor = ""
  let previousSelect = ""

  function start(event: PointerEvent, data: T) {
    if (event.button !== 0 || active) return false
    const target = event.currentTarget as HTMLElement
    active = { id: event.pointerId, target, data }
    if (options.capture !== false) target.setPointerCapture(event.pointerId)
    previousCursor = document.body.style.cursor
    previousSelect = document.body.style.userSelect
    if (options.cursor) document.body.style.cursor = options.cursor
    document.body.style.userSelect = "none"
    if (options.windowListeners) {
      window.addEventListener("pointermove", move)
      window.addEventListener("pointerup", stop)
      window.addEventListener("pointercancel", cancel)
    }
    event.preventDefault()
    return true
  }

  function move(event: PointerEvent) {
    if (!active || active.id !== event.pointerId) return
    options.onMove(active.data, event)
  }

  function cleanup() {
    if (!active) return null
    const current = active
    active = null
    if (options.capture !== false && current.target.hasPointerCapture(current.id))
      current.target.releasePointerCapture(current.id)
    document.body.style.cursor = previousCursor
    document.body.style.userSelect = previousSelect
    if (options.windowListeners) {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", stop)
      window.removeEventListener("pointercancel", cancel)
    }
    return current.data
  }

  function stop() {
    const data = cleanup()
    if (data !== null) options.onEnd?.(data)
  }

  function cancel() {
    if (cleanup() !== null) options.onCancel?.()
  }

  onScopeDispose(cancel)
  return { start, move, stop, cancel }
}
