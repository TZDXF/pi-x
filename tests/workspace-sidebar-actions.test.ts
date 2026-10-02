import { afterEach, expect, test, vi } from "vitest"
import { createRenderer, h } from "vue"
import type { SessionMeta } from "@/api/piClient"
import type { QueuedPrompt } from "@/stores/session"
import { useSidebarSessionActions } from "@/components/workspace/sidebar/useSidebarSessionActions"
import { sidebarSessionRows, setSidebarSessionDragData } from "@/components/workspace/sidebar/useSidebarSessionOrdering"
import { sidebarQueueTitle } from "@/components/workspace/sidebar/useSidebarSessionStatus"

// A tiny Vue host exercises composable lifecycle without a browser or extra dependencies.
const renderer = createRenderer({
  createElement: () => ({}),
  createText: () => ({}),
  createComment: () => ({}),
  insert: () => {},
  remove: () => {},
  setText: () => {},
  setElementText: () => {},
  patchProp: () => {},
  parentNode: () => null,
  nextSibling: () => null,
})
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const unmount of cleanup.splice(0)) unmount()
  vi.useRealTimers()
})
const saved = (file = "one", extra: Partial<SessionMeta> = {}): SessionMeta => ({
  file,
  id: `id-${file}`,
  cwd: "project",
  mtimeMs: 0,
  title: file,
  ...extra,
})
function mountActions(overrides: Partial<Parameters<typeof useSidebarSessionActions>[0]> = {}) {
  const options = {
    label: (session: SessionMeta) => session.title || "Untitled",
    disabled: () => false,
    navigationDisabled: () => false,
    resume: vi.fn(),
    update: vi.fn(async () => {}),
    onError: vi.fn(),
    ...overrides,
  }
  let actions!: ReturnType<typeof useSidebarSessionActions>
  const app = renderer.createApp({
    setup() {
      actions = useSidebarSessionActions(options)
      return () => h("div")
    },
  })
  app.mount({})
  cleanup.push(() => app.unmount())
  return { actions, options, app }
}

test("one shared timer opens only the last clicked session, and double click renames without opening", () => {
  vi.useFakeTimers()
  const { actions, options } = mountActions()
  actions.openSession(saved("project"))
  actions.openSession(saved("projectless"))
  vi.advanceTimersByTime(249)
  expect(options.resume).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(options.resume).toHaveBeenCalledExactlyOnceWith(saved("projectless"))
  actions.openSession(saved())
  actions.openSession(saved())
  actions.renameOnDoubleClick(saved())
  vi.advanceTimersByTime(300)
  expect(options.resume).toHaveBeenCalledTimes(1)
  expect(actions.renaming.value).toEqual(saved())
  expect(actions.title.value).toBe("one")
})

test("double click cancels opening when navigation is busy; unmount clears a pending click", () => {
  vi.useFakeTimers()
  const { actions, options, app } = mountActions({ navigationDisabled: () => true })
  actions.openSession(saved())
  actions.renameOnDoubleClick(saved())
  vi.advanceTimersByTime(300)
  expect(options.resume).not.toHaveBeenCalled()
  expect(actions.renaming.value).toBeNull()
  actions.openSession(saved())
  app.unmount()
  vi.advanceTimersByTime(300)
  expect(options.resume).not.toHaveBeenCalled()
})

test("optimistic archive hides immediately, blocks duplicate requests and rolls back on failure", async () => {
  let reject!: (error: Error) => void
  const update = vi.fn(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail
      }),
  )
  const { actions, options } = mountActions({ update })
  const sessions = [saved("first"), saved("second"), saved("third")]
  const pending = actions.archive(sessions[1]!)
  expect(actions.archiving.value).toEqual({ second: true })
  expect(sidebarSessionRows(sessions, actions.archiving.value, "", s => s.title!)).toEqual([sessions[0], sessions[2]])
  await actions.archive(sessions[1]!)
  expect(update).toHaveBeenCalledExactlyOnceWith(sessions[1], "second", true)
  const error = new Error("archive failed")
  reject(error)
  await pending
  expect(options.onError).toHaveBeenCalledWith(error)
  expect(actions.archiving.value).toEqual({})
  expect(sidebarSessionRows(sessions, actions.archiving.value, "", s => s.title!)).toEqual(sessions)
})

