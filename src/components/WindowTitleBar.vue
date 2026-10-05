<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getCurrentWindow } from "@tauri-apps/api/window"
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleArrowUp,
  Code,
  Folder,
  PanelLeft,
  PanelRight,
  Settings,
  SquareTerminal,
} from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { isDesktop } from "@/api/transport"
import { openPath, openTerminalInDir } from "@/api/piClient"
import { canGoBack, canGoForward, navigate, useRoute } from "@/lib/router"
import {
  detectEditors,
  detectIcons,
  EDITOR_OPTIONS,
  openProjectInEditor,
  openWithPreference,
  setOpenWith,
  type EditorIconMap,
  type EditorKind,
} from "@/lib/openWith"
import { useUiStore } from "@/stores/conversations"
import { useAppUpdateStore } from "@/stores/appUpdate"

const props = defineProps<{
  sidebarOpen?: boolean
  rightSidebarOpen?: boolean
  showRightSidebar?: boolean
  showOpenInEditor?: boolean
  openInEditorProject?: string
}>()
const emit = defineEmits<{ toggleSidebar: []; toggleRightSidebar: [] }>()

const { t } = useI18n()
const route = useRoute()
const isDevelopment = import.meta.env.DEV
const appWindow = isDesktop ? getCurrentWindow() : null
const maximized = ref(false)
const maximizable = ref(true)
let unlistenResized: (() => void) | null = null

async function refreshWindowState() {
  if (!appWindow) return
  const [isMaximized, canMaximize] = await Promise.all([appWindow.isMaximized(), appWindow.isMaximizable()])
  maximized.value = isMaximized
  maximizable.value = canMaximize
}

onMounted(async () => {
  if (!appWindow) return
  unlistenResized = await appWindow.onResized(refreshWindowState)
  await refreshWindowState()
  // 标题栏 IDE 列表：检测失败（如远程模式）时保持全列表展示
  try {
    editorAvailability.value = await detectEditors()
    editorsDetected.value = true
  } catch {
    /* keep the full list */
  }
  // 图标提取较慢（后端有缓存），后台拉取
  void detectIcons().then(map => {
    editorIcons.value = map
  })
})

onUnmounted(() => {
  unlistenResized?.()
  unlistenResized = null
})

function goBack() {
  window.history.back()
}

function goForward() {
  window.history.forward()
}

function minimize() {
  void appWindow?.minimize()
}

function toggleMaximize() {
  void appWindow?.toggleMaximize()
}

function close() {
  void appWindow?.close()
}

// ---- 标题栏打开方式：左键按默认方式打开，右侧下拉切换默认并与设置页同步 ----
const ui = useUiStore()
const editorAvailability = ref<Record<string, boolean>>({})
const editorsDetected = ref(false)
const editorIcons = ref<EditorIconMap>({})
const openingProject = ref(false)

const openInEditorVisible = computed(() => isDesktop && !!props.showOpenInEditor && !!props.openInEditorProject)

const editorLabelOf = (kind: EditorKind) =>
  kind === "system" || kind === "custom"
    ? t(`openWith.${kind}`)
    : (EDITOR_OPTIONS.find(option => option.id === kind)?.label ?? kind)

const defaultKind = computed(() => openWithPreference.value.kind)
const defaultLabel = computed(() => editorLabelOf(defaultKind.value))
const defaultIcon = computed(() => editorIcons.value[defaultKind.value] ?? null)

// 与设置页一致：检测成功后隐藏未检测到的 IDE；始终保留系统默认与自定义项
const openWithMenuItems = computed<{ id: EditorKind; label: string }[]>(() => {
  const items: { id: EditorKind; label: string }[] = [{ id: "system", label: t("openWith.system") }]
  for (const option of EDITOR_OPTIONS) {
    if (!editorsDetected.value || editorAvailability.value[option.id] !== false)
      items.push({ id: option.id, label: option.label })
  }
  if (openWithPreference.value.kind === "custom" || openWithPreference.value.executable)
    items.push({ id: "custom", label: t("openWith.custom") })
  return items
})

async function runProjectAction(action: (project: string) => Promise<void>) {
  const project = props.openInEditorProject
  if (!project || openingProject.value) return
  openingProject.value = true
  try {
    await action(project)
  } catch (cause) {
    ui.pushToast(t("openWith.openProjectFailed", { error: String(cause) }), "error")
  } finally {
    openingProject.value = false
  }
}

const openWithKind = (kind: EditorKind, project: string) =>
  kind === "system" ? openPath(project) : openProjectInEditor(project, kind)
const openWithDefault = () => runProjectAction(project => openWithKind(defaultKind.value, project))
// 下拉选择即设为默认，设置页的“默认打开方式”随之变更
const chooseOpenWith = (kind: EditorKind) => {
  setOpenWith(kind)
  return runProjectAction(project => openWithKind(kind, project))
}
const openInTerminal = () => runProjectAction(project => openTerminalInDir(project))

// ---- 标题栏更新入口：启动自动检查发现新版本后展示，点击进入关于页 ----
const appUpdate = useAppUpdateStore()
const appUpdateAvailable = computed(() => !!appUpdate.status?.updateAvailable)
</script>

