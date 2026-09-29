import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const canvasAnnotations = loadTsSource(
  readFileSync(new URL("../src/lib/canvasAnnotations.ts", import.meta.url), "utf8"),
)
const { drawAnnotation, drawArrow } = canvasAnnotations

// 记录型 2D 上下文桩:收集调用与属性赋值,无需真实 canvas。
function stubCtx() {
  const calls = []
  const props = {}
  const ctx = {
    calls,
    props,
  }
  for (const name of [
    "beginPath",
    "moveTo",
    "lineTo",
    "stroke",
    "fill",
    "closePath",
    "strokeRect",
    "fillText",
    "ellipse",
  ]) {
    ctx[name] = (...args) => calls.push([name, ...args])
  }
  for (const name of ["strokeStyle", "fillStyle", "lineWidth", "lineCap", "lineJoin", "font"]) {
    ctx[name] = undefined
    Object.defineProperty(ctx, name, {
      set: value => {
        props[name] = value
      },
      get: () => props[name],
    })
  }
  return ctx
}

test("applies color and width before drawing", () => {
  const ctx = stubCtx()
  drawAnnotation(ctx, {
    id: "a",
    tool: "pen",
    points: [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ],
    color: "#ff0000",
    strokeWidth: 3,
  })
  expect(ctx.props.strokeStyle).toBe("#ff0000")
  expect(ctx.props.lineWidth).toBe(3)
  expect(ctx.calls[0]).toEqual(["beginPath"])
  expect(ctx.calls[1]).toEqual(["moveTo", 0, 0])
  expect(ctx.calls[2]).toEqual(["lineTo", 10, 10])
  expect(ctx.calls[3]).toEqual(["stroke"])
})

test("pen strokes need at least two points", () => {
  const ctx = stubCtx()
  drawAnnotation(ctx, { id: "a", tool: "pen", points: [{ x: 1, y: 1 }], color: "#000", strokeWidth: 2 })
  expect(ctx.calls).toEqual([])
})

test("rect normalizes drag direction", () => {
  const ctx = stubCtx()
  drawAnnotation(ctx, {
    id: "a",
    tool: "rect",
    points: [
      { x: 100, y: 50 },
      { x: 40, y: 10 },
    ],
    color: "#000",
    strokeWidth: 2,
  })
  expect(ctx.calls.at(-1)).toEqual(["strokeRect", 40, 10, 60, 40])
})

test("ellipse is centered on the drag bounds", () => {
  const ctx = stubCtx()
  drawAnnotation(ctx, {
    id: "a",
    tool: "circle",
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 60 },
    ],
    color: "#000",
    strokeWidth: 2,
  })
  const [name, cx, cy, rx, ry] = ctx.calls.find(call => call[0] === "ellipse")
  expect(name).toBe("ellipse")
  expect(cx).toBe(50)
  expect(cy).toBe(30)
  expect(rx).toBe(50)
  expect(ry).toBe(30)
})

test("text uses a size derived from the stroke width", () => {
  const ctx = stubCtx()
  drawAnnotation(ctx, {
    id: "a",
    tool: "text",
    points: [{ x: 5, y: 20 }],
    color: "#000",
    strokeWidth: 2,
    text: "看这里",
  })
  expect(ctx.props.font).toBe("22px sans-serif")
  expect(ctx.calls.at(-1)).toEqual(["fillText", "看这里", 5, 20])
  // 没有文字内容时不绘制。
  const empty = stubCtx()
  drawAnnotation(empty, { id: "b", tool: "text", points: [{ x: 5, y: 20 }], color: "#000", strokeWidth: 2 })
  expect(empty.calls).toEqual([])
})

test("arrow draws a shaft and a triangular head", () => {
  const ctx = stubCtx()
  ctx.lineWidth = 2
  drawArrow(ctx, { x: 0, y: 0 }, { x: 100, y: 0 })
  const strokes = ctx.calls.filter(call => call[0] === "moveTo")
  expect(strokes[0]).toEqual(["moveTo", 0, 0])
  expect(strokes[1]).toEqual(["moveTo", 100, 0])
  // 箭头头部由两条线段 + closePath + fill 构成。
  expect(ctx.calls.some(call => call[0] === "closePath")).toBeTruthy()
  expect(ctx.calls.some(call => call[0] === "fill")).toBeTruthy()
})
