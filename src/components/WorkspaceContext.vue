<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Folder, GitBranch, Laptop, Layers, ChevronDown, Plus, LoaderCircle } from "@lucide/vue"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { workspaceGitInfo, createWorkspaceGit, type WorkspaceGitInfo } from "@/api/piClient"
import { useWorkspaceStore } from "@/stores/workspace"
const props = defineProps<{ project: string; disabled?: boolean }>()
const emit = defineEmits<{ selectProject: [path: string]; openProject: [] }>()
const workspace = useWorkspaceStore()
const { t } = useI18n()
const info = ref<WorkspaceGitInfo | null>(null)
const loading = ref(false)
const gitError = ref("")
const projectOpen = ref(false)
const modeOpen = ref(false)
const branchOpen = ref(false)
const createOpen = ref(false)
const worktree = ref(false)
const branch = ref("")
const error = ref("")
const blocked = computed(() => props.disabled || workspace.gitBusy)
const name = (path: string) => workspace.projectName(path)
let request = 0
async function refresh() {
  const id = ++request
  loading.value = true
  info.value = null
  gitError.value = ""
  try { const result = await workspaceGitInfo(props.project); if (id === request) info.value = result }
  catch (e) { if (id === request) gitError.value = String(e) }
  finally { if (id === request) loading.value = false }
}
function openCreate(isWorktree: boolean) {
  worktree.value = isWorktree
  branch.value = ""
  error.value = ""
  modeOpen.value = false
  branchOpen.value = false
  createOpen.value = true
}
function select(path: string) { projectOpen.value = false; if (path !== props.project) emit('selectProject', path) }
async function create() {
  if (blocked.value || !branch.value.trim()) return
  workspace.gitBusy = true
  error.value = ""
  try {
    const path = await createWorkspaceGit(props.project, branch.value.trim(), worktree.value)
    createOpen.value = false
    workspace.gitBusy = false
    if (path !== props.project) emit('selectProject', path)
    else await refresh()
  } catch (e) { error.value = String(e) }
  finally { workspace.gitBusy = false }
}
watch(() => props.project, refresh, { immediate: true })
</script>

<template>
  <div class="workspace-context">
    <Popover v-model:open="projectOpen"><PopoverTrigger as-child><Button variant="ghost" size="sm" class="context-chip" :disabled="blocked" :title="project"><Folder :size="14" /><span class="truncate">{{ name(project) }}</span><ChevronDown :size="12" /></Button></PopoverTrigger>
      <PopoverContent align="start" class="w-72 p-2"><p class="px-2 py-1 text-xs text-muted-foreground">{{ t('workspace.selectProject') }}</p>
        <Button v-for="path in workspace.orderedProjects()" :key="path" variant="ghost" size="sm" class="context-menu-item" :aria-current="path === workspace.projectRoot(project) ? 'true' : undefined" :title="path" @click="select(path)"><Folder :size="14" /><span class="truncate">{{ name(path) }}</span><span v-if="path === workspace.projectRoot(project)" class="ml-auto">✓</span></Button>
        <Button variant="ghost" size="sm" class="context-menu-item" @click="projectOpen = false; emit('openProject')"><Plus :size="14" />{{ t('sidebar.openProject') }}</Button>
      </PopoverContent>
    </Popover>
    <Popover v-model:open="modeOpen"><PopoverTrigger as-child><Button variant="ghost" size="sm" class="context-chip" :disabled="blocked || !info" :title="gitError || undefined"><Layers v-if="info?.worktree" :size="14" /><Laptop v-else :size="14" />{{ info?.worktree ? 'Worktree' : t('workspace.local') }}<ChevronDown :size="12" /></Button></PopoverTrigger>
      <PopoverContent align="start" class="w-64 p-2"><p class="px-2 py-2 text-xs text-muted-foreground">{{ t('workspace.worktreeHint') }}</p><Button variant="ghost" size="sm" class="context-menu-item" @click="openCreate(true)"><Plus :size="14" />{{ t('workspace.createWorktree') }}</Button></PopoverContent>
    </Popover>
    <Popover v-model:open="branchOpen"><PopoverTrigger as-child><Button variant="ghost" size="sm" class="context-chip" :disabled="blocked || !info" :title="gitError || undefined"><LoaderCircle v-if="loading" :size="14" class="animate-spin" /><GitBranch v-else :size="14" /><span class="truncate">{{ loading ? t('sidebar.loading') : info?.branch || t('workspace.noGit') }}</span><ChevronDown v-if="info" :size="12" /></Button></PopoverTrigger>
      <PopoverContent align="start" class="w-64 p-2"><p class="px-2 py-2 text-xs text-muted-foreground">{{ t('workspace.currentBranch') }}: {{ info?.branch }}</p><Button variant="ghost" size="sm" class="context-menu-item" @click="openCreate(false)"><Plus :size="14" />{{ t('workspace.createBranch') }}</Button><Button variant="ghost" size="sm" class="context-menu-item" @click="openCreate(true)"><Layers :size="14" />{{ t('workspace.createWorktree') }}</Button></PopoverContent>
    </Popover>
    <Dialog :open="createOpen" @update:open="v => { if (!workspace.gitBusy) createOpen = v }"><DialogContent class="sm:max-w-md"><DialogHeader><DialogTitle>{{ worktree ? t('workspace.createWorktree') : t('workspace.createBranch') }}</DialogTitle></DialogHeader>
      <form class="space-y-4" @submit.prevent="create"><p class="text-sm text-muted-foreground">{{ worktree ? t('workspace.worktreeHint') : t('workspace.branchHint') }}</p><label class="block text-sm">{{ t('workspace.branchName') }}<Input v-model="branch" :disabled="workspace.gitBusy" autofocus placeholder="feature/my-task" class="workspace-text-input mt-2 h-auto" /></label><p v-if="error" role="alert" class="text-sm text-destructive whitespace-pre-wrap">{{ error }}</p><div class="flex justify-end gap-2"><Button variant="ghost" size="sm" class="quiet-button" type="button" :disabled="workspace.gitBusy" @click="createOpen = false">{{ t('workspace.cancel') }}</Button><Button size="sm" class="workspace-primary" :disabled="workspace.gitBusy || !branch.trim()">{{ workspace.gitBusy ? t('workspace.creating') : t('workspace.create') }}</Button></div></form>
    </DialogContent></Dialog>
  </div>
</template>
