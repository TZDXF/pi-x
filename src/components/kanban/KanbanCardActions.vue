<script setup lang="ts">
import { computed, ref } from "vue"
import { useI18n } from "vue-i18n"
import { Archive, LoaderCircle, Pencil, Play, Trash2 } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { useWorkspaceStore } from "@/stores/workspace"
import { peekConversation, useUiStore } from "@/stores/conversations"
import { isRemoteProject } from "@/lib/ssh"
import { normalizeProjectPath, samePath } from "@/lib/paths"
import { dataUrlToImage } from "@/lib/attachments"
import { modelKey } from "@/lib/modelKey"
import { notifySessionArchived } from "@/lib/sessionArchiveToast"
import type { KanbanCard, KanbanCreatePayload, KanbanDraftEditor } from "@/lib/kanban"
import type { BoardDraft } from "@/lib/workspaceState"

const props = defineProps<{
  card: KanbanCard
  projects: { value: string; label: string }[]
  disabled?: boolean
}>()
const emit = defineEmits<{
  cardDeleted: [card: KanbanCard]
  startDraft: [card: KanbanCard]
  editDraft: [editor: KanbanDraftEditor]
}>()
const { t } = useI18n()
const workspace = useWorkspaceStore()
const ui = useUiStore()
const saving = ref(false)
const archiving = ref(false)
const deleting = ref(false)
const draft = computed(() =>
  props.card.draftId ? (workspace.boardDrafts[props.card.draftId] as BoardDraft | undefined) : undefined,
)
const owner = computed(() => {
  const key = props.card.runtimeId || props.card.draftId || props.card.file
  return key ? peekConversation(key, props.card.cwd || props.card.project) : undefined
})
const projectLocked = computed(() => !draft.value || !!owner.value?.started)
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
  const queuedId = queued?.id
  const project = draft.value?.project ?? props.card.cwd ?? props.card.project
  const environmentLocked = projectLocked.value
  const initial: KanbanCreatePayload = {
    project: workspace.isProjectless(project) ? "" : project,
    message: draft.value?.sessionFile
      ? (queued?.text ?? props.card.preview)
      : (draft.value?.message ?? queued?.text ?? props.card.preview),
    attachments:
      draft.value && !draft.value.sessionFile
        ? draft.value.attachments
        : queued?.images?.map(image => ({
            mediaType: image.mimeType,
            url: `data:${image.mimeType};base64,${image.data}`,
          })),
    modelKey:
      draft.value?.modelKey ??
      owner.value?.desiredModelKey ??
      (owner.value?.state?.model ? modelKey(owner.value.state.model) : undefined),
    thinkingLevel: draft.value?.thinkingLevel ?? owner.value?.desiredThinkingLevel ?? owner.value?.thinkingLevel,
    selection: draft.value?.selection ? { ...draft.value.selection } : undefined,
  }
  emit("editDraft", { initial, environmentLocked, save: payload => save(payload, queuedId) })
}

async function save(payload: KanbanCreatePayload, queuedId?: number) {
  if (props.disabled || saving.value) throw new Error(t("kanban.draftUnavailable"))
  if (!payload.message.trim() && !payload.attachments?.length) throw new Error(t("kanban.createDescription"))
  saving.value = true
  try {
    // A delayed prompt may start while its editor is open. Never rewrite a running task.
    if (props.card.status !== "todo" || owner.value?.isStreaming || owner.value?.entries.some(e => e.kind === "user"))
      throw new Error(t("kanban.draftUnavailable"))
    if (draft.value && !draft.value.sessionFile) {
      const project = projectLocked.value
        ? draft.value.project
        : normalizeProjectPath(payload.project || (await workspace.ensureProjectless()))
      if (
        !projectLocked.value &&
        !props.projects.some(item => samePath(item.value, project)) &&
        !workspace.isProjectless(project)
      )
        throw new Error(t("kanban.draftUnavailable"))
      const previous = { ...draft.value }
      const next: BoardDraft = {
        ...previous,
        project,
        message: payload.message.trim(),
        attachments: payload.attachments ?? [],
        modelKey: projectLocked.value ? previous.modelKey : payload.modelKey,
        thinkingLevel: projectLocked.value ? previous.thinkingLevel : payload.thinkingLevel,
        selection: projectLocked.value
          ? previous.selection
          : payload.selection?.project === project
            ? payload.selection
            : undefined,
        updatedAt: Date.now(),
      }
      workspace.upsertBoardDraft(next)
      try {
        await workspace.flushPersistence()
      } catch (cause) {
        workspace.upsertBoardDraft(previous)
        throw cause
      }
    } else {
      const queued = owner.value?.promptQueue.find(item => item.id === queuedId)
      if (!queued) throw new Error(t("kanban.draftUnavailable"))
      queued.text = payload.message.trim()
      queued.expandedText = undefined
      queued.images = (payload.attachments ?? []).flatMap(attachment => {
        const image = dataUrlToImage(attachment.url)
        return image ? [image] : []
      })
    }
    if (payload.startImmediately) emit("startDraft", props.card)
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
    notifySessionArchived(ui, t, async () => {
      const current = workspace.histories[cwd]?.find(item => item.file === row.file) ?? row
      await workspace.update(current, current.title || null, false)
      await workspace.refresh(cwd)
    })
    await workspace.refresh(cwd)
  } catch (cause) {
    ui.pushToast(String(cause), "error")
  } finally {
    archiving.value = false
  }
}

