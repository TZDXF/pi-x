<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronDown, ChevronRight, Folder, Layers, RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { invoke } from "@/api/transport"
import { baseName, samePath } from "@/lib/paths"
import { fileDirectoryEntries, initialFilePath, type ProjectFileEntry as Entry } from "@/lib/projectFiles"
import { useWorkspaceStore } from "@/stores/workspace"
import ProjectFilePreview from "@/components/ProjectFilePreview.vue"
import FileTypeIcon from "@/components/FileTypeIcon.vue"

const props = withDefaults(
  defineProps<{
    project: string
    /** Omit for lazy project directory loading; provide for a static resource list. */
    files?: string[]
    filter?: string
    preview?: boolean
    showHeader?: boolean
    /** Static lists may request a specific initial document, without a first-file fallback. */
    defaultSelectedPath?: string | null
  }>(),
  { filter: "", preview: true, showHeader: true },
)
const { t } = useI18n()
const workspace = useWorkspaceStore()
// 多目录项目：树根默认跟随会话目录，可在组内目录（含 worktree）之间切换。
const roots = computed(() => (props.files === undefined ? workspace.projectFolders(props.project) : [props.project]))
const activeRoot = ref(props.project)
function rootLabel(root: string) {
  return samePath(root, props.project) ? workspace.projectName(props.project) : baseName(root)
}
const children = ref<Record<string, Entry[]>>({})
const expanded = ref(new Set<string>())
const loading = ref(new Set<string>())
const errors = ref<Record<string, string>>({})
const selected = defineModel<string | null>("selectedPath", { default: null })
const directories = computed(() =>
  props.files === undefined ? children.value : fileDirectoryEntries(props.files, props.filter),
)
const visibleExpanded = computed(() =>
  props.files !== undefined && props.filter.trim() ? new Set(Object.keys(directories.value)) : expanded.value,
)
let generation = 0

async function load(path: string) {
  if (loading.value.has(path)) return
  loading.value = new Set([...loading.value, path])
  const current = generation
  try {
    const entries = await invoke<Entry[]>("list_project_directory", { project: activeRoot.value, path })
    if (current === generation) {
      children.value = { ...children.value, [path]: entries }
      const next = { ...errors.value }
      delete next[path]
      errors.value = next
    }
  } catch (error) {
    if (current === generation) errors.value = { ...errors.value, [path]: String(error) }
  } finally {
    if (current === generation) {
      const next = new Set(loading.value)
      next.delete(path)
      loading.value = next
    }
  }
}
function reset() {
  generation++
  children.value = {}
  expanded.value = new Set()
  loading.value = new Set()
  errors.value = {}
  selected.value = null
  if (props.files !== undefined) {
    selected.value = initialFilePath(props.files, props.defaultSelectedPath)
  } else void load("")
}
onMounted(reset)
watch(
  () => [props.project, props.files] as const,
  () => {
    activeRoot.value = props.project
    reset()
  },
)
watch(activeRoot, reset)
function toggle(entry: Entry) {
  if (!entry.is_dir) {
    selected.value = entry.path
    return
  }
  const next = new Set(expanded.value)
  if (next.has(entry.path)) next.delete(entry.path)
  else {
    next.add(entry.path)
    if (props.files === undefined && !(entry.path in children.value)) void load(entry.path)
  }
  expanded.value = next
}
const rows = computed(() => {
  const result: { entry: Entry; depth: number }[] = []
  function append(path: string, depth: number) {
    for (const entry of directories.value[path] ?? []) {
      result.push({ entry, depth })
      if (entry.is_dir && visibleExpanded.value.has(entry.path)) append(entry.path, depth + 1)
    }
  }
  append("", 0)
  return result
})
</script>

