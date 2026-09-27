/** Inspect annotations captured on a previewed page (element pins and rectangular areas). */

import type { PreviewArea, PreviewPin } from "./previewBridge"

export interface PageAnnotation {
  id: string
  kind: "pin" | "area"
  number: number
  pin?: PreviewPin
  area?: PreviewArea
  comment: string
  url: string
}

export interface AnnotationChatLabels {
  page: string
  element: string
  area: string
  comment: string
}

/** Renders the annotations as a structured block the user can send to the agent. */
export function formatAnnotationsForChat(
  annotations: PageAnnotation[],
  page: { url: string; title: string },
  labels: AnnotationChatLabels,
): string {
  const lines: string[] = []
  const header = labels.page + (page.title ? ` · ${page.title}` : "")
  lines.push(header, page.url)
  for (const annotation of annotations) {
    lines.push("")
    lines.push(`${annotation.number}. ${describe(annotation, labels)}`)
    if (annotation.comment) lines.push(`   ${labels.comment}: ${annotation.comment}`)
  }
  return lines.join("\n")
}

function describe(annotation: PageAnnotation, labels: AnnotationChatLabels): string {
  if (annotation.kind === "pin" && annotation.pin) {
    const text = annotation.pin.text ? ` "${annotation.pin.text}"` : ""
    return `${labels.element} \`${annotation.pin.selector}\`${text}`
  }
  const rect = annotation.area?.rect
  if (rect)
    return `${labels.area} (${Math.round(rect.x)}, ${Math.round(rect.y)}) ${Math.round(rect.width)}×${Math.round(rect.height)}`
  return labels.area
}

let annotationSeq = 0

export function nextAnnotationId(): string {
  return `page-annotation-${++annotationSeq}-${Date.now()}`
}

/** Keeps the in-page markers of annotations that belong to the given page. */
export function annotationsForPage(annotations: PageAnnotation[], url: string): PageAnnotation[] {
  return annotations.filter(annotation => sameUrl(annotation.url, url))
}

/** Compares URLs ignoring hash changes, since markers target the document. */
export function sameUrl(left: string, right: string): boolean {
  if (left === right) return true
  try {
    const a = new URL(left)
    const b = new URL(right)
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search
  } catch {
    return false
  }
}
