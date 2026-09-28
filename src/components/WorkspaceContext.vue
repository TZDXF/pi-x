<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Folder, GitBranch, Laptop, Layers, MessagesSquare, ChevronDown, Plus, LoaderCircle } from "@lucide/vue"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
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

function openProject() {
  projectOpen.value = false
  emit("openProject")
}
const modeOpen = ref(false)
const branchOpen = ref(false)
const createOpen = ref(false)
const worktree = ref(false)
const branch = ref("")
const error = ref("")
const blocked = computed(() => props.disabled || workspace.gitBusy)
const name = (path: string) => workspace.projectName(path)
// 项目下拉：搜索框 + 两组选项（上方为普通项目，底部固定为无项目会话与添加项目）。
const projectQuery = ref("")
watch(projectOpen, open => {
  if (open) projectQuery.value = ""
})
const filteredProjects = computed(() => {
  const paths = workspace.orderedProjects().filter(p => !workspace.isProjectless(p))
  const query = projectQuery.value.trim().toLowerCase()
  if (!query) return paths
  return paths.filter(p => name(p).toLowerCase().includes(query) || p.toLowerCase().includes(query))
})
let request = 0
async function refresh() {
  const id = ++request
  loading.value = true
  info.value = null
  gitError.value = ""
  try {
    const result = await workspaceGitInfo(props.project)
    if (id === request) info.value = result
  } catch (e) {
    if (id === request) gitError.value = String(e)
  } finally {
    if (id === request) loading.value = false
  }
}
function openCreate(isWorktree: boolean) {
  worktree.value = isWorktree
  branch.value = ""
  error.value = ""
  modeOpen.value = false
  branchOpen.value = false
  createOpen.value = true
}
function select(path: string) {
  projectOpen.value = false
  if (path !== props.project) emit("selectProject", path)
}
// 工作树下拉：切换到当前项目拥有的某个工作树。
function selectWorktree(path: string) {
  modeOpen.value = false
  select(path)
}
async function create() {
  if (blocked.value || !branch.value.trim()) return
  workspace.gitBusy = true
  error.value = ""
  try {
    const path = await createWorkspaceGit(props.project, branch.value.trim(), worktree.value)
    createOpen.value = false
    workspace.gitBusy = false
    if (path !== props.project) emit("selectProject", path)
    else await refresh()
  } catch (e) {
    error.value = String(e)
  } finally {
    workspace.gitBusy = false
  }
}
watch(() => props.project, refresh, { immediate: true })
</script>

