export type SplitDropZone = "left" | "right" | "top" | "bottom" | "center"

function insideRect(clientX: number, clientY: number, rect: DOMRect): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom
}

/**
 * Resolve a pointer position against a pane. A point within thresholdRatio of
 * an edge selects that edge; otherwise center keeps the existing @-mention
 * behavior. The closest qualifying edge wins at corners. `exclude` marks a
 * rect (e.g. the composer) that always resolves to center so edge bands can
 * avoid it.
 */
export function resolveDropZone(
  clientX: number,
  clientY: number,
  rect: DOMRect,
  thresholdRatio = 0.18,
  exclude?: DOMRect | null,
): SplitDropZone {
  if (rect.width <= 0 || rect.height <= 0) return "center"
  if (exclude && exclude.width > 0 && exclude.height > 0 && insideRect(clientX, clientY, exclude)) return "center"

  const fromLeft = (clientX - rect.left) / rect.width
  const fromRight = (rect.right - clientX) / rect.width
  const fromTop = (clientY - rect.top) / rect.height
  const fromBottom = (rect.bottom - clientY) / rect.height
  const candidates = [
    { zone: "left" as const, distance: fromLeft },
    { zone: "right" as const, distance: fromRight },
    { zone: "top" as const, distance: fromTop },
    { zone: "bottom" as const, distance: fromBottom },
  ]
  const edge = candidates
    .filter(candidate => candidate.distance <= thresholdRatio)
    .sort((first, second) => first.distance - second.distance)[0]
  return edge?.zone ?? "center"
}

/** Geometry of the bottom split preview: the band minus the notched-out input rect. */
export interface BottomNotch {
  /** Top of the bottom preview band (viewport-independent, relative to the pane). */
  bandTop: number
  holeLeft: number
  holeRight: number
  holeTop: number
  holeBottom: number
}

/**
 * Compute the notch cut out of the bottom preview band around the composer's
 * text area. `root` and `input` are viewport rects; both band and hole are
 * returned relative to the pane. Returns null when there is nothing to cut
 * (no input rect, or the rect does not intersect the band).
 */
export function computeBottomNotch(root: DOMRect, input: DOMRect | null, gap = 8): BottomNotch | null {
  const bandTop = root.height * 0.75
  if (!input || input.width <= 0 || input.height <= 0) return null
  const holeLeft = Math.max(input.left - root.left - gap, 0)
  const holeRight = Math.min(input.right - root.left + gap, root.width)
  const holeTop = Math.max(input.top - root.top - gap, bandTop)
  const holeBottom = Math.min(input.bottom - root.top + gap, root.height)
  if (holeRight <= holeLeft || holeBottom <= holeTop) return null
  return { bandTop, holeLeft, holeRight, holeTop, holeBottom }
}
