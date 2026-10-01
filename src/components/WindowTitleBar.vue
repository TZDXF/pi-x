<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue"
import { useI18n } from "vue-i18n"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { ChevronLeft, ChevronRight, Code, Folder, PanelLeft, PanelRight, Settings, SquareTerminal } from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
  type EditorIconMap,
  type EditorKind,
} from "@/lib/openWith"
import { useUiStore } from "@/stores/conversations"

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

// ---- 从标题栏在外部打开当前会话的项目 ----
const ui = useUiStore()
const editorAvailability = ref<Record<string, boolean>>({})
const editorsDetected = ref(false)
const editorIcons = ref<EditorIconMap>({})
const openingProject = ref(false)

const openInEditorVisible = computed(() => isDesktop && !!props.showOpenInEditor && !!props.openInEditorProject)
// 与设置页一致：检测成功后隐藏未检测到的 IDE；配置过自定义 IDE 时追加该项
const editorMenuItems = computed<{ id: EditorKind; label: string }[]>(() => {
  const items: { id: EditorKind; label: string }[] = EDITOR_OPTIONS.filter(
    option => !editorsDetected.value || editorAvailability.value[option.id] !== false,
  ).map(option => ({ id: option.id, label: option.label }))
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

const openInEditor = (kind: EditorKind) => runProjectAction(project => openProjectInEditor(project, kind))
const openInExplorer = () => runProjectAction(project => openPath(project))
const openInTerminal = () => runProjectAction(project => openTerminalInDir(project))

// 图标提取较慢，首次展开菜单时才拉取（后端有缓存）
function onEditorMenuOpen(open: boolean) {
  if (!open) return
  void detectIcons().then(map => {
    editorIcons.value = map
  })
}
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
      <DropdownMenu v-if="openInEditorVisible" @update:open="onEditorMenuOpen">
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="titlebar-control"
            :disabled="openingProject"
            :title="t('openWith.openExternal')"
            :aria-label="t('openWith.openExternal')"
          >
            <Code :size="16" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="min-w-56">
          <DropdownMenuItem :disabled="openingProject" @click="openInExplorer">
            <Folder :size="16" class="shrink-0" />
            <span class="min-w-0 truncate">{{ t("openWith.openInExplorer") }}</span>
          </DropdownMenuItem>
          <DropdownMenuItem :disabled="openingProject" @click="openInTerminal">
            <SquareTerminal :size="16" class="shrink-0" />
            <span class="min-w-0 truncate">{{ t("openWith.openInTerminal") }}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{{ t("openWith.openProjectTitle") }}</DropdownMenuLabel>
          <DropdownMenuItem
            v-for="option in editorMenuItems"
            :key="option.id"
            :disabled="openingProject"
            @click="openInEditor(option.id)"
          >
            <img v-if="editorIcons[option.id]" :src="editorIcons[option.id]!" class="size-4 shrink-0" alt="" />
            <span class="min-w-0 truncate">{{ option.label }}</span>
          </DropdownMenuItem>
          <DropdownMenuItem v-if="editorMenuItems.length === 0" disabled>
            {{ t("openWith.noEditorFound") }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Badge
        v-if="isDevelopment"
        variant="destructive"
        class="text-muted-foreground pointer-events-none mr-1 ml-1 select-none border-destructive/20 bg-transparent text-[10px] dark:border-destructive/30 dark:text-destructive"
      >
        {{ t("app.development") }}
      </Badge>
    </div>
    <div data-tauri-drag-region class="h-full min-w-0 flex-1" @dblclick="toggleMaximize"></div>
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
.titlebar-close:hover {
  background: #e81123;
  color: #fff;
}
</style>
