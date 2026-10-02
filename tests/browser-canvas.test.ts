import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { markRaw, nextTick, ref } from "vue"
import type { DrawAnnotation, DrawTool } from "@/lib/canvasAnnotations"
import { hitTest } from "@/composables/browser/browserCanvasHitTest"
import { useBrowserCanvasHistory } from "@/composables/browser/useBrowserCanvasHistory"
import { useBrowserCanvas } from "@/composables/browser/useBrowserCanvas"
import { mountBrowserComposable } from "./browserTestHarness"

function annotation(tool: DrawTool, overrides: Partial<DrawAnnotation> = {}): DrawAnnotation {
  return {
    id: "draw",
    tool,
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 120 },
    ],
    color: "red",
    strokeWidth: 2,
    ...overrides,
  }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

test("history snapshots are independent, enforce limits and discard redo after a new edit", () => {
  const drawings = ref<DrawAnnotation[]>([])
  const changed = vi.fn()
  const state = useBrowserCanvasHistory(drawings, changed)
  state.saveHistory()
  state.undo()
  state.redo()
  expect(changed).not.toHaveBeenCalled()
  drawings.value.push(annotation("pen"))
  state.saveHistory()
  drawings.value[0].points[0].x = 999
  expect(state.history.value[1][0].points[0].x).toBe(10)
  state.undo()
  expect(drawings.value).toEqual([])
  state.redo()
  expect(drawings.value[0].points[0].x).toBe(10)
  drawings.value[0].color = "blue"
  expect(state.history.value[1][0].color).toBe("red")
  state.undo()
  drawings.value.push(annotation("rect"))
  state.saveHistory()
  expect(state.history.value).toHaveLength(2)
  state.redo()
  expect(drawings.value[0].tool).toBe("rect")
})

test("pen and arrow hit segments, including degenerate segments, not just sampled endpoints", () => {
  for (const tool of ["pen", "arrow"] as const) {
    expect(hitTest(annotation(tool), { x: 60, y: 70 }, 1)).toBe(true)
    expect(hitTest(annotation(tool), { x: 60, y: 90 }, 1)).toBe(false)
  }
  expect(
    hitTest(
      annotation("pen", {
        points: [
          { x: 10, y: 20 },
          { x: 10, y: 20 },
        ],
      }),
      { x: 10, y: 20 },
      0,
    ),
  ).toBe(true)
  expect(hitTest(annotation("pen", { points: [{ x: 10, y: 20 }] }), { x: 10, y: 20 }, 8)).toBe(false)
})

test("rect and ellipse hit outlines, handle reverse drags and reject empty ellipses", () => {
  const rect = annotation("rect", {
    points: [
      { x: 110, y: 120 },
      { x: 10, y: 20 },
    ],
  })
  expect(hitTest(rect, { x: 60, y: 20 }, 1)).toBe(true)
  expect(hitTest(rect, { x: 60, y: 70 }, 1)).toBe(false)
  const circle = annotation("circle")
  expect(hitTest(circle, { x: 110, y: 70 }, 1)).toBe(true)
  expect(hitTest(circle, { x: 60, y: 70 }, 1)).toBe(false)
  expect(
    hitTest(
      annotation("circle", {
        points: [
          { x: 10, y: 20 },
          { x: 10, y: 120 },
        ],
      }),
      { x: 10, y: 70 },
      8,
    ),
  ).toBe(false)
})

test("text hit uses canvas metrics when available, otherwise deterministic fallback", () => {
  const text = annotation("text", { text: "Hello", points: [{ x: 10, y: 40 }] })
  expect(hitTest(text, { x: 39, y: 30 }, 8, () => 30)).toBe(true)
  expect(hitTest(text, { x: 41, y: 30 }, 8, () => 30)).toBe(false)
  expect(hitTest(text, { x: 41, y: 30 }, 8)).toBe(true)
  expect(hitTest(text, { x: 10, y: 41 }, 8)).toBe(false)
  expect(() => hitTest(annotation("text"), { x: 1, y: 1 }, 8)).not.toThrow()
})

let unmount: (() => void) | undefined
let resize: (() => void) | undefined
const observe = vi.fn()
const disconnect = vi.fn()
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(1234)
  vi.stubGlobal("window", { devicePixelRatio: 2 })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback
      }
      observe = observe
      disconnect = disconnect
    },
  )
  observe.mockClear()
  disconnect.mockClear()
})
afterEach(() => {
  unmount?.()
  unmount = undefined
  resize = undefined
})

