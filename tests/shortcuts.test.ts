import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = readFileSync(new URL("../src/lib/shortcuts.ts", import.meta.url), "utf8")
  .replace(/^import .*$/gm, "")
  .replace(/export /g, "")

// Synchronous adapter double for shortcut behavior; config.json persistence is
// tested independently in config-preferences.test.ts.
const preferenceSource = readFileSync(new URL("../src/lib/localPreference.ts", import.meta.url), "utf8")
  .replace("createLocalPreference", "createConfigPreference")
  .replaceAll("options.key", "options.legacyKey")
  .replace(/^import .*$/gm, "")
  .replace(/if \(import\.meta\.hot\).*$/gm, "")
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
    ts.transpile(preferenceSource + source + expose, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }),
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

test("defaults resolve and overrides persist through the preference adapter", () => {
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
  expect(storage()).toBe("{}")

  api.setShortcutOverride("app.newSession", "ctrl+alt+n")
  api.resetAllShortcuts()
  expect(api.shortcutCombo("app.newSession")).toBe("ctrl+n")
  expect(storage()).toBe("{}")
})

test("comboFromEvent normalizes modifiers, keys, IME and modifiers-only presses", () => {
  const { api } = harness(null)
  expect(api.comboFromEvent(keyEvent("E", { ctrl: true, shift: true }))).toBe("ctrl+shift+e")
  expect(api.comboFromEvent(keyEvent("ArrowUp", { alt: true }))).toBe("alt+arrowup")
  expect(api.comboFromEvent(keyEvent(" "))).toBe("space")
  expect(api.comboFromEvent(keyEvent("Escape"))).toBe("escape")
  expect(api.comboFromEvent(keyEvent("`", { ctrl: true }))).toBe("ctrl+`")
  expect(api.comboFromEvent(keyEvent("toString"))).toBe("tostring")
  expect(api.comboFromEvent(keyEvent("constructor"))).toBe("constructor")
  expect(api.comboFromEvent(keyEvent("Shift"))).toBe(null)
  expect(api.comboFromEvent(keyEvent("e", { ctrl: true, composing: true }))).toBe(null)
})

test("invalid keyboard keys do not form or dispatch shortcuts", () => {
  const { api } = harness(null)
  let hits = 0
  api.registerShortcutHandler("app.searchTasks", () => hits++)

  for (const key of [undefined, null, "", 42, {}]) {
    const event = keyEvent(key, { ctrl: true })
    event.preventDefault = () => {
      throw new Error("Unmatched keyboard events must not be consumed")
    }
    expect(api.comboFromEvent(event)).toBe(null)
    expect(api.dispatchShortcut(event)).toBe(false)
  }
  expect(hits).toBe(0)
  expect(api.dispatchShortcut(keyEvent("k", { ctrl: true }))).toBe(true)
  expect(hits).toBe(1)
})

