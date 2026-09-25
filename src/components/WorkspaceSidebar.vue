<script setup lang="ts">
import PiXLogo from "@/components/PiXLogo.vue"
import { computed, onBeforeUnmount, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Folder, FolderPlus, PanelLeft, Plus, Search, Settings, Archive, Pencil, MoreHorizontal, Pin, PinOff, FolderOpen, X, FileDown } from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import { openPath, type SessionMeta } from "@/api/piClient"
import { useSessionStore } from "@/stores/conversations"
import { sessionRunStatus } from "@/stores/sessionRunStatus"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Input } from "@/components/ui/input"
const props = defineProps<{ project: string; ready: boolean; busy: boolean; navigationBusy?: boolean }>()
const emit = defineEmits<{
  switchProject: []; selectProject: [path: string]; resumeSession: [file: string, project: string]
  removeProject: [project: string]; editProject: [project: string];
  newSession: [project: string]; sessionAction: [file: string, action: "export"]; settings: []; collapse: []
}>()
const session = useSessionStore()
const ui = useUiStore()
const workspace = useWorkspaceStore()
const { t } = useI18n()
const query = ref("")
const collapsed = ref<Record<string, boolean>>({})
const errors = ref<Record<string, string>>({})
const loading = ref<Record<string, boolean>>({})
const showArchived = ref(false)
const renaming = ref<SessionMeta | null>(null)
const title = ref("")
const saving = ref(false)
const navigationDisabled = computed(() => props.navigationBusy || workspace.gitBusy || saving.value)
const disabled = computed(() => props.busy || workspace.gitBusy || saving.value)
const name = (path: string) => workspace.projectName(path)
const label = (s: SessionMeta) => s.title || s.preview || t("sidebar.untitled")
function rows(path: string) {
  const sessions = workspace.orderedSessions(path)
  return sessions.filter(s => !!s.archived === showArchived.value && `${label(s)} ${s.id}`.toLowerCase().includes(query.value.toLowerCase()))
}
async function openProjectFolder(path: string) {
  try { await openPath(path) }
  catch (e) { ui.pushToast(String(e), "error") }
}
async function refresh(path: string) {
  loading.value[path] = true
  errors.value[path] = ""
  try { await workspace.refresh(path) } catch { errors.value[path] = t("sidebar.loadFailed") }
  finally { loading.value[path] = false }
}
function rename(s: SessionMeta) { renaming.value = s; title.value = label(s) }
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
onBeforeUnmount(() => clearTimeout(openTimer))
async function saveTitle() {
  if (!renaming.value || !title.value.trim() || saving.value) return
  saving.value = true
  try { await workspace.update(renaming.value, title.value.trim(), !!renaming.value.archived); renaming.value = null }
  catch (e) { ui.pushToast(String(e), "error") } finally { saving.value = false }
}
async function archive(s: SessionMeta) {
  if (disabled.value) return
  saving.value = true
  try { await workspace.update(s, s.title || null, !s.archived) }
  catch (e) { ui.pushToast(String(e), "error") } finally { saving.value = false }
}

// ---- drag & drop ordering (whole row draggable, no handle icon) ----
const dragProject = ref<string | null>(null)
const projectDrop = ref<{ path: string; before: boolean } | null>(null)
const dragSession = ref<{ path: string; file: string } | null>(null)
const sessionDrop = ref<{ path: string; file: string; before: boolean } | null>(null)
function clearDrag() {
  dragProject.value = null
  projectDrop.value = null
  dragSession.value = null
  sessionDrop.value = null
}
function dropBefore(e: DragEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return e.clientY < rect.top + rect.height / 2
}
function onProjectDragStart(e: DragEvent, path: string) {
  if (disabled.value) { e.preventDefault(); return }
  dragProject.value = path
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", path) }
}
function onProjectDragOver(e: DragEvent, path: string) {
  if (!dragProject.value || dragProject.value === path) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
  projectDrop.value = { path, before: dropBefore(e) }
}
function onProjectDrop(e: DragEvent, path: string) {
  e.preventDefault()
  const from = dragProject.value
  const before = projectDrop.value?.before ?? true
  clearDrag()
  if (!from || from === path) return
  const next = workspace.orderedProjects().filter(p => p !== from)
  next.splice(next.indexOf(path) + (before ? 0 : 1), 0, from)
  workspace.reorderProjects(next)
}
function onSessionDragStart(e: DragEvent, path: string, file: string) {
  if (disabled.value) { e.preventDefault(); return }
  dragSession.value = { path, file }
  if (e.dataTransfer) { e.dataTransfer.effectAllowed = "copyMove"; e.dataTransfer.setData("application/x-pix-session", file); e.dataTransfer.setData("text/plain", file) }
}
function onSessionDragOver(e: DragEvent, path: string, file: string) {
  if (query.value || !dragSession.value || dragSession.value.path !== path || dragSession.value.file === file) return
  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
  sessionDrop.value = { path, file, before: dropBefore(e) }
}
function onSessionDrop(e: DragEvent, path: string, file: string) {
  const drag = dragSession.value
  if (query.value || !drag || drag.path !== path || drag.file === file) return
  e.preventDefault()
  const before = dropBefore(e)
  clearDrag()
  const next = rows(path).map(s => s.file).filter(f => f !== drag.file)
  next.splice(next.indexOf(file) + (before ? 0 : 1), 0, drag.file)
  workspace.reorderSessions(path, next)
}
function onRowDragLeave(e: DragEvent) {
  const row = e.currentTarget as HTMLElement
  if (e.relatedTarget instanceof Node && row.contains(e.relatedTarget)) return
  if (projectDrop.value && e.currentTarget === row) projectDrop.value = null
  sessionDrop.value = null
}
watch(() => props.project, path => { workspace.remember(path); if (path) void refresh(path) }, { immediate: true })
watch(() => [props.ready, session.sessionFile, session.isStreaming], () => {
  if (props.ready && !session.isStreaming && props.project) void refresh(props.project)
})
for (const path of workspace.projects) for (const folder of workspace.projectFolders(path)) if (folder !== props.project) void refresh(folder)
</script>

