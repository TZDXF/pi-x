<script setup lang="ts">
/** Full-page workspace settings, routed via #/settings/:tab.
 *  Tabs are declared in ./settings/tabs.ts and lazy-loaded per route. */
import { computed, nextTick, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ArrowLeft, Search } from "@lucide/vue"
import { onClickOutside, useMediaQuery, useWindowSize } from "@vueuse/core"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { usePanelKeyboardResize, type ResizablePanelApi } from "@/composables/usePanelKeyboardResize"
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

/** Keep the default width aligned with the workspace sidebar (272px / `w-68`). */
const NAV_WIDTH_STORAGE_KEY = "pix.settings-nav-width"
const NARROW_NAV_WIDTH = 125
const preferredNavWidth = ref<number | null>(null)
try {
  const saved = Number(localStorage.getItem(NAV_WIDTH_STORAGE_KEY))
  if (Number.isFinite(saved) && saved > 0) preferredNavWidth.value = saved
} catch {
  /* Storage may be unavailable in restricted browsers. */
}

const { width: windowWidth } = useWindowSize()
const isNarrowViewport = useMediaQuery("(max-width: 640px)")
const navWidthBounds = computed(() =>
  isNarrowViewport.value
    ? { min: NARROW_NAV_WIDTH, max: NARROW_NAV_WIDTH }
    : { min: 220, max: Math.min(480, Math.max(280, windowWidth.value - 360)) },
)
function clampNavWidth(width: number) {
  const { min, max } = navWidthBounds.value
  return Math.min(max, Math.max(min, width))
}
/** reka 只在首次布局读取 default-size，之后由 min/max 约束与拖拽接管。 */
const defaultNavWidth = clampNavWidth(preferredNavWidth.value ?? 272)
const navWidthDisplay = ref(defaultNavWidth)
const navPanel = ref<ResizablePanelApi | null>(null)

function saveNavWidth() {
  if (preferredNavWidth.value === null) return
  try {
    localStorage.setItem(NAV_WIDTH_STORAGE_KEY, String(preferredNavWidth.value))
  } catch {
    /* Optional preference. */
  }
}

function onNavResize(width: number) {
  if (width <= 0 || isNarrowViewport.value) return
  navWidthDisplay.value = Math.round(width)
  preferredNavWidth.value = Math.round(width)
  saveNavWidth()
}

/** 回到宽屏时窄屏的 125px 定宽不再受约束，恢复为用户偏好的宽度。 */
watch(isNarrowViewport, narrow => {
  if (!narrow) navPanel.value?.resize(clampNavWidth(preferredNavWidth.value ?? defaultNavWidth))
})

const resizeNavWithKeyboard = usePanelKeyboardResize(navPanel, () => navWidthBounds.value)

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
  { tab: "general", labelKey: "settings.language" },
  { tab: "appearance", labelKey: "settings.theme" },
  { tab: "appearance", labelKey: "settings.terminalTheme" },
  { tab: "run-config", labelKey: "chat.runningBehavior" },
  { tab: "run-config", labelKey: "settings.processDetail" },
  { tab: "run-config", labelKey: "retrySettings.maxRetries" },
  { tab: "run-config", labelKey: "queueMode.title" },
  { tab: "shortcuts", labelKey: "settings.shortcutsTitle" },
  { tab: "notifications", labelKey: "settings.turnComplete" },
  { tab: "notifications", labelKey: "settings.questionNotify" },
  { tab: "notifications", labelKey: "settings.notifySound" },
  { tab: "remote", labelKey: "settings.remotePort" },
  { tab: "remote", labelKey: "settings.remotePassword" },
  { tab: "remote", labelKey: "settings.remoteLinks" },
  { tab: "ssh", labelKey: "ssh.nav" },
  { tab: "ssh", labelKey: "ssh.addConnection" },
  { tab: "ssh", labelKey: "ssh.testConnection" },
  { tab: "packages", labelKey: "packages.market" },
  { tab: "packages", labelKey: "packages.installed" },
  { tab: "packages", labelKey: "packages.customTitle" },
  { tab: "models", labelKey: "settings.providerAdd" },
  { tab: "models", labelKey: "settings.modelAdd" },
  { tab: "models", labelKey: "settings.modelFetch" },
  { tab: "model-config", labelKey: "titleGeneration.defaultModel" },
  { tab: "model-config", labelKey: "titleGeneration.enabled" },
  { tab: "model-config", labelKey: "translation.model" },
  { tab: "agent-config", labelKey: "agentConfig.files" },
  { tab: "skills", labelKey: "skillsConfig.hosted" },
  { tab: "skills", labelKey: "skillsConfig.discovered" },
  { tab: "mcp", labelKey: "mcpConfig.refresh" },
  { tab: "mcp", labelKey: "mcpConfig.addServer" },
  { tab: "general", labelKey: "settings.language" },
  { tab: "archives", labelKey: "sessionArchive.restore" },
  { tab: "archives", labelKey: "sessionArchive.delete" },
  { tab: "about", labelKey: "appUpdate.title" },
  { tab: "about", labelKey: "piUpdate.title" },
  { tab: "about", labelKey: "settings.dataDirectory" },
]