test("dispatchShortcut resolves handlers and respects scope and suppression", () => {
  const { api } = harness(null)
  let sidebarHits = 0
  let editorHits = 0
  let chatHits = 0
  const offs = [
    api.registerShortcutHandler("sidebar.files", () => {
      sidebarHits++
    }),
    api.registerShortcutHandler("editor.attachFile", () => {
      editorHits++
    }),
    api.registerShortcutHandler("chat.forkLast", () => {
      chatHits++
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

  // bare keys never hijack typing, and Escape no longer stops a run
  expect(api.dispatchShortcut(keyEvent("a", {}, editable))).toBe(false)
  expect(api.dispatchShortcut(keyEvent("Escape", {}, editable))).toBe(false)
  expect(api.dispatchShortcut(keyEvent("Escape", {}, plain))).toBe(false)
  expect(api.resolveShortcut("escape")).toBe(null)
  expect(chatHits).toBe(0)

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

test("the stop action exists but Esc is not bound to it", () => {
  const { api } = harness(null)
  // 回归（TZD-134）：动作与执行器保留，只是默认不再绑定 Esc。
  expect(api.SHORTCUT_ACTION_IDS).toContain("chat.stop")
  expect(api.shortcutCombo("chat.stop")).toBe("")
  expect(api.resolveShortcut("escape")).toBe(null)
  expect(api.resolveShortcut("")).toBe(null)
  expect(Object.keys(api.SHORTCUT_ACTION_DEFS).filter(id => api.SHORTCUT_ACTION_DEFS[id].default === "escape")).toEqual(
    [],
  )

  // 派发层：默认状态按 Esc 不消费、不触发任何处理器。
  let stopHits = 0
  api.registerShortcutHandler("chat.stop", () => {
    stopHits++
  })
  expect(api.dispatchShortcut(keyEvent("Escape", {}, editable))).toBe(false)
  expect(api.dispatchShortcut(keyEvent("Escape", {}, plain))).toBe(false)
  expect(stopHits).toBe(0)

  // 执行器仍在：聊天视图注册了 chat.stop，停止按钮也仍调用 abort()。
  const chatView = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  expect(chatView).toMatch(/registerShortcutHandler\("chat\.stop"/)
  const composer = readFileSync(new URL("../src/components/chat/ChatComposer.vue", import.meta.url), "utf8")
  expect(composer).toMatch(/@click="showStopButton && abort\(\)"/)
})

test("a saved non-Esc stop binding keeps working and Esc can never be bound", () => {
  // 旧版本保存的偏好（Esc 从未被保存过，但一旦被手改/历史遗留要拦住）。
  const { api, storage } = harness(JSON.stringify({ "chat.stop": "ctrl+alt+k", "sidebar.files": "ctrl+shift+x" }))
  expect(api.shortcutCombo("chat.stop")).toBe("ctrl+alt+k")
  expect(api.isShortcutModified("chat.stop")).toBe(true)
  expect(api.resolveShortcut("ctrl+alt+k")).toBe("chat.stop")

  let stopHits = 0
  api.registerShortcutHandler("chat.stop", () => {
    stopHits++
  })
  // 会话流式中焦点常在输入框：录制出来的带修饰键组合仍要生效。
  expect(api.dispatchShortcut(keyEvent("K", { ctrl: true, alt: true }, editable))).toBe(true)
  expect(api.dispatchShortcut(keyEvent("k", { ctrl: true, alt: true }, plain))).toBe(true)
  expect(stopHits).toBe(2)

  // 存储里的 escape 变体不会生效，也不会被回写成绑定。
  const escapeStored = harness(JSON.stringify({ "chat.stop": "escape" }))
  expect(escapeStored.api.shortcutCombo("chat.stop")).toBe("")
  expect(escapeStored.api.resolveShortcut("escape")).toBe(null)
  expect(escapeStored.storage()).toBe(JSON.stringify({ "chat.stop": "escape" }))
  expect(escapeStored.api.dispatchShortcut(keyEvent("Escape", {}, editable))).toBe(false)

  // 界面录制 Esc 无法写入绑定：回到未绑定，而不是回到 Esc。
  api.setShortcutOverride("chat.stop", "escape")
  expect(api.shortcutCombo("chat.stop")).toBe("")
  expect(JSON.parse(storage())).toEqual({ "sidebar.files": "ctrl+shift+x" })
  expect(JSON.parse(storage())).not.toHaveProperty("chat.stop")
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

test("task search supports Ctrl+K, rebinding, modal suppression and cleanup", () => {
  const { api } = harness(null)
  let calls = 0
  const off = api.registerShortcutHandler("app.searchTasks", () => calls++)
  expect(api.shortcutCombo("app.searchTasks")).toBe("ctrl+k")
  expect(api.dispatchShortcut(keyEvent("k", { ctrl: true }, editable))).toBe(true)
  expect(calls).toBe(1)
  api.setShortcutsSuppressed("task-search", true)
  expect(api.dispatchShortcut(keyEvent("k", { ctrl: true }))).toBe(false)
  api.setShortcutsSuppressed("task-search", false)
  api.setShortcutOverride("app.searchTasks", "ctrl+shift+k")
  expect(api.dispatchShortcut(keyEvent("k", { ctrl: true }))).toBe(false)
  expect(api.dispatchShortcut(keyEvent("K", { ctrl: true, shift: true }))).toBe(true)
  expect(calls).toBe(2)
  off()
  expect(api.dispatchShortcut(keyEvent("K", { ctrl: true, shift: true }))).toBe(false)
})