test("busy archive does nothing; successful archive/restore preserves the existing title", async () => {
  const blocked = mountActions({ disabled: () => true })
  await blocked.actions.archive(saved())
  expect(blocked.options.update).not.toHaveBeenCalled()
  const { actions, options } = mountActions()
  await actions.archive(saved("draft", { title: null }))
  expect(options.update).toHaveBeenLastCalledWith(saved("draft", { title: null }), null, true)
  await actions.archive(saved("old", { archived: true }))
  expect(options.update).toHaveBeenLastCalledWith(saved("old", { archived: true }), "old", false)
  expect(actions.archiving.value).toEqual({})
})

test("rename trims the title, preserves archive state, blocks concurrent saves and stays open after failure", async () => {
  let finish!: () => void
  const update = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      }),
  )
  const { actions } = mountActions({ update })
  actions.rename(saved("old", { archived: true }))
  actions.title.value = "   "
  await actions.saveTitle()
  expect(update).not.toHaveBeenCalled()
  actions.title.value = " renamed "
  const pending = actions.saveTitle()
  expect(actions.saving.value).toBe(true)
  await actions.saveTitle()
  expect(update).toHaveBeenCalledExactlyOnceWith(saved("old", { archived: true }), "renamed", true)
  finish()
  await pending
  expect(actions.saving.value).toBe(false)
  expect(actions.renaming.value).toBeNull()
  const failed = mountActions({
    update: async () => {
      throw new Error("rename failed")
    },
  })
  failed.actions.rename(saved())
  await failed.actions.saveTitle()
  expect(failed.actions.renaming.value).toEqual(saved())
  expect(failed.actions.saving.value).toBe(false)
  expect(failed.options.onError).toHaveBeenCalledOnce()
})

test("search respects store order and excludes archived/optimistically hidden files without changing sortable order", () => {
  const sessions = [
    saved("third"),
    saved("first", { title: "SEARCH" }),
    saved("archived", { archived: true }),
    saved("hidden"),
  ]
  const archiving = { hidden: true }
  const label = (s: SessionMeta) => s.title!
  expect(sidebarSessionRows(sessions, archiving, "search", label).map(s => s.file)).toEqual(["first"])
  expect(sidebarSessionRows(sessions, archiving, "ID-THIRD", label).map(s => s.file)).toEqual(["third"])
  expect(sidebarSessionRows(sessions, archiving, "", label).map(s => s.file)).toEqual(["third", "first"])
})

test("native drag writes both PiX payloads and plain text, including runtime identity and group path", () => {
  const setData = vi.fn()
  const transfer = { setData, effectAllowed: "none" } as unknown as DataTransfer
  const item = { dataset: { file: "session.jsonl", path: "project-root" } } as unknown as HTMLElement
  setSidebarSessionDragData(transfer, item, () => "runtime-1")
  expect(transfer.effectAllowed).toBe("copyMove")
  expect(setData.mock.calls).toEqual([
    ["application/x-pix-session", "session.jsonl"],
    ["text/plain", "session.jsonl"],
    [
      "application/x-pix-session-drag",
      JSON.stringify({ file: "session.jsonl", path: "project-root", runtimeId: "runtime-1" }),
    ],
  ])
  setData.mockClear()
  setSidebarSessionDragData(transfer, item, () => undefined)
  expect(JSON.parse(setData.mock.calls[2]![1])).toEqual({ file: "session.jsonl", path: "project-root" })
  setData.mockClear()
  setSidebarSessionDragData(transfer, { dataset: { file: "session.jsonl" } } as HTMLElement, () => "unused")
  expect(setData).not.toHaveBeenCalled()
})

test("queue status counts down to the earliest scheduled item and catches up after suspension", () => {
  const title = (queue: QueuedPrompt[] | undefined, now = 1000) =>
    sidebarQueueTitle(queue, now, "Queued", time => `in ${time}`)
  expect(title(undefined)).toBe("Queued")
  expect(title([{ text: "manual" } as QueuedPrompt])).toBe("Queued")
  const queue = [{ sendAt: 121000 }, { sendAt: 62001 }, {}] as QueuedPrompt[]
  expect(title(queue)).toBe("Queued · in 01:02")
  expect(title(queue, 62001)).toBe("Queued · in 00:00")
  expect(title(queue, 200000)).toBe("Queued · in 00:00")
})