async function setup() {
  const context = markRaw({
    clearRect: vi.fn(),
    scale: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    strokeRect: vi.fn(),
    ellipse: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn(() => ({ width: 40 })),
  })
  const canvas = markRaw({
    width: 0,
    height: 0,
    style: {} as CSSStyleDeclaration,
    getBoundingClientRect: () => ({ left: 10, top: 20 }),
    getContext: () => context,
    toDataURL: vi.fn(() => "data:image/png;base64,test"),
  })
  const stage = markRaw({ getBoundingClientRect: () => ({ width: 200, height: 150 }) })
  const mode = ref<"none" | "draw" | "inspect">("none")
  const onTextRequested = vi.fn()
  const mounted = mountBrowserComposable(() =>
    useBrowserCanvas({
      mode,
      onTextRequested,
      canvasRef: ref(canvas as unknown as HTMLCanvasElement),
      stageRef: ref(stage as unknown as HTMLElement),
    }),
  )
  unmount = mounted.unmount
  await nextTick()
  const drawing = mounted.result
  const current = () => drawing.history.value[drawing.historyIndex.value]
  return { drawing, canvas, context, mode, onTextRequested, current }
}
function pointer(x: number, y: number) {
  return { clientX: x + 10, clientY: y + 20, preventDefault: vi.fn() } as unknown as MouseEvent
}

test("canvas initializes at DPR, switches pointer mode and disconnects resize observer", async () => {
  const { drawing, canvas, context, mode } = await setup()
  expect(canvas.width).toBe(400)
  expect(canvas.height).toBe(300)
  expect(canvas.style.width).toBe("200px")
  expect(context.scale).toHaveBeenCalledWith(2, 2)
  expect(canvas.style.pointerEvents).toBe("none")
  expect(drawing.history.value).toEqual([[]])
  mode.value = "draw"
  drawing.updateCanvasStyle()
  expect(canvas.style.pointerEvents).toBe("auto")
  expect(canvas.style.cursor).toBe("crosshair")
  resize?.()
  expect(context.scale).toHaveBeenCalledTimes(2)
  unmount?.()
  unmount = undefined
  expect(disconnect).toHaveBeenCalledOnce()
})

test("drawing ignores browse/inspect, commits pen on leave, erases only the topmost hit and can undo clearing", async () => {
  const { drawing, mode, current } = await setup()
  drawing.onPointerDown(pointer(10, 20))
  drawing.onPointerUp()
  mode.value = "inspect"
  drawing.onPointerDown(pointer(10, 20))
  drawing.onPointerUp()
  expect(current()).toEqual([])
  mode.value = "draw"
  for (let i = 0; i < 2; i++) {
    drawing.onPointerDown(pointer(10, 20))
    drawing.onPointerMove(pointer(110, 120))
    drawing.onPointerLeave()
  }
  expect(current()).toHaveLength(2)
  const firstId = current()[0].id
  expect(current()[0].points).toEqual([
    { x: 10, y: 20 },
    { x: 110, y: 120 },
  ])
  drawing.activeTool.value = "eraser"
  drawing.onPointerDown(pointer(60, 70))
  expect(current()).toHaveLength(1)
  expect(current()[0].id).toBe(firstId)
  drawing.undo()
  expect(current()).toHaveLength(2)
  drawing.clearDrawAnnotations()
  expect(current()).toEqual([])
  drawing.undo()
  expect(current()).toHaveLength(2)
})

test("text tool requests shared editor without a drawing history edit until saved, and exports PNG", async () => {
  const { drawing, mode, current, onTextRequested, canvas, context } = await setup()
  mode.value = "draw"
  drawing.activeTool.value = "text"
  drawing.onPointerDown(pointer(30, 40))
  drawing.onPointerUp()
  expect(onTextRequested).toHaveBeenCalledWith({ x: 30, y: 40 })
  expect(current()).toEqual([])
  drawing.addText({ x: 30, y: 40 }, "   ")
  expect(current()).toEqual([])
  drawing.addText({ x: 30, y: 40 }, "  Label  ")
  expect(current()[0]).toMatchObject({ tool: "text", text: "Label", points: [{ x: 30, y: 40 }] })
  expect(context.fillText).toHaveBeenLastCalledWith("Label", 30, 40)
  const link = { href: "", download: "", click: vi.fn() }
  vi.stubGlobal("document", { createElement: vi.fn(() => link) })
  drawing.exportAnnotations()
  expect(canvas.toDataURL).toHaveBeenCalledWith("image/png")
  expect(link.href).toBe("data:image/png;base64,test")
  expect(link.download).toBe("annotations-1234.png")
  expect(link.click).toHaveBeenCalledOnce()
})

test.each(["rect", "circle", "arrow"] as const)(
  "%s pointer tool keeps endpoints and selected stroke settings",
  async tool => {
    const { drawing, mode, current } = await setup()
    mode.value = "draw"
    drawing.activeTool.value = tool
    drawing.strokeColor.value = "#10b981"
    drawing.strokeWidth.value = 5
    drawing.onPointerDown(pointer(10, 20))
    drawing.onPointerMove(pointer(60, 70))
    drawing.onPointerMove(pointer(110, 120))
    drawing.onPointerUp()
    expect(current()).toHaveLength(1)
    expect(current()[0]).toMatchObject({
      tool,
      color: "#10b981",
      strokeWidth: 5,
      points: [
        { x: 10, y: 20 },
        { x: 110, y: 120 },
      ],
    })
  },
)
