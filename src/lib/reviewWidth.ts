export function reviewWidthBounds(containerWidth: number, overlay: boolean) {
  const available = Math.max(0, containerWidth)
  const max = overlay ? available : Math.min(900, Math.max(0, available - 360))
  return { min: Math.min(280, max), max }
}

export function clampReviewWidth(width: number, containerWidth: number, overlay: boolean) {
  const { min, max } = reviewWidthBounds(containerWidth, overlay)
  return Math.min(max, Math.max(min, Number.isFinite(width) ? width : 420))
}
