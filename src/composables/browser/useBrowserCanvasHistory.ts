import { ref, type Ref } from "vue"
import type { DrawAnnotation } from "@/lib/canvasAnnotations"

/** Snapshot history for the draw layer only; inspect annotations have a separate lifecycle. */
export function useBrowserCanvasHistory(drawAnnotations: Ref<DrawAnnotation[]>, onChange: () => void) {
  const history = ref<DrawAnnotation[][]>([])
  const historyIndex = ref(-1)
  function saveHistory() {
    history.value = history.value.slice(0, historyIndex.value + 1)
    history.value.push(JSON.parse(JSON.stringify(drawAnnotations.value)))
    historyIndex.value = history.value.length - 1
  }

  function undo() {
    if (historyIndex.value <= 0) return
    historyIndex.value--
    drawAnnotations.value = JSON.parse(JSON.stringify(history.value[historyIndex.value]))
    onChange()
  }

  function redo() {
    if (historyIndex.value >= history.value.length - 1) return
    historyIndex.value++
    drawAnnotations.value = JSON.parse(JSON.stringify(history.value[historyIndex.value]))
    onChange()
  }

  return { history, historyIndex, saveHistory, undo, redo }
}
