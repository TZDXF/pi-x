import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"
const source = readFileSync(new URL("../src/lib/openWith.ts", import.meta.url), "utf8").replace(
  /^if \(import\.meta\.hot\).*$/m,
  "",
)
function harness(saved = null, desktop = true) {
  let stored = saved
  let failStorage = false
  const calls = [],
    listeners = {}
  const api = loadTsSource(source, {
    require: id =>
      id === "vue"
        ? { ref: value => ({ value }), readonly: value => value }
        : {
            isDesktop: desktop,
            invoke: async (command, args) => {
              calls.push({ command, args })
            },
          },
    localStorage: {
      getItem: () => stored,
      setItem: (_, value) => {
        if (failStorage) throw Error("blocked")
        stored = value
      },
    },
    window: {
      addEventListener: (name, fn) => {
        listeners[name] = fn
      },
    },
  })
  return {
    ...api,
    calls,
    stored: () => stored,
    failStorage: () => {
      failStorage = true
    },
    storage: value => {
      stored = value
      listeners.storage({ key: "pix.openWith" })
    },
  }
}
test("defaults safely and restores only valid editor preferences", () => {
  for (const value of [null, "{", '{"kind":"arbitrary-command"}'])
    expect(harness(value).openWithPreference.value.kind).toBe("vscode")
  expect(harness('{"kind":"cursor"}').openWithPreference.value.kind).toBe("cursor")
})
test("persists default and custom executable and synchronizes other windows", () => {
  const h = harness()
  h.setOpenWith("custom", " C:/Program Files/My IDE/ide.exe ")
  expect(JSON.parse(h.stored()).executable).toBe("C:/Program Files/My IDE/ide.exe")
  h.storage('{"kind":"system"}')
  expect(h.openWithPreference.value.kind).toBe("system")
  h.failStorage()
  expect(() => h.setOpenWith("cursor")).toThrow(/blocked/)
  expect(h.openWithPreference.value.kind).toBe("system")
})
test("passes the file and project separately without shell interpolation", async () => {
  const h = harness()
  h.setOpenWith("cursor")
  await h.openFileInEditor("src/file & 中文.ts", "C:/my project")
  expect(h.calls[0].command).toBe("open_in_editor")
  expect(h.calls[0].args.path).toBe("src/file & 中文.ts")
  expect(h.calls[0].args.project).toBe("C:/my project")
  expect(h.calls[0].args.kind).toBe("cursor")
  expect(h.calls[0].args.executable).toBe(null)
  h.setOpenWith("custom", "C:/ide.exe")
  await h.openFileInEditor("a.ts", "C:/project")
  expect(h.calls[1].args.executable).toBe("C:/ide.exe")
})
test("does not launch an editor from remote web mode", async () => {
  const h = harness(null, false)
  await expect(h.openFileInEditor("a.ts", "/project")).rejects.toThrow(/desktop/)
  expect(h.calls.length).toBe(0)
})
test("both split panes reuse the shared themed scrollbars", () => {
  const split = readFileSync(new URL("../src/components/ReviewSplitDiff.vue", import.meta.url), "utf8")
  expect((split.match(/<ScrollArea\s/g) ?? []).length).toBe(2)
  expect((split.match(/orientation="both"/g) ?? []).length).toBe(2)
  expect((split.match(/@viewport-scroll=/g) ?? []).length).toBe(2)
})