<template>
  <header
    data-testid="window-titlebar"
    class="fixed inset-x-0 top-0 z-[200] flex h-9 select-none items-center bg-background text-foreground shadow-[0_1px_0_var(--border)]"
  >
    <div class="flex h-full items-center">
      <button
        type="button"
        class="titlebar-control"
        :disabled="route.name === 'settings'"
        :title="props.sidebarOpen ? t('sidebar.collapse') : t('app.expandSidebar')"
        :aria-label="props.sidebarOpen ? t('sidebar.collapse') : t('app.expandSidebar')"
        @click="emit('toggleSidebar')"
      >
        <PanelLeft :size="16" />
      </button>
      <button
        type="button"
        class="titlebar-control"
        :disabled="!canGoBack"
        :title="t('app.goBack')"
        :aria-label="t('app.goBack')"
        @click="goBack"
      >
        <ChevronLeft :size="17" />
      </button>
      <button
        type="button"
        class="titlebar-control"
        :disabled="!canGoForward"
        :title="t('app.goForward')"
        :aria-label="t('app.goForward')"
        @click="goForward"
      >
        <ChevronRight :size="17" />
      </button>
      <button
        type="button"
        class="titlebar-control"
        :aria-current="route.name === 'settings' ? 'page' : undefined"
        :title="t('sidebar.settings')"
        :aria-label="t('sidebar.settings')"
        @click="navigate('/settings/general')"
      >
        <Settings :size="16" />
      </button>
      <button
        v-if="appUpdateAvailable"
        type="button"
        class="titlebar-control titlebar-update"
        :title="t('appUpdate.newVersion', { version: appUpdate.status?.version ?? '' })"
        :aria-label="t('appUpdate.newVersion', { version: appUpdate.status?.version ?? '' })"
        @click="navigate('/settings/about')"
      >
        <CircleArrowUp :size="16" />
      </button>
      <Badge
        v-if="isDevelopment"
        variant="destructive"
        class="text-muted-foreground pointer-events-none mr-1 ml-1 select-none border-destructive/20 bg-transparent text-[10px] dark:border-destructive/30 dark:text-destructive"
      >
        {{ t("app.development") }}
      </Badge>
    </div>
    <div data-tauri-drag-region class="h-full min-w-0 flex-1" @dblclick="toggleMaximize"></div>
    <div v-if="openInEditorVisible" class="flex h-full items-center">
      <button
        type="button"
        class="titlebar-control titlebar-open-main"
        :disabled="openingProject"
        :title="`${t('openWith.openProjectDefault')} · ${defaultLabel}`"
        :aria-label="t('openWith.openProjectDefault')"
        @click="openWithDefault"
      >
        <img v-if="defaultIcon" :src="defaultIcon" class="size-4 shrink-0" alt="" />
        <Code v-else :size="16" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="titlebar-control titlebar-open-trigger"
            :disabled="openingProject"
            :title="t('openWith.openExternal')"
            :aria-label="t('openWith.openExternal')"
          >
            <ChevronDown :size="14" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="min-w-56">
          <DropdownMenuItem
            v-for="option in openWithMenuItems"
            :key="option.id"
            :disabled="openingProject"
            @click="chooseOpenWith(option.id)"
          >
            <img v-if="editorIcons[option.id]" :src="editorIcons[option.id]!" class="size-4 shrink-0" alt="" />
            <Folder v-else-if="option.id === 'system'" :size="16" class="shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
            <Check v-if="option.id === defaultKind" class="ml-auto size-3.5 shrink-0" />
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem :disabled="openingProject" @click="openInTerminal">
            <SquareTerminal :size="16" class="shrink-0" />
            <span class="min-w-0 truncate">{{ t("openWith.openInTerminal") }}</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    <button
      v-if="showRightSidebar"
      type="button"
      class="titlebar-control"
      :title="t('sidebarTabs.toggle')"
      :aria-label="t('sidebarTabs.toggle')"
      :aria-expanded="rightSidebarOpen"
      @click="emit('toggleRightSidebar')"
    >
      <PanelRight :size="16" />
    </button>
    <div v-if="isDesktop" class="flex h-full items-center">
      <button
        type="button"
        class="titlebar-control"
        :title="t('app.windowMinimize')"
        :aria-label="t('app.windowMinimize')"
        @click="minimize"
      >
        <svg aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <path d="M0 5h10" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
      <button
        v-if="maximizable"
        type="button"
        class="titlebar-control"
        :title="maximized ? t('app.windowRestore') : t('app.windowMaximize')"
        :aria-label="maximized ? t('app.windowRestore') : t('app.windowMaximize')"
        @click="toggleMaximize"
      >
        <svg v-if="maximized" aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none" />
          <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" stroke-width="1" fill="none" />
        </svg>
        <svg v-else aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" stroke-width="1" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        class="titlebar-control titlebar-close"
        :title="t('app.windowClose')"
        :aria-label="t('app.windowClose')"
        @click="close"
      >
        <svg aria-hidden="true" viewBox="0 0 10 10" class="size-2.5">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" stroke-width="1" />
        </svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar-control {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 100%;
  color: var(--muted-foreground);
  transition:
    background-color 0.15s ease,
    color 0.15s ease;
}
.titlebar-control:hover:not(:disabled) {
  background: var(--accent);
  color: var(--accent-foreground);
}
.titlebar-control:disabled {
  color: color-mix(in srgb, var(--muted-foreground) 45%, transparent);
}
.titlebar-control:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -3px;
}
.titlebar-control[aria-current="page"] {
  color: var(--foreground);
}
.titlebar-update {
  color: var(--primary);
}
.titlebar-update:hover:not(:disabled) {
  color: var(--primary);
}
.titlebar-open-main {
  width: auto;
  padding: 0 11px;
}
.titlebar-open-trigger {
  width: 26px;
}
.titlebar-close:hover {
  background: #e81123;
  color: #fff;
}
</style>
