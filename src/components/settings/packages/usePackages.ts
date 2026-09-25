/** Shared state for the package settings tabs: catalog browsing, installed
 *  packages, install/remove/update actions, and the project-install flow. */
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import {
  packageCatalog,
  packageList,
  packageInstall,
  packageRemove,
  packageUpdate,
  packageNameOf,
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
  let catalogLoaded = false

  // ---- installed ----
  const installed = ref<InstalledPackage[]>([])
  const installedLoading = ref(false)

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

  const recentProjects = computed(() => [...new Set([
    ...workspace.orderedProjects(), project(), viewedProject.value,
  ].filter((p): p is string => !!p))])

  /** Initial load, called when the packages route mounts. */
  async function activate() {
    void refreshInstalled()
    if (!catalogLoaded) void loadCatalog()
  }

  async function loadCatalog() {
    catalogLoading.value = true
    catalogError.value = ""
    try {
      catalog.value = await packageCatalog()
      catalogLoaded = true
    } catch (e) {
      catalogError.value = String(e)
    } finally {
      catalogLoading.value = false
    }
  }

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

  const filteredCatalog = computed(() => {
    const q = query.value.trim().toLowerCase()
    let list = catalog.value
    if (typeFilter.value !== "all") {
      list = list.filter((p) => p.types.includes(typeFilter.value))
    }
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description.toLowerCase().includes(q) ||
          p.author.toLowerCase().includes(q),
      )
    }
    const sorted = [...list]
    switch (sortBy.value) {
      case "downloads":
        sorted.sort((a, b) => b.downloadsMonth - a.downloadsMonth)
        break
      case "updated":
        sorted.sort((a, b) => b.updatedMs - a.updatedMs)
        break
      case "name":
        sorted.sort((a, b) => a.name.localeCompare(b.name))
        break
    }
    return sorted
  })

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
      catalogLoaded = true
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

  const globalInstalled = computed(() => installed.value.filter((p) => p.scope === "global"))
  const projectInstalled = computed(() => installed.value.filter((p) => p.scope === "project"))

  return {
    catalog,
    catalogLoading,
    catalogError,
    installed,
    installedLoading,
    query,
    sortBy,
    typeFilter,
    customSource,
    customScope,
    viewedProject,
    pendingProjectSource,
    busy,
    recentProjects,
    filteredCatalog,
    installedScopes,
    globalInstalled,
    projectInstalled,
    activate,
    loadCatalog,
    refreshInstalled,
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