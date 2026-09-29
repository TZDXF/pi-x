import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"

// The bridge is executed against a stub DOM so the inspect wiring is
// exercised end to end: enabling the mode must actually register the
// pointer handlers, and clicks/drags must report `selected` to the panel.
const bridgeSource = readFileSync(new URL("../src-tauri/src/preview_bridge.js", import.meta.url), "utf8")

function makeElement(name = "div") {
  const children = []
  return {
    nodeName: name.toUpperCase(),
    tagName: name.toUpperCase(),
    nodeType: 1,
    style: {},
    dataset: {},
    children,
    firstChild: null,
    textContent: "",
    innerText: "",
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) {
      children.push(child)
      if (!this.firstChild) this.firstChild = child
      return child
    },
    querySelector: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 30 }),
  }
}

function makeEnvironment() {
  const listeners = {}
  const posted = []
  const track = prefix => (type, fn) => {
    ;(listeners[`${prefix}:${type}`] ??= []).push(fn)
  }
  const untrack = prefix => (type, fn) => {
    const list = listeners[`${prefix}:${type}`]
    if (!list) return
    const index = list.indexOf(fn)
    if (index >= 0) list.splice(index, 1)
  }
  const documentElement = makeElement("html")
  const document = {
    documentElement,
    body: makeElement("body"),
    title: "Stub page",
    readyState: "complete",
    createElement: name => makeElement(name),
    addEventListener: track("document"),
    removeEventListener: untrack("document"),
    querySelector: () => null,
  }
  const win = {
    window: null,
    parent: {
      postMessage(message) {
        posted.push(message)
      },
    },
    document,
    location: { href: "http://127.0.0.1:9/p/s/http/localhost:5173/", protocol: "http:", host: "127.0.0.1:9" },
    history: { pushState() {}, replaceState() {}, back() {}, forward() {} },
    __pixPreviewBase: "/p/s/http/localhost:5173",
    scrollX: 5,
    scrollY: 7,
    URL,
    setTimeout,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
    fetch: () => {},
    XMLHttpRequest: function XMLHttpRequest() {},
    addEventListener: track("window"),
    removeEventListener: untrack("window"),
  }
  win.XMLHttpRequest.prototype.open = function () {}
  win.window = win
  return { win, listeners, posted }
}

function dispatch(env, type, event) {
  for (const handler of env.listeners[`document:${type}`] ?? []) handler(event)
  for (const handler of env.listeners[`window:${type}`] ?? []) handler(event)
}

function pageMessage(env, data) {
  dispatch(env, "message", { data, origin: "http://127.0.0.1:9" })
}

function clickTarget() {
  const target = makeElement("button")
  target.innerText = "Save"
  return target
}

const noopEvent = { preventDefault() {}, stopPropagation() {} }

test("bridge reports ready and navigated to the panel", () => {
  const env = makeEnvironment()
  vm.createContext(env.win)
  vm.runInContext(bridgeSource, env.win)
  expect(env.posted.map(message => message.type)).toEqual(["navigated", "ready"])
  expect(env.posted[0].source).toBe("pix-preview")
  expect(env.posted[0].url).toBe("http://127.0.0.1:9/p/s/http/localhost:5173/")
})

test("enabling inspect registers pointer handlers and clicks report pins", () => {
  const env = makeEnvironment()
  vm.createContext(env.win)
  vm.runInContext(bridgeSource, env.win)

  pageMessage(env, { target: "pix-preview-page", type: "inspect", enabled: true })
  expect(env.listeners["document:mousemove"]).toBeTruthy()
  expect(env.listeners["document:mousedown"]).toBeTruthy()
  expect(env.listeners["document:mouseup"]).toBeTruthy()

  const target = clickTarget()
  dispatch(env, "mousemove", { target, pageX: 12, pageY: 14 })
  dispatch(env, "mousedown", { ...noopEvent, button: 0, target, pageX: 12, pageY: 14 })
  dispatch(env, "mouseup", { ...noopEvent, target, pageX: 13, pageY: 15 })

  const selected = env.posted.find(message => message.type === "selected")
  expect(selected).toBeTruthy()
  // JSON round-trip: the bridge runs in a VM realm whose object prototypes
  // differ from the host's, which deepStrictEqual would reject.
  const selection = JSON.parse(JSON.stringify(selected))
  expect(selection.pin.selector).toBe("button:nth-of-type(1)")
  expect(selection.pin.text).toBe("Save")
  // Document coordinates include the scroll offset.
  expect(selection.pin.rect).toEqual({ x: 15, y: 27, width: 100, height: 30 })
})

test("dragging beyond the threshold reports an area selection", () => {
  const env = makeEnvironment()
  vm.createContext(env.win)
  vm.runInContext(bridgeSource, env.win)
  pageMessage(env, { target: "pix-preview-page", type: "inspect", enabled: true })

  const target = clickTarget()
  dispatch(env, "mousedown", { ...noopEvent, button: 0, target, pageX: 10, pageY: 10 })
  dispatch(env, "mousemove", { target, pageX: 60, pageY: 80 })
  dispatch(env, "mouseup", { ...noopEvent, target, pageX: 60, pageY: 80 })

  const selected = env.posted.find(message => message.type === "selected")
  expect(selected).toBeTruthy()
  const selection = JSON.parse(JSON.stringify(selected))
  expect(selection.pin).toBe(undefined)
  expect(selection.area.rect).toEqual({ x: 10, y: 10, width: 50, height: 70 })
})

test("disabling inspect removes the pointer handlers", () => {
  const env = makeEnvironment()
  vm.createContext(env.win)
  vm.runInContext(bridgeSource, env.win)
  pageMessage(env, { target: "pix-preview-page", type: "inspect", enabled: true })
  pageMessage(env, { target: "pix-preview-page", type: "inspect", enabled: false })
  expect((env.listeners["document:mousemove"] ?? []).length).toBe(0)
  expect((env.listeners["document:mousedown"] ?? []).length).toBe(0)
  expect((env.listeners["document:mouseup"] ?? []).length).toBe(0)
})

test("messages without the page target are ignored", () => {
  const env = makeEnvironment()
  vm.createContext(env.win)
  vm.runInContext(bridgeSource, env.win)
  // Would call history.back() if the guard failed.
  pageMessage(env, { source: "pix-preview", type: "back" })
  pageMessage(env, { type: "inspect", enabled: true })
  expect(env.listeners["document:mousedown"]).toBe(undefined)
})

test("panel posts plain JSON payloads so structured clone accepts them", () => {
  const panel = readFileSync(new URL("../src/components/browser/BrowserPanel.vue", import.meta.url), "utf8")
  const postToPage = panel.match(/function postToPage\(message: BridgeOutbound\) \{([\s\S]*?)\n\}/)
  expect(postToPage).toBeTruthy()
  expect(postToPage[1]).toMatch(/JSON\.parse\(JSON\.stringify\(message\)\)/)
  expect(postToPage[1]).not.toMatch(/postMessage\(message\b/)

  // The failure mode: payloads built from deep-ref values are reactive
  // proxies, and postMessage's structured clone rejects proxies outright.
  const raw = {
    rect: { x: 1, y: 2, width: 3, height: 4 },
    pin: { selector: "#save", text: "Save", rect: { x: 1, y: 2, width: 3, height: 4 } },
  }
  const proxied = new Proxy(raw, {})
  expect(() => structuredClone(proxied)).toThrow(/could not be cloned/)
  const flattened = JSON.parse(JSON.stringify(proxied))
  expect(flattened).toEqual(JSON.parse(JSON.stringify(raw)))
})
