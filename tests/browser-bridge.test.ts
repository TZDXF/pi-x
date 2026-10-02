import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { markRaw, ref } from "vue"
import { bridgeAddMarker, bridgeCommand } from "@/lib/previewBridge"
import { toProxyUrl } from "@/lib/previewUrl"
import { pageUrlFromProxy, useBrowserBridge } from "@/composables/browser/useBrowserBridge"
import { mountBrowserComposable } from "./browserTestHarness"

const base = "http://127.0.0.1:9000/p/secret"
const target = "http://localhost:5173/app?q=1"
const pin = { selector: "button", text: "Save", rect: { x: 1, y: 2, width: 30, height: 20 } }
let listener: ((event: MessageEvent) => void) | undefined
let unmount: (() => void) | undefined
beforeEach(() => {
  vi.stubGlobal("window", {
    addEventListener: vi.fn((_type: string, fn: (event: MessageEvent) => void) => {
      listener = fn
    }),
    removeEventListener: vi.fn(),
  })
})
afterEach(() => {
  unmount?.()
  listener = undefined
  vi.unstubAllGlobals()
})

function setup(opaque = false) {
  const options = {
    iframeRef: ref<HTMLIFrameElement | null>(null),
    directMode: ref(false),
    proxyBase: ref<string | null>(base),
    sandboxAttr: ref(opaque ? "allow-scripts" : "allow-scripts allow-same-origin"),
    onNavigated: vi.fn(),
    onConsole: vi.fn(),
    onSelected: vi.fn(),
    onLoad: vi.fn(),
  }
  const contentWindow = { postMessage: vi.fn() }
  const mounted = mountBrowserComposable(() => useBrowserBridge(options))
  unmount = mounted.unmount
  options.iframeRef.value = markRaw({ contentWindow }) as unknown as HTMLIFrameElement
  function receive(data: unknown, origin = opaque ? "null" : new URL(base).origin, source: unknown = contentWindow) {
    listener?.({ data, origin, source } as MessageEvent)
  }
  return { bridge: mounted.result, options, contentWindow, receive }
}

test("reverse proxy URLs preserve query/hash and reject foreign namespace/capability/scheme", () => {
  const proxied = toProxyUrl(base, target) + "#section"
  expect(pageUrlFromProxy(base, proxied)).toBe(target + "#section")
  expect(pageUrlFromProxy(base, proxied.replace("127.0.0.1:9000", "evil.example"))).toBeNull()
  expect(pageUrlFromProxy(base, proxied.replace("/p/", "/other/"))).toBeNull()
  expect(pageUrlFromProxy(base, proxied.replace(/\/p\/[^/]+\//, "/p/wrong/"))).toBeNull()
  expect(pageUrlFromProxy(base, proxied.replace("/http/", "/javascript/"))).toBeNull()
  expect(pageUrlFromProxy(base, "not a URL")).toBeNull()
  const remote = "https://remote.example/api/preview/secret"
  expect(pageUrlFromProxy(remote, toProxyUrl(remote, "https://example.org/"))).toBe("https://example.org/")
})

test("bridge requires this iframe, expected origin, contract source and well-formed data", () => {
  const { receive, options } = setup()
  const selected = { source: "pix-preview", type: "selected", pin }
  receive(selected, "http://evil.example")
  receive(selected, "null")
  receive(selected, undefined, {})
  receive({ ...selected, source: "foreign" })
  receive({ ...selected, pin: { ...pin, rect: { x: "bad" } } })
  receive({ source: "pix-preview", type: "console", level: "fatal", text: "bad" })
  receive({ source: "pix-preview", type: "navigated", url: "https://evil.example", title: "bad" })
  expect(options.onSelected).not.toHaveBeenCalled()
  expect(options.onConsole).not.toHaveBeenCalled()
  expect(options.onNavigated).not.toHaveBeenCalled()
  receive(selected)
  receive({ source: "pix-preview", type: "console", level: "error", text: "failed" })
  receive({ source: "pix-preview", type: "navigated", url: toProxyUrl(base, target), title: "Page" })
  expect(options.onSelected).toHaveBeenCalledWith(selected)
  expect(options.onConsole).toHaveBeenCalledWith("error", "failed")
  expect(options.onNavigated).toHaveBeenCalledWith(target, "Page")
})

test("opaque remote sandbox accepts only null origin from its iframe and sends cloned JSON to that iframe", () => {
  const { bridge, receive, options, contentWindow } = setup(true)
  receive({ source: "pix-preview", type: "console", level: "log", text: "opaque" })
  expect(options.onConsole).toHaveBeenCalledWith("log", "opaque")
  receive({ source: "pix-preview", type: "console", level: "log", text: "wrong origin" }, new URL(base).origin)
  expect(options.onConsole).toHaveBeenCalledTimes(1)
  const marker = ref({ id: "a", kind: "pin" as const, number: 1, rect: pin.rect, pin })
  bridge.postToPage(bridgeAddMarker(marker.value))
  const [message, origin] = contentWindow.postMessage.mock.calls[0]
  expect(origin).toBe("*")
  expect(message.annotation).toEqual(marker.value)
  expect(message.annotation).not.toBe(marker.value)
  expect(() => structuredClone(message)).not.toThrow()
})

test("normal proxy has explicit targetOrigin, while direct mode or absent proxy disables both directions", () => {
  const { bridge, options, contentWindow, receive } = setup()
  bridge.postToPage(bridgeCommand("back"))
  expect(contentWindow.postMessage).toHaveBeenCalledWith(bridgeCommand("back"), new URL(base).origin)
  options.directMode.value = true
  bridge.postToPage(bridgeCommand("forward"))
  receive({ source: "pix-preview", type: "selected", pin })
  expect(contentWindow.postMessage).toHaveBeenCalledTimes(1)
  expect(options.onSelected).not.toHaveBeenCalled()
  options.directMode.value = false
  options.proxyBase.value = null
  bridge.postToPage(bridgeCommand("reload"))
  receive({ source: "pix-preview", type: "selected", pin })
  expect(contentWindow.postMessage).toHaveBeenCalledTimes(1)
  expect(options.onSelected).not.toHaveBeenCalled()
  bridge.onIframeLoad()
  expect(options.onLoad).toHaveBeenCalledTimes(1)
  const savedListener = listener
  unmount?.()
  unmount = undefined
  expect(window.removeEventListener).toHaveBeenCalledWith("message", savedListener)
})
