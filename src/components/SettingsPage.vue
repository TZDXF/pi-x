<script setup lang="ts">
/** Full-page workspace settings, routed via #/settings/:tab.
 *  Tabs are declared in ./settings/tabs.ts and lazy-loaded per route. */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ArrowLeft, Search } from "@lucide/vue"
import { onClickOutside } from "@vueuse/core"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { isDesktop } from "@/api/transport"
import { useRoute, navigate, goHome, type SettingsTab } from "@/lib/router"
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_GROUP_DEFS,
  SETTINGS_TAB_DEFS,
  settingsGroupForTab,
  type SettingsTabDef,
} from "@/components/settings/tabs"
import { scoreSettingsSearch, settingsSearchText } from "@/lib/settings-search"

const props = defineProps<{ project?: string }>()

const route = useRoute()
const { t, tm } = useI18n()

/** Keep the default width aligned with the workspace sidebar (`w-68`). */
const NAV_WIDTH_STORAGE_KEY = "pix.settings-nav-width"
const NAV_WIDTH_STEP = 16
const nav = ref<HTMLElement | null>(null)
const containerWidth = ref(1200)
const preferredNavWidth = ref<number | null>(null)
const navDragging = ref(false)
const currentNavWidth = ref(272)
try {
  const saved = Number(localStorage.getItem(NAV_WIDTH_STORAGE_KEY))
  if (Number.isFinite(saved) && saved > 0) preferredNavWidth.value = saved
} catch {
  /* Storage may be unavailable in restricted browsers. */
}

const navWidthBounds = computed(() => ({
  min: 220,
  max: Math.min(480, Math.max(280, containerWidth.value - 360)),
}))
const navWidth = computed(() => {
  const preferred = preferredNavWidth.value
  if (preferred === null) return "17rem"
  const { min, max } = navWidthBounds.value
  return `${Math.min(max, Math.max(min, preferred))}px`
})
let navPointer: { id: number; x: number; width: number; target: HTMLElement } | null = null
let navObserver: ResizeObserver | undefined
let navPreviousCursor = ""
let navPreviousSelect = ""

function clampNavWidth(width: number) {
  const { min, max } = navWidthBounds.value
  return Math.min(max, Math.max(min, width))
}

function saveNavWidth() {
  if (preferredNavWidth.value === null) return
  try {
    localStorage.setItem(NAV_WIDTH_STORAGE_KEY, String(preferredNavWidth.value))
  } catch {
    /* Optional preference. */
  }
}

function measureNav() {
  containerWidth.value = nav.value?.parentElement?.getBoundingClientRect().width ?? 0
  currentNavWidth.value = nav.value?.offsetWidth ?? 272
}

function startNavResize(event: PointerEvent) {
  if (event.button !== 0 || navPointer) return
  measureNav()
  const target = event.currentTarget as HTMLElement
  target.focus()
  target.setPointerCapture(event.pointerId)
  navPointer = { id: event.pointerId, x: event.clientX, width: nav.value?.offsetWidth ?? 272, target }
  currentNavWidth.value = navPointer.width
  navDragging.value = true
  navPreviousCursor = document.body.style.cursor
  navPreviousSelect = document.body.style.userSelect
  document.body.style.cursor = "col-resize"
  document.body.style.userSelect = "none"
  event.preventDefault()
}

function resizeNav(event: PointerEvent) {
  if (!navPointer || navPointer.id !== event.pointerId) return
  preferredNavWidth.value = clampNavWidth(navPointer.width + navPointer.x - event.clientX)
  currentNavWidth.value = preferredNavWidth.value
}

function stopNavResize() {
  if (!navPointer) return
  const active = navPointer
  navPointer = null
  navDragging.value = false
  if (active.target.hasPointerCapture(active.id)) active.target.releasePointerCapture(active.id)
  document.body.style.cursor = navPreviousCursor
  document.body.style.userSelect = navPreviousSelect
  saveNavWidth()
}

function resizeNavWithKeyboard(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  measureNav()
  const step = event.shiftKey ? NAV_WIDTH_STEP * 2 : NAV_WIDTH_STEP
  const current = nav.value?.offsetWidth ?? 272
  const next =
    event.key === "Home"
      ? navWidthBounds.value.min
      : event.key === "End"
        ? navWidthBounds.value.max
        : current + (event.key === "ArrowLeft" ? step : -step)
  preferredNavWidth.value = clampNavWidth(next)
  currentNavWidth.value = preferredNavWidth.value
  saveNavWidth()
}

