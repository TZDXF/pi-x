import { computed, ref } from "vue"

/**
 * Minimal hash-based router.
 *
 * Routes:
 *   #/                          -> workspace (home)
 *   #/project/:project          -> a pristine/new conversation in a project
 *   #/session/:id/:project      -> a pending runtime id or saved session file
 *   #/schedules                 -> scheduled tasks in the workspace main pane
 *   #/archives                  -> legacy alias for #/settings/archives
 *   #/settings                  -> settings page, defaults to the "general" tab
 *   #/settings/:tab             -> settings page with a specific tab
 *
 * Hash routing is used so the app works unchanged under the Tauri
 * custom protocol and from a static file server.
 */

export interface Route {
  /** Normalized path, e.g. "/settings/models". */
  path: string
  /** Route name: "home" | "project" | "session" | "schedules" | "settings". */
  name: "home" | "project" | "session" | "schedules" | "settings"
  /** Path parameters, e.g. { tab: "models" }. */
  params: {
    tab?: string
    /** A pending runtime id or saved session file path. */
    conversation?: string
    /** The normalized project path that owns a conversation route. */
    project?: string
  }
}

export const SETTINGS_TABS = [
  "general",
  "appearance",
  "run-config",
  "archives",
  "notifications",
  "remote",
  "models",
  "model-config",
  "shortcuts",
  "packages",
  "package-resources",
  "agent-config",
  "skills",
  "mcp",
  "about",
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "")
  const path = raw.startsWith("/") ? raw : `/${raw}`
  const segments = path.split("/").filter(Boolean)
  if (segments[0] === "settings") {
    return { path, name: "settings", params: { tab: segments[1] ?? "general" } }
  }
  if (segments[0] === "schedules") return { path: "/schedules", name: "schedules", params: {} }
  if (segments[0] === "session" && segments[1]) {
    return {
      path,
      name: "session",
      params: {
        conversation: decodeURIComponent(segments[1]),
        project: segments[2] ? decodeURIComponent(segments[2]) : undefined,
      },
    }
  }
  if (segments[0] === "project" && segments[1]) {
    return { path, name: "project", params: { project: decodeURIComponent(segments[1]) } }
  }
  // 归档页已并入设置，旧链接仍然直达设置里的归档标签。
  if (segments[0] === "archives") return { path: "/settings/archives", name: "settings", params: { tab: "archives" } }
  return { path: "/", name: "home", params: {} }
}

const current = ref<Route>(parse())

/** Our own history index; browser history entries outside the app fall back to 0. */
const historyIndex = ref(readHistoryIndex())
const historyLength = ref(Math.max(window.history.length, historyIndex.value + 1))

function readHistoryIndex(): number {
  const value = (window.history.state as { pixHistoryIndex?: unknown } | null)?.pixHistoryIndex
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function syncHistory() {
  historyIndex.value = readHistoryIndex()
  historyLength.value = Math.max(historyLength.value, historyIndex.value + 1)
}

// pushState does not fire hashchange/popstate; other navigation does.
window.addEventListener("hashchange", () => {
  current.value = parse()
  syncHistory()
})
window.addEventListener("popstate", () => {
  current.value = parse()
  syncHistory()
})

/** Reactive current route (readonly view). */
export function useRoute() {
  return computed(() => current.value)
}

/** Whether app history has an older entry (used by title-bar navigation). */
export const canGoBack = computed(() => historyIndex.value > 0)

/** Whether app history has a newer entry (used by title-bar navigation). */
export const canGoForward = computed(() => historyIndex.value < historyLength.value - 1)

export function isSettingsTab(tab: string | undefined): tab is SettingsTab {
  return !!tab && (SETTINGS_TABS as readonly string[]).includes(tab)
}

/** Route for a pristine/new conversation in a project. */
export function projectRoute(project: string): string {
  return `/project/${encodeURIComponent(project)}`
}

/** Route for a pending runtime id or a saved session file. */
export function sessionRoute(conversation: string, project?: string): string {
  const suffix = project ? `/${encodeURIComponent(project)}` : ""
  return `/session/${encodeURIComponent(conversation)}${suffix}`
}

/** Navigate to a path; pushes a history entry unless `replace`. */
export function navigate(path: string, replace = false) {
  const target = path.startsWith("/") ? path : `/${path}`
  const hash = `#${target}`
  if (window.location.hash === hash) {
    current.value = parse()
    return
  }
  const currentState = (window.history.state ?? {}) as Record<string, unknown>
  if (replace) {
    // replaceState does not fire hashchange; update the route manually.
    window.history.replaceState({ ...currentState, pixHistoryIndex: historyIndex.value }, "", hash)
    current.value = parse()
  } else {
    // Keep our own index because history.length cannot identify the active entry.
    const nextIndex = historyIndex.value + 1
    window.history.pushState({ ...currentState, pixHistoryIndex: nextIndex }, "", hash)
    historyIndex.value = nextIndex
    historyLength.value = nextIndex + 1 // pushState also discards newer entries.
    current.value = parse()
  }
}

/** Go back to the workspace. */
export function goHome(replace = false) {
  navigate("/", replace)
}
