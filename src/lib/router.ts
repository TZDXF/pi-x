import { computed, ref } from "vue"

/**
 * Minimal hash-based router.
 *
 * Routes:
 *   #/                    -> workspace (home)
 *   #/settings            -> settings page, defaults to the "general" tab
 *   #/settings/:tab       -> settings page with a specific tab (deep-linkable)
 *
 * Hash routing is used so the app works unchanged under the Tauri
 * custom protocol and from a static file server.
 */

export interface Route {
  /** Normalized path, e.g. "/settings/models". */
  path: string
  /** Route name: "home" | "settings". */
  name: "home" | "settings"
  /** Path parameters, e.g. { tab: "models" }. */
  params: { tab?: string }
}

export const SETTINGS_TABS = [
  "remote",
  "general",
  "notifications",
  "archive",
  "models",
  "agent-config",
  "skills",
  "packages",
  "about",
  "model-config",
] as const

export type SettingsTab = (typeof SETTINGS_TABS)[number]

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, "")
  const path = raw.startsWith("/") ? raw : `/${raw}`
  const segments = path.split("/").filter(Boolean)
  if (segments[0] === "settings") {
    return { path, name: "settings", params: { tab: segments[1] ?? "general" } }
  }
  return { path: "/", name: "home", params: {} }
}

const current = ref<Route>(parse())

window.addEventListener("hashchange", () => {
  current.value = parse()
})

/** Reactive current route (readonly view). */
export function useRoute() {
  return computed(() => current.value)
}

export function isSettingsTab(tab: string | undefined): tab is SettingsTab {
  return !!tab && (SETTINGS_TABS as readonly string[]).includes(tab)
}

/** Navigate to a path; pushes a history entry unless `replace`. */
export function navigate(path: string, replace = false) {
  const target = path.startsWith("/") ? path : `/${path}`
  const hash = `#${target}`
  if (window.location.hash === hash) {
    current.value = parse()
    return
  }
  if (replace) {
    // replaceState does not fire hashchange; update the route manually.
    window.history.replaceState(null, "", hash)
    current.value = parse()
  } else {
    window.location.hash = hash
  }
}

/** Go back to the workspace. */
export function goHome(replace = false) {
  navigate("/", replace)
}