onMounted(() => {
  measureNav()
  navObserver = new ResizeObserver(measureNav)
  if (nav.value?.parentElement) navObserver.observe(nav.value.parentElement)
  window.addEventListener("resize", measureNav)
  window.addEventListener("blur", stopNavResize)
})

onBeforeUnmount(() => {
  stopNavResize()
  navObserver?.disconnect()
  window.removeEventListener("resize", measureNav)
  window.removeEventListener("blur", stopNavResize)
})

const visibleTabs = computed(() => SETTINGS_TAB_DEFS.filter(d => isDesktop || !d.desktopOnly))

const visibleGroups = computed(() =>
  SETTINGS_GROUP_DEFS.flatMap(group => {
    const tabs = group.tabIds
      .map(id => visibleTabs.value.find(def => def.id === id))
      .filter((def): def is SettingsTabDef => !!def)
    return tabs.length ? [{ ...group, tabs }] : []
  }),
)

// Guard the tab param: unknown or desktop-only tabs fall back to the default.
const active = computed<SettingsTabDef>(
  () =>
    visibleTabs.value.find(d => d.id === route.value.params.tab) ??
    SETTINGS_TAB_DEFS.find(d => d.id === DEFAULT_SETTINGS_TAB)!,
)
/** Feature labels are searchable independently from their parent menu title. */
interface SettingsSearchEntry {
  tab: SettingsTab
  labelKey: string
}

const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  { tab: "general", labelKey: "settings.theme" },
  { tab: "general", labelKey: "chat.runningBehavior" },
  { tab: "general", labelKey: "settings.language" },
  { tab: "shortcuts", labelKey: "settings.shortcutsTitle" },
  { tab: "workspace", labelKey: "openWith.default" },
  { tab: "workspace", labelKey: "projectless.settingsLabel" },
  { tab: "notifications", labelKey: "settings.turnComplete" },
  { tab: "notifications", labelKey: "settings.questionNotify" },
  { tab: "notifications", labelKey: "settings.notifySound" },
  { tab: "remote", labelKey: "settings.remotePort" },
  { tab: "remote", labelKey: "settings.remotePassword" },
  { tab: "remote", labelKey: "settings.remoteLinks" },
  { tab: "packages", labelKey: "packages.market" },
  { tab: "packages", labelKey: "packages.installed" },
  { tab: "packages", labelKey: "packages.customTitle" },
  { tab: "models", labelKey: "settings.providerAdd" },
  { tab: "models", labelKey: "settings.modelAdd" },
  { tab: "models", labelKey: "settings.modelFetch" },
  { tab: "model-config", labelKey: "titleGeneration.defaultModel" },
  { tab: "model-config", labelKey: "titleGeneration.enabled" },
  { tab: "model-config", labelKey: "titleGeneration.model" },
  { tab: "agent-config", labelKey: "agentConfig.files" },
  { tab: "skills", labelKey: "skillsConfig.hosted" },
  { tab: "skills", labelKey: "skillsConfig.discovered" },
  { tab: "retry", labelKey: "retrySettings.maxRetries" },
  { tab: "about", labelKey: "appUpdate.title" },
  { tab: "about", labelKey: "piUpdate.title" },
  { tab: "about", labelKey: "settings.dataDirectory" },
]

/** Low-weight fallback text so synonyms and field labels locate the owning menu. */
const SETTINGS_SEARCH_DETAIL_KEYS: Record<SettingsTab, readonly string[]> = {
  general: ["settings.theme", "settings.runningBehaviorDesc", "settings.language"],
  shortcuts: [
    "shortcuts.actions.newSession",
    "shortcuts.actions.focusComposer",
    "shortcuts.actions.toggleSidebar",
    "shortcuts.actions.stop",
    "shortcuts.actions.forkLast",
    "shortcuts.actions.attachFile",
    "shortcuts.actions.terminal",
  ],
  workspace: ["openWith", "projectless", "sessionArchive.description"],
  notifications: [
    "settings.turnCompleteDesc",
    "settings.questionNotifyDesc",
    "settings.notifySoundDesc",
    "settings.soundDefault",
    "settings.soundNone",
  ],
  remote: [
    "settings.remoteDesc",
    "settings.remoteWarning",
    "settings.remotePort",
    "settings.remoteEnable",
    "settings.remoteDisable",
    "settings.remotePassword",
    "settings.remoteLinks",
  ],
  packages: ["packages"],
  models: [
    "settings.providers",
    "settings.models",
    "settings.providerAdd",
    "settings.providerId",
    "settings.providerName",
    "settings.providerBaseUrl",
    "settings.providerApi",
    "settings.providerApiKey",
    "settings.modelAdd",
    "settings.modelFetch",
    "settings.modelAdvancedJson",
  ],
  "model-config": ["titleGeneration"],
  "agent-config": ["agentConfig"],
  skills: ["skillsConfig"],
  retry: ["retrySettings"],
  about: ["settings.aboutBody", "appUpdate", "piUpdate", "settings.dataDirectory"],
}

