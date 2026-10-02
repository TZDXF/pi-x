import type { DrawAnnotation, Point } from "@/lib/canvasAnnotations"

export function hitTest(
  annotation: DrawAnnotation,
  point: Point,
  tolerance: number,
  measureText?: (text: string) => number,
): boolean {
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) <= tolerance
  const nearSegment = (a: Point, b: Point) => {
    const lengthSquared = (b.x - a.x) ** 2 + (b.y - a.y) ** 2
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((point.x - a.x) * (b.x - a.x) + (point.y - a.y) * (b.y - a.y)) / lengthSquared))
    return near(point, { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) })
  }
  if (annotation.tool === "pen" || annotation.tool === "arrow") {
    for (let i = 1; i < annotation.points.length; i++) {
      if (nearSegment(annotation.points[i - 1], annotation.points[i])) return true
    }
    return false
  }
  if (annotation.tool === "rect" && annotation.points.length >= 2) {
    const { x, y, width, height } = boundsOf(annotation)
    return (
      nearSegment({ x, y }, { x: x + width, y }) ||
      nearSegment({ x: x + width, y }, { x: x + width, y: y + height }) ||
      nearSegment({ x: x + width, y: y + height }, { x, y: y + height }) ||
      nearSegment({ x, y: y + height }, { x, y })
    )
  }
  if (annotation.tool === "circle" && annotation.points.length >= 2) {
    const { x, y, width, height } = boundsOf(annotation)
    const rx = width / 2
    const ry = height / 2
    if (rx <= 0 || ry <= 0) return false
    const dx = (point.x - (x + rx)) / rx
    const dy = (point.y - (y + ry)) / ry
    return Math.abs(Math.hypot(dx, dy) - 1) * Math.min(rx, ry) <= tolerance
  }
  if (annotation.tool === "text" && annotation.points.length >= 1) {
    const origin = annotation.points[0]
    const size = annotation.strokeWidth * 6 + 10
    const width = measureText?.(annotation.text ?? "") ?? (annotation.text ?? "").length * size
    return point.x >= origin.x && point.x <= origin.x + width && point.y >= origin.y - size && point.y <= origin.y
  }
  return false
}

function boundsOf(annotation: DrawAnnotation) {
  const [start, end] = annotation.points
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}
