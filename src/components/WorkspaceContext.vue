<script setup lang="ts">
import { computed, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { Folder, GitBranch, Laptop, Layers, MessagesSquare, Plus, LoaderCircle } from "@lucide/vue"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { workspaceGitInfo, createWorkspaceGit, type WorkspaceGitInfo, type WorkspaceSelection } from "@/api/piClient"
import { tBackendError } from "@/i18n"
import { useWorkspaceStore } from "@/stores/workspace"
const props = defineProps<{ project: string; disabled?: boolean }>()
const emit = defineEmits<{ selectProject: [path: string]; openProject: [] }>()
const selection = defineModel<WorkspaceSelection | null>({ default: null })
const workspace = useWorkspaceStore()
const { t } = useI18n()
const info = ref<WorkspaceGitInfo | null>(null)
const loading = ref(false)
const gitError = ref("")
const projectOpen = ref(false)

function openProject() {
  if (blocked.value) return
  projectOpen.value = false
  emit("openProject")
}
const modeOpen = ref(false)
const branchOpen = ref(false)
const blocked = computed(() => props.disabled || workspace.gitBusy)
const name = (path: string) => workspace.projectName(path)
// 空项目仅作为无项目会话的初始展示；真正切换仍由父组件完成。
const isProjectless = computed(() => !props.project || workspace.isProjectless(props.project))
const projectTitle = computed(() => props.project || workspace.projectless)
const projectLabel = computed(() => (props.project ? name(props.project) : t("projectless.name")))
// An unborn HEAD is the current branch, but it has no commit to use as a base.
const branchOptions = computed(() => {
  const result = info.value
  if (!result) return []
  return result.unborn_branch && !result.branches.includes(result.branch)
    ? [result.branch, ...result.branches]
    : result.branches
})
const unbornBranch = (branch: string) => info.value?.unborn_branch && info.value.branch === branch
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
  if (!props.project) return
  const id = ++request
  loading.value = true
  info.value = null
  selection.value = null
  gitError.value = ""
  try {
    const result = await workspaceGitInfo(props.project)
    if (id === request) {
      info.value = result
      selection.value = {
        project: props.project,
        worktree: false,
        branch: result.branch,
      }
      workspace.registerWorktrees(result)
    }
  } catch (e) {
    if (id === request) gitError.value = String(e)
  } finally {
    if (id === request) loading.value = false
  }
}
function select(path: string) {
  if (blocked.value) return
  projectOpen.value = false
  if (path !== props.project) emit("selectProject", path)
}
// 这里只记录草稿的工作环境；首次发送时才准备工作区。
function selectMode(worktree: boolean) {
  if (blocked.value) return
  if (selection.value) {
    const branch =
      worktree && !info.value?.branches.includes(selection.value.branch)
        ? info.value?.branches[0] || ""
        : selection.value.branch
    selection.value = { ...selection.value, worktree, branch }
  }
  modeOpen.value = false
}
function selectBranch(branch: string) {
  if (blocked.value) return
  if (selection.value) selection.value = { ...selection.value, branch }
  branchOpen.value = false
}
// 分支下拉内通过按钮弹出对话框创建并检出新分支；工作树模式下选中的只是基准分支，因此仅本地模式提供。
const newBranch = ref("")
const createError = ref("")
const creating = ref(false)
const createOpen = ref(false)
watch(createOpen, open => {
  if (open) {
    newBranch.value = ""
    createError.value = ""
  }
})
function openCreateDialog() {
  if (blocked.value) return
  branchOpen.value = false
  createOpen.value = true
}
async function createBranch() {
  const branch = newBranch.value.trim()
  if (blocked.value || creating.value || !branch) return
  creating.value = true
  workspace.gitBusy = true
  createError.value = ""
  try {
    await createWorkspaceGit(props.project, branch, false)
    newBranch.value = ""
    // 创建后新分支即当前分支，重新拉取使下拉与草稿选择保持一致。
    await refresh()
    createOpen.value = false
  } catch (e) {
    createError.value = tBackendError(e)
  } finally {
    creating.value = false
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
        ><Button
          variant="context-chip"
          size="content"
          class="context-chip"
          :disabled="blocked"
          :title="projectTitle || undefined"
          ><Folder :size="14" class="size-auto shrink-0" /><span class="truncate">{{ projectLabel }}</span></Button
        ></PopoverTrigger
      >
      <PopoverContent side="top" align="start" class="w-72 p-2">
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
            :aria-current="isProjectless ? 'true' : undefined"
            :title="workspace.projectless"
            @click="select(workspace.projectless)"
            ><MessagesSquare :size="14" class="size-auto shrink-0" /><span class="truncate">{{
              name(workspace.projectless)
            }}</span
            ><span v-if="isProjectless" class="ml-auto">✓</span></Button
          >
          <Button variant="context-menu-item" size="content" class="context-menu-item" @click="openProject"
            ><Plus :size="14" class="size-auto shrink-0" />{{ t("sidebar.openProject") }}</Button
          >
        </div>
      </PopoverContent>
    </Popover>
    <Popover v-if="!isProjectless" v-model:open="modeOpen"
      ><PopoverTrigger as-child
        ><Button
          variant="context-chip"
          size="content"
          class="context-chip"
          :disabled="blocked || !info"
          :title="gitError || undefined"
          ><Layers v-if="selection?.worktree" :size="14" class="size-auto shrink-0" /><Laptop
            v-else
            :size="14"
            class="size-auto shrink-0"
          />{{ selection?.worktree ? t("workspace.createWorktree") : t("workspace.local") }}</Button
        ></PopoverTrigger
      >
      <PopoverContent side="top" align="start" class="w-64 p-2"
        ><Button
          variant="context-menu-item"
          size="content"
          class="context-menu-item"
          :aria-current="!selection?.worktree ? 'true' : undefined"
          @click="selectMode(false)"
          ><Laptop :size="14" class="size-auto shrink-0" /><span>{{ t("workspace.local") }}</span
          ><span v-if="!selection?.worktree" class="ml-auto">✓</span></Button
        >
        <Button
          variant="context-menu-item"
          size="content"
          class="context-menu-item"
          :aria-current="selection?.worktree ? 'true' : undefined"
          @click="selectMode(true)"
          ><GitBranch :size="14" class="size-auto shrink-0" />{{ t("workspace.createWorktree")
          }}<span v-if="selection?.worktree" class="ml-auto">✓</span></Button
        ></PopoverContent
      >
    </Popover>
    <Popover v-if="!isProjectless" v-model:open="branchOpen"
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
            class="size-auto shrink-0"
          /><span class="truncate">{{
            loading ? t("sidebar.loading") : selection?.branch || info?.branch || t("workspace.noGit")
          }}</span></Button
        ></PopoverTrigger
      >
      <PopoverContent side="top" align="start" class="w-64 p-2">
        <p class="px-2 py-2 text-xs text-muted-foreground">
          {{ t(selection?.worktree ? "workspace.baseBranch" : "workspace.currentBranch") }}
        </p>
        <ScrollArea viewport-class="max-h-64">
          <Button
            v-for="branch in branchOptions"
            :key="branch"
            variant="context-menu-item"
            size="content"
            class="context-menu-item"
            :disabled="blocked || (selection?.worktree && unbornBranch(branch))"
            :title="unbornBranch(branch) ? t('workspace.noCommitsYet') : undefined"
            :aria-current="selection?.branch === branch ? 'true' : undefined"
            @click="selectBranch(branch)"
            ><GitBranch :size="14" class="size-auto shrink-0" /><span class="truncate">{{ branch }}</span
            ><span class="ml-auto flex shrink-0 items-center gap-2"
              ><span v-if="unbornBranch(branch)" class="text-xs text-muted-foreground">{{
                t("workspace.noCommitsYet")
              }}</span
              ><span v-if="selection?.branch === branch">✓</span></span
            ></Button
          >
        </ScrollArea>
        <div v-if="!selection?.worktree" class="mt-1 border-t border-border pt-1.5">
          <Button
            variant="context-menu-item"
            size="content"
            class="context-menu-item"
            :disabled="blocked"
            @click="openCreateDialog"
            ><Plus :size="14" class="size-auto shrink-0" />{{ t("workspace.createBranch") }}</Button
          >
        </div>
      </PopoverContent>
    </Popover>
    <Dialog v-model:open="createOpen">
      <DialogContent class="sm:max-w-sm">
        <DialogHeader><DialogTitle>{{ t("workspace.createBranch") }}</DialogTitle></DialogHeader>
        <form class="space-y-4" @submit.prevent="createBranch">
          <p class="text-sm text-muted-foreground">{{ t("workspace.branchHint") }}</p>
          <Input
            v-model="newBranch"
            autofocus
            :placeholder="t('workspace.branchName')"
            :disabled="blocked || creating"
            @keydown.enter="createBranch"
          />
          <p v-if="createError" role="alert" class="text-sm text-destructive">{{ createError }}</p>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" :disabled="creating" @click="createOpen = false">{{
              t("common.cancel")
            }}</Button>
            <Button type="submit" :disabled="blocked || creating || !newBranch.trim()"
              ><LoaderCircle v-if="creating" :size="15" class="animate-spin" />{{
                creating ? t("workspace.creating") : t("workspace.create")
              }}</Button
            >
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </div>
</template>
