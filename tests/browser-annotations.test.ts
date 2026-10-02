import { afterEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { useBrowserPageAnnotations } from "@/composables/browser/useBrowserPageAnnotations"
import { useBrowserConsole } from "@/composables/browser/useBrowserConsole"
import { useBrowserDrawers } from "@/composables/browser/useBrowserDrawers"

const pin = { selector: "button.save", text: "Save", rect: { x: 1, y: 2, width: 100, height: 20 } }
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
function setup() {
  vi.spyOn(Date, "now").mockReturnValue(1234)
  const options = {
    currentUrl: ref("http://localhost/a"),
    pageTitle: ref("Title"),
    t: (key: string) => key,
    postToPage: vi.fn(),
    sendToChat: vi.fn(),
    onInserted: vi.fn(),
  }
  return { annotations: useBrowserPageAnnotations(options), options }
}

test("pin/area comments retain document coordinates and markers sync only for the current document", () => {
  const { annotations: state, options } = setup()
  state.select({ pin })
  expect(state.selectionSummary.value).toBe("button.save · Save")
  state.saveSelection("  fix this  ")
  expect(state.pendingSelection.value).toBeNull()
  expect(state.annotations.value[0]).toMatchObject({
    kind: "pin",
    number: 1,
    comment: "fix this",
    url: "http://localhost/a",
    pin,
  })
  expect(options.postToPage).toHaveBeenLastCalledWith({
    target: "pix-preview-page",
    type: "add-marker",
    annotation: expect.objectContaining({ number: 1, rect: pin.rect }),
  })
  options.currentUrl.value = "http://localhost/b"
  const area = { rect: { x: 10.2, y: 20.7, width: 30.1, height: 40.9 } }
  state.select({ area })
  expect(state.selectionSummary.value).toBe("30×41 @ (10, 21)")
  state.saveSelection("area comment")
  expect(state.annotations.value[1]).toMatchObject({ kind: "area", number: 2, area })
  options.currentUrl.value = "http://localhost/a#section"
  options.postToPage.mockClear()
  state.syncMarkers()
  expect(options.postToPage.mock.calls.map(([message]) => message.type)).toEqual(["clear-markers", "add-marker"])
  expect(options.postToPage.mock.calls[1][0].annotation.number).toBe(1)
  state.deleteAnnotation(state.annotations.value[0].id)
  expect(state.annotations.value.map(a => a.number)).toEqual([2])
  expect(options.postToPage).toHaveBeenLastCalledWith({ target: "pix-preview-page", type: "clear-markers" })
  state.clearAllAnnotations()
  state.select({ pin })
  state.saveSelection("")
  expect(state.annotations.value[0].number).toBe(1)
})

test("chat insertion and copy share localized formatting, preserve all page annotations and tolerate unavailable clipboard", async () => {
  const { annotations: state, options } = setup()
  state.insertIntoChat()
  expect(options.sendToChat).not.toHaveBeenCalled()
  state.select({ pin })
  state.saveSelection("comment")
  options.currentUrl.value = "http://localhost/other"
  state.select({ area: { rect: pin.rect } })
  state.saveSelection("")
  state.insertIntoChat()
  const text = options.sendToChat.mock.calls[0][0]
  expect(text).toContain("browser.chatPage · Title")
  expect(text).toContain("button.save")
  expect(text).toContain("browser.chatComment: comment")
  expect(text).toContain("2. browser.chatArea")
  expect(options.onInserted).toHaveBeenCalledOnce()
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal("navigator", { clipboard: { writeText } })
  state.copyAnnotations()
  expect(writeText).toHaveBeenCalledWith(text)
  writeText.mockRejectedValue(new Error("denied"))
  state.copyAnnotations()
  await Promise.resolve()
  vi.stubGlobal("navigator", {})
  expect(() => state.copyAnnotations()).not.toThrow()
})

test("console keeps the newest 200 entries and IDs remain monotonic after clear", () => {
  const { consoleEntries, pushConsole } = useBrowserConsole()
  for (let i = 0; i < 205; i++) pushConsole(i % 2 ? "error" : "log", `line ${i}`)
  expect(consoleEntries.value).toHaveLength(200)
  expect(consoleEntries.value[0]).toEqual({ id: 6, level: "error", text: "line 5" })
  consoleEntries.value = []
  pushConsole("warn", "after clear")
  expect(consoleEntries.value).toEqual([{ id: 206, level: "warn", text: "after clear" }])
})

test("drawers toggle exclusively, capture pointer and clamp to page reserve/minimum", () => {
  const stage = ref({ clientHeight: 400 } as HTMLElement)
  const drawers = useBrowserDrawers(stage)
  drawers.toggleDrawer("annotations")
  drawers.toggleDrawer("console")
  expect(drawers.showAnnotations.value).toBe(false)
  expect(drawers.showConsole.value).toBe(true)
  drawers.toggleDrawer("console")
  expect(drawers.showConsole.value).toBe(false)
  const capture = vi.fn()
  drawers.onDrawerResizeStart("annotations", {
    preventDefault: vi.fn(),
    clientY: 300,
    pointerId: 7,
    currentTarget: { setPointerCapture: capture },
  } as unknown as PointerEvent)
  expect(capture).toHaveBeenCalledWith(7)
  drawers.onDrawerResizeMove({ clientY: -100 } as PointerEvent)
  expect(drawers.drawerHeights.value.annotations).toBe(304)
  drawers.onDrawerResizeMove({ clientY: 1000 } as PointerEvent)
  expect(drawers.drawerHeights.value.annotations).toBe(96)
  drawers.onDrawerResizeEnd()
  drawers.onDrawerResizeMove({ clientY: 0 } as PointerEvent)
  expect(drawers.drawerHeights.value.annotations).toBe(96)
  expect(drawers.drawerHeights.value.console).toBe(160)
})