const query = ref("")
const searchOpen = ref(false)
const selectedIndex = ref(0)
const searchRoot = ref<HTMLElement | null>(null)
onClickOutside(searchRoot, () => {
  searchOpen.value = false
})

interface SettingsSearchResult {
  tab: SettingsTab
  labelKey: string
  score: number
  snippet: string
  order: number
}

const searchEntries = computed<readonly SettingsSearchEntry[]>(() =>
  visibleTabs.value.flatMap(def => [
    { tab: def.id, labelKey: def.nav },
    ...SETTINGS_SEARCH_ENTRIES.filter(entry => entry.tab === def.id),
  ]),
)

const searchResults = computed<readonly SettingsSearchResult[]>(() => {
  if (!query.value.trim()) return []
  return searchEntries.value
    .map((entry, order): SettingsSearchResult | null => {
      const isMenuTitle = visibleTabs.value.some(def => def.nav === entry.labelKey)
      const tab = visibleTabs.value.find(def => def.id === entry.tab)!
      const hit = scoreSettingsSearch(query.value, {
        title: t(entry.labelKey),
        category: `${t(settingsGroupForTab(entry.tab).labelKey)} ${t(tab.nav)}`,
        key: entry.labelKey,
        details: isMenuTitle
          ? SETTINGS_SEARCH_DETAIL_KEYS[entry.tab].map(key => settingsSearchText(tm(key))).join(" ")
          : "",
      })
      return hit ? { ...entry, ...hit, order } : null
    })
    .filter((entry): entry is SettingsSearchResult => entry !== null)
    .sort((a, b) => b.score - a.score || a.order - b.order)
})

watch(query, () => {
  selectedIndex.value = 0
  searchOpen.value = true
})

function moveSelection(delta: number) {
  if (!searchResults.value.length) return
  searchOpen.value = true
  selectedIndex.value = (selectedIndex.value + delta + searchResults.value.length) % searchResults.value.length
  void nextTick(() => searchRoot.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }))
}

function locateSetting(entry = searchResults.value[selectedIndex.value]) {
  if (!entry) return
  navigate(`/settings/${entry.tab}`)
  searchOpen.value = false
}
</script>

