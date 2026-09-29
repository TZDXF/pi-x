export type SplitDropZone = "left" | "right" | "top" | "bottom" | "center"

/**
 * Resolve a pointer position against a pane. A point within thresholdRatio of
 * an edge selects that edge; otherwise center keeps the existing @-mention
 * behavior. The closest qualifying edge wins at corners.
 */
export function resolveDropZone(clientX: number, clientY: number, rect: DOMRect, thresholdRatio = 0.18): SplitDropZone {
  if (rect.width <= 0 || rect.height <= 0) return "center"

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
