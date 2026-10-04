<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { VueDraggable } from "vue-draggable-plus"
import { Clock, FolderPlus, Plus, Search } from "@lucide/vue"
import { parseCodedError } from "@/lib/backendError"
import { normalizeProjectPath } from "@/lib/paths"
import { duplicateSessionFile, type SessionMeta } from "@/api/piClient"
import { pendingConversations } from "@/lib/pendingConversations"
import { useCountdownNow } from "@/composables/useCountdownNow"
import { copyWithToast } from "@/lib/clipboard"
import { allConversations, useSessionStore } from "@/stores/conversations"
import { useUiStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"
import SidebarProjectGroup from "@/components/workspace/sidebar/SidebarProjectGroup.vue"
import SidebarSessionList from "@/components/workspace/sidebar/SidebarSessionList.vue"
import { useSidebarSessionActions } from "@/components/workspace/sidebar/useSidebarSessionActions"
import { sidebarSessionRows } from "@/components/workspace/sidebar/useSidebarSessionOrdering"
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
const navigationDisabled = computed<boolean>(() => !!props.navigationBusy || workspace.gitBusy || saving.value)
const disabled = computed<boolean>(() => props.busy || workspace.gitBusy || saving.value)
const label = (s: SessionMeta) => s.title || s.preview || t("sidebar.untitled")
const { renaming, title, saving, archiving, rename, openSession, renameOnDoubleClick, saveTitle, archive } =
  useSidebarSessionActions({
    label,
    disabled: () => disabled.value,
    navigationDisabled: () => navigationDisabled.value,
    resume: s => emit("resumeSession", s.file, s.cwd),
    update: (s, nextTitle, archived) => workspace.update(s, nextTitle, archived),
    onError: error => ui.pushToast(String(error), "error"),
  })
const sessionActions = {
  open: openSession,
  renameOnDoubleClick,
  rename,
  archive,
  duplicate: duplicateSession,
  copyLink: copySessionLink,
  export: (file: string) => emit("sessionAction", file, "export"),
  selectConversation: (runtimeId: string) => emit("selectConversation", runtimeId),
}
function rows(path: string) {
  return sidebarSessionRows(workspace.orderedSessions(path), archiving.value, query.value, label)
}
/** The sortable model is never query-filtered. */
function orderedSessionFiles(path: string) {
  return sidebarSessionRows(workspace.orderedSessions(path), archiving.value, "", label).map(s => s.file)
}
const showDraft = computed(
  () =>
    props.ready &&
    !session.sessionFile &&
    !session.promptQueue.length &&
    !!(session.started || session.entries.length) &&
    !query.value,
)
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
function copySessionLink(s: SessionMeta) {
  return copyWithToast(ui, s.file, t("workspace.linkCopied"))
}
async function duplicateSession(s: SessionMeta) {
  try {
    await duplicateSessionFile(s.file)
    ui.pushToast(t("workspace.duplicated"), "info")
    // The copy lands in the source session's own cwd, which can be any folder
    // of a grouped project — refreshing only the primary would miss it.
    await refresh(normalizeProjectPath(s.cwd) || props.project)
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
/** A grouped project's sidebar state aggregates every folder: the list hides
 *  only when no folder can be read, and failure lines cover the whole group. */
function groupState(path: string) {
  const folders = workspace.projectFolders(path)
  const states = folders.map(folder => errors.value[folder])
  return {
    // The heading warning stays tied to the primary: that is where new sessions start.
    error: errors.value[path],
    listError: states.some(state => state) && states.every(state => state === "failed") ? "failed" : "",
    hidden: folders.length > 0 && folders.every(folder => errors.value[folder] === "missing"),
    loading: folders.some(folder => loading.value[folder]),
    hasHistory: folders.some(folder => !!workspace.histories[folder]),
  }
}
async function refreshGroup(path: string) {
  for (const folder of workspace.projectFolders(path)) await refresh(folder)
}
const projectStates = computed(() => Object.fromEntries(visibleProjects.value.map(path => [path, groupState(path)])))
function onProjectDragStart(event: { item?: HTMLElement; originalEvent?: DragEvent }) {
  const path = event.item?.dataset.path
  const transfer = event.originalEvent?.dataTransfer
  if (!path || !transfer) return
  transfer.effectAllowed = "move"
  transfer.setData("text/plain", path)
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
    class="workspace-sidebar h-full w-full flex flex-col bg-sidebar border-r border-border pt-3.5 pr-[7px] pb-2 pl-[7px] min-h-0 overflow-hidden transition-[transform,visibility] duration-200 ease-out max-[640px]:absolute max-[640px]:[inset:0_auto_0_0] max-[640px]:z-[30] max-[640px]:shadow-[var(--sidebar-shadow)] max-[640px]:w-55"
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
            class="hover-action opacity-[0] disabled:opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
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
          <SidebarProjectGroup
            v-for="path in visibleProjects"
            :key="path"
            :path="path"
            :project="project"
            :ready="ready"
            :collapsed="!!collapsed[path]"
            :error="projectStates[path]?.error"
            :hidden="projectStates[path]?.hidden"
            :disabled="disabled"
            :navigation-disabled="navigationDisabled"
            @toggle="collapsed[path] = !collapsed[path]"
            @new-session="emit('newSession', $event)"
            @edit-project="emit('editProject', $event)"
            @remove-project="emit('removeProject', $event)"
          >
            <SidebarSessionList
              :path="path"
              :rows="rows(path)"
              :ordered-files="orderedSessionFiles(path)"
              :pending="pendingRows(path)"
              :query="query"
              :disabled="disabled"
              :navigation-disabled="navigationDisabled"
              :queue-now="queueNow"
              :error="projectStates[path]?.listError"
              :loading="projectStates[path]?.loading"
              :has-history="projectStates[path]?.hasHistory"
              :show-draft="path === workspace.projectRoot(project) && showDraft"
              :draft-worktree="workspace.isWorktree(project)"
              v-on="sessionActions"
              @reorder="workspace.reorderSessions(path, $event)"
              @refresh="refreshGroup(path)"
            />
          </SidebarProjectGroup>
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
            class="hover-action opacity-[0] disabled:opacity-[0] pointer-events-none [@media(hover:none)]:opacity-[1] [@media(hover:none)]:pointer-events-auto"
            :disabled="navigationDisabled"
            :title="t('projectless.name')"
            :aria-label="t('projectless.name')"
            @click="emit('projectless')"
            ><Plus :size="15" class="size-auto shrink-0"
          /></Button>
        </div>
        <SidebarSessionList
          :path="taskPath"
          :rows="rows(taskPath)"
          :ordered-files="orderedSessionFiles(taskPath)"
          :pending="pendingRows(taskPath)"
          :query="query"
          :disabled="disabled"
          :navigation-disabled="navigationDisabled"
          :queue-now="queueNow"
          :error="errors[taskPath]"
          :loading="loading[taskPath]"
          :has-history="!!workspace.histories[taskPath]"
          v-if="!tasksCollapsed && taskPath"
          projectless
          :show-draft="workspace.isProjectless(project) && showDraft"
          v-on="sessionActions"
          @reorder="workspace.reorderSessions(taskPath, $event)"
          @refresh="refresh(taskPath)"
        />
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
.sidebar-section-label:is(:hover, :has(:focus-visible)) > .hover-action:not(:disabled) {
  opacity: 1;
  pointer-events: auto;
}
</style>
