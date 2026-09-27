/** Pure drawing primitives for the free-hand canvas annotation layer. */

export interface Point {
  x: number
  y: number
}

export type DrawTool = "pen" | "arrow" | "rect" | "circle" | "text"

export interface DrawAnnotation {
  id: string
  tool: DrawTool
  points: Point[]
  color: string
  strokeWidth: number
  text?: string
}

export function drawAnnotation(ctx: CanvasRenderingContext2D, annotation: DrawAnnotation): void {
  ctx.strokeStyle = annotation.color
  ctx.fillStyle = annotation.color
  ctx.lineWidth = annotation.strokeWidth
  ctx.lineCap = "round"
  ctx.lineJoin = "round"

  if (annotation.tool === "pen" && annotation.points.length > 1) {
    ctx.beginPath()
    ctx.moveTo(annotation.points[0].x, annotation.points[0].y)
    for (let i = 1; i < annotation.points.length; i++) {
      ctx.lineTo(annotation.points[i].x, annotation.points[i].y)
    }
    ctx.stroke()
  } else if (annotation.tool === "arrow" && annotation.points.length >= 2) {
    drawArrow(ctx, annotation.points[0], annotation.points[annotation.points.length - 1])
  } else if (annotation.tool === "rect" && annotation.points.length >= 2) {
    const rect = rectOf(annotation.points)
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height)
  } else if (annotation.tool === "circle" && annotation.points.length >= 2) {
    const rect = rectOf(annotation.points)
    ctx.beginPath()
    ctx.ellipse(rect.x + rect.width / 2, rect.y + rect.height / 2, rect.width / 2, rect.height / 2, 0, 0, Math.PI * 2)
    ctx.stroke()
  } else if (annotation.tool === "text" && annotation.points.length >= 1 && annotation.text) {
    ctx.font = `${annotation.strokeWidth * 6 + 10}px sans-serif`
    ctx.fillText(annotation.text, annotation.points[0].x, annotation.points[0].y)
  }
}

export function drawArrow(ctx: CanvasRenderingContext2D, from: Point, to: Point): void {
  const headLen = 10 + ctx.lineWidth * 2
  const dx = to.x - from.x
  const dy = to.y - from.y
  const angle = Math.atan2(dy, dx)

  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(to.x, to.y)
  ctx.lineTo(to.x - headLen * Math.cos(angle - Math.PI / 6), to.y - headLen * Math.sin(angle - Math.PI / 6))
  ctx.lineTo(to.x - headLen * Math.cos(angle + Math.PI / 6), to.y - headLen * Math.sin(angle + Math.PI / 6))
  ctx.closePath()
  ctx.fill()
}

function rectOf(points: Point[]): { x: number; y: number; width: number; height: number } {
  const [start, end] = points
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  }
}
