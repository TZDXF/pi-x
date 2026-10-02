import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { nextTick, ref } from "vue"
import { previewProxyInfo } from "@/api/piClient"
import { openUrl } from "@tauri-apps/plugin-opener"
import { toProxyUrl } from "@/lib/previewUrl"
import { useBrowserNavigation } from "@/composables/browser/useBrowserNavigation"
import { mountBrowserComposable } from "./browserTestHarness"

const platform = vi.hoisted(() => ({ desktop: false }))
vi.mock("@/api/piClient", () => ({ previewProxyInfo: vi.fn() }))
vi.mock("@/api/transport", () => ({
  get isDesktop() {
    return platform.desktop
  },
}))
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn().mockResolvedValue(undefined) }))

const base = "http://127.0.0.1:9000/p/secret"
let pref: string | null
let unmount: (() => void) | undefined
beforeEach(() => {
  pref = null
  platform.desktop = false
  vi.mocked(previewProxyInfo).mockReset().mockResolvedValue({ base })
  vi.stubGlobal("window", { location: { origin: "https://remote.example" }, open: vi.fn() })
  vi.stubGlobal("localStorage", {
    getItem: vi.fn(() => pref),
    setItem: vi.fn((_key: string, value: string) => {
      pref = value
    }),
  })
})
afterEach(() => {
  unmount?.()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function setup(visible = ref(false)) {
  const postToPage = vi.fn()
  const onDirectMode = vi.fn()
  const mounted = mountBrowserComposable(() =>
    useBrowserNavigation({
      visible: () => visible.value,
      t: key => key,
      postToPage,
      onDirectMode,
    }),
  )
  unmount = mounted.unmount
  return { nav: mounted.result, visible, postToPage, onDirectMode }
}

for (const desktop of [true, false]) {
  test(`proxy remains the default on ${desktop ? "desktop" : "remote"} and src is independent of reported URL`, async () => {
    platform.desktop = desktop
    const { nav, postToPage } = setup(ref(true))
    nav.inputUrl.value = "localhost:5173/app"
    await nav.navigate()
    expect(previewProxyInfo).toHaveBeenCalledTimes(1)
    expect(nav.activeSrc.value).toBe(toProxyUrl(base, "http://localhost:5173/app"))
    const src = nav.activeSrc.value
    nav.receiveNavigation("http://localhost:5173/other#hash", "Page title")
    expect(nav.currentUrl.value).toBe("http://localhost:5173/other#hash")
    expect(nav.inputUrl.value).toBe(nav.currentUrl.value)
    expect(nav.pageTitle.value).toBe("Page title")
    expect(nav.activeSrc.value).toBe(src)
    expect(nav.loading.value).toBe(false)
    nav.goBack()
    nav.goForward()
    nav.reload()
    expect(postToPage.mock.calls.map(([message]) => message.type)).toEqual(["back", "forward", "reload"])
    nav.openExternal()
    if (desktop) expect(openUrl).toHaveBeenCalledWith(nav.currentUrl.value)
    else expect(window.open).toHaveBeenCalledWith(nav.currentUrl.value, "_blank", "noopener")
  })
}

test("initialization is lazy and remote-relative proxy base has an opaque sandbox", async () => {
  vi.mocked(previewProxyInfo).mockResolvedValue({ base: "/api/preview/secret" })
  const { nav, visible } = setup()
  expect(previewProxyInfo).not.toHaveBeenCalled()
  visible.value = true
  await nextTick()
  await nextTick()
  expect(nav.proxyBase.value).toBe("https://remote.example/api/preview/secret")
  expect(nav.sandboxAttr.value).not.toContain("allow-same-origin")
})

test("direct fallback persists preference, degrades bridge UI and retains stack branching/reload", async () => {
  const { nav, postToPage, onDirectMode } = setup()
  nav.inputUrl.value = "example.com/a"
  await nav.navigate()
  await nav.cycleAccessMode()
  expect(pref).toBe("direct")
  expect(nav.sandboxAttr.value).toBeUndefined()
  expect(nav.activeSrc.value).toBe("https://example.com/a")
  expect(onDirectMode).toHaveBeenCalledTimes(1)
  for (const path of ["b", "c"]) {
    nav.inputUrl.value = `example.com/${path}`
    await nav.navigate()
  }
  nav.goBack()
  expect(nav.currentUrl.value).toBe("https://example.com/b")
  nav.goForward()
  expect(nav.currentUrl.value).toBe("https://example.com/c")
  nav.goBack()
  nav.inputUrl.value = "example.com/d"
  await nav.navigate()
  expect(nav.directHistory.value).toEqual(["https://example.com/a", "https://example.com/b", "https://example.com/d"])
  nav.goForward()
  expect(nav.currentUrl.value).toBe("https://example.com/d")
  const key = nav.iframeKey.value
  await nav.navigate() // same URL reloads without adding a history entry
  expect(nav.iframeKey.value).toBe(key + 1)
  expect(nav.directIndex.value).toBe(2)
  expect(postToPage).not.toHaveBeenCalled()
  await nav.cycleAccessMode()
  await nextTick()
  await nextTick()
  expect(pref).toBe("auto")
  expect(nav.activeSrc.value).toBe(toProxyUrl(base, nav.currentUrl.value))
  expect(nav.directHistory.value).toEqual([nav.currentUrl.value])
})

test("failed proxy init is retried after switching back from usable direct fallback", async () => {
  vi.mocked(previewProxyInfo).mockRejectedValueOnce(new Error("offline"))
  const { nav } = setup()
  nav.inputUrl.value = "localhost:3000"
  await nav.navigate()
  expect(nav.proxyError.value).toBe(true)
  await nav.cycleAccessMode()
  expect(nav.activeSrc.value).toBe("http://localhost:3000")
  await nav.cycleAccessMode()
  await nextTick()
  await nextTick()
  expect(previewProxyInfo).toHaveBeenCalledTimes(2)
  expect(nav.proxyError.value).toBe(false)
  expect(nav.activeSrc.value).toBe(toProxyUrl(base, nav.currentUrl.value))
})

test("legacy preferences and unavailable storage still default to proxy; invalid input is ignored", async () => {
  pref = "proxy"
  const { nav } = setup()
  expect(nav.directMode.value).toBe(false)
  nav.inputUrl.value = "javascript:alert(1)"
  await nav.navigate()
  expect(nav.currentUrl.value).toBe("")
  unmount?.()
  vi.stubGlobal("localStorage", {
    getItem() {
      throw new Error("blocked")
    },
    setItem() {
      throw new Error("blocked")
    },
  })
  const { nav: restricted } = setup()
  restricted.cycleAccessMode()
  expect(restricted.directMode.value).toBe(true)
})

test("persisted direct preference never initializes the proxy when becoming visible", async () => {
  pref = "direct"
  const { nav } = setup(ref(true))
  nav.inputUrl.value = "localhost:5173"
  await nav.navigate()
  expect(nav.directMode.value).toBe(true)
  expect(nav.activeSrc.value).toBe("http://localhost:5173")
  expect(previewProxyInfo).not.toHaveBeenCalled()
})

test("slow proxy initialization cannot replace a newer direct-mode selection", async () => {
  pref = "direct"
  let resolveProxy!: (info: { base: string }) => void
  vi.mocked(previewProxyInfo).mockReturnValue(
    new Promise(resolve => {
      resolveProxy = resolve
    }),
  )
  const { nav } = setup()
  nav.inputUrl.value = "localhost:5173"
  await nav.navigate()
  const switchingToProxy = nav.cycleAccessMode()
  await nav.cycleAccessMode()
  resolveProxy({ base })
  await switchingToProxy
  expect(nav.directMode.value).toBe(true)
  expect(nav.activeSrc.value).toBe("http://localhost:5173")
})
