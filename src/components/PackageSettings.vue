<script setup lang="ts">
/** Pi package management: browse the official pi.dev/packages catalog and
 *  install / remove / update packages via the pi CLI. */
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { openUrl } from "@tauri-apps/plugin-opener"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Dialog,
  DialogContent,
} from "@/components/ui/dialog"
import { Checkbox } from "@/components/ui/checkbox"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  packageCatalog,
  packageList,
  packageInstall,
  packageRemove,
  packageUpdate,
  packageResources,
  packageSetResource,
  packageNameOf,
  type CatalogPackage,
  type InstalledPackage,
  type PackageResource,
} from "@/api/piClient"
import { useUiStore } from "@/stores/conversations"
import { currentLocale } from "@/i18n"
import { Download, RefreshCw, ExternalLink, Trash2, ArrowUpCircle, Plus, SlidersHorizontal } from "@lucide/vue"

const props = defineProps<{ active?: boolean; project?: string }>()
const ui = useUiStore()
const { t } = useI18n()

const innerTab = ref("market")

// ---- catalog state (module-level cache via closure-free refs is fine: the
// component lives inside the settings dialog and remounts on open) ----
const catalog = ref<CatalogPackage[]>([])
const catalogLoading = ref(false)
const catalogError = ref("")
let catalogLoaded = false

const installed = ref<InstalledPackage[]>([])
const installedLoading = ref(false)

const query = ref("")
const sortBy = ref<"downloads" | "updated" | "name">("downloads")
const typeFilter = ref<string>("all")

const customSource = ref("")
const customScope = ref<"global" | "project">("global")

/** busy key: `${action}:${source}` or "catalog" / "installed" / "all" */
const busy = ref<string | null>(null)

watch(
  () => props.active,
  (a) => {
    if (!a) return
    void refreshInstalled()
    if (!catalogLoaded) void loadCatalog()
  },
  { immediate: true },
)

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
    installed.value = await packageList(props.project || undefined)
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

async function install(source: string, scope: "global" | "project") {
  const key = `install:${source}`
  if (busy.value) return
  busy.value = key
  try {
    await packageInstall(source, scope, scope === "project" ? props.project : undefined)
    ui.pushToast(t("packages.toastInstalled", { name: packageNameOf(source) }), "info")
    await refreshInstalled()
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    busy.value = null
  }
}

