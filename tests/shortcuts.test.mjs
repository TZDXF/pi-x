import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/lib/shortcuts.ts", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/export /g, "")

const expose = `
globalThis.api = {
  SHORTCUT_ACTION_DEFS, SHORTCUT_ACTION_IDS, LOCKED_SHORTCUTS,
  shortcutCombo, setShortcutOverride, resetAllShortcuts, isShortcutModified,
  resolveShortcut, findShortcutConflict, comboFromEvent, formatComboParts,
  dispatchShortcut, registerShortcutHandler, setShortcutsSuppressed, shortcutsSuppressed,
}`

function harness(stored) {
  let value = stored
  const context = vm.createContext({
    ref: initial => ({ value: initial }),
    readonly: value => value,
    computed: fn => ({
      get value() {
        return fn()
      },
    }),
    localStorage: {
      getItem: () => value,
      setItem: (_, next) => {
        value = next
      },
      removeItem: () => {
        value = null
      },
    },
  })
  vm.runInContext(
    ts.transpile(source + expose, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }),
    context,
  )
  return { api: context.api, storage: () => value }
}

function keyEvent(key, mods = {}, target = null) {
  return {
    key,
    ctrlKey: !!mods.ctrl,
    altKey: !!mods.alt,
    shiftKey: !!mods.shift,
    metaKey: !!mods.meta,
    isComposing: !!mods.composing,
    defaultPrevented: false,
    preventDefault() {},
    target,
  }
}

const editable = { closest: () => ({}) }
const plain = { closest: () => null }

test("defaults resolve and overrides persist to storage", () => {
  const { api, storage } = harness(null)
  expect(api.shortcutCombo("app.newSession")).toBe("ctrl+n")
  expect(api.isShortcutModified("app.newSession")).toBe(false)

  api.setShortcutOverride("app.newSession", "ctrl+alt+n")
  expect(api.shortcutCombo("app.newSession")).toBe("ctrl+alt+n")
  expect(api.isShortcutModified("app.newSession")).toBe(true)
  expect(JSON.parse(storage())).toEqual({ "app.newSession": "ctrl+alt+n" })

  // overrides load from storage on startup
  const reloaded = harness(JSON.stringify({ "app.newSession": "ctrl+alt+n", bogus: "x" }))
  expect(reloaded.api.shortcutCombo("app.newSession")).toBe("ctrl+alt+n")

  // resetting to the default removes the stored override
  api.setShortcutOverride("app.newSession", "ctrl+n")
  expect(api.isShortcutModified("app.newSession")).toBe(false)
  expect(storage()).toBe(null)

  api.setShortcutOverride("app.newSession", "ctrl+alt+n")
  api.resetAllShortcuts()
  expect(api.shortcutCombo("app.newSession")).toBe("ctrl+n")
  expect(storage()).toBe(null)
})

test("comboFromEvent normalizes modifiers, keys, IME and modifiers-only presses", () => {
  const { api } = harness(null)
  expect(api.comboFromEvent(keyEvent("E", { ctrl: true, shift: true }))).toBe("ctrl+shift+e")
  expect(api.comboFromEvent(keyEvent("ArrowUp", { alt: true }))).toBe("alt+arrowup")
  expect(api.comboFromEvent(keyEvent(" "))).toBe("space")
  expect(api.comboFromEvent(keyEvent("Escape"))).toBe("escape")
  expect(api.comboFromEvent(keyEvent("`", { ctrl: true }))).toBe("ctrl+`")
  expect(api.comboFromEvent(keyEvent("Shift"))).toBe(null)
  expect(api.comboFromEvent(keyEvent("e", { ctrl: true, composing: true }))).toBe(null)
})

test("dispatchShortcut resolves handlers and respects scope and suppression", () => {
  const { api } = harness(null)
  let sidebarHits = 0
  let editorHits = 0
  let stopHits = 0
  const offs = [
    api.registerShortcutHandler("sidebar.files", () => {
      sidebarHits++
    }),
    api.registerShortcutHandler("editor.attachFile", () => {
      editorHits++
    }),
    api.registerShortcutHandler("chat.stop", () => {
      stopHits++
    }),
  ]

  // sidebar action fires anywhere
  expect(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain))).toBe(true)
  expect(sidebarHits).toBe(1)

  // editor-scope action needs an editable target
  expect(api.dispatchShortcut(keyEvent("A", { ctrl: true, shift: true }, plain))).toBe(false)
  expect(editorHits).toBe(0)
  expect(api.dispatchShortcut(keyEvent("A", { ctrl: true, shift: true }, editable))).toBe(true)
  expect(editorHits).toBe(1)

  // bare keys never hijack typing, but Escape stays available
  expect(api.dispatchShortcut(keyEvent("a", {}, editable))).toBe(false)
  expect(api.dispatchShortcut(keyEvent("Escape", {}, editable))).toBe(true)
  expect(stopHits).toBe(1)

  // unbound combos do nothing
  expect(api.dispatchShortcut(keyEvent("k", { ctrl: true, alt: true }, plain))).toBe(false)

  // suppressed while a dialog is open
  api.setShortcutsSuppressed("chat-dialogs", true)
  expect(api.shortcutsSuppressed.value).toBe(true)
  expect(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain))).toBe(false)
  api.setShortcutsSuppressed("chat-dialogs", false)
  expect(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain))).toBe(true)
  expect(sidebarHits).toBe(2)

  offs.forEach(off => off())
  expect(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain))).toBe(false)
})

test("resolve and conflict detection cover custom bindings and locked keys", () => {
  const { api } = harness(null)
  expect(api.resolveShortcut("ctrl+shift+e")).toBe("sidebar.files")
  expect(api.findShortcutConflict("ctrl+shift+e")).toBe("sidebar.files")
  expect(api.findShortcutConflict("enter")).toBe("editor.send")
  expect(api.findShortcutConflict("shift+enter")).toBe("editor.newline")

  api.setShortcutOverride("sidebar.files", "ctrl+shift+x")
  expect(api.resolveShortcut("ctrl+shift+x")).toBe("sidebar.files")
  expect(api.resolveShortcut("ctrl+shift+e")).toBe(null)
  expect(api.findShortcutConflict("ctrl+shift+x", "sidebar.files")).toBe(null)
})

test("formatComboParts renders human-readable key segments", () => {
  const { api } = harness(null)
  expect([...api.formatComboParts("ctrl+shift+e")]).toEqual(["Ctrl", "Shift", "E"])
  expect([...api.formatComboParts("alt+arrowup")]).toEqual(["Alt", "↑"])
  expect([...api.formatComboParts("escape")]).toEqual(["Esc"])
  expect([...api.formatComboParts("ctrl+,")]).toEqual(["Ctrl", ","])
})
