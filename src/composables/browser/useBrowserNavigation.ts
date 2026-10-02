import { computed, ref, watch } from "vue"
import { openUrl } from "@tauri-apps/plugin-opener"
import { isDesktop } from "@/api/transport"
import { previewProxyInfo } from "@/api/piClient"
import { bridgeCommand, type BridgeOutbound } from "@/lib/previewBridge"
import { normalizeInputUrl, resolveProxyBase, toProxyUrl, type AccessMode } from "@/lib/previewUrl"

type AccessPref = "auto" | "direct"

/** localStorage key for the manual access-mode override. */
const ACCESS_PREF_KEY = "pix.browser.accessMode"

function loadAccessPref(): AccessPref {
  try {
    const stored = localStorage.getItem(ACCESS_PREF_KEY)
    // Legacy "proxy" collapsed into "auto" — the proxy is the auto default.
    return stored === "direct" ? "direct" : "auto"
  } catch {
    /* Storage may be unavailable in restricted browsers. */
    return "auto"
  }
}

interface NavigationOptions {
  visible: () => boolean | undefined
  t: (key: string) => string
  postToPage: (message: BridgeOutbound) => void
  onDirectMode: () => void
}

/** Access policy, proxy initialization and navigation; never reacts to bridge URLs by reloading src. */
export function useBrowserNavigation(options: NavigationOptions) {
  const { t } = options
  // ---- access mode: preview proxy vs direct iframe -----------------------------
  // The preview proxy is the default on every platform: it injects the bridge
  // that enables element inspect, console capture and page annotations, and it
  // also lets remote devices reach dev servers on this machine. Direct iframe
  // loading is a manual fallback (toolbar toggle) for pages the proxy cannot
  // serve; it runs without the bridge, so those features degrade there.

  const accessPref = ref<AccessPref>(loadAccessPref())
  const effectiveAccessMode = computed<AccessMode>(() => (accessPref.value === "direct" ? "direct" : "proxy"))
  /** True when the iframe loads target URLs without the preview proxy. */
  const directMode = computed(() => effectiveAccessMode.value === "direct")
  const useProxy = computed(() => !directMode.value)

  /** Self-managed navigation stack for direct mode (bridge history is unavailable cross-origin). */
  const directHistory = ref<string[]>([])
  const directIndex = ref(-1)

  const accessModeLabel = computed(() => {
    const mode = directMode.value ? t("browser.accessModeDirect") : t("browser.accessModeProxy")
    return accessPref.value === "auto" ? `${t("browser.accessModeAuto")}·${mode}` : mode
  })
  const accessModeTitle = computed(() => `${t("browser.accessMode")}: ${accessModeLabel.value}`)

  function cycleAccessMode() {
    const order: AccessPref[] = ["auto", "direct"]
    const next = order[(order.indexOf(accessPref.value) + 1) % order.length]
    accessPref.value = next
    try {
      localStorage.setItem(ACCESS_PREF_KEY, next)
    } catch {
      /* Storage may be unavailable in restricted browsers. */
    }
    return applyAccessModeChange()
  }

  let accessChangeSeq = 0

  /** Reloads the current page under the new access mode; bridge-only features degrade in direct mode. */
  async function applyAccessModeChange() {
    const changeSeq = ++accessChangeSeq
    if (directMode.value) {
      options.onDirectMode()
    }
    if (!currentUrl.value) return
    directHistory.value = [currentUrl.value]
    directIndex.value = 0
    loading.value = true
    if (useProxy.value) {
      await initProxy()
      // A slower proxy init must not overwrite a newer direct-mode choice.
      if (changeSeq !== accessChangeSeq || directMode.value) return
      if (proxyBase.value) {
        activeSrc.value = toProxyUrl(proxyBase.value, currentUrl.value)
        iframeKey.value++
      } else {
        loading.value = false
      }
    } else {
      activeSrc.value = currentUrl.value
      iframeKey.value++
    }
  }

  const proxyBase = ref<string | null>(null)
  const proxyError = ref(false)
  const currentUrl = ref("")
  const pageTitle = ref("")
  const inputUrl = ref("")
  const iframeKey = ref(0)
  const loading = ref(false)

  // What the iframe actually loads; kept separate from `currentUrl` (the display
  // URL) so bridge-reported navigations never recompute the src and cause
  // reload loops through URL-normalization differences.
  const activeSrc = ref("")

  const sandboxAttr = computed(() => {
    // Direct mode: no sandbox — the page runs like a normal cross-origin iframe.
    if (directMode.value) return undefined
    if (proxyBase.value && isSameOrigin(proxyBase.value)) {
      return "allow-scripts allow-forms allow-popups allow-modals"
    }
    return "allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
  })

  function isSameOrigin(url: string): boolean {
    try {
      return new URL(url).origin === window.location.origin
    } catch {
      return false
    }
  }

  let initialized = false
  let initPromise: Promise<void> | null = null

  watch(
    options.visible,
    visible => {
      if (visible && !initialized) {
        initialized = true
        if (useProxy.value) initProxy()
      }
    },
    { immediate: true },
  )

  async function initProxy() {
    if (!initPromise) {
      initPromise = doInitProxy()
    }
    return initPromise
  }

  async function doInitProxy() {
    try {
      const info = await previewProxyInfo()
      proxyBase.value = resolveProxyBase(info.base)
      proxyError.value = false
    } catch {
      // Drop the cached promise so switching back to proxy mode retries
      // instead of replaying the failed init forever.
      initPromise = null
      proxyError.value = true
    }
  }

  /** Points the iframe at `url` under the active access mode. */
  function loadUrl(url: string) {
    currentUrl.value = url
    loading.value = true
    if (directMode.value) {
      activeSrc.value = url
      directHistory.value = directHistory.value.slice(0, directIndex.value + 1)
      if (directHistory.value[directIndex.value] !== url) {
        directHistory.value.push(url)
        directIndex.value = directHistory.value.length - 1
      }
    } else {
      activeSrc.value = proxyBase.value ? toProxyUrl(proxyBase.value, url) : ""
    }
  }

  async function navigate() {
    if (useProxy.value) await initProxy()
    const url = normalizeInputUrl(inputUrl.value)
    if (!url) return
    if (url === currentUrl.value) {
      reload()
      return
    }
    loadUrl(url)
  }

  function reload() {
    if (!currentUrl.value) return
    loading.value = true
    if (directMode.value) {
      // Cross-origin pages cannot be reloaded from script; swap the iframe instead.
      iframeKey.value++
      return
    }
    options.postToPage(bridgeCommand("reload"))
  }

  function goBack() {
    if (!currentUrl.value) return
    if (directMode.value) {
      if (directIndex.value <= 0) return
      directIndex.value--
      currentUrl.value = directHistory.value[directIndex.value]
      activeSrc.value = currentUrl.value
      loading.value = true
      return
    }
    options.postToPage(bridgeCommand("back"))
  }

  function goForward() {
    if (!currentUrl.value) return
    if (directMode.value) {
      if (directIndex.value >= directHistory.value.length - 1) return
      directIndex.value++
      currentUrl.value = directHistory.value[directIndex.value]
      activeSrc.value = currentUrl.value
      loading.value = true
      return
    }
    options.postToPage(bridgeCommand("forward"))
  }

  function openExternal() {
    if (!currentUrl.value) return
    if (isDesktop) void openUrl(currentUrl.value)
    else window.open(currentUrl.value, "_blank", "noopener")
  }

  watch(currentUrl, url => {
    inputUrl.value = url
  })

  function receiveNavigation(url: string, title: string) {
    currentUrl.value = url
    inputUrl.value = url
    pageTitle.value = title
    loading.value = false
  }

  return {
    directMode,
    useProxy,
    directHistory,
    directIndex,
    accessModeLabel,
    accessModeTitle,
    proxyBase,
    proxyError,
    currentUrl,
    pageTitle,
    inputUrl,
    iframeKey,
    loading,
    activeSrc,
    sandboxAttr,
    cycleAccessMode,
    navigate,
    reload,
    goBack,
    goForward,
    openExternal,
    receiveNavigation,
  }
}