<template>
  <aside class="workspace-sidebar" :aria-label="t('sidebar.ariaLabel')">
    <div class="sidebar-brand"><PiXLogo /><Button variant="ghost" size="icon" class="icon-button ml-auto" :aria-label="t('sidebar.collapse')" @click="emit('collapse')"><PanelLeft :size="17" /></Button></div>
    <Button variant="ghost" class="sidebar-action" :disabled="!ready || navigationDisabled" @click="emit('newSession', project)"><Plus :size="17" />{{ t('sidebar.newSession') }}</Button>
    <label class="sidebar-search"><Search :size="15" /><Input v-model="query" :placeholder="t('sidebar.search')" :aria-label="t('sidebar.search')" class="h-auto border-0 bg-transparent px-0 text-xs focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent" /></label>
    <div class="sidebar-section-label"><span>{{ showArchived ? t('workspace.archived') : t('sidebar.projects') }}</span>
      <div class="flex"><Button variant="ghost" size="icon" class="icon-button" :aria-pressed="showArchived" :title="t('workspace.archived')" :aria-label="t('workspace.archived')" @click="showArchived = !showArchived"><Archive :size="15" /></Button>
      <Button variant="ghost" size="icon" class="icon-button" :disabled="navigationDisabled" :title="t('sidebar.openProject')" :aria-label="t('sidebar.openProject')" @click="emit('switchProject')"><FolderPlus :size="15" /></Button></div>
    </div>
    <ScrollArea class="project-groups" @dragend="clearDrag">
      <section v-for="path in workspace.orderedProjects()" :key="path" class="project-group">
        <div class="project-heading" :class="{ selected: path === workspace.projectRoot(project), 'drag-source': dragProject === path, 'drop-before': projectDrop?.path === path && projectDrop.before, 'drop-after': projectDrop?.path === path && !projectDrop.before }"
          :draggable="!disabled" @dragstart="onProjectDragStart($event, path)" @dragover="onProjectDragOver($event, path)" @drop="onProjectDrop($event, path)" @dragleave="onRowDragLeave">
          <Button variant="ghost" class="project-row" :title="path" :aria-expanded="!collapsed[path]" @click="collapsed[path] = !collapsed[path]">
            <FolderOpen v-if="!collapsed[path]" :size="15" /><Folder v-else :size="15" /><span class="truncate">{{ name(path) }}</span>
          </Button>
          <Button variant="ghost" size="icon" class="icon-button hover-action" :disabled="navigationDisabled || (!ready && path === project)" :title="t('sidebar.newSession')" :aria-label="`${t('sidebar.newSession')} · ${name(path)}`" @click="emit('newSession', path)"><Plus :size="16" /></Button>
          <Pin v-if="workspace.pinnedProjects.includes(path)" :size="12" class="project-pin" :aria-label="t('workspace.pinned')" />
          <DropdownMenu>
            <DropdownMenuTrigger as-child><Button variant="ghost" size="icon" class="icon-button project-more hover-action" :disabled="disabled" :title="t('workspace.projectActions')" :aria-label="`${t('workspace.projectActions')} · ${name(path)}`"><MoreHorizontal :size="16" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom">
              <DropdownMenuItem @select="workspace.togglePin(path)"><PinOff v-if="workspace.pinnedProjects.includes(path)" :size="14" /><Pin v-else :size="14" />{{ workspace.pinnedProjects.includes(path) ? t('workspace.unpin') : t('workspace.pin') }}</DropdownMenuItem>
              <DropdownMenuItem @select="emit('editProject', path)"><Pencil :size="14" />{{ t('projectDialog.editTitle') }}</DropdownMenuItem>
              <DropdownMenuItem :disabled="!isDesktop" :title="!isDesktop ? t('workspace.desktopOnly') : undefined" @select="openProjectFolder(path)"><FolderOpen :size="14" />{{ t('workspace.openExplorer') }}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem class="text-destructive" :title="t('workspace.removeProjectHint')" @select="emit('removeProject', path)"><X :size="14" />{{ t('workspace.removeProject') }}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div v-if="!collapsed[path]" class="session-list">
          <div v-if="path === workspace.projectRoot(project) && ready && !session.sessionFile && (session.started || session.entries.length) && !showArchived && !query" class="session-row active" aria-current="page"><span class="truncate">{{ t('chat.newSession') }}</span></div>
          <div v-for="s in rows(path)" :key="s.file" class="session-row group/session" :aria-current="s.file === session.sessionFile ? 'page' : undefined" :class="{ active: s.file === session.sessionFile, 'drag-source': dragSession?.file === s.file && dragSession.path === path, 'drop-before': sessionDrop?.path === path && sessionDrop.file === s.file && sessionDrop.before, 'drop-after': sessionDrop?.path === path && sessionDrop.file === s.file && !sessionDrop.before }"
            :draggable="!disabled" @dragstart="onSessionDragStart($event, path, s.file)" @dragend="clearDrag" @dragover="onSessionDragOver($event, path, s.file)" @drop="onSessionDrop($event, path, s.file)" @dragleave="onRowDragLeave">
            <Button variant="ghost" class="session-link" :aria-current="s.file === session.sessionFile ? 'page' : undefined" :disabled="navigationDisabled" :title="label(s)" @click="openSession(s)" @dblclick.stop="renameOnDoubleClick(s)">{{ label(s) }}</Button>
            <span v-if="sessionRunStatus(s.file)" class="session-status group-hover/session:invisible group-has-[:focus-visible]/session:invisible group-has-[[data-state=open]]/session:invisible" :class="`session-status-${sessionRunStatus(s.file)}`" role="status" :aria-label="t(`sidebar.status.${sessionRunStatus(s.file)}`)" :title="t(`sidebar.status.${sessionRunStatus(s.file)}`)">
              <span v-if="sessionRunStatus(s.file) === 'running'" class="session-running" aria-hidden="true" />
              <span v-else class="session-status-dot" aria-hidden="true" />
            </span>
            <div class="session-actions hover-action">
              <Button variant="ghost" size="icon" class="icon-button" :disabled="disabled" :title="s.archived ? t('workspace.restore') : t('workspace.archive')" :aria-label="s.archived ? t('workspace.restore') : t('workspace.archive')" @click="archive(s)"><Archive :size="14" /></Button>
              <DropdownMenu><DropdownMenuTrigger as-child><Button variant="ghost" size="icon" class="icon-button" :disabled="disabled" :aria-label="t('workspace.sessionActions')"><MoreHorizontal :size="14" /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuItem @select="rename(s)"><Pencil :size="14" />{{ t('workspace.rename') }}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem @select="emit('sessionAction', s.file, 'export')"><FileDown :size="14" />{{ t('chat.export') }}</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
          <Button v-if="errors[path]" variant="ghost" class="sidebar-empty text-destructive" @click="refresh(path)">{{ errors[path] }} · {{ t('sidebar.refresh') }}</Button>
          <p v-else-if="loading[path] && !workspace.histories[path]" class="sidebar-empty">{{ t('sidebar.loading') }}</p>
          <p v-else-if="!rows(path).length && (showArchived || query)" class="sidebar-empty">{{ t('sidebar.noMatch') }}</p>
        </div>
      </section>
    </ScrollArea>
    <div class="sidebar-footer"><Button variant="ghost" class="sidebar-action" @click="emit('settings')"><Settings :size="17" />{{ t('sidebar.settings') }}</Button></div>
    <Dialog :open="!!renaming" @update:open="v => { if (!v) renaming = null }"><DialogContent class="sm:max-w-md"><DialogHeader><DialogTitle>{{ t('workspace.rename') }}</DialogTitle></DialogHeader>
      <form @submit.prevent="saveTitle" class="space-y-4"><Input v-model="title" autofocus maxlength="120" :aria-label="t('workspace.title')" class="workspace-text-input h-auto" /><div class="flex justify-end gap-2"><Button variant="ghost" size="sm" class="quiet-button" type="button" @click="renaming = null">{{ t('workspace.cancel') }}</Button><Button size="sm" class="workspace-primary" :disabled="saving || !title.trim()">{{ t('workspace.save') }}</Button></div></form>
    </DialogContent></Dialog>
  </aside>
</template>
