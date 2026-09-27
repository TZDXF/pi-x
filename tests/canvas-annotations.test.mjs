import { test } from "node:test"
import assert from "node:assert/strict"
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
  assert.equal(ctx.props.strokeStyle, "#ff0000")
  assert.equal(ctx.props.lineWidth, 3)
  assert.deepEqual(ctx.calls[0], ["beginPath"])
  assert.deepEqual(ctx.calls[1], ["moveTo", 0, 0])
  assert.deepEqual(ctx.calls[2], ["lineTo", 10, 10])
  assert.deepEqual(ctx.calls[3], ["stroke"])
})

test("pen strokes need at least two points", () => {
  const ctx = stubCtx()
  drawAnnotation(ctx, { id: "a", tool: "pen", points: [{ x: 1, y: 1 }], color: "#000", strokeWidth: 2 })
  assert.deepEqual(ctx.calls, [])
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
  assert.deepEqual(ctx.calls.at(-1), ["strokeRect", 40, 10, 60, 40])
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
  assert.equal(name, "ellipse")
  assert.equal(cx, 50)
  assert.equal(cy, 30)
  assert.equal(rx, 50)
  assert.equal(ry, 30)
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
  assert.equal(ctx.props.font, "22px sans-serif")
  assert.deepEqual(ctx.calls.at(-1), ["fillText", "看这里", 5, 20])
  // 没有文字内容时不绘制。
  const empty = stubCtx()
  drawAnnotation(empty, { id: "b", tool: "text", points: [{ x: 5, y: 20 }], color: "#000", strokeWidth: 2 })
  assert.deepEqual(empty.calls, [])
})

test("arrow draws a shaft and a triangular head", () => {
  const ctx = stubCtx()
  ctx.lineWidth = 2
  drawArrow(ctx, { x: 0, y: 0 }, { x: 100, y: 0 })
  const strokes = ctx.calls.filter(call => call[0] === "moveTo")
  assert.deepEqual(strokes[0], ["moveTo", 0, 0])
  assert.deepEqual(strokes[1], ["moveTo", 100, 0])
  // 箭头头部由两条线段 + closePath + fill 构成。
  assert.ok(ctx.calls.some(call => call[0] === "closePath"))
  assert.ok(ctx.calls.some(call => call[0] === "fill"))
})
