<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Check, ChevronRight, Eye, Undo2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import FileTypeIcon from "@/components/FileTypeIcon.vue"
import { relativeDisplayPath } from "@/lib/paths"
import { encodeCodedError } from "@/lib/backendError"
import { restoreCheckpoints, type TurnCheckpointRecord } from "@/lib/checkpoints"
import { revertTurnFiles, type RevertFileResult } from "@/lib/revertChanges"
import type { TurnFileChange } from "@/lib/turnChanges"

const props = defineProps<{ files: TurnFileChange[]; project: string; checkpoint?: TurnCheckpointRecord | null }>()
const emit = defineEmits<{ openReview: [path: string]; reverted: [results: RevertFileResult[]]; revertedAll: [] }>()
const { t } = useI18n()

const expanded = ref(false)
const busy = ref(false)
const confirmOpen = ref(false)
const reverted = ref(new Set<string>())
const totals = computed(() => props.files.reduce(
  (sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }),
  { added: 0, removed: 0 },
))
const revertibleFiles = computed(() => props.files.filter(file => file.revertible && !reverted.value.has(file.path)))
// Git 快照回滚：该轮处于「未回滚」状态才可用；否则降级为内容回放。
const gitRevertible = computed(() => !!props.checkpoint && props.checkpoint.state === "active")
const turnReverted = computed(() => !!props.checkpoint && props.checkpoint.state === "reverted")

// 项目内显示相对路径，项目外显示原路径；目录段弱化、文件名保持高亮。
const rows = computed(() => props.files.map((file) => {
  const display = relativeDisplayPath(file.path, props.project)
  const index = display.lastIndexOf("/")
  return {
    file,
    display,
    dir: index === -1 ? "" : display.slice(0, index + 1),
    base: index === -1 ? display : display.slice(index + 1),
  }
}))

