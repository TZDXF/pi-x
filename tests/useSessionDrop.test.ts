import { computed, nextTick, ref } from "vue"
import { afterEach, expect, test, vi } from "vitest"
import { useSessionDrop } from "@/composables/useSessionDrop"
import type { SessionStore } from "@/stores/session"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"

function setup(options?: { excludeRect?: () => DOMRect | null }) {
  const setTextInput = vi.fn()
  const focus = vi.fn()
  vi.stubGlobal("document", { querySelector: () => ({ focus }) })
  const onSplitDrop = vi.fn()
  const drop = useSessionDrop(
    { sessionFile: "current.jsonl" } as SessionStore,
    ref({ textInput: "hello", setTextInput } as unknown as InstanceType<typeof PromptInputBridge>),
    computed(() => [{ file: "other.jsonl", title: "Other" }]),
    onSplitDrop,
    options,
  )
  return { ...drop, setTextInput, focus, onSplitDrop }
}

function event(data: Record<string, string>, clientX = 500) {
  return {
    clientX,
    clientY: 500,
    currentTarget: {
      getBoundingClientRect: () => ({ left: 0, right: 1000, top: 0, bottom: 1000, width: 1000, height: 1000 }),
    },
    dataTransfer: { types: Object.keys(data), getData: (type: string) => data[type] ?? "", dropEffect: "none" },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as DragEvent
}

const payload = { file: "other.jsonl", path: "C:/demo" }
const data = {
  "application/x-pix-session": payload.file,
  "application/x-pix-session-drag": JSON.stringify(payload),
}

afterEach(() => vi.unstubAllGlobals())

test("dual-type center drop inserts a reference and clears the preview", async () => {
  const drop = setup()
  const e = event(data)
  drop.onSessionDragOver(e)
  expect(drop.splitZone.value).toBe("center")
  drop.onSessionDrop(e)
  expect(drop.setTextInput).toHaveBeenCalledWith('hello @session("other.jsonl") ')
  expect(drop.onSplitDrop).not.toHaveBeenCalled()
  expect(drop.splitZone.value).toBeNull()
  expect(e.preventDefault).toHaveBeenCalled()
  expect(e.stopPropagation).toHaveBeenCalled()
  await nextTick()
  expect(drop.focus).toHaveBeenCalled()
})

test("edge drop splits without inserting a reference", () => {
  const drop = setup()
  drop.onSessionDrop(event(data, 20))
  expect(drop.onSplitDrop).toHaveBeenCalledWith(payload, "left")
  expect(drop.setTextInput).not.toHaveBeenCalled()
})

test("malformed edge payload is ignored and clears the preview", () => {
  const drop = setup()
  const e = event({ ...data, "application/x-pix-session-drag": "{" }, 20)
  drop.onSessionDragOver(e)
  expect(() => drop.onSessionDrop(e)).not.toThrow()
  expect(drop.splitZone.value).toBeNull()
  expect(drop.onSplitDrop).not.toHaveBeenCalled()
  expect(drop.setTextInput).not.toHaveBeenCalled()
})

for (const file of ["current.jsonl", "unknown.jsonl", ""]) {
  test(`center drop ignores invalid reference ${file}`, () => {
    const drop = setup()
    drop.onSessionDrop(event({ ...data, "application/x-pix-session": file }))
    expect(drop.setTextInput).not.toHaveBeenCalled()
    expect(drop.onSplitDrop).not.toHaveBeenCalled()
  })
}

test("legacy reference-only payload still inserts a reference", async () => {
  const drop = setup()
  drop.onSessionDrop(event({ "application/x-pix-session": "other.jsonl" }))
  expect(drop.setTextInput).toHaveBeenCalledWith('hello @session("other.jsonl") ')
  await nextTick()
})

test("dragover sets the composer hint on center and the split preview on edges", () => {
  const drop = setup()
  const over = (x: number, y: number) => {
    const e = event(data, x)
    ;(e as unknown as { clientY: number }).clientY = y
    drop.onSessionDragOver(e)
  }
  over(500, 500)
  expect(drop.splitZone.value).toBe("center")
  expect(drop.sessionDragOver.value).toBe(true)
  over(500, 950)
  expect(drop.splitZone.value).toBe("bottom")
  expect(drop.sessionDragOver.value).toBe(false)
  over(500, 500)
  expect(drop.sessionDragOver.value).toBe(true)
})

test("excluded composer rect keeps the hint and center drop inside the bottom band", () => {
  const composer = { left: 300, right: 700, top: 800, bottom: 1000, width: 400, height: 200 }
  const drop = setup({ excludeRect: () => composer as DOMRect })
  const over = (x: number, y: number) => {
    const e = event(data, x)
    ;(e as unknown as { clientY: number }).clientY = y
    drop.onSessionDragOver(e)
  }
  // Inside the composer (bottom band region) the reference hint stays on.
  over(500, 950)
  expect(drop.splitZone.value).toBe("center")
  expect(drop.sessionDragOver.value).toBe(true)
  // Outside the composer the bottom band still previews the split.
  over(100, 950)
  expect(drop.splitZone.value).toBe("bottom")
  expect(drop.sessionDragOver.value).toBe(false)
  // Drop over the composer inserts a reference instead of splitting.
  const dropEvent = event(data, 500)
  ;(dropEvent as unknown as { clientY: number }).clientY = 950
  drop.onSessionDrop(dropEvent)
  expect(drop.setTextInput).toHaveBeenCalledWith('hello @session("other.jsonl") ')
  expect(drop.onSplitDrop).not.toHaveBeenCalled()
})
