<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue"
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
import type { FileChange } from "@/lib/sessionChanges"

const props = defineProps<{
  changes: FileChange[]
  project: string
  focus?: string | null
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
</script>

<template>
  <div data-review-panel class="flex min-h-0 flex-1 flex-col min-w-0">
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
            v-if="activeFile.changes.some(change => !change.unknownBefore)"
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
          <section v-for="(change, operation) in activeFile.changes" :key="change.id" class="border-b">
            <div class="px-3 py-2 text-xs text-muted-foreground">
              {{ operation + 1 }} · {{ change.tool
              }}<span v-if="!change.unknownBefore">
                · {{ t(change.id.startsWith("artifact:") ? "changes.exactLines" : "changes.snippetLines") }}</span
              ><span v-if="change.unknownBefore"> · {{ t("changes.unknown") }}</span>
            </div>
            <SessionDiff :change="change" :split="splitDiff" :word="wordDiff" />
          </section>
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
              <span v-if="row.data.changes.some(change => change.unknownBefore)" :title="t('changes.unknown')">*</span>
            </template>
          </button>
        </ScrollArea>
      </nav>
    </div>
    <p v-else class="p-6 text-center text-sm text-muted-foreground">{{ t("changes.empty") }}</p>
  </div>
</template>
