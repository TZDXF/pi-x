<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { VueDraggable } from "vue-draggable-plus"
import {
  Clock,
  Layers,
  Copy,
  Folder,
  FolderPlus,
  Link,
  Plus,
  Search,
  Archive,
  AlertTriangle,
  Pencil,
  MoreHorizontal,
  Pin,
  PinOff,
  FolderOpen,
  X,
  FileDown,
} from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import { parseCodedError } from "@/lib/backendError"
import { duplicateSessionFile, openPath, type SessionMeta } from "@/api/piClient"
import type { QueuedPrompt } from "@/stores/session"
import { sendCountdown } from "@/lib/sendCountdown"
import { pendingConversations } from "@/lib/pendingConversations"
import { useCountdownNow } from "@/composables/useCountdownNow"
import { copyWithToast } from "@/lib/clipboard"
import { allConversations, activeRuntimeId, findConversation, useSessionStore } from "@/stores/conversations"
import { sessionRunStatus } from "@/stores/sessionRunStatus"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
import { useRoute } from "@/lib/router"
const props = defineProps<{ project: string; ready: boolean; busy: boolean; navigationBusy?: boolean }>()
const emit = defineEmits<{
  selectConversation: [runtimeId: string]
  switchProject: []
  selectProject: [path: string]
  resumeSession: [file: string, project: string]
  removeProject: [project: string]
  editProject: [project: string]
  projectless: []
  newSession: [project: string]
  sessionAction: [file: string, action: "export"]
  schedules: []
}>()
const session = useSessionStore()
const ui = useUiStore()
const workspace = useWorkspaceStore()
const { t } = useI18n()
const route = useRoute()
const query = ref("")
const collapsed = ref<Record<string, boolean>>({})
const errors = ref<Record<string, string>>({})
const loading = ref<Record<string, boolean>>({})
const tasksCollapsed = ref(false)
const projectsCollapsed = ref(false)
const renaming = ref<SessionMeta | null>(null)
const title = ref("")
const saving = ref(false)
/** 归档中的会话：先从列表中隐藏，请求失败时自动撤回 */
const archiving = ref<Record<string, boolean>>({})
const navigationDisabled = computed(() => props.navigationBusy || workspace.gitBusy || saving.value)
const disabled = computed(() => props.busy || workspace.gitBusy || saving.value)
const name = (path: string) => workspace.projectName(path)
const label = (s: SessionMeta) => s.title || s.preview || t("sidebar.untitled")
function rows(path: string) {
  const sessions = workspace.orderedSessions(path)
  return sessions.filter(
    s =>
      !s.archived &&
      !archiving.value[s.file] &&
      `${label(s)} ${s.id}`.toLowerCase().includes(query.value.toLowerCase()),
  )
}
function pendingRows(path: string) {
  return pendingConversations(
    allConversations(),
    workspace.projectFolders(path),
    workspace.orderedSessions(path).map(row => row.file),
    query.value,
  )
}
const taskPath = computed(() => workspace.projectless)
const visibleProjects = computed(() =>
  projectsCollapsed.value ? [] : workspace.orderedProjects().filter(p => !workspace.isProjectless(p)),
)
const queueNow = useCountdownNow(() =>
  allConversations().some(conversation => conversation.promptQueue.some(item => item.sendAt !== undefined)),
)
function queueTitle(queue: QueuedPrompt[] | undefined) {
  const nextSendAt =
    queue?.reduce(
      (earliest, item) => (item.sendAt === undefined ? earliest : Math.min(earliest, item.sendAt)),
      Infinity,
    ) ?? Infinity
  return Number.isFinite(nextSendAt)
    ? `${t("chat.queuedPrompts")} · ${t("chat.sendCountdown", { time: sendCountdown(nextSendAt, queueNow.value) })}`
    : t("chat.queuedPrompts")
}
async function openProjectFolder(path: string) {
  try {
    await openPath(path)
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
async function refresh(path: string) {
  loading.value[path] = true
  errors.value[path] = ""
  try {
    await workspace.refresh(path)
  } catch (error) {
    const code = parseCodedError(String(error).replace(/^Error: /, ""))?.code
    errors.value[path] = code === "projectDirMissing" ? "missing" : "failed"
  } finally {
    loading.value[path] = false
  }
}
function rename(s: SessionMeta) {
  renaming.value = s
  title.value = label(s)
}
function copySessionLink(s: SessionMeta) {
  return copyWithToast(ui, s.file, t("workspace.linkCopied"))
}
async function duplicateSession(s: SessionMeta) {
  try {
    await duplicateSessionFile(s.file)
    ui.pushToast(t("workspace.duplicated"), "info")
    await workspace.refresh(props.project)
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
let openTimer: ReturnType<typeof setTimeout> | undefined
function openSession(s: SessionMeta) {
  clearTimeout(openTimer)
  openTimer = setTimeout(() => {
    emit("resumeSession", s.file, s.cwd)
    openTimer = undefined
  }, 250)
}
function renameOnDoubleClick(s: SessionMeta) {
  clearTimeout(openTimer)
  openTimer = undefined
  if (!navigationDisabled.value) rename(s)
}
onBeforeUnmount(() => {
  clearTimeout(openTimer)
})
async function saveTitle() {
  if (!renaming.value || !title.value.trim() || saving.value) return
  saving.value = true
  try {
    await workspace.update(renaming.value, title.value.trim(), !!renaming.value.archived)
    renaming.value = null
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    saving.value = false
  }
}
async function archive(s: SessionMeta) {
  if (disabled.value || archiving.value[s.file]) return
  // 先隐藏行，后端写入完成前列表保持可用；失败时清掉标记自动回滚
  archiving.value[s.file] = true
  try {
    await workspace.update(s, s.title || null, !s.archived)
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    delete archiving.value[s.file]
  }
}

// ---- drag & drop ordering（VueDraggable/Sortable 接管；整行可拖，无把手图标）----
/** 统一起拖载荷：主界面 @引用 读取 x-pix-session，分屏投放读取 x-pix-session-drag。 */
// Sortable 的 start 异步触发；必须在原生 dragstart 的 setData 回调中写入载荷。
function setSessionDragData(transfer: DataTransfer, item: HTMLElement) {
  const file = item.dataset.file
  const path = item.dataset.path
  if (!file || !path) return
  transfer.effectAllowed = "copyMove"
  transfer.setData("application/x-pix-session", file)
  transfer.setData("text/plain", file)
  transfer.setData(
    "application/x-pix-session-drag",
    JSON.stringify({ file, path, runtimeId: findConversation(file)?.runtimeId }),
  )
}
function onProjectDragStart(event: { item?: HTMLElement; originalEvent?: DragEvent }) {
  const path = event.item?.dataset.path
  const transfer = event.originalEvent?.dataTransfer
  if (!path || !transfer) return
  transfer.effectAllowed = "move"
  transfer.setData("text/plain", path)
}
/** 供 Sortable 绑定的有序会话文件列表：不含查询过滤，排序只在查询为空时可用。 */
function orderedSessionFiles(path: string) {
  return workspace
    .orderedSessions(path)
    .filter(s => !s.archived && !archiving.value[s.file])
    .map(s => s.file)
}
watch(
  () => props.project,
  path => {
    void workspace.rememberWorkspace(path)
    if (path) void refresh(path)
  },
  { immediate: true },
)
watch(
  () => [props.ready, session.sessionFile, session.isStreaming],
  () => {
    if (props.ready && !session.isStreaming && props.project) void refresh(props.project)
  },
)
for (const path of workspace.projects.flatMap(project => workspace.projectFolders(project)))
  void workspace.rememberWorkspace(path)
watch(
  () => workspace.projects.flatMap(path => workspace.projectFolders(path)),
  folders => {
    for (const folder of new Set(folders)) void refresh(folder)
  },
  { immediate: true },
)
</script>

<template>
  <aside
    class="workspace-sidebar h-full w-full flex flex-col bg-sidebar border-r border-border pt-3.5 pr-[7px] pb-2 pl-[7px] min-h-0 overflow-hidden max-[640px]:absolute max-[640px]:[inset:0_auto_0_0] max-[640px]:z-[30] max-[640px]:shadow-[var(--sidebar-shadow)] max-[640px]:w-55"
    :aria-label="t('sidebar.ariaLabel')"
  >
    <Button
      size="content"
      variant="sidebar-action"
      class="sidebar-action"
      :disabled="!ready || navigationDisabled"
      @click="emit('newSession', project)"
      ><Plus :size="17" class="size-auto shrink-0" />{{ t("sidebar.newSession") }}</Button
    >
    <Button
      v-if="isDesktop"
      size="content"
      variant="sidebar-action"
      class="sidebar-action"
      :aria-current="route.name === 'schedules' ? 'page' : undefined"
      @click="emit('schedules')"
      ><Clock :size="17" class="size-auto shrink-0" />{{ t("schedules.title") }}</Button
    >
    <label class="sidebar-search flex items-center gap-2.5 text-muted-foreground py-1.5 px-2.5 mb-1.5 shrink-0"
      ><Search :size="15" class="size-auto shrink-0" /><Input
        v-model="query"
        :placeholder="t('sidebar.search')"
        :aria-label="t('sidebar.search')"
        class="h-auto border-0 bg-transparent px-0 text-xs focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
    /></label>
    <ScrollArea class="project-groups flex-1 min-h-0 min-w-0 -mr-[7px]" viewportClass="pr-[7px]">
      <section class="project-section mb-1.5 min-w-0 max-w-full">
        <div class="sidebar-section-label flex items-center justify-between gap-1 py-[2px] pl-1 pr-1 shrink-0">
          <Button
            variant="quiet"
            size="content"
            class="section-toggle min-w-0 flex-1 justify-start rounded-md px-1.5 py-[5px] text-xs font-semibold tracking-[0.02em]"
            :aria-expanded="!projectsCollapsed"
            @click="projectsCollapsed = !projectsCollapsed"
            ><span class="truncate">{{ t("sidebar.projects") }}</span></Button
          >
          <Button
            variant="quiet"
            size="toolbar"
            class="hover-action opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
            :disabled="navigationDisabled"
            :title="t('sidebar.openProject')"
            :aria-label="t('sidebar.openProject')"
            @click="emit('switchProject')"
            ><FolderPlus :size="15" class="size-auto shrink-0"
          /></Button>
        </div>
        <VueDraggable
          tag="div"
          class="project-list"
          :model-value="visibleProjects"
          :animation="150"
          :disabled="disabled"
          draggable=".project-group"
          chosen-class="drag-source"
          @start="onProjectDragStart"
          @update:model-value="(next: string[]) => workspace.reorderProjects(next)"
        >
          <section v-for="path in visibleProjects" :key="path" class="project-group mb-1 min-w-0 max-w-full">
            <ContextMenu>
              <ContextMenuTrigger as-child :disabled="disabled">
                <div
                  class="project-heading relative flex items-center min-h-8 rounded-md pr-1 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)]"
                  :class="{
                    selected: path === workspace.projectRoot(project),
                    'drag-cursor': !disabled,
                  }"
                  :data-path="path"
                >
                  <Button
                    size="content"
                    variant="project-row"
                    class="project-row"
                    :title="path"
                    :aria-expanded="!collapsed[path]"
                    @click="collapsed[path] = !collapsed[path]"
                  >
                    <FolderOpen v-if="!collapsed[path]" :size="15" class="size-auto shrink-0" /><Folder
                      v-else
                      :size="15"
                      class="size-auto shrink-0"
                    /><span class="truncate">{{ name(path) }}</span>
                    <AlertTriangle
                      v-if="errors[path] === 'missing'"
                      :size="14"
                      class="size-auto shrink-0 text-amber-600 dark:text-amber-400"
                      :aria-label="t('sidebar.projectDirMissing')"
                      :title="t('sidebar.projectDirMissing')"
                    />
                  </Button>
                  <Button
                    variant="quiet"
                    size="row-action"
                    class="hover-action opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
                    :disabled="navigationDisabled || (!ready && path === project)"
                    :title="t('sidebar.newSession')"
                    :aria-label="`${t('sidebar.newSession')} · ${name(path)}`"
                    @click="emit('newSession', path)"
                    ><Plus :size="16" class="size-auto shrink-0"
                  /></Button>
                  <Pin
                    v-if="workspace.pinnedProjects.includes(path)"
                    :size="12"
                    class="size-auto shrink-0 project-pin shrink-0 text-muted-foreground"
                    :aria-label="t('workspace.pinned')"
                  />
                  <DropdownMenu>
                    <DropdownMenuTrigger as-child
                      ><Button
                        variant="quiet"
                        size="row-action"
                        class="project-more hover-action w-6 h-6.5 opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
                        :disabled="disabled"
                        :title="t('workspace.projectActions')"
                        :aria-label="`${t('workspace.projectActions')} · ${name(path)}`"
                        ><MoreHorizontal :size="16" class="size-auto shrink-0" /></Button
                    ></DropdownMenuTrigger>
                    <DropdownMenuContent align="start" side="bottom" class="w-auto">
                      <DropdownMenuItem @select="workspace.togglePin(path)"
                        ><PinOff
                          v-if="workspace.pinnedProjects.includes(path)"
                          :size="14"
                          class="size-auto shrink-0"
                        /><Pin v-else :size="14" class="size-auto shrink-0" />{{
                          workspace.pinnedProjects.includes(path) ? t("workspace.unpin") : t("workspace.pin")
                        }}</DropdownMenuItem
                      >
                      <DropdownMenuItem @select="emit('editProject', path)"
                        ><Pencil :size="14" class="size-auto shrink-0" />{{
                          t("projectDialog.editTitle")
                        }}</DropdownMenuItem
                      >
                      <DropdownMenuItem
                        :disabled="!isDesktop"
                        :title="!isDesktop ? t('workspace.desktopOnly') : undefined"
                        @select="openProjectFolder(path)"
                        ><FolderOpen :size="14" class="size-auto shrink-0" />{{
                          t("workspace.openExplorer")
                        }}</DropdownMenuItem
                      >
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        class="text-destructive"
                        :title="t('workspace.removeProjectHint')"
                        @select="emit('removeProject', path)"
                        ><X :size="14" />{{ t("workspace.removeProject") }}</DropdownMenuItem
                      >
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                ><ContextMenuItem @select="workspace.togglePin(path)"
                  ><PinOff v-if="workspace.pinnedProjects.includes(path)" :size="14" class="size-auto shrink-0" /><Pin
                    v-else
                    :size="14"
                    class="size-auto shrink-0"
                  />{{
                    workspace.pinnedProjects.includes(path) ? t("workspace.unpin") : t("workspace.pin")
                  }}</ContextMenuItem
                ><ContextMenuItem @select="emit('editProject', path)"
                  ><Pencil :size="14" class="size-auto shrink-0" />{{ t("projectDialog.editTitle") }}</ContextMenuItem
                ><ContextMenuItem
                  :disabled="!isDesktop"
                  :title="!isDesktop ? t('workspace.desktopOnly') : undefined"
                  @select="openProjectFolder(path)"
                  ><FolderOpen :size="14" class="size-auto shrink-0" />{{
                    t("workspace.openExplorer")
                  }}</ContextMenuItem
                ><ContextMenuSeparator /><ContextMenuItem
                  class="text-destructive"
                  :title="t('workspace.removeProjectHint')"
                  @select="emit('removeProject', path)"
                  ><X :size="14" />{{ t("workspace.removeProject") }}</ContextMenuItem
                ></ContextMenuContent
              >
            </ContextMenu>
            <p
              v-if="!collapsed[path] && errors[path] === 'missing'"
              role="alert"
              class="flex items-center gap-2 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
            >
              <AlertTriangle :size="14" class="shrink-0" />{{ t("sidebar.projectDirMissing") }}
            </p>
            <div
              v-if="!collapsed[path] && errors[path] !== 'missing'"
              class="session-list min-h-0 p-0 overflow-visible"
            >
              <div
                v-if="
                  path === workspace.projectRoot(project) &&
                  ready &&
                  !session.sessionFile &&
                  !session.promptQueue.length &&
                  (session.started || session.entries.length) &&
                  !query
                "
                class="session-row active flex items-center gap-0.5 w-full pt-0 pr-1 pb-0 pl-7 rounded-md text-xs text-left relative min-h-8 m-0 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)] [@media(pointer:coarse)]:min-h-9"
                aria-current="page"
              >
                <Layers
                  v-if="workspace.isWorktree(project)"
                  :size="13"
                  class="shrink-0 text-muted-foreground"
                  role="img"
                  :aria-label="t('workspace.worktree')"
                  :title="t('workspace.worktree')"
                />
                <span class="truncate">{{ t("chat.newSession") }}</span>
              </div>
              <div
                v-for="pending in pendingRows(path)"
                :key="pending.runtimeId"
                class="session-row relative flex min-h-8 min-w-0 items-center gap-1 rounded-md pl-7 pr-2 text-xs"
                :class="{ active: pending.runtimeId === activeRuntimeId }"
              >
                <span
                  class="session-queue-status absolute left-[7px] top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
                  role="status"
                  :title="queueTitle(pending.promptQueue)"
                  :aria-label="queueTitle(pending.promptQueue)"
                  ><Clock class="size-3"
                /></span>
                <Layers
                  v-if="workspace.isWorktree(pending.cwd)"
                  :size="13"
                  class="shrink-0 text-muted-foreground"
                  role="img"
                  :aria-label="t('workspace.worktree')"
                  :title="t('workspace.worktree')"
                />
                <Button
                  size="content"
                  variant="session-link"
                  class="session-link"
                  :disabled="navigationDisabled"
                  :aria-current="pending.runtimeId === activeRuntimeId ? 'page' : undefined"
                  :title="pending.promptQueue[0]?.text || t('chat.newSession')"
                  @click="emit('selectConversation', pending.runtimeId)"
                  >{{ pending.promptQueue[0]?.text || t("chat.newSession") }}</Button
                >
              </div>
              <VueDraggable
                tag="div"
                :model-value="orderedSessionFiles(path)"
                :animation="150"
                :disabled="disabled || !!query"
                chosen-class="drag-source"
                :set-data="setSessionDragData"
                @update:model-value="(next: string[]) => workspace.reorderSessions(path, next)"
              >
                <ContextMenu v-for="s in rows(path)" :key="s.file">
                  <ContextMenuTrigger as-child :disabled="disabled">
                    <div
                      class="session-row group/session flex items-center gap-0.5 w-full pt-0 pr-1 pb-0 rounded-md text-xs text-left relative min-h-8 m-0 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)] [@media(pointer:coarse)]:min-h-9"
                      :aria-current="s.file === session.sessionFile ? 'page' : undefined"
                      :class="{
                        active: s.file === session.sessionFile,
                        'drag-cursor': !disabled && !query,
                        'pl-11': !!(sessionRunStatus(s.file) && findConversation(s.file)?.promptQueue.length),
                        'pl-7': !(sessionRunStatus(s.file) && findConversation(s.file)?.promptQueue.length),
                      }"
                      :data-file="s.file"
                      :data-path="path"
                    >
                      <span
                        v-if="sessionRunStatus(s.file)"
                        class="session-status absolute left-[7px] top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
                        :class="`session-status-${sessionRunStatus(s.file)}`"
                        role="status"
                        :aria-label="t(`sidebar.status.${sessionRunStatus(s.file)}`)"
                        :title="t(`sidebar.status.${sessionRunStatus(s.file)}`)"
                      >
                        <span
                          v-if="sessionRunStatus(s.file) === 'running'"
                          class="session-running"
                          aria-hidden="true"
                        />
                        <span
                          v-else
                          class="session-status-dot w-1.5 h-1.5 rounded-full bg-current"
                          aria-hidden="true"
                        />
                      </span>
                      <span
                        v-if="findConversation(s.file)?.promptQueue.length"
                        class="session-queue-status absolute top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
                        :class="sessionRunStatus(s.file) ? 'left-[23px]' : 'left-[7px]'"
                        role="status"
                        :title="queueTitle(findConversation(s.file)?.promptQueue)"
                        :aria-label="queueTitle(findConversation(s.file)?.promptQueue)"
                        ><Clock class="size-3"
                      /></span>
                      <Layers
                        v-if="workspace.isWorktree(s.cwd)"
                        :size="13"
                        class="shrink-0 text-muted-foreground"
                        role="img"
                        :aria-label="t('workspace.worktree')"
                        :title="t('workspace.worktree')"
                      />
                      <Button
                        size="content"
                        variant="session-link"
                        class="session-link"
                        :aria-current="s.file === session.sessionFile ? 'page' : undefined"
                        :disabled="navigationDisabled"
                        :title="label(s)"
                        @click="openSession(s)"
                        @dblclick.stop="renameOnDoubleClick(s)"
                        >{{ label(s) }}</Button
                      >
                      <Button
                        variant="quiet"
                        size="row-action"
                        class="session-archive hover-action absolute right-1 top-[50%] [transform:translateY(-50%)] z-[1] opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
                        :disabled="disabled"
                        :title="s.archived ? t('workspace.restore') : t('workspace.archive')"
                        :aria-label="s.archived ? t('workspace.restore') : t('workspace.archive')"
                        @click="archive(s)"
                        ><Archive :size="14" class="size-auto shrink-0"
                      /></Button>
                    </div>
                  </ContextMenuTrigger>
                  <ContextMenuContent
                    ><ContextMenuItem @select="rename(s)"
                      ><Pencil :size="14" class="size-auto shrink-0" />{{ t("workspace.rename") }}</ContextMenuItem
                    ><ContextMenuItem @select="duplicateSession(s)"
                      ><Copy :size="14" class="size-auto shrink-0" />{{ t("workspace.duplicate") }}</ContextMenuItem
                    ><ContextMenuItem @select="copySessionLink(s)"
                      ><Link :size="14" class="size-auto shrink-0" />{{ t("workspace.copyLink") }}</ContextMenuItem
                    ><ContextMenuSeparator /><ContextMenuItem @select="emit('sessionAction', s.file, 'export')"
                      ><FileDown :size="14" class="size-auto shrink-0" />{{ t("chat.export") }}</ContextMenuItem
                    ></ContextMenuContent
                  >
                </ContextMenu>
              </VueDraggable>
              <Button
                v-if="errors[path] === 'failed'"
                variant="ghost"
                class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto"
                @click="refresh(path)"
                >{{ t("sidebar.loadFailed") }} · {{ t("sidebar.refresh") }}</Button
              >
              <p
                v-else-if="loading[path] && !workspace.histories[path]"
                class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto"
              >
                {{ t("sidebar.loading") }}
              </p>
              <p
                v-else-if="!rows(path).length && query"
                class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto"
              >
                {{ t("sidebar.noMatch") }}
              </p>
            </div>
          </section>
        </VueDraggable>
      </section>
      <section class="task-group mb-1 min-w-0 max-w-full">
        <div class="sidebar-section-label flex items-center justify-between gap-1 py-[2px] pl-1 pr-1 shrink-0">
          <Button
            variant="quiet"
            size="content"
            class="section-toggle min-w-0 flex-1 justify-start rounded-md px-1.5 py-[5px] text-xs font-semibold tracking-[0.02em]"
            :aria-expanded="!tasksCollapsed"
            @click="tasksCollapsed = !tasksCollapsed"
            ><span class="truncate">{{ t("sidebar.tasks") }}</span></Button
          >
          <Button
            variant="quiet"
            size="toolbar"
            class="hover-action opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
            :disabled="navigationDisabled"
            :title="t('projectless.name')"
            :aria-label="t('projectless.name')"
            @click="emit('projectless')"
            ><Plus :size="15" class="size-auto shrink-0"
          /></Button>
        </div>
        <div v-if="!tasksCollapsed && taskPath" class="session-list min-h-0 p-0 overflow-visible">
          <div
            v-if="
              workspace.isProjectless(project) &&
              ready &&
              !session.sessionFile &&
              !session.promptQueue.length &&
              (session.started || session.entries.length) &&
              !query
            "
            class="session-row active flex items-center gap-0.5 w-full pt-0 pr-1 pb-0 pl-7 rounded-md text-xs text-left relative min-h-8 m-0 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)] [@media(pointer:coarse)]:min-h-9"
            aria-current="page"
          >
            <span class="truncate">{{ t("chat.newSession") }}</span>
          </div>
          <div
            v-for="pending in pendingRows(taskPath)"
            :key="pending.runtimeId"
            class="session-row relative flex min-h-8 min-w-0 items-center gap-1 rounded-md pl-7 pr-2 text-xs"
            :class="{ active: pending.runtimeId === activeRuntimeId }"
          >
            <span
              class="session-queue-status absolute left-[7px] top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
              role="status"
              :title="queueTitle(pending.promptQueue)"
              :aria-label="queueTitle(pending.promptQueue)"
              ><Clock class="size-3"
            /></span>
            <Button
              size="content"
              variant="session-link"
              class="session-link"
              :disabled="navigationDisabled"
              :aria-current="pending.runtimeId === activeRuntimeId ? 'page' : undefined"
              :title="pending.promptQueue[0]?.text || t('chat.newSession')"
              @click="emit('selectConversation', pending.runtimeId)"
              >{{ pending.promptQueue[0]?.text || t("chat.newSession") }}</Button
            >
          </div>
          <VueDraggable
            tag="div"
            :model-value="orderedSessionFiles(taskPath)"
            :animation="150"
            :disabled="disabled || !!query"
            chosen-class="drag-source"
            :set-data="setSessionDragData"
            @update:model-value="(next: string[]) => workspace.reorderSessions(taskPath, next)"
          >
            <ContextMenu v-for="s in rows(taskPath)" :key="s.file">
              <ContextMenuTrigger as-child :disabled="disabled">
                <div
                  class="session-row group/session flex items-center gap-0.5 w-full pt-0 pr-1 pb-0 rounded-md text-xs text-left relative min-h-8 m-0 min-w-0 max-w-full hover:[background:color-mix(in_srgb,_var(--sidebar-accent)_60%,_transparent)] [@media(pointer:coarse)]:min-h-9"
                  :aria-current="s.file === session.sessionFile ? 'page' : undefined"
                  :class="{
                    active: s.file === session.sessionFile,
                    'drag-cursor': !disabled && !query,
                    'pl-11': !!(sessionRunStatus(s.file) && findConversation(s.file)?.promptQueue.length),
                    'pl-7': !(sessionRunStatus(s.file) && findConversation(s.file)?.promptQueue.length),
                  }"
                  :data-file="s.file"
                  :data-path="taskPath"
                >
                  <span
                    v-if="sessionRunStatus(s.file)"
                    class="session-status absolute left-[7px] top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
                    :class="`session-status-${sessionRunStatus(s.file)}`"
                    role="status"
                    :aria-label="t(`sidebar.status.${sessionRunStatus(s.file)}`)"
                    :title="t(`sidebar.status.${sessionRunStatus(s.file)}`)"
                  >
                    <span v-if="sessionRunStatus(s.file) === 'running'" class="session-running" aria-hidden="true" />
                    <span v-else class="session-status-dot w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
                  </span>
                  <span
                    v-if="findConversation(s.file)?.promptQueue.length"
                    class="session-queue-status absolute top-1/2 -translate-y-1/2 inline-flex w-3.5 items-center justify-center text-muted-foreground"
                    :class="sessionRunStatus(s.file) ? 'left-[23px]' : 'left-[7px]'"
                    role="status"
                    :title="queueTitle(findConversation(s.file)?.promptQueue)"
                    :aria-label="queueTitle(findConversation(s.file)?.promptQueue)"
                    ><Clock class="size-3"
                  /></span>
                  <Button
                    size="content"
                    variant="session-link"
                    class="session-link"
                    :aria-current="s.file === session.sessionFile ? 'page' : undefined"
                    :disabled="navigationDisabled"
                    :title="label(s)"
                    @click="openSession(s)"
                    @dblclick.stop="renameOnDoubleClick(s)"
                    >{{ label(s) }}</Button
                  >
                  <Button
                    variant="quiet"
                    size="row-action"
                    class="session-archive hover-action absolute right-1 top-[50%] [transform:translateY(-50%)] z-[1] opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
                    :disabled="disabled"
                    :title="s.archived ? t('workspace.restore') : t('workspace.archive')"
                    :aria-label="s.archived ? t('workspace.restore') : t('workspace.archive')"
                    @click="archive(s)"
                    ><Archive :size="14" class="size-auto shrink-0"
                  /></Button>
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                ><ContextMenuItem @select="rename(s)"
                  ><Pencil :size="14" class="size-auto shrink-0" />{{ t("workspace.rename") }}</ContextMenuItem
                ><ContextMenuItem @select="duplicateSession(s)"
                  ><Copy :size="14" class="size-auto shrink-0" />{{ t("workspace.duplicate") }}</ContextMenuItem
                ><ContextMenuItem @select="copySessionLink(s)"
                  ><Link :size="14" class="size-auto shrink-0" />{{ t("workspace.copyLink") }}</ContextMenuItem
                ><ContextMenuSeparator /><ContextMenuItem @select="emit('sessionAction', s.file, 'export')"
                  ><FileDown :size="14" class="size-auto shrink-0" />{{ t("chat.export") }}</ContextMenuItem
                ></ContextMenuContent
              >
            </ContextMenu>
          </VueDraggable>
          <Button
            v-if="errors[taskPath]"
            variant="ghost"
            class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto"
            @click="refresh(taskPath)"
            >{{ errors[taskPath] }} · {{ t("sidebar.refresh") }}</Button
          >
          <p
            v-else-if="loading[taskPath] && !workspace.histories[taskPath]"
            class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto"
          >
            {{ t("sidebar.loading") }}
          </p>
          <p
            v-else-if="!rows(taskPath).length && query"
            class="sidebar-empty p-3 text-xs leading-[1.8] text-muted-foreground h-auto"
          >
            {{ t("sidebar.noMatch") }}
          </p>
        </div>
      </section>
    </ScrollArea>
    <Dialog
      :open="!!renaming"
      @update:open="
        v => {
          if (!v) renaming = null
        }
      "
      ><DialogContent class="sm:max-w-md"
        ><DialogHeader
          ><DialogTitle>{{ t("workspace.rename") }}</DialogTitle></DialogHeader
        >
        <form @submit.prevent="saveTitle" class="space-y-4">
          <Input
            v-model="title"
            autofocus
            maxlength="120"
            :aria-label="t('workspace.title')"
            class="w-full rounded-lg border-border bg-background px-3 py-[9px] dark:bg-background h-auto"
          />
          <div class="flex justify-end gap-2">
            <Button variant="quiet" size="quiet" type="button" @click="renaming = null">{{
              t("workspace.cancel")
            }}</Button
            ><Button size="workspace" :disabled="saving || !title.trim()">{{ t("workspace.save") }}</Button>
          </div>
        </form>
      </DialogContent></Dialog
    >
  </aside>
</template>

<style scoped>
.session-row.active {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}
.session-row time {
  margin-left: auto;
  white-space: nowrap;
  font-size: 10px;
  color: var(--muted-foreground);
}
.session-row.active:hover {
  background: var(--sidebar-accent);
  color: var(--sidebar-accent-foreground);
}
.project-heading:is(:hover, :has(:focus-visible)) > .hover-action {
  opacity: 1;
  pointer-events: auto;
}
.sidebar-section-label:is(:hover, :has(:focus-visible)) > .hover-action {
  opacity: 1;
  pointer-events: auto;
}
.session-row:is(:hover, :has(:focus-visible)) .session-archive {
  opacity: 1;
  pointer-events: auto;
}
.session-row:has(.session-archive):is(:hover, :has(:focus-visible)) .session-link {
  margin-right: 28px;
}
@media (hover: none) {
  .session-row:has(.session-archive) .session-link {
    margin-right: 28px;
    padding-right: 0;
  }
}
@media (pointer: coarse) {
  .session-row:has(.session-archive) .session-link {
    margin-right: 36px;
    padding-right: 0;
  }
}
.hover-action:has([data-state="open"]) {
  opacity: 1;
  pointer-events: auto;
}
.session-running {
  display: block;
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: session-status-spin 1s linear infinite;
}
@keyframes session-status-spin {
  to {
    transform: rotate(360deg);
  }
}
.session-status-completed {
  color: var(--success);
}
.session-status-error {
  color: var(--destructive);
}
.project-more[data-state="open"] {
  background: var(--accent);
  color: var(--foreground);
}
.drag-cursor {
  cursor: grab;
}
.drag-cursor:active {
  cursor: grabbing;
}
.project-heading.drag-source {
  opacity: 0.45;
}
.session-row.drag-source {
  opacity: 0.45;
}
</style>
