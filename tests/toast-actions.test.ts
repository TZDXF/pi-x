import { readFileSync } from "node:fs"
import vm from "node:vm"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import * as vue from "vue"
import { createPinia, defineStore, setActivePinia } from "pinia"
import ts from "typescript"
import type { createUiStore as createUiStoreType } from "@/stores/ui"
import { notifySessionArchived } from "@/lib/sessionArchiveToast"

// Load the real store with only its external RPC/notification dependencies stubbed.
const source = readFileSync(new URL("../src/stores/ui.ts", import.meta.url), "utf8")
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText
const module = { exports: {} as { createUiStore: typeof createUiStoreType } }
vm.runInNewContext(code, {
  exports: module.exports,
  require: (id: string) => {
    if (id === "vue") return vue
    if (id === "pinia") return { defineStore }
    if (id === "@/i18n") return { tBackendError: (message: string) => message }
    if (id === "@/api/piClient") return { rpcNotify: vi.fn() }
    if (id === "@/lib/notifications") return { notifyQuestion: vi.fn() }
    throw new Error(`Unexpected import: ${id}`)
  },
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
})

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

test("archive toast localizes its message and undo button, and expires after ten seconds", () => {
  const ui = module.exports.createUiStore()()
  notifySessionArchived(ui, key => `translated:${key}`, vi.fn())
  expect(ui.toasts[0]).toMatchObject({
    message: "translated:workspace.sessionArchived",
    kind: "info",
    action: { label: "translated:workspace.undoArchive" },
  })
  ui.pushToast("Ordinary notice")
  vi.advanceTimersByTime(5000)
  expect(ui.toasts).toHaveLength(1)
  vi.advanceTimersByTime(5000)
  expect(ui.toasts).toHaveLength(0)
})

test("undo runs once, stays available while pending and dismisses only its own toast on success", async () => {
  const ui = module.exports.createUiStore()()
  let finish!: () => void
  const restore = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      }),
  )
  notifySessionArchived(ui, key => key, restore)
  const id = ui.toasts[0]!.id
  const pending = ui.runToastAction(id)
  await ui.runToastAction(id)
  expect(restore).toHaveBeenCalledOnce()
  expect(ui.toasts[0]!.pending).toBe(true)
  vi.advanceTimersByTime(10000)
  expect(ui.toasts).toHaveLength(1)
  ui.pushToast("Another notification")
  finish()
  await pending
  expect(ui.toasts.map(toast => toast.message)).toEqual(["Another notification"])
  await ui.runToastAction(id)
  expect(restore).toHaveBeenCalledOnce()
})

test("failed undo displays an error and allows retry before expiring", async () => {
  const ui = module.exports.createUiStore()()
  const restore = vi.fn().mockRejectedValueOnce(new Error("Restore failed")).mockResolvedValueOnce(undefined)
  notifySessionArchived(ui, key => key, restore)
  const id = ui.toasts[0]!.id
  await ui.runToastAction(id)
  expect(ui.toasts[0]!.pending).toBe(false)
  expect(ui.toasts[1]).toMatchObject({ message: "Error: Restore failed", kind: "error" })
  vi.advanceTimersByTime(5000)
  await ui.runToastAction(id)
  expect(restore).toHaveBeenCalledTimes(2)
  expect(ui.toasts).toHaveLength(0)
})

test("an expired archive action cannot restore a session", async () => {
  const ui = module.exports.createUiStore()()
  const restore = vi.fn()
  notifySessionArchived(ui, key => key, restore)
  const id = ui.toasts[0]!.id
  vi.advanceTimersByTime(10000)
  await ui.runToastAction(id)
  expect(restore).not.toHaveBeenCalled()
})