<template>
  <div data-project-files class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div v-if="showHeader" class="flex h-10 shrink-0 items-center justify-between border-b px-3">
      <DropdownMenu v-if="roots.length > 1">
        <DropdownMenuTrigger as-child
          ><Button
            variant="ghost"
            size="sm"
            class="min-w-0 gap-1 px-1.5 text-xs text-muted-foreground"
            :title="activeRoot"
            :aria-label="t('projectFiles.switchFolder')"
            ><Folder v-if="!workspace.isWorktree(activeRoot)" :size="13" class="shrink-0" /><Layers
              v-else
              :size="13"
              class="shrink-0" /><span class="truncate">{{ baseName(activeRoot) }}</span
            ><ChevronDown :size="13" class="shrink-0" opacity="0.6" /></Button
        ></DropdownMenuTrigger>
        <DropdownMenuContent align="start" class="w-auto">
          <DropdownMenuItem v-for="root in roots" :key="root" :title="root" @select="activeRoot = root"
            ><Layers v-if="workspace.isWorktree(root)" :size="14" class="size-auto shrink-0" /><Folder
              v-else
              :size="14"
              class="size-auto shrink-0"
            /><span class="truncate">{{ rootLabel(root) }}</span
            ><span v-if="samePath(root, props.project)" class="ml-auto shrink-0 text-xs text-muted-foreground">{{
              t("projectDialog.primary")
            }}</span></DropdownMenuItem
          >
        </DropdownMenuContent>
      </DropdownMenu>
      <span v-else class="truncate text-xs text-muted-foreground" :title="activeRoot">{{ baseName(activeRoot) }}</span>
      <Button
        variant="ghost"
        size="icon-xs"
        :title="t('projectFiles.refresh')"
        :aria-label="t('projectFiles.refresh')"
        @click="reset"
        ><RefreshCw
      /></Button>
    </div>
    <div
      class="grid min-h-0 flex-1 overflow-hidden"
      :class="preview && selected ? 'grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'grid-cols-1'"
    >
      <ProjectFilePreview
        v-if="preview && selected"
        :project="activeRoot"
        :path="selected"
        :comment-project="props.project"
        @close="selected = null"
      />
      <ScrollArea class="min-h-0 min-w-0" viewport-class="py-1">
        <p v-if="errors['']" class="px-3 py-2 text-xs text-destructive" role="alert">{{ errors[""] }}</p>
        <p v-else-if="loading.has('')" class="px-3 py-2 text-xs text-muted-foreground">{{ t("completion.loading") }}</p>
        <p v-else-if="!rows.length" class="px-3 py-2 text-xs text-muted-foreground">{{ t("projectFiles.empty") }}</p>
        <template v-for="{ entry, depth } in rows" :key="entry.path">
          <button
            type="button"
            class="flex w-full items-center gap-1.5 py-1 pr-2 text-left font-mono text-xs hover:bg-accent/60 focus-visible:outline-ring"
            :class="{ 'bg-accent': entry.path === selected }"
            :style="{ paddingLeft: `${8 + depth * 16}px` }"
            :title="entry.path"
            :aria-expanded="entry.is_dir ? visibleExpanded.has(entry.path) : undefined"
            :aria-current="!entry.is_dir && entry.path === selected ? 'true' : undefined"
            @click="toggle(entry)"
          >
            <ChevronRight
              v-if="entry.is_dir"
              class="size-3.5 shrink-0"
              :class="{ 'rotate-90': visibleExpanded.has(entry.path) }"
            />
            <span v-else class="w-3.5 shrink-0" />
            <FileTypeIcon
              :name="entry.name"
              :dir="entry.is_dir"
              :open="visibleExpanded.has(entry.path)"
              class="size-3.5"
            />
            <span class="truncate">{{ entry.name }}</span>
          </button>
          <p v-if="errors[entry.path]" class="px-3 py-1 text-xs text-destructive" role="alert">
            {{ errors[entry.path] }}
          </p>
          <p
            v-else-if="entry.is_dir && visibleExpanded.has(entry.path) && loading.has(entry.path)"
            class="px-3 py-1 text-xs text-muted-foreground"
          >
            {{ t("completion.loading") }}
          </p>
        </template>
      </ScrollArea>
    </div>
  </div>
</template>