async function remove() {
  if (props.disabled || saving.value || deleting.value || props.card.status !== "todo") return
  deleting.value = true
  try {
    if (owner.value?.isStreaming || owner.value?.entries.some(entry => entry.kind === "user"))
      throw new Error(t("kanban.draftUnavailable"))
    if (draft.value && !draft.value.sessionFile) {
      const removed = { ...draft.value }
      workspace.removeBoardDraft(removed.id)
      try {
        await workspace.flushPersistence()
      } catch (cause) {
        // Keep the visible draft consistent with the failed persisted delete.
        workspace.upsertBoardDraft(removed)
        throw cause
      }
      emit("cardDeleted", props.card)
    } else {
      const queued = owner.value?.promptQueue[0]
      if (!queued) throw new Error(t("kanban.draftUnavailable"))
      owner.value!.removeQueuedPrompt(queued.id)
    }
  } catch (cause) {
    ui.pushToast(String(cause), "error")
  } finally {
    deleting.value = false
  }
}
</script>

<template>
  <div
    v-if="!archiving"
    class="kanban-card-actions relative min-w-0"
    :class="{ 'has-action': card.status === 'todo' || canArchive, 'has-todo-actions': card.status === 'todo' }"
  >
    <slot :edit="openEditor" :remove="remove" :busy="saving || deleting" />
    <Button
      v-if="card.status === 'todo'"
      type="button"
      variant="ghost"
      size="icon-sm"
      class="kanban-card-action absolute right-2 top-2 z-1 size-7 bg-card text-muted-foreground"
      :disabled="disabled || saving || deleting"
      :title="t('kanban.startDraft')"
      :aria-label="t('kanban.startDraft')"
      @click.stop="emit('startDraft', card)"
    >
      <Play class="size-3.5" aria-hidden="true" />
    </Button>
    <Button
      v-if="card.status === 'todo'"
      type="button"
      variant="ghost"
      size="icon-sm"
      class="kanban-card-action absolute right-10 top-2 z-1 size-7 bg-card text-muted-foreground"
      :disabled="disabled"
      :title="t('kanban.editDraft')"
      :aria-label="t('kanban.editDraft')"
      @click.stop="openEditor"
    >
      <Pencil class="size-3.5" aria-hidden="true" />
    </Button>
    <Button
      v-if="card.status === 'todo'"
      type="button"
      variant="ghost"
      size="icon-sm"
      class="kanban-card-delete absolute bottom-2 right-2 z-1 size-7 bg-card text-muted-foreground hover:text-destructive"
      :disabled="disabled || saving || deleting"
      :title="t('kanban.delete')"
      :aria-label="t('kanban.delete')"
      @click.stop="remove"
    >
      <LoaderCircle v-if="deleting" class="size-3.5 animate-spin" aria-hidden="true" />
      <Trash2 v-else class="size-3.5" aria-hidden="true" />
    </Button>
    <Button
      v-else-if="canArchive"
      type="button"
      variant="ghost"
      size="icon-sm"
      class="kanban-archive absolute right-2 top-2 z-1 size-7 bg-card text-muted-foreground"
      :disabled="disabled || archiving"
      :title="t('workspace.archive')"
      :aria-label="t('workspace.archive')"
      @click.stop="archive"
    >
      <Archive class="size-3.5" aria-hidden="true" />
    </Button>
  </div>
</template>

<style scoped>
.kanban-card-action,
.kanban-card-delete,
.kanban-archive {
  opacity: 0;
  pointer-events: none;
}
.kanban-card-actions:is(:hover, :focus-within) :is(.kanban-card-action, .kanban-card-delete, .kanban-archive) {
  opacity: 1;
  pointer-events: auto;
}
.has-todo-actions:is(:hover, :focus-within) :deep(.kanban-card-time) {
  opacity: 0;
}
.has-action :deep([data-kanban-card] > span:first-child) {
  padding-right: 1.75rem;
}
.has-todo-actions :deep([data-kanban-card] > span:first-child) {
  padding-right: 3.75rem;
}
@media (hover: none) {
  .kanban-card-action,
  .kanban-card-delete,
  .kanban-archive {
    opacity: 1;
    pointer-events: auto;
  }
  .has-todo-actions :deep(.kanban-card-time) {
    opacity: 0;
  }
}
</style>
