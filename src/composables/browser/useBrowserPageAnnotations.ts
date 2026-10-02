import { computed, ref, type Ref } from "vue"
import {
  bridgeAddMarker,
  bridgeCommand,
  type BridgeOutbound,
  type PreviewPin,
  type PreviewArea,
} from "@/lib/previewBridge"
import {
  annotationsForPage,
  formatAnnotationsForChat,
  nextAnnotationId,
  type PageAnnotation,
} from "@/lib/previewAnnotations"

interface PageAnnotationOptions {
  currentUrl: Ref<string>
  pageTitle: Ref<string>
  postToPage: (message: BridgeOutbound) => void
  t: (key: string) => string
  sendToChat: (text: string) => void
  onInserted: () => void
}

/** Document-space inspect annotations and their page markers/chat representation. */
export function useBrowserPageAnnotations(options: PageAnnotationOptions) {
  const { t } = options
  const annotations = ref<PageAnnotation[]>([])
  const numberSeq = ref(0)
  const pendingSelection = ref<{ pin?: PreviewPin; area?: PreviewArea } | null>(null)
  const selectionSummary = computed(() => {
    const selection = pendingSelection.value
    if (!selection) return ""
    if (selection.pin) return selection.pin.selector + (selection.pin.text ? ` · ${selection.pin.text}` : "")
    const rect = selection.area?.rect
    if (rect)
      return `${Math.round(rect.width)}×${Math.round(rect.height)} @ (${Math.round(rect.x)}, ${Math.round(rect.y)})`
    return ""
  })

  function select(selection: { pin?: PreviewPin; area?: PreviewArea }) {
    pendingSelection.value = selection
  }
  function saveSelection(comment: string) {
    if (!pendingSelection.value) return
    const selection = pendingSelection.value
    const annotation: PageAnnotation = {
      id: nextAnnotationId(),
      kind: selection.pin ? "pin" : "area",
      number: ++numberSeq.value,
      pin: selection.pin,
      area: selection.area,
      comment: comment.trim(),
      url: options.currentUrl.value,
    }
    annotations.value.push(annotation)
    options.postToPage(
      bridgeAddMarker({
        id: annotation.id,
        kind: annotation.kind,
        number: annotation.number,
        rect: annotationRect(annotation),
        pin: annotation.pin,
      }),
    )
    pendingSelection.value = null
  }

  function annotationRect(annotation: PageAnnotation) {
    return annotation.pin?.rect ?? annotation.area?.rect ?? { x: 0, y: 0, width: 0, height: 0 }
  }

  function syncMarkers() {
    options.postToPage(bridgeCommand("clear-markers"))
    for (const annotation of annotationsForPage(annotations.value, options.currentUrl.value)) {
      options.postToPage(
        bridgeAddMarker({
          id: annotation.id,
          kind: annotation.kind,
          number: annotation.number,
          rect: annotationRect(annotation),
          pin: annotation.pin,
        }),
      )
    }
  }

  function deleteAnnotation(id: string) {
    annotations.value = annotations.value.filter(annotation => annotation.id !== id)
    syncMarkers()
  }

  function clearAllAnnotations() {
    annotations.value = []
    numberSeq.value = 0
    syncMarkers()
  }

  function copyAnnotations() {
    void navigator.clipboard?.writeText(chatText()).catch(() => {
      /* clipboard is optional */
    })
  }

  function chatText() {
    return formatAnnotationsForChat(
      annotations.value,
      { url: options.currentUrl.value, title: options.pageTitle.value },
      {
        page: t("browser.chatPage"),
        element: t("browser.chatElement"),
        area: t("browser.chatArea"),
        comment: t("browser.chatComment"),
      },
    )
  }

  function insertIntoChat() {
    if (!annotations.value.length) return
    options.sendToChat(chatText())
    options.onInserted()
  }

  return {
    annotations,
    pendingSelection,
    selectionSummary,
    select,
    saveSelection,
    syncMarkers,
    deleteAnnotation,
    clearAllAnnotations,
    copyAnnotations,
    insertIntoChat,
  }
}