async function remove(pkg: InstalledPackage) {
  const key = `remove:${pkg.source}`
  if (busy.value) return
  busy.value = key
  try {
    await packageRemove(pkg.source, pkg.scope, pkg.scope === "project" ? props.project : undefined)
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
  await install(src, customScope.value)
  customSource.value = ""
}

function filterSummary(filters: Record<string, unknown> | null): string {
  if (!filters) return ""
  return Object.entries(filters)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? (v.length ? v.join(", ") : "∅") : String(v)}`)
    .join(" · ")
}

const globalInstalled = computed(() => installed.value.filter((p) => p.scope === "global"))
const projectInstalled = computed(() => installed.value.filter((p) => p.scope === "project"))

// ---- per-package resource management (enable/disable individual resources) ----
const resPkg = ref<InstalledPackage | null>(null)
const resources = ref<PackageResource[]>([])
const resourcesLoading = ref(false)
const resourceBusy = ref<string | null>(null)

const RESOURCE_GROUPS: PackageResource["resourceType"][] = ["extensions", "skills", "prompts", "themes"]

async function openResources(p: InstalledPackage) {
  resPkg.value = p
  resources.value = []
  resourcesLoading.value = true
  try {
    resources.value = await packageResources(p.source, p.scope, props.project)
  } catch (e) {
    ui.pushToast(String(e), "error")
    resPkg.value = null
  } finally {
    resourcesLoading.value = false
  }
}

function resourcesOf(type: PackageResource["resourceType"]): PackageResource[] {
  return resources.value.filter((r) => r.resourceType === type)
}

async function toggleResource(r: PackageResource) {
  if (!resPkg.value || resourceBusy.value) return
  const key = `${r.resourceType}:${r.path}`
  resourceBusy.value = key
  try {
    await packageSetResource(
      resPkg.value.source,
      resPkg.value.scope,
      r.resourceType,
      r.path,
      !r.enabled,
      props.project,
    )
    r.enabled = !r.enabled
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    resourceBusy.value = null
  }
}

const resourceTypeName = (type: string) => {
  const key = `packages.types.${type.replace(/s$/, "")}`
  const label = t(key)
  return label === key ? type : label
}
</script>

<template>
  <header class="flex flex-col gap-2 text-left">
    <h2 class="text-base leading-none font-medium">{{ t("packages.title") }}</h2>
    <p class="text-sm text-muted-foreground">{{ t("packages.description") }}</p>
  </header>

  <Tabs v-model="innerTab" class="min-h-0">
    <div class="mb-3 flex items-center justify-between gap-2">
      <TabsList>
        <TabsTrigger value="market">{{ t("packages.market") }}</TabsTrigger>
        <TabsTrigger value="installed">
          {{ t("packages.installed") }}
          <span v-if="installed.length" class="text-muted-foreground">({{ installed.length }})</span>
        </TabsTrigger>
      </TabsList>
      <Button
        variant="ghost"
        size="sm"
        :disabled="busy !== null || catalogLoading"
        @click="innerTab === 'market' ? loadCatalog() : refreshInstalled()"
      >
        <RefreshCw :size="14" :class="{ 'animate-spin': catalogLoading || installedLoading }" />
        {{ t("packages.refresh") }}
      </Button>
    </div>

    <!-- marketplace -->
    <TabsContent value="market" class="mt-0">
      <div class="mb-3 flex items-center gap-2">
        <Input v-model="query" :placeholder="t('packages.searchPlaceholder')" class="h-8 flex-1" />
        <Select v-model="sortBy">
          <SelectTrigger class="h-8 w-32 shrink-0"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="downloads">{{ t("packages.sortDownloads") }}</SelectItem>
            <SelectItem value="updated">{{ t("packages.sortUpdated") }}</SelectItem>
            <SelectItem value="name">{{ t("packages.sortName") }}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="mb-3 flex flex-wrap items-center gap-1.5">
        <Button
          v-for="tf in ['all', 'extension', 'skill', 'prompt', 'theme']"
          :key="tf"
          :variant="typeFilter === tf ? 'default' : 'outline'"
          size="sm"
          class="h-7 px-2.5 text-xs"
          @click="typeFilter = tf"
        >
          {{ tf === "all" ? t("packages.typeAll") : t(`packages.types.${tf}`) }}
        </Button>
      </div>

      <div v-if="catalogLoading && !catalog.length" class="flex items-center justify-center gap-2 py-12">
        <Spinner class="size-4" />
        <span class="text-muted-foreground text-sm">{{ t("packages.loading") }}</span>
      </div>
      <div v-else-if="catalogError" class="py-8 text-center">
        <p class="text-destructive text-sm">{{ catalogError }}</p>
        <Button variant="outline" size="sm" class="mt-3" @click="loadCatalog">
          {{ t("packages.retry") }}
        </Button>
      </div>
      <p v-else-if="!filteredCatalog.length" class="text-muted-foreground py-8 text-center text-sm">
        {{ t("packages.empty") }}
      </p>

      <div v-else class="grid gap-3">
        <div
          v-for="p in filteredCatalog"
          :key="p.name"
          class="rounded-md border p-3"
        >
          <div class="flex flex-wrap items-center gap-2">
            <h4 class="text-sm font-medium">{{ p.name }}</h4>
            <Badge v-for="tp in p.types" :key="tp" variant="secondary">{{ typeLabel(tp) }}</Badge>
            <Badge v-if="scopesOf(p.name).size" variant="outline" class="text-chart-2">
              {{ t("packages.installedBadge") }}
            </Badge>
          </div>
          <p v-if="p.description" class="text-muted-foreground mt-1 line-clamp-2 text-xs">
            {{ p.description }}
          </p>
          <p class="text-muted-foreground mt-1.5 text-xs">
            {{ p.author }} · {{ fmtDownloads(p.downloadsMonth) }}/{{ t("packages.perMonth") }}
            <template v-if="p.updatedMs"> · {{ fmtUpdated(p.updatedMs) }}</template>
          </p>
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              :disabled="busy !== null || scopesOf(p.name).has('global')"
              @click="install(p.source, 'global')"
            >
              <Spinner v-if="busy === `install:${p.source}`" class="size-3" />
              <Download v-else :size="14" />
              {{ scopesOf(p.name).has("global") ? t("packages.installedBadge") : t("packages.install") }}
            </Button>
            <Button
              v-if="project && !scopesOf(p.name).has('project')"
              variant="outline"
              size="sm"
              :disabled="busy !== null"
              @click="install(p.source, 'project')"
            >
              {{ t("packages.installProject") }}
            </Button>
            <Button variant="ghost" size="sm" @click="openUrl(p.detailUrl)">
              <ExternalLink :size="14" />
              {{ t("packages.details") }}
            </Button>
            <code class="text-muted-foreground ml-auto hidden font-mono text-xs sm:block">
              pi install {{ p.source }}
            </code>
          </div>
        </div>
      </div>
    </TabsContent>

    <!-- installed -->
    <TabsContent value="installed" class="mt-0">
      <div class="mb-4">
        <h3 class="settings-section">{{ t("packages.customTitle") }}</h3>
        <p class="text-muted-foreground mb-2 text-xs">{{ t("packages.customHint") }}</p>
        <div class="flex items-center gap-2">
          <Input
            v-model="customSource"
            placeholder="npm:@scope/pkg / git:github.com/user/repo / ./path"
            class="h-8 flex-1 font-mono text-xs"
            @keydown.enter="installCustom"
          />
          <Select v-if="project" v-model="customScope">
            <SelectTrigger class="h-8 w-28 shrink-0"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="global">{{ t("packages.scopeGlobal") }}</SelectItem>
              <SelectItem value="project">{{ t("packages.scopeProject") }}</SelectItem>
            </SelectContent>
          </Select>
          <Button size="sm" :disabled="busy !== null || !customSource.trim()" @click="installCustom">
            <Plus :size="14" />
            {{ t("packages.install") }}
          </Button>
        </div>
      </div>

      <Separator class="my-4" />

      <div class="mb-2 flex items-center justify-between">
        <h3 class="settings-section !mb-0">{{ t("packages.scopeGlobal") }}</h3>
        <Button
          v-if="globalInstalled.length"
          variant="outline"
          size="sm"
          :disabled="busy !== null"
          @click="update()"
        >
          <Spinner v-if="busy === 'all'" class="size-3" />
          <ArrowUpCircle v-else :size="14" />
          {{ t("packages.updateAll") }}
        </Button>
      </div>
      <p v-if="!globalInstalled.length" class="text-muted-foreground py-3 text-sm">
        {{ t("packages.noneGlobal") }}
      </p>
      <div v-for="p in globalInstalled" :key="`g:${p.source}`" class="setting-row">
        <div>
          <h3 class="!text-sm">{{ packageNameOf(p.source) }}</h3>
          <p class="font-mono text-xs">{{ p.source }}</p>
          <p v-if="p.filters" class="text-xs">{{ filterSummary(p.filters) }}</p>
        </div>
        <div class="flex shrink-0 gap-2">
          <Button
            variant="outline"
            size="sm"
            @click="openResources(p)"
          >
            <SlidersHorizontal :size="14" />
            {{ t("packages.manage") }}
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="busy !== null"
            @click="update(p.source)"
          >
            <Spinner v-if="busy === `update:${p.source}`" class="size-3" />
            <ArrowUpCircle v-else :size="14" />
            {{ t("packages.update") }}
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="busy !== null"
            @click="remove(p)"
          >
            <Spinner v-if="busy === `remove:${p.source}`" class="size-3" />
            <Trash2 v-else :size="14" />
            {{ t("packages.remove") }}
          </Button>
        </div>
      </div>

      <template v-if="project">
        <Separator class="my-4" />
        <h3 class="settings-section">{{ t("packages.scopeProject") }}</h3>
        <p class="text-muted-foreground mb-2 font-mono text-xs">{{ project }}/.pi/settings.json</p>
        <p v-if="!projectInstalled.length" class="text-muted-foreground py-3 text-sm">
          {{ t("packages.noneProject") }}
        </p>
        <div v-for="p in projectInstalled" :key="`p:${p.source}`" class="setting-row">
          <div>
            <h3 class="!text-sm">{{ packageNameOf(p.source) }}</h3>
            <p class="font-mono text-xs">{{ p.source }}</p>
            <p v-if="p.filters" class="text-xs">{{ filterSummary(p.filters) }}</p>
          </div>
          <div class="flex shrink-0 gap-2">
            <Button
              variant="outline"
              size="sm"
              @click="openResources(p)"
            >
              <SlidersHorizontal :size="14" />
              {{ t("packages.manage") }}
            </Button>
            <Button
              variant="outline"
              size="sm"
              :disabled="busy !== null"
              @click="remove(p)"
            >
              <Spinner v-if="busy === `remove:${p.source}`" class="size-3" />
              <Trash2 v-else :size="14" />
              {{ t("packages.remove") }}
            </Button>
          </div>
        </div>
      </template>

      <p class="text-muted-foreground mt-6 text-xs">{{ t("packages.restartHint") }}</p>
    </TabsContent>
  </Tabs>

  <!-- resource management dialog -->
  <Dialog :open="!!resPkg" @update:open="(v: boolean) => { if (!v) resPkg = null }">
    <DialogContent v-if="resPkg" class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t("packages.resourcesTitle", { name: packageNameOf(resPkg.source) }) }}</DialogTitle>
        <DialogDescription>{{ t("packages.resourcesHint") }}</DialogDescription>
      </DialogHeader>
      <div v-if="resourcesLoading" class="flex items-center justify-center gap-2 py-8">
        <Spinner class="size-4" />
        <span class="text-muted-foreground text-sm">{{ t("packages.loading") }}</span>
      </div>
      <ScrollArea v-else viewport-class="max-h-[55dvh]">
        <div class="flex flex-col gap-4 pr-2">
          <template v-for="group in RESOURCE_GROUPS" :key="group">
            <div v-if="resourcesOf(group).length">
              <h4 class="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {{ resourceTypeName(group) }}
              </h4>
              <div
                v-for="r in resourcesOf(group)"
                :key="`${r.resourceType}:${r.path}`"
                class="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-muted/50"
              >
                <Checkbox
                  :model-value="r.enabled"
                  :disabled="resourceBusy !== null"
                  @update:model-value="() => toggleResource(r)"
                />
                <span
                  class="flex-1 truncate font-mono text-xs"
                  :class="r.enabled ? '' : 'text-muted-foreground line-through'"
                  :title="r.path"
                >{{ r.path }}</span>
                <Spinner v-if="resourceBusy === `${r.resourceType}:${r.path}`" class="size-3" />
              </div>
            </div>
          </template>
          <p v-if="!resources.length" class="text-muted-foreground py-6 text-center text-sm">
            {{ t("packages.resourcesEmpty") }}
          </p>
        </div>
      </ScrollArea>
    </DialogContent>
  </Dialog>
</template>