async function revert(list: TurnFileChange[], full: boolean) {
  if (busy.value || !list.length) return
  busy.value = true
  try {
    let results: RevertFileResult[]
    if (gitRevertible.value && props.checkpoint) {
      // 回滚 = 从结束态恢复到轮开始前的快照；子集回滚只传受影响路径。
      const outcome = await restoreCheckpoints(
        props.project,
        props.checkpoint.endOid,
        props.checkpoint.startOid,
        full ? undefined : list.map(file => file.path),
      )
      results = [
        ...outcome.restored.map(path => ({ path, ok: true })),
        ...outcome.conflicts.map(conflict => ({
          path: conflict.path,
          ok: false,
          error: encodeCodedError("checkpointConflict", "文件在回滚前被再次修改，已跳过", { detail: conflict.path }),
        })),
      ]
    } else {
      results = await revertTurnFiles(props.project, list.map(file => ({ path: file.path, ops: file.ops })))
    }
    for (const result of results) if (result.ok) reverted.value.add(result.path)
    if (full && results.length > 0 && results.every(result => result.ok)) emit("revertedAll")
    emit("reverted", results)
  } catch (error) {
    emit("reverted", [{ path: "", ok: false, error: String(error) }])
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="not-prose w-full overflow-hidden rounded-md border bg-background/60">
    <div class="flex items-center gap-1 py-1 pl-1 pr-1.5">
      <button
        type="button"
        class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent/50 focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
        :aria-expanded="expanded"
        :aria-label="t(expanded ? 'turnChanges.collapse' : 'turnChanges.expand')"
        @click="expanded = !expanded"
      >
        <ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform" :class="{ 'rotate-90': expanded }" />
        <FileTypeIcon :name="files[0]?.path ?? ''" class="size-3.5" />
        <span class="min-w-0 truncate text-xs text-muted-foreground">{{ t('turnChanges.filesCount', { count: files.length }) }}</span>
        <span class="flex shrink-0 items-center gap-1.5 text-xs font-medium tabular-nums">
          <span v-if="totals.added" class="text-green-600 dark:text-green-400">+{{ totals.added }}</span>
          <span v-if="totals.removed" class="text-red-600 dark:text-red-400">-{{ totals.removed }}</span>
        </span>
        <span
          v-if="turnReverted"
          class="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
        >{{ t('turnChanges.reverted') }}</span>
      </button>
      <Button
        v-if="revertibleFiles.length && !turnReverted"
        type="button"
        variant="ghost"
        size="xs"
        class="shrink-0 text-muted-foreground"
        :disabled="busy"
        :title="t('turnChanges.revertAll')"
        :aria-label="t('turnChanges.revertAll')"
        @click="confirmOpen = true"
      >
        <Undo2 data-icon="inline-start" />{{ busy ? t('turnChanges.busy') : t('turnChanges.revert') }}
      </Button>
    </div>
    <div v-if="expanded" class="border-t border-border" role="list" :aria-label="t('turnChanges.title')">
      <div v-for="row in rows" :key="row.file.path" role="listitem"
        class="group flex items-center gap-1.5 border-b border-border/60 py-1 pl-2.5 pr-1.5 transition-colors last:border-b-0 hover:bg-accent/30">
        <FileTypeIcon :name="row.base" class="size-3.5" />
        <button
          type="button"
          class="min-w-0 flex-1 truncate py-0.5 text-left font-mono text-xs focus-visible:[outline:2px_solid_var(--ring)] focus-visible:[outline-offset:-2px]"
          :title="row.file.path"
          :aria-label="t('turnChanges.viewFile', { path: row.display })"
          @click="emit('openReview', row.file.path)"
        ><span v-if="row.dir" class="text-muted-foreground">{{ row.dir }}</span><span>{{ row.base }}</span></button>
        <span class="flex shrink-0 items-center gap-1.5 text-xs tabular-nums">
          <span v-if="row.file.added" class="text-green-600 dark:text-green-400">+{{ row.file.added }}</span>
          <span v-if="row.file.removed" class="text-red-600 dark:text-red-400">-{{ row.file.removed }}</span>
        </span>
        <div class="flex shrink-0 items-center gap-0.5 opacity-75 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground"
            :title="t('turnChanges.view')"
            :aria-label="t('turnChanges.viewFile', { path: row.display })"
            @click="emit('openReview', row.file.path)"
          ><Eye /></Button>
          <span
            v-if="turnReverted || reverted.has(row.file.path)"
            class="flex size-6 shrink-0 items-center justify-center text-green-600 dark:text-green-400"
            :title="t('turnChanges.reverted')"
            :aria-label="t('turnChanges.reverted')"
          >
            <Check class="size-3.5" />
          </span>
          <Button
            v-else
            type="button"
            variant="ghost"
            size="icon-xs"
            class="text-muted-foreground"
            :disabled="busy || !row.file.revertible"
            :title="row.file.revertible ? t('turnChanges.revertFile') : t('turnChanges.notRevertible')"
            :aria-label="row.file.revertible ? t('turnChanges.revertFile') : t('turnChanges.notRevertible')"
            @click="revert([row.file], false)"
          ><Undo2 /></Button>
        </div>
      </div>
    </div>

    <Dialog :open="confirmOpen" @update:open="confirmOpen = $event">
      <DialogContent class="max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t('turnChanges.confirmTitle') }}</DialogTitle>
        </DialogHeader>
        <p class="text-muted-foreground text-xs">{{ t('turnChanges.confirmDesc') }}</p>
        <ScrollArea viewport-class="max-h-60">
          <div class="flex flex-col gap-0.5 pr-2">
            <div v-for="file in revertibleFiles" :key="file.path"
              class="flex items-center gap-2 rounded-md px-1 py-1.5 font-mono text-xs hover:bg-muted">
              <span class="min-w-0 flex-1 truncate" :title="file.path">{{ relativeDisplayPath(file.path, project) }}</span>
              <span v-if="file.added" class="shrink-0 tabular-nums text-green-600 dark:text-green-400">+{{ file.added }}</span>
              <span v-if="file.removed" class="shrink-0 tabular-nums text-red-600 dark:text-red-400">-{{ file.removed }}</span>
            </div>
          </div>
        </ScrollArea>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" :disabled="busy" @click="confirmOpen = false">{{ t('common.cancel') }}</Button>
          <Button type="button" size="sm" :disabled="busy" @click="confirmOpen = false; revert(revertibleFiles, true)">{{ busy ? t('turnChanges.busy') : t('turnChanges.confirmAction') }}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
</template>
