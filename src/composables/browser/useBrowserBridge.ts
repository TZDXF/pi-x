import { onMounted, onBeforeUnmount, type Ref } from "vue"
import { isBridgeInbound, type BridgeInbound, type BridgeOutbound } from "@/lib/previewBridge"
import { toProxyUrl } from "@/lib/previewUrl"

/** Reverse only URLs in this proxy namespace, including its per-host capability token. */
export function pageUrlFromProxy(base: string, proxiedUrl: string): string | null {
  try {
    const proxy = new URL(base)
    const page = new URL(proxiedUrl)
    if (page.origin !== proxy.origin) return null
    const prefix = proxy.pathname.replace(/\/$/, "").replace(/\/[^/]+$/, "")
    if (!page.pathname.startsWith(`${prefix}/`)) return null
    const [token, scheme, host, ...path] = page.pathname.slice(prefix.length + 1).split("/")
    if (!token || !host || (scheme !== "http" && scheme !== "https")) return null
    const target = `${scheme}://${host}/${path.join("/")}${page.search}${page.hash}`
    // Reject URLs outside the capability namespace (and authority tricks in host).
    const expected = new URL(toProxyUrl(base, target))
    if (expected.pathname !== page.pathname || expected.search !== page.search) return null
    return target
  } catch {
    return null
  }
}

interface BridgeOptions {
  iframeRef: Ref<HTMLIFrameElement | null>
  directMode: Ref<boolean>
  proxyBase: Ref<string | null>
  sandboxAttr: Ref<string | undefined>
  onNavigated: (url: string, title: string) => void
  onConsole: (level: Extract<BridgeInbound, { type: "console" }>["level"], text: string) => void
  onSelected: (selection: Extract<BridgeInbound, { type: "selected" }>) => void
  onLoad: () => void
}

/** Owns the iframe channel and listener; pages without our proxy never get bridge privileges. */
export function useBrowserBridge(options: BridgeOptions) {
  const { iframeRef } = options
  const opaqueOrigin = () => !!options.sandboxAttr.value && !options.sandboxAttr.value.includes("allow-same-origin")

  function postToPage(message: BridgeOutbound) {
    if (options.directMode.value || !options.proxyBase.value) return
    // An opaque sandbox needs '*'; delivery is still restricted to this iframe.
    const targetOrigin = opaqueOrigin() ? "*" : new URL(options.proxyBase.value).origin
    // Deep refs contain reactive proxies, which structured clone cannot serialize.
    iframeRef.value?.contentWindow?.postMessage(JSON.parse(JSON.stringify(message)), targetOrigin)
  }

  function onMessage(event: MessageEvent) {
    if (options.directMode.value || !options.proxyBase.value) return
    if (!iframeRef.value || event.source !== iframeRef.value.contentWindow) return
    const origin = opaqueOrigin() ? "null" : new URL(options.proxyBase.value).origin
    if (event.origin !== origin || !isBridgeInbound(event.data)) return
    const data = event.data
    if (data.type === "navigated" && typeof data.url === "string" && typeof data.title === "string") {
      const url = pageUrlFromProxy(options.proxyBase.value, data.url)
      if (url) options.onNavigated(url, data.title)
    } else if (
      data.type === "console" &&
      typeof data.text === "string" &&
      ["log", "info", "warn", "error", "debug"].includes(data.level)
    ) {
      options.onConsole(data.level, data.text)
    } else if (data.type === "selected" && validSelection(data)) {
      options.onSelected(data)
    }
  }

  function onIframeLoad() {
    options.onLoad()
  }

  onMounted(() => window.addEventListener("message", onMessage))
  onBeforeUnmount(() => window.removeEventListener("message", onMessage))
  return { postToPage, onIframeLoad }
}

function validSelection(data: Extract<BridgeInbound, { type: "selected" }>): boolean {
  const validRect = (rect: unknown) => {
    if (!rect || typeof rect !== "object") return false
    const values = rect as Record<string, unknown>
    return ["x", "y", "width", "height"].every(key => typeof values[key] === "number" && Number.isFinite(values[key]))
  }
  if (data.pin)
    return typeof data.pin.selector === "string" && typeof data.pin.text === "string" && validRect(data.pin.rect)
  return !!data.area && validRect(data.area.rect)
}
