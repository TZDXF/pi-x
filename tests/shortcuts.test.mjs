import test from "node:test"
import assert from "node:assert/strict"
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
  assert.equal(api.shortcutCombo("app.newSession"), "ctrl+n")
  assert.equal(api.isShortcutModified("app.newSession"), false)

  api.setShortcutOverride("app.newSession", "ctrl+alt+n")
  assert.equal(api.shortcutCombo("app.newSession"), "ctrl+alt+n")
  assert.equal(api.isShortcutModified("app.newSession"), true)
  assert.deepEqual(JSON.parse(storage()), { "app.newSession": "ctrl+alt+n" })

  // overrides load from storage on startup
  const reloaded = harness(JSON.stringify({ "app.newSession": "ctrl+alt+n", bogus: "x" }))
  assert.equal(reloaded.api.shortcutCombo("app.newSession"), "ctrl+alt+n")

  // resetting to the default removes the stored override
  api.setShortcutOverride("app.newSession", "ctrl+n")
  assert.equal(api.isShortcutModified("app.newSession"), false)
  assert.equal(storage(), null)

  api.setShortcutOverride("app.newSession", "ctrl+alt+n")
  api.resetAllShortcuts()
  assert.equal(api.shortcutCombo("app.newSession"), "ctrl+n")
  assert.equal(storage(), null)
})

test("comboFromEvent normalizes modifiers, keys, IME and modifiers-only presses", () => {
  const { api } = harness(null)
  assert.equal(api.comboFromEvent(keyEvent("E", { ctrl: true, shift: true })), "ctrl+shift+e")
  assert.equal(api.comboFromEvent(keyEvent("ArrowUp", { alt: true })), "alt+arrowup")
  assert.equal(api.comboFromEvent(keyEvent(" ")), "space")
  assert.equal(api.comboFromEvent(keyEvent("Escape")), "escape")
  assert.equal(api.comboFromEvent(keyEvent("`", { ctrl: true })), "ctrl+`")
  assert.equal(api.comboFromEvent(keyEvent("Shift")), null)
  assert.equal(api.comboFromEvent(keyEvent("e", { ctrl: true, composing: true })), null)
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
  assert.equal(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain)), true)
  assert.equal(sidebarHits, 1)

  // editor-scope action needs an editable target
  assert.equal(api.dispatchShortcut(keyEvent("A", { ctrl: true, shift: true }, plain)), false)
  assert.equal(editorHits, 0)
  assert.equal(api.dispatchShortcut(keyEvent("A", { ctrl: true, shift: true }, editable)), true)
  assert.equal(editorHits, 1)

  // bare keys never hijack typing, but Escape stays available
  assert.equal(api.dispatchShortcut(keyEvent("a", {}, editable)), false)
  assert.equal(api.dispatchShortcut(keyEvent("Escape", {}, editable)), true)
  assert.equal(stopHits, 1)

  // unbound combos do nothing
  assert.equal(api.dispatchShortcut(keyEvent("k", { ctrl: true, alt: true }, plain)), false)

  // suppressed while a dialog is open
  api.setShortcutsSuppressed("chat-dialogs", true)
  assert.equal(api.shortcutsSuppressed.value, true)
  assert.equal(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain)), false)
  api.setShortcutsSuppressed("chat-dialogs", false)
  assert.equal(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain)), true)
  assert.equal(sidebarHits, 2)

  offs.forEach(off => off())
  assert.equal(api.dispatchShortcut(keyEvent("E", { ctrl: true, shift: true }, plain)), false)
})

test("resolve and conflict detection cover custom bindings and locked keys", () => {
  const { api } = harness(null)
  assert.equal(api.resolveShortcut("ctrl+shift+e"), "sidebar.files")
  assert.equal(api.findShortcutConflict("ctrl+shift+e"), "sidebar.files")
  assert.equal(api.findShortcutConflict("enter"), "editor.send")
  assert.equal(api.findShortcutConflict("shift+enter"), "editor.newline")

  api.setShortcutOverride("sidebar.files", "ctrl+shift+x")
  assert.equal(api.resolveShortcut("ctrl+shift+x"), "sidebar.files")
  assert.equal(api.resolveShortcut("ctrl+shift+e"), null)
  assert.equal(api.findShortcutConflict("ctrl+shift+x", "sidebar.files"), null)
})

test("formatComboParts renders human-readable key segments", () => {
  const { api } = harness(null)
  assert.deepEqual([...api.formatComboParts("ctrl+shift+e")], ["Ctrl", "Shift", "E"])
  assert.deepEqual([...api.formatComboParts("alt+arrowup")], ["Alt", "↑"])
  assert.deepEqual([...api.formatComboParts("escape")], ["Esc"])
  assert.deepEqual([...api.formatComboParts("ctrl+,")], ["Ctrl", ","])
})
