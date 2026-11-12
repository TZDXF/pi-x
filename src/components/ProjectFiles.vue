<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronDown, ChevronRight, Folder, Layers, RefreshCw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { invokeProjectFile } from "@/api/client/projectFiles"
import { formatCodedError } from "@/lib/backendError"
import { baseName, samePath } from "@/lib/paths"
import { clampFileTreeWidth, fileTreeWidthBounds, FILE_TREE_DEFAULT_WIDTH } from "@/lib/fileTreeWidth"
import { directoriesToReload, interestPaths, previewNeedsReload } from "@/lib/projectFileSync"
import { fileDirectoryEntries, initialFilePath, type ProjectFileEntry as Entry } from "@/lib/projectFiles"
import { useProjectFileWatch } from "@/composables/useProjectFileWatch"
import { usePointerDrag } from "@/composables/usePointerDrag"
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
/** 预览刷新令牌：磁盘内容变化时 +1，由预览组件据此重新读取。 */
const previewRevision = ref(0)

async function load(path: string) {
  if (loading.value.has(path)) return
  loading.value = new Set([...loading.value, path])
  const current = generation
  try {
    const entries = await invokeProjectFile<Entry[]>("list_project_directory", activeRoot.value, path)
    if (current === generation) {
      children.value = { ...children.value, [path]: entries }
      const next = { ...errors.value }
      delete next[path]
      errors.value = next
    }
  } catch (error) {
    if (current === generation) errors.value = { ...errors.value, [path]: formatCodedError(t, error) }
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
  previewRevision.value = 0
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

// ---- 文件自动同步：监听项目目录，已加载的目录重新拉取列表，正在预览的文件重新读取内容。 ----
/**
 * Apply one backend report:
 * - ordinary changes re-list the affected loaded directories (a directory that
 *   itself disappeared is re-listed too, so its stale children are replaced),
 *   keeping expansion state as the user left it;
 * - `reset` means the root was recreated or the OS watch was re-armed: drop the
 *   cache and reload the root plus every expanded directory, so nothing from
 *   the old tree survives.
 */
function refreshChanged(paths: string[], reset = false) {
  if (props.files !== undefined) return
  if (reset) {
    children.value = {}
    errors.value = {}
  }
  const targets = reset ? ["", ...expanded.value] : directoriesToReload(paths, children.value)
  for (const dir of targets) void load(dir)
  if (reset || previewNeedsReload(selected.value, paths)) previewRevision.value++
}
/** 静态资源列表没有文件系统监听，远程项目由后端拒绝。 */
const watchRoot = computed(() => (props.files === undefined ? activeRoot.value : ""))
/** 后端只上报当前可浏览范围（已加载目录）与已打开文件的变更。 */
const interest = () => interestPaths(children.value, selected.value)
useProjectFileWatch({
  project: () => watchRoot.value,
  interest,
  onChange: change => refreshChanged(change.paths, change.reset),
})

// ---- 文件树宽度：默认不占满面板，内容区常开，宽度可拖拽并按项目记忆。 ----
const split = ref<HTMLElement | null>(null)
const containerWidth = ref(0)
const storageKey = "pix.project-files-tree-width"
const preferredTreeWidth = ref<number>(FILE_TREE_DEFAULT_WIDTH)
try {
  const saved = Number(localStorage.getItem(storageKey))
  if (Number.isFinite(saved) && saved > 0) preferredTreeWidth.value = saved
} catch {
  /* Storage may be unavailable in restricted browsers. */
}
const treeWidth = computed(() =>
  props.preview ? clampFileTreeWidth(preferredTreeWidth.value, containerWidth.value) : containerWidth.value,
)
const treeBounds = computed(() => fileTreeWidthBounds(containerWidth.value))
const treeDragging = ref(false)
let observer: ResizeObserver | undefined
function measure() {
  containerWidth.value = split.value?.getBoundingClientRect().width ?? 0
}
function saveWidth() {
  try {
    localStorage.setItem(storageKey, String(Math.round(preferredTreeWidth.value)))
  } catch {
    /* Optional preference. */
  }
}
function startTreeResize(event: PointerEvent) {
  measure()
  if (treeDrag.start(event, { x: event.clientX, width: treeWidth.value })) {
    ;(event.currentTarget as HTMLElement).focus()
    treeDragging.value = true
  }
}
const treeDrag = usePointerDrag<{ x: number; width: number }>({
  cursor: "col-resize",
  onMove: (start, event) => {
    // 手柄在文件树左侧：向左拖动变宽。
    preferredTreeWidth.value = clampFileTreeWidth(start.width + start.x - event.clientX, containerWidth.value)
  },
  onEnd: () => {
    treeDragging.value = false
    saveWidth()
  },
  onCancel: () => (treeDragging.value = false),
})
function resizeTree(event: PointerEvent) {
  treeDrag.move(event)
}
function stopTreeResize() {
  treeDrag.stop()
}
function resizeTreeWithKeyboard(event: KeyboardEvent) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return
  event.preventDefault()
  measure()
  const step = event.shiftKey ? 64 : 16
  const next =
    event.key === "Home"
      ? treeBounds.value.min
      : event.key === "End"
        ? treeBounds.value.max
        : treeWidth.value + (event.key === "ArrowLeft" ? step : -step)
  preferredTreeWidth.value = clampFileTreeWidth(next, containerWidth.value)
  saveWidth()
}
onMounted(() => {
  measure()
  observer = new ResizeObserver(measure)
  if (split.value) observer.observe(split.value)
  window.addEventListener("resize", measure)
  window.addEventListener("blur", stopTreeResize)
})
onBeforeUnmount(() => {
  stopTreeResize()
  saveWidth()
  observer?.disconnect()
  window.removeEventListener("resize", measure)
  window.removeEventListener("blur", stopTreeResize)
})
</script>

<template>
  <div data-project-files class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div ref="split" class="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <!-- 内容区常开：缩小文件树不影响预览，未选文件时保留占位提示。 -->
      <ProjectFilePreview
        v-if="preview && selected"
        :project="activeRoot"
        :path="selected"
        :comment-project="props.project"
        :revision="previewRevision"
        class="min-w-0 flex-1"
        @close="selected = null"
      />
      <section
        v-else-if="preview"
        class="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 border-r p-4 text-center text-xs text-muted-foreground"
        :aria-label="t('projectFiles.preview')"
      >
        <Layers class="size-5 opacity-60" aria-hidden="true" />
        <p>{{ t("projectFiles.selectFile") }}</p>
      </section>
      <div
        v-if="preview"
        class="project-files-tree-resize relative w-[7px] shrink-0 cursor-col-resize [touch-action:none] focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
        :class="{ 'is-dragging': treeDragging }"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        :aria-label="t('projectFiles.resizeTree')"
        :title="t('projectFiles.resizeTree')"
        :aria-valuenow="Math.round(treeWidth)"
        :aria-valuemin="Math.round(treeBounds.min)"
        :aria-valuemax="Math.round(treeBounds.max)"
        @pointerdown="startTreeResize"
        @pointermove="resizeTree"
        @pointerup="stopTreeResize"
        @pointercancel="stopTreeResize"
        @lostpointercapture="stopTreeResize"
        @keydown="resizeTreeWithKeyboard"
      />
      <div
        data-project-files-tree
        class="flex min-h-0 min-w-0 flex-col overflow-hidden"
        :class="preview ? 'shrink-0' : 'flex-1'"
        :style="preview ? { width: `${treeWidth}px` } : undefined"
      >
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
          <span v-else class="truncate text-xs text-muted-foreground" :title="activeRoot">{{
            baseName(activeRoot)
          }}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            :title="t('projectFiles.refresh')"
            :aria-label="t('projectFiles.refresh')"
            @click="reset"
            ><RefreshCw
          /></Button>
        </div>
        <ScrollArea class="min-h-0 min-w-0 flex-1" viewport-class="py-1">
          <p v-if="errors['']" class="px-3 py-2 text-xs text-destructive" role="alert">{{ errors[""] }}</p>
          <p v-else-if="loading.has('')" class="px-3 py-2 text-xs text-muted-foreground">
            {{ t("completion.loading") }}
          </p>
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
  </div>
</template>

<style scoped>
.project-files-tree-resize::after {
  content: "";
  position: absolute;
  inset: 0 0 0 auto;
  width: 2px;
  background: transparent;
  transition: background 120ms;
}
.project-files-tree-resize:hover::after,
.project-files-tree-resize:focus-visible::after,
.project-files-tree-resize.is-dragging::after {
  background: var(--primary);
}
</style>