/** Low-weight fallback text so synonyms and field labels locate the owning menu. */
const SETTINGS_SEARCH_DETAIL_KEYS: Record<SettingsTab, readonly string[]> = {
  general: [
    "settings.workspace",
    "openWith",
    "workspace.worktreeDirLabel",
    "workspace.worktreeDirDesc",
    "projectless",
    "settings.language",
  ],
  appearance: ["settings.theme", "settings.terminalTheme", "settings.terminalThemeDesc"],
  "run-config": [
    "settings.runningBehaviorDesc",
    "settings.processDetail",
    "settings.processDetailDesc",
    "retrySettings",
    "queueMode",
  ],
  shortcuts: [
    "shortcuts.actions.newSession",
    "shortcuts.actions.focusComposer",
    "shortcuts.actions.toggleSidebar",
    "shortcuts.actions.stop",
    "shortcuts.actions.forkLast",
    "shortcuts.actions.attachFile",
    "shortcuts.actions.terminal",
  ],
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
  ssh: ["ssh.desc", "ssh.connectionsHint", "ssh.addConnection", "ssh.testConnection", "ssh.host", "ssh.keyPath"],
  packages: ["packages"],
  "package-resources": ["packages"],
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
  mcp: ["mcpConfig"],
  archives: ["sessionArchive"],
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
  <ResizablePanelGroup direction="horizontal" class="settings-page relative flex-1 min-h-0 overflow-hidden">
    <ResizablePanel
      ref="navPanel"
      size-unit="px"
      :default-size="defaultNavWidth"
      :min-size="navWidthBounds.min"
      :max-size="navWidthBounds.max"
      @resize="onNavResize"
    >
      <nav
        class="settings-nav h-full bg-sidebar border-r border-border relative pt-5 pr-2 pb-7 pl-3.5 flex flex-col gap-[5px] min-h-0 min-w-0 max-[640px]:py-6 max-[640px]:px-2"
        :aria-label="t('settings.nav')"
      >
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
    </ResizablePanel>
    <ResizableHandle
      class="settings-nav-resize-handle bg-transparent max-[640px]:hidden"
      :aria-label="t('settings.resizeNav')"
      :title="t('settings.resizeNav')"
      :aria-valuenow="navWidthDisplay"
      :aria-valuemin="navWidthBounds.min"
      :aria-valuemax="navWidthBounds.max"
      @keydown="resizeNavWithKeyboard"
    />
    <ResizablePanel class="min-h-0">
      <!-- Resource previews own their scroll areas instead of scrolling the entire settings body. -->
      <component
        :is="active.id === 'package-resources' ? 'div' : ScrollArea"
        :key="active.id"
        class="settings-scroll h-full min-h-0"
        :class="{ 'overflow-hidden': active.id === 'package-resources' }"
      >
        <div
          class="settings-body min-w-0 py-9.5 px-9 wrap-anywhere max-[640px]:py-9.5 max-[640px]:px-4.5"
          :class="{ 'flex h-full min-h-0 flex-col overflow-hidden': active.id === 'package-resources' }"
        >
          <header class="settings-header mb-7.5 shrink-0 text-left">
            <h1 class="text-lg font-semibold">{{ t(active.title) }}</h1>
            <p v-if="active.desc" class="mt-1.5 text-xs text-muted-foreground">{{ t(active.desc) }}</p>
          </header>
          <component :is="active.component" v-bind="active.needsProject ? { project: props.project } : {}" />
        </div>
      </component>
    </ResizablePanel>
  </ResizablePanelGroup>
</template>

<style scoped>
/* reka 手柄本体只有 1px，用 ::before 扩大命中区而不占布局空间。 */
.settings-nav-resize-handle {
  position: relative;
  z-index: 2;
  touch-action: none;
}

.settings-nav-resize-handle::before {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  right: -3px;
}

.settings-nav-resize-handle::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  left: -1px;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}

.settings-nav-resize-handle:hover::after,
.settings-nav-resize-handle:focus-visible::after,
.settings-nav-resize-handle[data-resize-handle-state="drag"]::after,
.settings-nav-resize-handle[data-resize-handle-active="keyboard"]::after {
  background: var(--primary);
}
</style>