<template>
  <div
    class="settings-page relative flex-1 min-h-0 grid [grid-template-columns:var(--settings-nav-width)_minmax(0,_1fr)] overflow-hidden max-[640px]:[grid-template-columns:125px_minmax(0,_1fr)]"
    :style="{ '--settings-nav-width': navWidth }"
  >
    <nav
      ref="nav"
      class="settings-nav bg-sidebar border-r border-border relative pt-5 pr-2 pb-7 pl-3.5 flex flex-col gap-[5px] min-h-0 min-w-0 max-[640px]:py-6 max-[640px]:px-2"
      :aria-label="t('settings.nav')"
    >
      <button
        type="button"
        class="settings-nav-resize-handle absolute inset-y-0 right-0 z-[2] hidden w-[7px] cursor-col-resize [touch-action:none] focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px] min-[641px]:block"
        :class="{ 'is-dragging': navDragging }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('settings.resizeNav')"
        :title="t('settings.resizeNav')"
        :aria-valuenow="Math.round(currentNavWidth)"
        :aria-valuemin="Math.round(navWidthBounds.min)"
        :aria-valuemax="Math.round(navWidthBounds.max)"
        @pointerdown="startNavResize"
        @pointermove="resizeNav"
        @pointerup="stopNavResize"
        @pointercancel="stopNavResize"
        @lostpointercapture="stopNavResize"
        @keydown="resizeNavWithKeyboard"
      />
      <Button
        variant="ghost"
        size="sm"
        class="settings-back [align-self:flex-start] mt-0 mr-0 mb-1.5 ml-0 py-2.5 px-3 text-[13px] text-muted-foreground hover:bg-border hover:text-foreground"
        @click="goHome()"
      >
        <ArrowLeft :size="16" />
        {{ t("settings.back") }}
      </Button>
      <h2 class="px-3 pb-3.5 text-base font-semibold">{{ t("settings.title") }}</h2>
      <div ref="searchRoot" class="relative mb-3.5 px-0.5" @keydown.esc="searchOpen = false">
        <Search :size="14" class="pointer-events-none absolute top-2.5 left-2.5 text-muted-foreground" />
        <Input
          v-model="query"
          class="h-8 pr-2 pl-8 text-xs"
          :placeholder="t('settings.searchPlaceholder')"
          :aria-label="t('settings.searchPlaceholder')"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="settings-search-results"
          :aria-expanded="searchOpen && !!query.trim()"
          :aria-activedescendant="searchOpen && searchResults.length ? `settings-result-${selectedIndex}` : undefined"
          @focus="searchOpen = true"
          @keydown.down.prevent="moveSelection(1)"
          @keydown.up.prevent="moveSelection(-1)"
          @keydown.enter.prevent="locateSetting()"
        />
        <div
          v-if="searchOpen && query.trim()"
          id="settings-search-results"
          role="listbox"
          :aria-label="t('settings.searchPlaceholder')"
          class="border-border bg-popover text-popover-foreground absolute top-full left-0 z-50 mt-1 max-h-80 w-64 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-md border p-1 shadow-md"
        >
          <button
            v-for="(result, index) in searchResults"
            :id="`settings-result-${index}`"
            :key="`${result.tab}:${result.labelKey}`"
            type="button"
            role="option"
            :aria-selected="selectedIndex === index"
            class="hover:bg-border flex w-full flex-col rounded-[7px] px-2.5 py-2 text-left text-[13px]"
            :class="{ 'bg-border': selectedIndex === index }"
            @click="locateSetting(result)"
          >
            <span class="line-clamp-1">{{ t(result.labelKey) }}</span>
            <span v-if="result.snippet" class="text-muted-foreground line-clamp-2 text-xs">{{ result.snippet }}</span>
            <span class="text-muted-foreground/70 line-clamp-1 text-xs">
              {{ t(settingsGroupForTab(result.tab).labelKey) }} ·
              {{ t(visibleTabs.find(def => def.id === result.tab)!.nav) }}
            </span>
          </button>
          <p class="text-muted-foreground px-2.5 py-3 text-sm" v-if="!searchResults.length">
            {{ t("settings.searchEmpty") }}
          </p>
        </div>
      </div>
      <ScrollArea class="settings-menu min-h-0 flex-1" viewport-class="pr-4">
        <section v-for="group in visibleGroups" :key="group.id" class="mb-2 last:mb-0">
          <p
            class="text-muted-foreground px-3 pt-3 pb-1 text-[11px] font-medium tracking-[0.04em] uppercase first:pt-0"
          >
            {{ t(group.labelKey) }}
          </p>
          <ul class="[list-style:none] m-0 p-0 flex flex-col gap-[5px] w-full">
            <li v-for="def in group.tabs" :key="def.id">
              <Button
                variant="quiet"
                size="content"
                class="w-full justify-start rounded-[7px] px-3 py-2.5 text-left text-[13px] text-foreground hover:bg-border"
                :class="{ 'bg-border': active.id === def.id }"
                @click="navigate(`/settings/${def.id}`)"
              >
                {{ t(def.nav) }}
              </Button>
            </li>
          </ul>
        </section>
      </ScrollArea>
    </nav>
    <ScrollArea :key="active.id" class="settings-scroll min-h-0 h-full">
      <div class="settings-body min-w-0 py-9.5 px-9 wrap-anywhere max-[640px]:py-9.5 max-[640px]:px-4.5">
        <header class="settings-header mb-7.5 text-left">
          <h1 class="text-lg font-semibold">{{ t(active.title) }}</h1>
          <p v-if="active.desc" class="mt-1.5 text-xs text-muted-foreground">{{ t(active.desc) }}</p>
        </header>
        <component :is="active.component" v-bind="active.needsProject ? { project: props.project } : {}" />
      </div>
    </ScrollArea>
  </div>
</template>

<style scoped>
.settings-nav-resize-handle::after {
  content: "";
  position: absolute;
  inset: 0 0 0 auto;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}

.settings-nav-resize-handle:hover::after,
.settings-nav-resize-handle:focus-visible::after,
.settings-nav-resize-handle.is-dragging::after {
  background: var(--primary);
}
</style>
