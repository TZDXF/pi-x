/** Shared state for the package settings tabs: catalog browsing, installed
 *  packages, install/remove/update actions, and the project-install flow. */
import { computed, onScopeDispose, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import {
  packageCatalog,
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
import { currentLocale } from "@/i18n"

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

  // ---- built-in plugins ----
  const appConfig = ref<AppConfig | null>(null)
  const builtinLoading = ref(false)
  const builtinBusy = ref<string | null>(null)

  const builtinFileChanges = computed(() => appConfig.value?.builtinFileChanges !== false)

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

  async function setBuiltinFileChanges(enabled: boolean) {
    if (builtinBusy.value) return
    const previous = appConfig.value
    const next = { ...(appConfig.value ?? {}), builtinFileChanges: enabled }
    appConfig.value = next
    builtinBusy.value = "fileChanges"
    try {
      await saveConfig(next)
      ui.pushToast(
        t(enabled ? "packages.builtinEnabledToast" : "packages.builtinDisabledToast", {
          name: t("packages.builtin.fileChanges.name"),
        }),
        "info",
      )
    } catch (e) {
      appConfig.value = previous
      ui.pushToast(String(e), "error")
    } finally {
      builtinBusy.value = null
    }
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
    return new Intl.NumberFormat(currentLocale(), { notation: "compact" }).format(n)
  }

  function fmtUpdated(ms: number): string {
    if (!ms) return ""
    const diff = Date.now() - ms
    const rtf = new Intl.RelativeTimeFormat(currentLocale(), { numeric: "auto" })
    const days = Math.round(diff / 86400000)
    if (days < 1) return rtf.format(-Math.max(1, Math.round(diff / 3600000)), "hour")
    if (days < 30) return rtf.format(-days, "day")
    const months = Math.round(days / 30)
    if (months < 12) return rtf.format(-months, "month")
    return rtf.format(-Math.round(months / 12), "year")
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
    appConfig,
    builtinLoading,
    builtinBusy,
    builtinFileChanges,
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
    scopesOf,
    fmtDownloads,
    fmtUpdated,
    typeLabel,
    filterSummary,
    install,
    remove,
    update,
    installCustom,
    chooseProjectForInstall,
    confirmProjectInstall,
  }
}

export type PackagesContext = ReturnType<typeof usePackages>
