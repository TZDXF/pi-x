<script setup lang="ts">
import { computed, ref, useId } from "vue"
import { useI18n } from "vue-i18n"
import { Archive, LoaderCircle, Pencil } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspaceStore } from "@/stores/workspace"
import { peekConversation, useUiStore } from "@/stores/conversations"
import { isRemoteProject } from "@/lib/ssh"
import { normalizeProjectPath, samePath } from "@/lib/paths"
import type { KanbanCard } from "@/lib/kanban"
import type { BoardDraft } from "@/lib/workspaceState"

const props = defineProps<{
  card: KanbanCard
  projects: { value: string; label: string }[]
  disabled?: boolean
}>()
const emit = defineEmits<{ open: [card: KanbanCard] }>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const ui = useUiStore()
const id = useId()
const editing = ref(false)
const saving = ref(false)
const archiving = ref(false)
const message = ref("")
const project = ref("")
const error = ref("")
const queuedId = ref<number | null>(null)
const draft = computed(() =>
  props.card.draftId
    ? (workspace.boardDrafts[props.card.draftId] as (BoardDraft & { attachments?: unknown[] }) | undefined)
    : undefined,
)
const owner = computed(() => {
  const key = props.card.runtimeId || props.card.draftId || props.card.file
  return key ? peekConversation(key, props.card.cwd || props.card.project) : undefined
})
const projectLocked = computed(() => !draft.value || !!owner.value?.started)
const canSave = computed(
  () =>
    !props.disabled &&
    !saving.value &&
    (!!message.value.trim() || !!draft.value?.attachments?.length || !!owner.value?.promptQueue[0]?.images?.length) &&
    (projectLocked.value || props.projects.some(item => samePath(item.value, project.value))),
)
const canArchive = computed(
  () =>
    !!props.card.file &&
    (props.card.status === "idle" || props.card.status === "completed") &&
    !isRemoteProject(props.card.cwd || props.card.project) &&
    !isRemoteProject(props.card.project),
)

function openEditor() {
  if (props.disabled || saving.value || props.card.status !== "todo") return
  const queued = owner.value?.promptQueue[0]
  queuedId.value = queued?.id ?? null
  message.value = draft.value?.message ?? queued?.text ?? props.card.preview
  project.value = draft.value?.project ?? props.card.cwd ?? props.card.project
  error.value = ""
  editing.value = true
}

function setEditing(open: boolean) {
  if (!saving.value) editing.value = open
}

async function save(open = false) {
  if (!canSave.value) return
  saving.value = true
  error.value = ""
  try {
    // A delayed prompt may start while its editor is open. Never rewrite a running task.
    if (props.card.status !== "todo" || owner.value?.isStreaming || owner.value?.entries.some(e => e.kind === "user"))
      throw new Error(t("kanban.draftUnavailable"))
    if (draft.value && !draft.value.sessionFile) {
      const next = {
        ...draft.value,
        project: projectLocked.value ? draft.value.project : normalizeProjectPath(project.value),
        message: message.value.trim(),
        updatedAt: Date.now(),
      }
      workspace.upsertBoardDraft(next)
      await workspace.flushPersistence()
    } else {
      const queued = owner.value?.promptQueue.find(item => item.id === queuedId.value)
      if (!queued) throw new Error(t("kanban.draftUnavailable"))
      queued.text = message.value.trim()
      queued.expandedText = undefined
    }
    editing.value = false
    if (open) emit("open", props.card)
  } catch (cause) {
    error.value = String(cause)
  } finally {
    saving.value = false
  }
}

async function archive() {
  if (props.disabled || archiving.value || !canArchive.value) return
  const cwd = props.card.cwd || props.card.project
  const row = workspace.histories[cwd]?.find(item => item.file === props.card.file) ?? {
    file: props.card.file!,
    id: props.card.id,
    cwd,
    title: props.card.title,
    preview: props.card.preview,
    mtimeMs: props.card.updatedAt,
  }
  archiving.value = true
  try {
    await workspace.update(row, row.title || null, true)
    await workspace.refresh(cwd)
  } catch (cause) {
    ui.pushToast(String(cause), "error")
  } finally {
    archiving.value = false
  }
}
</script>

<template>
  <div
    v-if="!archiving"
    class="kanban-card-actions relative min-w-0"
    :class="{ 'has-action': card.status === 'todo' || canArchive }"
  >
    <slot />
    <Button
      v-if="card.status === 'todo'"
      type="button"
      variant="ghost"
      size="icon-sm"
      class="kanban-edit absolute right-2 top-2 z-1 size-7 bg-card text-muted-foreground"
      :disabled="disabled"
      :title="t('kanban.editDraft')"
      :aria-label="t('kanban.editDraft')"
      @click.stop="openEditor"
    >
      <Pencil class="size-3.5" aria-hidden="true" />
    </Button>
    <Button
      v-else-if="canArchive"
      type="button"
      variant="ghost"
      size="icon-sm"
      class="absolute right-2 top-2 z-1 size-7 bg-card text-muted-foreground"
      :disabled="disabled || archiving"
      :title="t('workspace.archive')"
      :aria-label="t('workspace.archive')"
      @click.stop="archive"
    >
      <Archive class="size-3.5" aria-hidden="true" />
    </Button>
  </div>
  <Dialog :open="editing" @update:open="setEditing">
    <DialogContent :aria-describedby="undefined" class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>{{ t("kanban.editDraft") }}</DialogTitle>
      </DialogHeader>
      <form class="min-w-0 space-y-4" @submit.prevent="save()">
        <label class="block space-y-2 text-sm font-medium" :for="`${id}-project`">
          <span>{{ t("kanban.project") }}</span>
          <select
            :id="`${id}-project`"
            v-model="project"
            :disabled="disabled || saving || projectLocked"
            class="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm disabled:opacity-50"
          >
            <option v-for="item in projects" :key="item.value" :value="item.value">{{ item.label }}</option>
          </select>
        </label>
        <label class="block space-y-2 text-sm font-medium" :for="`${id}-message`">
          <span>{{ t("kanban.draftMessage") }}</span>
          <Textarea
            :id="`${id}-message`"
            v-model="message"
            :disabled="disabled || saving"
            class="min-h-36 max-h-[45dvh] resize-y overflow-y-auto"
            :placeholder="t('kanban.messagePlaceholder')"
          />
        </label>
        <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
        <div class="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" :disabled="saving" @click="setEditing(false)">
            {{ t("kanban.cancel") }}
          </Button>
          <Button type="button" variant="outline" :disabled="!canSave" @click="save(true)">
            {{ t("kanban.openConversation") }}
          </Button>
          <Button type="submit" :disabled="!canSave">
            <LoaderCircle v-if="saving" class="size-3.5 animate-spin" aria-hidden="true" />
            {{ t(saving ? "kanban.saving" : "kanban.saveDraft") }}
          </Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
</template>

<style scoped>
.kanban-edit {
  opacity: 0;
  pointer-events: none;
}
.kanban-card-actions:is(:hover, :focus-within) .kanban-edit {
  opacity: 1;
  pointer-events: auto;
}
.has-action :deep([data-kanban-card] > span:first-child) {
  padding-right: 1.75rem;
}
@media (hover: none) {
  .kanban-edit {
    opacity: 1;
    pointer-events: auto;
  }
}
</style>
