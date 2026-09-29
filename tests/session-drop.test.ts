import { test, expect } from "vitest"
import { useSessionDrop, type SessionDragPayload } from "@/composables/useSessionDrop"
import type { SessionStore } from "@/stores/session"

const rect = {
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  top: 0,
  right: 200,
  bottom: 100,
  left: 0,
  toJSON: () => ({}),
}
const target = { getBoundingClientRect: () => rect }

function fakeEvent(overrides: {
  clientX?: number
  clientY?: number
  types?: string[]
  file?: string
  payload?: SessionDragPayload
}) {
  const store = new Map<string, string>([
    ["application/x-pix-session", overrides.file ?? "a.jsonl"],
    [
      "application/x-pix-session-drag",
      JSON.stringify(overrides.payload ?? { file: "a.jsonl", path: "C:/repo", runtimeId: "rt1" }),
    ],
  ])
  const types = overrides.types
  return {
    clientX: overrides.clientX ?? 100,
    clientY: overrides.clientY ?? 50,
    relatedTarget: null,
    preventDefault: () => {},
    stopPropagation: () => {},
    currentTarget: target,
    dataTransfer: {
      types: types ?? ["application/x-pix-session-drag"],
      getData: (type: string) => store.get(type) ?? "",
      dropEffect: "",
    },
  } as unknown as DragEvent
}

function makeDrop(bridge = { textInput: "" }) {
  const splits: Array<{ payload: SessionDragPayload; zone: string }> = []
  const session = {
    sessionFile: "self.jsonl",
  } as unknown as SessionStore
  const drop = useSessionDrop(session, { value: null } as never, { value: [] } as never, (payload, zone) =>
    splits.push({ payload, zone }),
  )
  return { drop, splits, bridge }
}

test("edge drops report the zone and payload without inserting a reference", () => {
  const { drop, splits } = makeDrop()
  drop.onSessionDragOver(fakeEvent({ clientX: 10, clientY: 50 }))
  expect(drop.splitZone.value).toBe("left")
  const payload = { file: "a.jsonl", path: "C:/repo" }
  drop.onSessionDrop(fakeEvent({ clientX: 190, clientY: 50, payload }))
  expect(drop.splitZone.value).toBeNull()
  expect(splits).toEqual([{ payload, zone: "right" }])
})

test("center drops keep the legacy @session reference behavior", () => {
  const { drop, splits } = makeDrop()
  drop.onSessionDragOver(fakeEvent({ clientX: 100, clientY: 50, types: ["application/x-pix-session-drag"] }))
  expect(drop.splitZone.value).toBe("center")
  drop.onSessionDrop(fakeEvent({ clientX: 100, clientY: 50 }))
  expect(splits).toEqual([])
})

test("drags without the split payload keep the reference highlight path", () => {
  const { drop, splits } = makeDrop()
  drop.onSessionDragOver(fakeEvent({ types: ["application/x-pix-session"] }))
  expect(drop.sessionDragOver.value).toBe(true)
  expect(drop.splitZone.value).toBeNull()
  drop.onSessionDrop(fakeEvent({ types: ["application/x-pix-session"], file: "a.jsonl" }))
  expect(splits).toEqual([])
})