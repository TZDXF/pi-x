import { afterEach, expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"
import { chatSource } from "./fixtures/chatSources"

// 与 workspace-sidebar-components.test.ts 一样，编译真实 SFC 并挂到最小 Vue host。
// Node 环境没有原生光标/选区；这里验证真实模板的事件默认行为与组件生命周期。
const button = {
  setup:
    (_, { attrs, slots }) =>
    () =>
      vue.h("button", attrs, slots.default?.()),
}
const textarea = {
  props: ["modelValue"],
  emits: ["update:modelValue"],
  setup:
    (props, { attrs, emit }) =>
    () =>
      vue.h("textarea", {
        ...attrs,
        value: props.modelValue,
        onInput: event => emit("update:modelValue", event.target.value),
      }),
}
const { descriptor } = parse(chatSource("components/chat/ConversationSelectionPopup.vue"))
const compiled = compileScript(descriptor, { id: "selection-popup-test", inlineTemplate: true })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const imports = {
  vue,
  "vue-i18n": { useI18n: () => ({ t: key => key }) },
  "@lucide/vue": { Check: () => vue.h("svg"), Trash2: () => vue.h("svg") },
  "@/components/ui/button": { Button: button },
  "@/components/ui/textarea": { Textarea: textarea },
}
const exports = {} as any
new Function("exports", "require", code)(exports, id => imports[id])

function node(tag = "root", text = "") {
  return vue.markRaw({
    tag,
    text,
    props: {} as any,
    parent: null as any,
    children: [] as any[],
    focus: vi.fn(),
    contains(target) {
      for (let current = target; current; current = current.parent) if (current === this) return true
      return false
    },
    querySelector(tag) {
      return descendants(this).find(child => child.tag === tag) ?? null
    },
  })
}
function descendants(root) {
  return root.children.flatMap(child => [child, ...descendants(child)])
}
const renderer = vue.createRenderer({
  createElement: tag => node(tag),
  createText: text => node("text", text),
  createComment: text => node("comment", text),
  insert(child, parent, anchor) {
    if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
    const index = anchor ? parent.children.indexOf(anchor) : -1
    parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
    child.parent = parent
  },
  remove(child) {
    child.parent?.children.splice(child.parent.children.indexOf(child), 1)
    child.parent = null
  },
  setText: (node, text) => {
    node.text = text
  },
  setElementText: (node, text) => {
    node.text = text
  },
  parentNode: node => node.parent,
  nextSibling: node => {
    const siblings = node.parent?.children ?? []
    return siblings[siblings.indexOf(node) + 1] ?? null
  },
  patchProp: (node, key, _previous, value) => {
    node.props[key] = value
  },
})
const apps = []
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount())
  vi.unstubAllGlobals()
})

async function harness() {
  const listeners = new Map()
  const document = {
    addEventListener: vi.fn((name, listener) => listeners.set(name, listener)),
    removeEventListener: vi.fn((name, listener) => {
      if (listeners.get(name) === listener) listeners.delete(name)
    }),
  }
  vi.stubGlobal("document", document)
  vi.stubGlobal("window", { innerWidth: 1024, innerHeight: 768 })
  const state = vue.ref({ comment: "initial comment", anchor: { left: 30, top: 40, bottom: 60 } })
  const save = vi.fn(),
    remove = vi.fn(),
    cancel = vi.fn()
  const app = renderer.createApp({
    setup: () => () => vue.h(exports.default, { state: state.value, onSave: save, onRemove: remove, onCancel: cancel }),
  })
  apps.push(app)
  const root = node()
  app.mount(root)
  await vue.nextTick()
  function mousedown(target) {
    const event = { target, preventDefault: vi.fn(), stopPropagation: vi.fn() }
    for (let current = target; current; current = current.parent) current.props.onMousedown?.(event)
    listeners.get("mousedown")?.(event)
    return event
  }
  const input = () => descendants(root).find(child => child.tag === "textarea")
  const buttons = () => descendants(root).filter(child => child.tag === "button")
  return { app, root, state, input, buttons, save, remove, cancel, document, listeners, mousedown }
}

test("textarea mousedown remains native while save/remove alone prevent selection loss", async () => {
  const h = await harness()
  expect(h.input().focus).toHaveBeenCalledOnce()
  expect(h.input().props.value).toBe("initial comment")
  expect(h.mousedown(h.input()).preventDefault).not.toHaveBeenCalled()
  expect(h.mousedown(h.root.children[0]).preventDefault).not.toHaveBeenCalled()
  for (const button of h.buttons()) {
    // 点击按钮内的图标也通过冒泡保留选区。
    const event = h.mousedown(button.children[0])
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(event.stopPropagation).not.toHaveBeenCalled()
  }
  expect(h.cancel).not.toHaveBeenCalled()
})

test("input edits are saved and delete still emits remove without outside cancellation", async () => {
  const h = await harness()
  h.input().props.onInput({ target: { value: "edited comment" } })
  await vue.nextTick()
  const [remove, save] = h.buttons()
  h.mousedown(save)
  save.props.onClick()
  expect(h.save).toHaveBeenCalledExactlyOnceWith("edited comment")
  h.mousedown(remove)
  remove.props.onClick()
  expect(h.remove).toHaveBeenCalledOnce()
  expect(h.cancel).not.toHaveBeenCalled()
})

test("outside mousedown cancels, inactive popup ignores it, and unmount removes the listener", async () => {
  const h = await harness()
  const event = h.mousedown(node("outside"))
  expect(event.preventDefault).not.toHaveBeenCalled()
  expect(h.cancel).toHaveBeenCalledOnce()
  h.state.value = null
  await vue.nextTick()
  h.mousedown(node("outside"))
  expect(h.cancel).toHaveBeenCalledOnce()
  const listener = h.listeners.get("mousedown")
  h.app.unmount()
  apps.splice(apps.indexOf(h.app), 1)
  expect(h.document.removeEventListener).toHaveBeenCalledWith("mousedown", listener)
  expect(h.listeners.has("mousedown")).toBe(false)
})

test("Escape cancels and Ctrl/Meta Enter save the current draft", async () => {
  const h = await harness()
  h.input().props.onInput({ target: { value: "keyboard comment" } })
  await vue.nextTick()
  const escape = { key: "Escape", stopPropagation: vi.fn(), preventDefault: vi.fn() }
  h.input().props.onKeydown.forEach(handler => handler(escape))
  expect(escape.stopPropagation).toHaveBeenCalledOnce()
  expect(h.cancel).toHaveBeenCalledOnce()
  for (const modifier of ["ctrlKey", "metaKey"]) {
    const event = { key: "Enter", [modifier]: true, stopPropagation: vi.fn(), preventDefault: vi.fn() }
    h.input().props.onKeydown.forEach(handler => handler(event))
    expect(event.preventDefault).toHaveBeenCalledOnce()
  }
  expect(h.save).toHaveBeenCalledTimes(2)
  expect(h.save).toHaveBeenLastCalledWith("keyboard comment")
})
