<script setup lang="ts">
import { computed, nextTick, ref, shallowRef, watch } from "vue"
import { useI18n } from "vue-i18n"
import { ChevronRight, Columns2, ExternalLink, FolderTree, Highlighter, List, Rows2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { isDesktop } from "@/api/transport"
import { openFileInEditor } from "@/lib/openWith"
import { normalizeSlashes } from "@/lib/paths"
import SessionDiff from "@/components/SessionDiff.vue"
import FileTypeIcon from "@/components/FileTypeIcon.vue"
import { buildFileTree, flatFileRows, flattenVisibleTree } from "@/lib/reviewFileTree"
import { changedLines, type FileChange } from "@/lib/sessionChanges"
import { checkpointFileContent, type TurnCheckpointRecord } from "@/lib/checkpoints"

const props = defineProps<{
  changes: FileChange[]
  project: string
  focus?: string | null
  checkpoints?: TurnCheckpointRecord[]
}>()
const { t } = useI18n()

const files = computed(() => {
  const groups = new Map<string, FileChange[]>()
  for (const change of props.changes) {
    const group = groups.get(change.path)
    if (group) group.push(change)
    else groups.set(change.path, [change])
  }
  return [...groups].map(([path, changes]) => ({
    path,
    changes,
    added: changes.reduce((n, c) => n + c.added, 0),
    removed: changes.reduce((n, c) => n + c.removed, 0),
  }))
})
const splitDiff = ref(false)
const wordDiff = ref(true)
const selectedPath = ref<string | null>(null)
// Keep the current file selected during streaming; fall back safely when the session changes.
const activeFile = computed(() => files.value.find(file => file.path === selectedPath.value) ?? files.value[0] ?? null)
const opening = ref(false)
const openError = ref("")
watch(
  () => activeFile.value?.path,
  () => {
    openError.value = ""
  },
)
async function openActiveFile() {
  const file = activeFile.value
  if (!file || opening.value) return
  const path = file.path
  opening.value = true
  openError.value = ""
  try {
    await openFileInEditor(path, props.project ?? "")
  } catch (error) {
    if (activeFile.value?.path === path) openError.value = t("openWith.failed", { error: String(error) })
  } finally {
    opening.value = false
  }
}
const treeMode = ref(false)
const collapsed = ref(new Set<string>())
const fileRows = computed(() =>
  treeMode.value
    ? flattenVisibleTree(
        buildFileTree(files.value.map(file => ({ ...file, path: normalizeSlashes(file.path) }))),
        collapsed.value,
      )
    : flatFileRows(files.value),
)
// Locate a file requested from a chat tool card: select it, reveal its
// tree ancestors, and scroll its row into view.
watch(
  () => props.focus,
  path => {
    if (!path) return
    const normalized = normalizeSlashes(path)
    const file = files.value.find(file => file.path === normalized)
    if (!file) return
    selectedPath.value = file.path
    const next = new Set(collapsed.value)
    const parts = normalized.split("/")
    for (let i = 1; i < parts.length; i++) next.delete(parts.slice(0, i).join("/"))
    collapsed.value = next
    nextTick(() =>
      document.querySelector('[data-review-panel] [aria-current="true"]')?.scrollIntoView({ block: "nearest" }),
    )
  },
  { immediate: true },
)
function selectRow(row: (typeof fileRows.value)[number]) {
  if (row.isDir) {
    const next = new Set(collapsed.value)
    if (next.has(row.fullPath)) next.delete(row.fullPath)
    else next.add(row.fullPath)
    collapsed.value = next
  } else if (row.data) selectedPath.value = row.data.changes[0]?.path ?? row.fullPath
}

// ---- 真实差异：artifact 优先，Git checkpoint 兼容旧会话 ----
// 内置文件变更插件已经为 write/edit 保存精确 before/after；没有 artifact 的
// 旧轮次再使用 Git 快照，最后才回退到工具参数片段。
const coveredPaths = computed(() => {
  const set = new Set<string>()
  for (const record of props.checkpoints ?? []) {
    for (const file of record.files) set.add(file.path)
  }
  return set
})
// Artifact-backed changes already carry exact before/after content. Never
// replace them with a broader checkpoint span from another turn.
const artifactBacked = computed(() =>
  activeFile.value?.changes.some(change => change.id.startsWith("artifact:")) ?? false,
)
const coverage = computed(() => {
  if (artifactBacked.value) return null
  const path = activeFile.value?.path
  const records = (props.checkpoints ?? []).filter(record => record.files.some(file => file.path === path))
  if (!path || !records.length) return null
  return { startOid: records[0]!.startOid, endOid: records[records.length - 1]!.endOid }
})
const realDiffKey = computed(() => {
  const span = coverage.value
  const path = activeFile.value?.path
  return span && path ? `${props.project}|${span.startOid}|${span.endOid}|${path}` : null
})
const realCache = new Map<string, FileChange | null>()
const realDiff = shallowRef<FileChange | null>(null)
watch(
  realDiffKey,
  key => {
    if (!key || !coverage.value || !activeFile.value) {
      realDiff.value = null
      return
    }
    const hit = realCache.get(key)
    if (hit !== undefined) {
      realDiff.value = hit
      return
    }
    realDiff.value = null
    const span = coverage.value
    const path = activeFile.value.path
    void (async () => {
      try {
        const [before, after] = await Promise.all([
          checkpointFileContent(props.project, span.startOid, path),
          checkpointFileContent(props.project, span.endOid, path),
        ])
        if (realDiffKey.value !== key) return
        const lines = changedLines(before ?? "", after ?? "")
        const change: FileChange = {
          id: `snapshot:${key}`,
          path,
          tool: "git",
          lines,
          added: lines.filter(line => line.kind === "add").length,
          removed: lines.filter(line => line.kind === "remove").length,
          unknownBefore: false,
        }
        realCache.set(key, change)
        realDiff.value = change
      } catch {
        // 快照不可读（历史会话残留 ref 被 GC 等）→ 保持参数片段视图。
        realCache.set(key, null)
        if (realDiffKey.value === key) realDiff.value = null
      }
    })()
  },
  { immediate: true },
)
</script>

<template>
  <div data-review-panel class="flex min-h-0 flex-1 flex-col min-w-0">
    <p class="border-b p-3 text-xs text-muted-foreground">{{ t("changes.description") }}</p>
    <div
      v-if="activeFile"
      class="changes-review-body grid [grid-template-columns:minmax(0,_1fr)_minmax(100px,_30%)] flex-1 min-h-0 min-w-0 overflow-hidden"
    >
      <section
        :key="activeFile.path"
        class="changes-file-view flex flex-col min-w-0 min-h-0 overflow-hidden"
        :aria-label="t('changes.fileDiff')"
      >
        <div class="flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
          <h3 class="min-w-0 flex-1 truncate font-mono text-xs" :title="activeFile.path">{{ activeFile.path }}</h3>
          <Button
            variant="quiet"
            size="review"
            v-if="isDesktop"
            :disabled="opening"
            :title="t('openWith.open')"
            :aria-label="t('openWith.open')"
            @click="openActiveFile"
            ><ExternalLink
          /></Button>
          <Button
            variant="quiet"
            size="review"
            :class="{ 'bg-accent text-foreground': wordDiff }"
            :title="t('changes.wordDiff')"
            :aria-label="t('changes.wordDiff')"
            :aria-pressed="wordDiff"
            @click="wordDiff = !wordDiff"
            ><Highlighter
          /></Button>
          <Button
            variant="quiet"
            size="review"
            v-if="realDiff || activeFile.changes.some(change => !change.unknownBefore)"
            :title="t(splitDiff ? 'changes.unified' : 'changes.split')"
            :aria-label="t(splitDiff ? 'changes.unified' : 'changes.split')"
            :aria-pressed="splitDiff"
            @click="splitDiff = !splitDiff"
            ><Rows2 v-if="splitDiff" /><Columns2 v-else
          /></Button>
        </div>
        <p v-if="openError" role="alert" class="shrink-0 break-words border-b px-3 py-2 text-xs text-destructive">
          {{ openError }}
        </p>
        <!-- 换 key 重建:reka-ui 的 ScrollAreaScrollbar 卸载时会同时禁用两个方向,动态改 orientation 会让 overflow-y 卡在 hidden -->
        <ScrollArea
          :key="splitDiff ? 'split' : 'unified'"
          class="min-h-0 flex-1"
          :orientation="splitDiff ? 'vertical' : 'both'"
          viewport-class="pb-2.5"
          :aria-label="t('changes.fileDiff')"
        >
          <template v-if="realDiff">
            <section class="border-b">
              <div class="px-3 py-2 text-xs text-muted-foreground">{{ t("changes.realDiff") }}</div>
              <SessionDiff :change="realDiff" :split="splitDiff" :word="wordDiff" />
            </section>
          </template>
          <template v-else>
            <section v-for="(change, operation) in activeFile.changes" :key="change.id" class="border-b">
              <div class="px-3 py-2 text-xs text-muted-foreground">
                {{ operation + 1 }} · {{ change.tool
                }}<span v-if="!change.unknownBefore"> · {{ t("changes.snippetLines") }}</span
                ><span v-if="change.unknownBefore"> · {{ t("changes.unknown") }}</span>
              </div>
              <SessionDiff :change="change" :split="splitDiff" :word="wordDiff" />
            </section>
          </template>
        </ScrollArea>
      </section>
      <nav
        class="changes-file-list flex flex-col min-w-0 min-h-0 overflow-hidden border-l border-border bg-background"
        :aria-label="t('changes.files')"
      >
        <div class="flex shrink-0 items-center justify-between border-b px-3 py-1.5">
          <h3 class="text-xs text-muted-foreground">{{ t("changes.files") }} · {{ files.length }}</h3>
          <Button
            variant="quiet"
            size="review"
            :title="t(treeMode ? 'changes.showFlat' : 'changes.showTree')"
            :aria-label="t(treeMode ? 'changes.showFlat' : 'changes.showTree')"
            @click="treeMode = !treeMode"
            ><List v-if="treeMode" /><FolderTree v-else
          /></Button>
        </div>
        <ScrollArea class="min-h-0 flex-1" viewport-class="py-1">
          <button
            v-for="row in fileRows"
            :key="row.key"
            type="button"
            class="changes-file-row flex items-center gap-1.5 w-full py-1 px-2 text-left font-mono text-xs cursor-pointer hover:[background:color-mix(in_srgb,_var(--accent)_60%,_transparent)] focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
            :class="{ 'bg-accent': !row.isDir && row.data?.changes[0]?.path === activeFile.path }"
            :style="{ paddingLeft: treeMode ? `${8 + row.depth * 14}px` : '12px' }"
            :aria-current="!row.isDir && row.data?.changes[0]?.path === activeFile.path ? 'true' : undefined"
            :aria-expanded="row.isDir ? row.expanded : undefined"
            :title="row.fullPath"
            @click="selectRow(row)"
          >
            <span v-if="treeMode" class="w-3 shrink-0 text-muted-foreground"
              ><ChevronRight
                v-if="row.isDir"
                class="size-3 transition-transform"
                :class="{ 'rotate-90': row.expanded }"
            /></span>
            <FileTypeIcon :name="row.name" :dir="row.isDir" :open="row.expanded" class="size-3.5" />
            <span class="min-w-0 flex-1 truncate">{{ row.name }}</span>
            <template v-if="row.data">
              <span v-if="row.data.added" class="shrink-0 text-green-600 dark:text-green-400"
                >+{{ row.data.added }}</span
              >
              <span v-if="row.data.removed" class="shrink-0 text-red-600 dark:text-red-400"
                >-{{ row.data.removed }}</span
              >
              <!-- 快照覆盖的文件在右侧展示真实 diff，原内容不再"未知"，无需标记。 -->
              <span
                v-if="row.data.changes.some(change => change.unknownBefore) && !coveredPaths.has(row.data.path)"
                :title="t('changes.unknown')"
                >*</span
              >
            </template>
          </button>
        </ScrollArea>
      </nav>
    </div>
    <p v-else class="p-6 text-center text-sm text-muted-foreground">{{ t("changes.empty") }}</p>
  </div>
</template>