<template>
  <div
    class="workspace-context flex gap-[5px] items-center mt-0 mr-3.5 mb-[-10px] ml-3.5 pt-[5px] pr-2 pb-[15px] pl-2 bg-muted rounded-[16px_16px_0_0] max-[700px]:[margin-inline:2px] max-[700px]:gap-0"
  >
    <Popover v-model:open="projectOpen"
      ><PopoverTrigger as-child
        ><Button variant="context-chip" size="content" class="context-chip" :disabled="blocked" :title="project"
          ><Folder :size="14" class="size-auto shrink-0" /><span class="truncate">{{ name(project) }}</span
          ><ChevronDown :size="12" class="size-auto shrink-0" /></Button
      ></PopoverTrigger>
      <PopoverContent align="start" class="w-72 p-2">
        <Input v-model="projectQuery" :placeholder="t('workspace.searchProject')" class="h-7 text-xs" />
        <ScrollArea v-if="filteredProjects.length" viewport-class="max-h-64">
          <Button
            v-for="path in filteredProjects"
            :key="path"
            variant="context-menu-item"
            size="content"
            class="context-menu-item"
            :aria-current="path === workspace.projectRoot(project) ? 'true' : undefined"
            :title="path"
            @click="select(path)"
            ><Folder :size="14" class="size-auto shrink-0" /><span class="truncate">{{ name(path) }}</span
            ><span v-if="path === workspace.projectRoot(project)" class="ml-auto">✓</span></Button
          >
        </ScrollArea>
        <p v-else-if="projectQuery.trim()" class="px-2 py-2 text-xs text-muted-foreground">
          {{ t("workspace.noMatchingProject") }}
        </p>
        <div class="border-t border-border pt-1.5">
          <Button
            v-if="workspace.projectless"
            variant="context-menu-item"
            size="content"
            class="context-menu-item"
            :aria-current="workspace.isProjectless(project) ? 'true' : undefined"
            :title="workspace.projectless"
            @click="select(workspace.projectless)"
            ><MessagesSquare :size="14" class="size-auto shrink-0" /><span class="truncate">{{
              name(workspace.projectless)
            }}</span
            ><span v-if="workspace.isProjectless(project)" class="ml-auto">✓</span></Button
          >
          <Button variant="context-menu-item" size="content" class="context-menu-item" @click="openProject"
            ><Plus :size="14" class="size-auto shrink-0" />{{ t("sidebar.openProject") }}</Button
          >
        </div>
      </PopoverContent>
    </Popover>
    <Popover v-model:open="modeOpen"
      ><PopoverTrigger as-child
        ><Button
          variant="context-chip"
          size="content"
          class="context-chip"
          :disabled="blocked || !info"
          :title="gitError || undefined"
          ><Layers v-if="info?.worktree" :size="14" class="size-auto shrink-0" /><Laptop
            v-else
            :size="14"
            class="size-auto shrink-0" />{{ info?.worktree ? "Worktree" : t("workspace.local")
          }}<ChevronDown :size="12" class="size-auto shrink-0" /></Button
      ></PopoverTrigger>
      <PopoverContent align="start" class="w-64 p-2"
        ><ScrollArea v-if="info?.worktrees.length" viewport-class="max-h-64">
          <Button
            v-for="tree in info.worktrees"
            :key="tree.path"
            variant="context-menu-item"
            size="content"
            class="context-menu-item"
            :aria-current="tree.current ? 'true' : undefined"
            :title="tree.path"
            @click="selectWorktree(tree.path)"
            ><Layers :size="14" class="size-auto shrink-0" /><span class="truncate">{{
              tree.branch || t("workspace.detachedHead")
            }}</span
            ><span v-if="tree.current" class="ml-auto">✓</span></Button
          >
        </ScrollArea>
        <div class="border-t border-border pt-1.5">
          <Button variant="context-menu-item" size="content" class="context-menu-item" @click="openCreate(true)"
            ><Plus :size="14" class="size-auto shrink-0" />{{ t("workspace.createWorktree") }}</Button
          >
        </div></PopoverContent
      >
    </Popover>
    <Popover v-model:open="branchOpen"
      ><PopoverTrigger as-child
        ><Button
          variant="context-chip"
          size="content"
          class="context-chip"
          :disabled="blocked || !info"
          :title="gitError || undefined"
          ><LoaderCircle v-if="loading" :size="14" class="size-auto shrink-0 animate-spin" /><GitBranch
            v-else
            :size="14"
            class="size-auto shrink-0" /><span class="truncate">{{
            loading ? t("sidebar.loading") : info?.branch || t("workspace.noGit")
          }}</span
          ><ChevronDown v-if="info" :size="12" class="size-auto shrink-0" /></Button
      ></PopoverTrigger>
      <PopoverContent align="start" class="w-64 p-2"
        ><p class="px-2 py-2 text-xs text-muted-foreground">{{ t("workspace.currentBranch") }}: {{ info?.branch }}</p>
        <Button variant="context-menu-item" size="content" class="context-menu-item" @click="openCreate(false)"
          ><Plus :size="14" class="size-auto shrink-0" />{{ t("workspace.createBranch") }}</Button
        ><Button variant="context-menu-item" size="content" class="context-menu-item" @click="openCreate(true)"
          ><Layers :size="14" class="size-auto shrink-0" />{{ t("workspace.createWorktree") }}</Button
        ></PopoverContent
      >
    </Popover>
    <Dialog
      :open="createOpen"
      @update:open="
        v => {
          if (!workspace.gitBusy) createOpen = v
        }
      "
      ><DialogContent class="sm:max-w-md"
        ><DialogHeader
          ><DialogTitle>{{
            worktree ? t("workspace.createWorktree") : t("workspace.createBranch")
          }}</DialogTitle></DialogHeader
        >
        <form class="space-y-4" @submit.prevent="create">
          <p class="text-sm text-muted-foreground">
            {{ worktree ? t("workspace.worktreeHint") : t("workspace.branchHint") }}
          </p>
          <label class="block text-sm"
            >{{ t("workspace.branchName")
            }}<Input
              v-model="branch"
              :disabled="workspace.gitBusy"
              autofocus
              placeholder="feature/my-task"
              class="w-full rounded-lg border-border bg-background px-3 py-[9px] dark:bg-background mt-2 h-auto"
          /></label>
          <p v-if="error" role="alert" class="text-sm text-destructive whitespace-pre-wrap">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <Button
              variant="quiet"
              size="quiet"
              type="button"
              :disabled="workspace.gitBusy"
              @click="createOpen = false"
              >{{ t("workspace.cancel") }}</Button
            ><Button size="workspace" :disabled="workspace.gitBusy || !branch.trim()">{{
              workspace.gitBusy ? t("workspace.creating") : t("workspace.create")
            }}</Button>
          </div>
        </form>
      </DialogContent></Dialog
    >
  </div>
</template>
