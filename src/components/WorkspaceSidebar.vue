<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Folder, FolderPlus, PanelLeft, Plus, Search, Settings, ChevronDown, Archive, ArchiveRestore, Pencil, MoreHorizontal, Pin, PinOff, FolderOpen, X } from "@lucide/vue"
import { isDesktop } from "@/api/transport"
import { openPath, type SessionMeta } from "@/api/piClient"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
const props = defineProps<{ project: string; ready: boolean; busy: boolean }>()
const emit = defineEmits<{
  switchProject: []; selectProject: [path: string]; resumeSession: [file: string, project: string]
  removeProject: [project: string];
  newSession: [project: string]; settings: []; collapse: []
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
const disabled = computed(() => props.busy || workspace.gitBusy || session.isStreaming || saving.value)
const name = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() || path
const label = (s: SessionMeta) => s.title || s.preview || t("sidebar.untitled")
function rows(path: string) {
  return (workspace.histories[path] || []).filter(s => !!s.archived === showArchived.value && `${label(s)} ${s.id}`.toLowerCase().includes(query.value.toLowerCase()))
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
watch(() => props.project, path => { workspace.remember(path); if (path) void refresh(path) }, { immediate: true })
watch(() => [props.ready, session.sessionFile, session.isStreaming], () => {
  if (props.ready && !session.isStreaming && props.project) void refresh(props.project)
})
for (const path of workspace.projects) if (path !== props.project) void refresh(path)
</script>

<template>
  <aside class="workspace-sidebar" :aria-label="t('sidebar.ariaLabel')">
    <div class="sidebar-brand"><span>Pi X</span><button class="icon-button ml-auto" :aria-label="t('sidebar.collapse')" @click="emit('collapse')"><PanelLeft :size="17" /></button></div>
    <button class="sidebar-action" :disabled="!ready || disabled" @click="emit('newSession', project)"><Plus :size="17" />{{ t('sidebar.newSession') }}</button>
    <label class="sidebar-search"><Search :size="15" /><input v-model="query" :placeholder="t('sidebar.search')" :aria-label="t('sidebar.search')" /></label>
    <div class="sidebar-section-label"><span>{{ showArchived ? t('workspace.archived') : t('sidebar.projects') }}</span>
      <div class="flex"><button class="icon-button" :aria-pressed="showArchived" :title="t('workspace.archived')" :aria-label="t('workspace.archived')" @click="showArchived = !showArchived"><Archive :size="15" /></button>
      <button class="icon-button" :disabled="disabled" :title="t('sidebar.openProject')" :aria-label="t('sidebar.openProject')" @click="emit('switchProject')"><FolderPlus :size="15" /></button></div>
    </div>
    <div class="project-groups">
      <section v-for="path in workspace.orderedProjects()" :key="path" class="project-group">
        <div class="project-heading" :class="{ selected: path === project && !session.entries.length }">
          <button class="project-row" :title="path" :aria-expanded="!collapsed[path]" @click="collapsed[path] = !collapsed[path]">
            <ChevronDown class="project-chevron" :size="12" :class="{ '-rotate-90': collapsed[path] }" /><Folder :size="15" /><span class="truncate">{{ name(path) }}</span>
          </button>
          <button class="icon-button hover-action" :disabled="disabled || (!ready && path === project)" :title="t('sidebar.newSession')" :aria-label="`${t('sidebar.newSession')} · ${name(path)}`" @click="emit('newSession', path)"><Plus :size="16" /></button>
          <Pin v-if="workspace.pinnedProjects.includes(path)" :size="12" class="project-pin" :aria-label="t('workspace.pinned')" />
          <DropdownMenu>
            <DropdownMenuTrigger as-child><button class="icon-button project-more" :disabled="disabled" :title="t('workspace.projectActions')" :aria-label="`${t('workspace.projectActions')} · ${name(path)}`"><MoreHorizontal :size="16" /></button></DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="bottom">
              <DropdownMenuItem @select="workspace.togglePin(path)"><PinOff v-if="workspace.pinnedProjects.includes(path)" :size="14" /><Pin v-else :size="14" />{{ workspace.pinnedProjects.includes(path) ? t('workspace.unpin') : t('workspace.pin') }}</DropdownMenuItem>
              <DropdownMenuItem :disabled="!isDesktop" :title="!isDesktop ? t('workspace.desktopOnly') : undefined" @select="openProjectFolder(path)"><FolderOpen :size="14" />{{ t('workspace.openExplorer') }}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem class="text-destructive" :title="t('workspace.removeProjectHint')" @select="emit('removeProject', path)"><X :size="14" />{{ t('workspace.removeProject') }}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div v-if="!collapsed[path]" class="session-list">
          <div v-if="path === project && ready && session.entries.length > 0 && !showArchived && !query && !workspace.histories[path]?.some(s => s.file === session.sessionFile)" class="session-row active"><span class="truncate">{{ t('chat.newSession') }}</span></div>
          <div v-for="s in rows(path)" :key="s.file" class="session-row" :class="{ active: s.file === session.sessionFile }">
            <button class="session-link" :aria-current="s.file === session.sessionFile ? 'page' : undefined" :disabled="disabled" :title="label(s)" @click="emit('resumeSession', s.file, path)">{{ label(s) }}</button>
            <span v-if="s.file === session.sessionFile && session.isStreaming" class="session-running" :aria-label="t('chat.thinking')" />
            <div class="session-actions hover-action">
              <DropdownMenu><DropdownMenuTrigger as-child><button class="icon-button" :disabled="disabled" :aria-label="t('workspace.sessionActions')"><MoreHorizontal :size="14" /></button></DropdownMenuTrigger>
                <DropdownMenuContent align="end"><DropdownMenuItem @select="rename(s)"><Pencil :size="14" />{{ t('workspace.rename') }}</DropdownMenuItem><DropdownMenuItem @select="archive(s)"><Archive :size="14" />{{ s.archived ? t('workspace.restore') : t('workspace.archive') }}</DropdownMenuItem></DropdownMenuContent>
              </DropdownMenu>
              <button class="icon-button" :disabled="disabled" :title="s.archived ? t('workspace.restore') : t('workspace.archive')" :aria-label="s.archived ? t('workspace.restore') : t('workspace.archive')" @click="archive(s)"><ArchiveRestore v-if="s.archived" :size="14" /><Archive v-else :size="14" /></button>
            </div>
          </div>
          <button v-if="errors[path]" class="sidebar-empty text-destructive" @click="refresh(path)">{{ errors[path] }} · {{ t('sidebar.refresh') }}</button>
          <p v-else-if="loading[path] && !workspace.histories[path]" class="sidebar-empty">{{ t('sidebar.loading') }}</p>
          <p v-else-if="!rows(path).length && (showArchived || query)" class="sidebar-empty">{{ t('sidebar.noMatch') }}</p>
        </div>
      </section>
    </div>
    <div class="sidebar-footer"><button class="sidebar-action" @click="emit('settings')"><Settings :size="17" />{{ t('sidebar.settings') }}</button></div>
    <Dialog :open="!!renaming" @update:open="v => { if (!v) renaming = null }"><DialogContent class="sm:max-w-md"><DialogHeader><DialogTitle>{{ t('workspace.rename') }}</DialogTitle></DialogHeader>
      <form @submit.prevent="saveTitle" class="space-y-4"><input v-model="title" autofocus maxlength="120" :aria-label="t('workspace.title')" class="workspace-text-input" /><div class="flex justify-end gap-2"><button type="button" class="quiet-button" @click="renaming = null">{{ t('workspace.cancel') }}</button><button class="workspace-primary" :disabled="saving || !title.trim()">{{ t('workspace.save') }}</button></div></form>
    </DialogContent></Dialog>
  </aside>
</template>
