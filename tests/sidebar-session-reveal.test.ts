import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, shallowRef } from "vue"
import {
  findSidebarSessionRow,
  useSidebarSessionReveal,
  type SidebarSessionTarget,
} from "@/components/workspace/sidebar/useSidebarSessionReveal"

const scopes: ReturnType<typeof effectScope>[] = []
const observers: { callback: () => void; disconnect: ReturnType<typeof vi.fn> }[] = []
beforeEach(() => {
  vi.stubGlobal(
    "MutationObserver",
    class {
      disconnect = vi.fn()
      observe = vi.fn()
      constructor(public callback: () => void) {
        observers.push(this)
      }
    },
  )
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  observers.splice(0)
  vi.unstubAllGlobals()
})
const row = (dataset: Record<string, string>) => ({ dataset, scrollIntoView: vi.fn() }) as unknown as HTMLElement
const container = (rows: HTMLElement[]) => ({ querySelectorAll: () => rows }) as unknown as HTMLElement

test("saved rows match opaque file identities and retain remote endpoint isolation", () => {
  const file = '/sessions/a"[odd].jsonl'
  const first = row({ file, cwd: "ssh://server-a/project" })
  const second = row({ file, cwd: "ssh://server-b/project" })
  expect(findSidebarSessionRow(container([first, second]), { file, cwd: "ssh://server-b/project" })).toBe(second)
  expect(findSidebarSessionRow(container([first]), { file, cwd: "ssh://server-b/project" })).toBeUndefined()
})

test("draft/pending targets locate their runtime and saved targets can match pending rows with reserved filenames", () => {
  const pending = row({ runtimeId: "draft-one", cwd: "C:/project", file: "C:/sessions/one.jsonl" })
  const root = container([pending])
  expect(findSidebarSessionRow(root, { runtimeId: "draft-one", cwd: "C:/project" })).toBe(pending)
  expect(findSidebarSessionRow(root, { file: "C:\\sessions\\one.jsonl", cwd: "C:/project" })).toBe(pending)
})

test("reveal expands first, waits for the row, scrolls once, and disconnects its observer", async () => {
  const rows: HTMLElement[] = []
  const request = shallowRef<SidebarSessionTarget | null>({ file: "chosen.jsonl", cwd: "root" })
  const root = shallowRef<HTMLElement | null>(container(rows))
  const expand = vi.fn()
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => useSidebarSessionReveal(root, () => request.value, expand))
  await nextTick()
  expect(expand).toHaveBeenCalledExactlyOnceWith(request.value)
  const chosen = row({ file: "chosen.jsonl", cwd: "root" })
  rows.push(chosen)
  observers[0].callback()
  await nextTick()
  expect(chosen.scrollIntoView).toHaveBeenCalledExactlyOnceWith({
    block: "nearest",
    inline: "nearest",
    behavior: "instant",
  })
  expect(observers[0].disconnect).toHaveBeenCalled()
  observers[0].callback()
  await nextTick()
  expect(chosen.scrollIntoView).toHaveBeenCalledOnce()
})

test("new requests and unmounting cancel obsolete asynchronous reveals", async () => {
  const rows: HTMLElement[] = []
  const request = shallowRef<SidebarSessionTarget | null>({ runtimeId: "old", cwd: "root" })
  const root = shallowRef<HTMLElement | null>(container(rows))
  const scope = effectScope()
  scopes.push(scope)
  scope.run(() => useSidebarSessionReveal(root, () => request.value, vi.fn()))
  await nextTick()
  request.value = { runtimeId: "new", cwd: "root" }
  await nextTick()
  const old = row({ runtimeId: "old" })
  const current = row({ runtimeId: "new" })
  rows.push(old, current)
  observers[0].callback()
  observers[1].callback()
  await nextTick()
  expect(old.scrollIntoView).not.toHaveBeenCalled()
  expect(current.scrollIntoView).toHaveBeenCalledOnce()
  scope.stop()
  expect(observers[1].disconnect).toHaveBeenCalled()
})
