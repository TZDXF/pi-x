/** Shared state for the package settings tabs: catalog browsing, installed
 *  packages, install/remove/update actions, and the project-install flow. */
import { computed, onScopeDispose, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  packageCatalog,
  packageResources,
  packageSetResource,
  getConfig,
  packageList,
  packageInstall,
  packageRemove,
  packageUpdate,
  packageNameOf,
  saveConfig,
  type AppConfig,
  type CatalogPackage,
  type InstalledPackage,
} from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"
import { compactNumber, formatRelativeTime } from "@/lib/format"

export function usePackages(project: () => string | undefined) {
  const ui = useUiStore()
  const workspace = useWorkspaceStore()
  const { t } = useI18n()

  // ---- catalog ----
  const catalog = ref<CatalogPackage[]>([])
  const catalogLoading = ref(false)
  const catalogError = ref("")
  const catalogHasMore = ref(false)
  let catalogPage = 0
  let catalogRequest = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  // ---- installed ----
  const installed = ref<InstalledPackage[]>([])
  const installedLoading = ref(false)
  /** `${scope}:${source}` -> cascade toggle state for the installed row.
   *  Scope is part of the key: the same package can be installed in both. */
  const extensionStates = ref<Map<string, ExtensionState>>(new Map())

  // ---- built-in plugins ----
  const appConfig = ref<AppConfig | null>(null)
  const builtinLoading = ref(false)
  const builtinBusy = ref<string | null>(null)

  const builtinFileChanges = computed(() => appConfig.value?.builtinFileChanges !== false)
  const builtinDelayedSend = computed(() => appConfig.value?.builtinDelayedSend !== false)

  // ---- market filters ----
  const query = ref("")
  const sortBy = ref<"downloads" | "updated" | "name">("downloads")
  const typeFilter = ref<string>("all")

  // ---- custom install form ----
  const customSource = ref("")
  const customScope = ref<"global" | "project">("global")

  // The project whose installed packages are displayed is independent of the
  // project selected in the main chat UI. Installation always asks for a target.
  const viewedProject = ref(project() ?? "")

  // ---- project install dialog flow ----
  const pendingProjectSource = ref("")

  /** busy key: `${action}:${source}` or "all" (null = idle) */
  const busy = ref<string | null>(null)

  const recentProjects = computed(() => [
    ...new Set([...workspace.orderedProjects(), project(), viewedProject.value].filter((p): p is string => !!p)),
  ])

  /** Initial load, called when the packages route mounts. */
  async function activate() {
    void Promise.all([refreshInstalled(), loadBuiltinPlugins()])
    void loadCatalog()
  }

  async function loadBuiltinPlugins() {
    builtinLoading.value = true
    try {
      appConfig.value = await getConfig()
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      builtinLoading.value = false
    }
  }

  /** Persist one built-in plugin toggle; rolls back the optimistic update on failure. */
  async function setBuiltinPlugin(key: "builtinFileChanges" | "builtinDelayedSend", nameKey: string, enabled: boolean) {
    if (builtinBusy.value) return
    const previous = appConfig.value
    const next = { ...(appConfig.value ?? {}), [key]: enabled }
    appConfig.value = next
    builtinBusy.value = key
    try {
      await saveConfig(next)
      ui.pushToast(
        t(enabled ? "packages.builtinEnabledToast" : "packages.builtinDisabledToast", { name: t(nameKey) }),
        "info",
      )
    } catch (e) {
      appConfig.value = previous
      ui.pushToast(String(e), "error")
    } finally {
      builtinBusy.value = null
    }
  }

  function setBuiltinFileChanges(enabled: boolean) {
    return setBuiltinPlugin("builtinFileChanges", "packages.builtin.fileChanges.name", enabled)
  }

  function setBuiltinDelayedSend(enabled: boolean) {
    return setBuiltinPlugin("builtinDelayedSend", "packages.builtin.delayedSend.name", enabled)
  }

  function clearSearchTimer() {
    clearTimeout(searchTimer)
    searchTimer = undefined
  }

  async function fetchCatalog(append: boolean) {
    clearSearchTimer()
    const request = ++catalogRequest
    const page = append ? catalogPage + 1 : 1
    catalogLoading.value = true
    catalogError.value = ""
    if (!append) {
      catalog.value = []
      catalogHasMore.value = false
      catalogPage = 0
    }
    try {
      const result = await packageCatalog(
        query.value.trim(),
        sortBy.value === "updated" ? "recent" : sortBy.value,
        typeFilter.value === "all" ? "" : typeFilter.value,
        page,
      )
      if (request !== catalogRequest) return
      const packages = append ? [...catalog.value, ...result.packages] : result.packages
      catalog.value = [...new Map(packages.map(p => [p.name, p])).values()]
      catalogHasMore.value = result.hasMore
      catalogPage = page
    } catch (e) {
      if (request === catalogRequest) catalogError.value = String(e)
    } finally {
      if (request === catalogRequest) catalogLoading.value = false
    }
  }

  function loadCatalog() {
    return fetchCatalog(false)
  }

  function loadMoreCatalog() {
    if (catalogLoading.value || !catalogHasMore.value) return
    return fetchCatalog(true)
  }

  watch(
    [query, sortBy, typeFilter],
    () => {
      // Invalidate immediately, including responses arriving during the debounce.
      ++catalogRequest
      clearSearchTimer()
      catalog.value = []
      catalogHasMore.value = false
      catalogError.value = ""
      catalogLoading.value = true
      searchTimer = setTimeout(() => {
        void loadCatalog()
      }, 250)
    },
    { flush: "sync" },
  )

  onScopeDispose(() => {
    clearSearchTimer()
    ++catalogRequest
  })

  async function refreshInstalled() {
    installedLoading.value = true
    try {
      installed.value = await packageList(viewedProject.value || undefined)
      // Fetch each package's extension enabled state in parallel.
      const entries = await Promise.all(
        installed.value.map(async p => {
          const project = p.scope === "project" ? viewedProject.value : undefined
          try {
            const res = await packageResources(p.source, p.scope, project)
            const ext = res.filter(r => r.resourceType === "extensions")
            return [
              extensionKey(p),
              { hasExtension: ext.length > 0, enabled: ext.length > 0 && ext.every(r => r.enabled) },
            ] as const
          } catch {
            return [extensionKey(p), { hasExtension: false, enabled: false }] as const
          }
        }),
      )
      extensionStates.value = new Map(entries)
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      installedLoading.value = false
    }
  }

  const installedScopes = computed(() => {
    const m = new Map<string, Set<string>>()
    for (const p of installed.value) {
      const name = packageNameOf(p.source)
      if (!m.has(name)) m.set(name, new Set())
      m.get(name)!.add(p.scope)
    }
    return m
  })

  function scopesOf(name: string): Set<string> {
    return installedScopes.value.get(name) ?? new Set()
  }

  function fmtDownloads(n: number): string {
    return compactNumber(n)
  }

  function fmtUpdated(ms: number): string {
    return formatRelativeTime(ms)
  }

  function typeLabel(type: string): string {
    const key = `packages.types.${type}`
    const label = t(key)
    return label === key ? type : label
  }

  // ---- install / remove / update ----

  function chooseProjectForInstall(source: string) {
    if (busy.value) return
    pendingProjectSource.value = source
  }

  async function confirmProjectInstall(target: string) {
    const source = pendingProjectSource.value
    target = target.trim()
    if (!source || !target) return
    if (await install(source, "project", target)) {
      if (customSource.value.trim() === source) customSource.value = ""
      pendingProjectSource.value = ""
    }
  }

  async function install(source: string, scope: "global" | "project", target?: string): Promise<boolean> {
    const key = `install:${source}`
    if (busy.value) return false
    busy.value = key
    try {
      await packageInstall(source, scope, target)
      if (scope === "project" && target) viewedProject.value = target
      ui.pushToast(t("packages.toastInstalled", { name: packageNameOf(source) }), "info")
      await refreshInstalled()
      return true
    } catch (e) {
      ui.pushToast(String(e), "error")
      return false
    } finally {
      busy.value = null
    }
  }

  async function remove(pkg: InstalledPackage) {
    const key = `remove:${pkg.source}`
    if (busy.value) return
    busy.value = key
    try {
      await packageRemove(pkg.source, pkg.scope, pkg.scope === "project" ? viewedProject.value : undefined)
      ui.pushToast(t("packages.toastRemoved", { name: packageNameOf(pkg.source) }), "info")
      await refreshInstalled()
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      busy.value = null
    }
  }

  async function update(source?: string) {
    const key = source ? `update:${source}` : "all"
    if (busy.value) return
    busy.value = key
    try {
      await packageUpdate(source)
      ui.pushToast(t("packages.toastUpdated"), "info")
      await refreshInstalled()
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      busy.value = null
    }
  }

  async function installCustom() {
    const src = customSource.value.trim()
    if (!src) return
    if (customScope.value === "project") {
      chooseProjectForInstall(src)
    } else if (await install(src, "global")) {
      customSource.value = ""
    }
  }

  /** Enable or disable a package's extension together with all of its
   *  skills, prompts and themes (cascading toggle on the installed row). */
  async function toggleExtension(pkg: InstalledPackage, enabled: boolean) {
    const key = `ext:${extensionKey(pkg)}`
    if (busy.value) return
    busy.value = key
    try {
      const project = pkg.scope === "project" ? viewedProject.value : undefined
      const all = await packageResources(pkg.source, pkg.scope, project)
      for (const r of all) {
        if (r.enabled === enabled) continue
        await packageSetResource(pkg.source, pkg.scope, r.resourceType, r.path, enabled, project)
      }
      ui.pushToast(
        t(enabled ? "packages.extEnabledToast" : "packages.extDisabledToast", { name: packageNameOf(pkg.source) }),
        "info",
      )
      await refreshInstalled()
    } catch (e) {
      ui.pushToast(String(e), "error")
    } finally {
      busy.value = null
    }
  }

  function filterSummary(filters: Record<string, unknown> | null): string {
    if (!filters) return ""
    return Object.entries(filters)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.length ? v.join(", ") : "∅") : String(v)}`)
      .join(" · ")
  }

  const globalInstalled = computed(() => installed.value.filter(p => p.scope === "global"))
  const projectInstalled = computed(() => installed.value.filter(p => p.scope === "project"))

  return {
    catalog,
    catalogLoading,
    catalogError,
    catalogHasMore,
    installed,
    installedLoading,
    extensionStates,
    appConfig,
    builtinLoading,
    builtinBusy,
    builtinFileChanges,
    builtinDelayedSend,
    query,
    sortBy,
    typeFilter,
    customSource,
    customScope,
    viewedProject,
    pendingProjectSource,
    busy,
    recentProjects,
    installedScopes,
    globalInstalled,
    projectInstalled,
    activate,
    loadCatalog,
    loadMoreCatalog,
    refreshInstalled,
    loadBuiltinPlugins,
    setBuiltinFileChanges,
    setBuiltinDelayedSend,
    scopesOf,
    fmtDownloads,
    fmtUpdated,
    typeLabel,
    filterSummary,
    install,
    remove,
    update,
    toggleExtension,
    installCustom,
    chooseProjectForInstall,
    confirmProjectInstall,
  }
}

export type PackagesContext = ReturnType<typeof usePackages>

export interface ExtensionState {
  /** Whether the package ships any extension file; rows without one hide the
   *  cascade toggle instead of showing a switch that snaps back to off. */
  hasExtension: boolean
  enabled: boolean
}

/** Map key for a package's row state; scopes are distinct installs. */
export function extensionKey(pkg: Pick<InstalledPackage, "scope" | "source">): string {
  return `${pkg.scope}:${pkg.source}`
}
