<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AlertCircle, ChevronDown, Folder, LoaderCircle, Plus, RotateCcw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import ChatPromptInput from "@/components/chat/ChatPromptInput.vue"
import WorkspaceContext from "@/components/WorkspaceContext.vue"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import ModelThinkingSelect from "@/components/ModelThinkingSelect.vue"
import ImagePreviewContent from "@/components/chat/ImagePreviewContent.vue"
import { createModelSelection } from "@/stores/session/modelSelection"
import type { Model, SessionState, ThinkingLevel } from "@/api/protocol"
import type { WorkspaceSelection } from "@/api/piClient"
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input/types"
import { useKanbanCardSorting } from "@/composables/useKanbanCardSorting"
import { useKanbanSelectionScroll } from "@/composables/useKanbanSelectionScroll"
import { formatKanbanDuration, formatKanbanTime } from "@/lib/kanbanTime"
import KanbanSessionMenu from "./KanbanSessionMenu.vue"
import KanbanCardActions from "./KanbanCardActions.vue"
import {
  KANBAN_COLUMNS,
  filterKanbanCards,
  groupKanbanCards,
  kanbanCardTitle,
  type KanbanCard,
  type KanbanCreatePayload,
  type KanbanStatus,
} from "@/lib/kanban"

const props = withDefaults(
  defineProps<{
    cards: KanbanCard[]
    projects: { value: string; label: string }[]
    selectedProject: string
    selectedId?: string
    loading?: boolean
    error?: string
    busy?: boolean
    navigationBusy?: boolean
    columnOrder?: Record<string, string[]>
  }>(),
  { loading: false, error: "", busy: false, navigationBusy: false },
)
const emit = defineEmits<{
  "update:selectedProject": [project: string]
  open: [card: KanbanCard]
  export: [file: string]
  create: [payload: KanbanCreatePayload]
  cardDeleted: [card: KanbanCard]
  retry: []
  reorder: [column: KanbanStatus, ids: string[]]
  startDraft: [card: KanbanCard]
}>()
defineSlots<{ actions?(): unknown }>()
defineExpose({ openCreate })

const { t, locale } = useI18n()
const scroller = ref<HTMLElement | null>(null)
useKanbanSelectionScroll(scroller, () => props.selectedId)
const id = useId()
const groups = computed(() =>
  groupKanbanCards(filterKanbanCards(props.cards, props.selectedProject), props.columnOrder, props.selectedProject),
)
const sorting = reactive(
  useKanbanCardSorting(
    () => groups.value,
    () => props.selectedProject,
    () => props.navigationBusy,
    (column, ids) => emit("reorder", column, ids),
    card => emit("startDraft", card),
  ),
)
const availableProjects = computed(() => props.projects.filter(project => project.value !== ""))
const idlePageSize = 30
const idleLimit = ref(idlePageSize)
const createOpen = ref(false)
const draftProject = ref("")
const draftSelection = ref<WorkspaceSelection | null>(null)
const startImmediately = ref(false)
const bridge = ref<InstanceType<typeof PromptInputBridge> | null>(null)
const previewImage = ref<string | null>(null)
const models = ref<Model[]>([])
const modelSelection = createModelSelection(ref<SessionState | null>(null), models)
const { desiredModelKey, offlineDefaultModelKey, availableThinking, thinkingLevel } = modelSelection
const modelKey = computed({
  get: () => desiredModelKey.value || offlineDefaultModelKey.value || "",
  set: (key: string) => modelSelection.setDesiredModel(key),
})
function setThinkingLevel(level: string) {
  modelSelection.setDesiredThinkingLevel(level as ThinkingLevel)
}
const submitted = ref(false)
const now = ref(Date.now())
let timeTicker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timeTicker = setInterval(() => (now.value = Date.now()), 1_000)
})
onBeforeUnmount(() => clearInterval(timeTicker))
const createBusy = computed(() => props.busy || submitted.value)
const canCreate = computed(
  () =>
    !createBusy.value &&
    availableProjects.value.some(project => project.value === draftProject.value) &&
    (!!bridge.value?.textInput.trim() || !!bridge.value?.files.length) &&
    !bridge.value?.isLoading,
)
const statusColor: Record<KanbanStatus, string> = {
  todo: "bg-muted-foreground",
  running: "bg-blue-500",
  waiting: "bg-amber-500",
  completed: "bg-emerald-500",
  idle: "bg-muted-foreground/40",
}
const dateFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }),
)

watch(
  () => props.selectedProject,
  () => (idleLimit.value = idlePageSize),
)

function visibleCards(status: KanbanStatus) {
  return status === "idle" ? groups.value.idle.slice(0, idleLimit.value) : groups.value[status]
}

function titleFor(card: KanbanCard) {
  return kanbanCardTitle(card.title, card.preview) || t("kanban.untitled")
}

function previewFor(card: KanbanCard) {
  const activity = card.status === "running" ? card.activity : undefined
  if (!activity) return card.preview || t("kanban.emptyPreview")
  if (activity.kind === "text") return activity.text
  if (activity.kind === "tool") {
    const label = t("kanban.executingTool", { tool: activity.name })
    return activity.detail ? `${label}\n${activity.detail}` : label
  }
  return t(`chat.${activity.kind === "retrying" ? "retrying" : activity.kind}`)
}

function dateFor(timestamp: number) {
  const date = new Date(timestamp)
  return Number.isFinite(timestamp) && Number.isFinite(date.getTime()) ? date : null
}

function formatTime(timestamp: number) {
  return formatKanbanTime(timestamp, locale.value, now.value, t("kanban.justNow")) ?? t("kanban.unknownTime")
}

function fullTime(timestamp: number) {
  const date = dateFor(timestamp)
  return date ? `${t("kanban.updatedAt")}: ${dateFormatter.value.format(date)}` : t("kanban.unknownTime")
}

function currentRoundStartedAt(card: KanbanCard): number | null {
  if (card.status !== "running" && card.status !== "waiting") return null
  return Number.isFinite(card.lastPromptAt) ? card.lastPromptAt! : card.updatedAt
}

function cardTime(card: KanbanCard) {
  const startedAt = currentRoundStartedAt(card)
  if (startedAt === null) return formatTime(card.updatedAt)
  return formatKanbanDuration(startedAt, now.value, locale.value) ?? t("kanban.unknownExecutionTime")
}

function cardTimeTitle(card: KanbanCard) {
  const startedAt = currentRoundStartedAt(card)
  if (startedAt === null) return fullTime(card.updatedAt)
  const elapsed = cardTime(card)
  const date = dateFor(startedAt)
  return date
    ? `${t("kanban.executionTime")}: ${elapsed}\n${t("kanban.startedAt")}: ${dateFormatter.value.format(date)}`
    : t("kanban.unknownExecutionTime")
}

function selectProject(event: Event) {
  emit("update:selectedProject", (event.target as HTMLSelectElement).value)
}

function setCreateOpen(open: boolean) {
  if (open) openCreate()
  else if (!createBusy.value) createOpen.value = false
}

/** Parent title-bar actions may open creation with an optional project preset. */
function openCreate(project = props.selectedProject) {
  draftProject.value = availableProjects.value.some(option => option.value === project) ? project : ""
  void modelSelection.loadOfflineModels()
  createError.value = ""
  startImmediately.value = false
  draftSelection.value = null
  createOpen.value = true
}

function inputError(error: { code: string }) {
  if (error.code === "attachment_read_error") createError.value = t("chat.attachmentReadFailed")
  if (error.code === "accept") createError.value = t("chat.imageAttachmentsOnly")
}
const createError = ref("")
const submitLabel = computed(() => {
  if (createBusy.value) return startImmediately.value ? "kanban.starting" : "kanban.saving"
  return startImmediately.value ? "kanban.startDraft" : "kanban.saveDraft"
})

async function submit(message: PromptInputMessage) {
  if (
    createBusy.value ||
    !availableProjects.value.some(project => project.value === draftProject.value) ||
    (!message.text.trim() && !message.files.length)
  )
    throw new Error(t("kanban.createDescription"))
  // The shared input waits for this promise and restores text/files on failure.
  submitted.value = true
  createError.value = ""
  try {
    // PromptInput has already converted original files to durable data URLs.
    const attachments = message.files.map(({ filename, mediaType, url }) => ({ filename, mediaType, url }))
    emit("create", {
      project: draftProject.value,
      message: message.text.trim(),
      ...(draftSelection.value?.project === draftProject.value ? { selection: draftSelection.value } : {}),
      ...(startImmediately.value ? { startImmediately: true } : {}),
      ...(modelKey.value ? { modelKey: modelKey.value } : {}),
      thinkingLevel: thinkingLevel.value,
      ...(attachments.length ? { attachments } : {}),
    })
    await nextTick()
    if (props.busy)
      await new Promise<void>(resolve => {
        const stop = watch(
          () => props.busy,
          busy => {
            if (!busy) {
              stop()
              resolve()
            }
          },
        )
      })
    if (props.error) throw new Error(props.error)
    createOpen.value = false
  } finally {
    submitted.value = false
  }
}
</script>

<template>
  <section class="flex h-full min-h-0 min-w-0 flex-1 flex-col bg-background" :aria-label="t('kanban.title')">
    <header class="flex shrink-0 flex-wrap items-center gap-3 border-b border-border/60 px-4 py-3">
      <h1 class="text-sm font-semibold">{{ t("kanban.title") }}</h1>
      <label class="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <span>{{ t("kanban.projectFilter") }}</span>
        <select
          :value="selectedProject"
          class="h-8 min-w-0 max-w-56 rounded-md border border-input bg-background px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
          @change="selectProject"
        >
          <option value="">{{ t("kanban.allTasks") }}</option>
          <option v-for="project in availableProjects" :key="project.value" :value="project.value">
            {{ project.label }}
          </option>
        </select>
      </label>
      <div class="ml-auto flex items-center gap-2">
        <slot name="actions" />
        <Button size="sm" @click="setCreateOpen(true)">
          <Plus class="size-3.5" aria-hidden="true" />
          {{ t("kanban.create") }}
        </Button>
      </div>
    </header>

    <div v-if="error" role="alert" class="flex shrink-0 items-center gap-2 border-b px-4 py-2 text-sm text-destructive">
      <AlertCircle class="size-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1 break-words">{{ t("kanban.loadFailed", { error }) }}</span>
      <Button variant="outline" size="sm" :disabled="loading || busy" @click="emit('retry')">
        <RotateCcw class="size-3.5" aria-hidden="true" />
        {{ t("kanban.retry") }}
      </Button>
    </div>
    <p v-if="!availableProjects.length" class="shrink-0 px-4 pt-3 text-xs text-muted-foreground">
      {{ t("kanban.noProjects") }}
    </p>

    <div ref="scroller" class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4" :aria-busy="loading">
      <div class="grid h-full min-h-0 min-w-[79rem] grid-cols-[repeat(5,minmax(15rem,1fr))] gap-3">
        <section
          v-for="column in KANBAN_COLUMNS"
          :key="column.id"
          :data-kanban-column="column.id"
          :aria-labelledby="`${id}-${column.id}`"
          class="flex min-h-0 min-w-0 flex-col rounded-xl border border-border/60 bg-muted/30"
        >
          <header class="flex shrink-0 items-center gap-2 px-3 py-3">
            <span class="size-2 shrink-0 rounded-full" :class="statusColor[column.id]" aria-hidden="true" />
            <h2 :id="`${id}-${column.id}`" class="text-xs font-semibold">{{ t(column.labelKey) }}</h2>
            <span
              class="ml-auto rounded-md bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"
              :aria-label="t('kanban.columnCount', { count: groups[column.id].length })"
              >{{ groups[column.id].length }}</span
            >
          </header>
          <div
            class="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-y-contain px-2 pb-2"
            @dragover="sorting.overColumn($event, column.id)"
            @drop="sorting.drop($event, column.id)"
          >
            <KanbanCardActions
              v-for="card in visibleCards(column.id)"
              :key="card.id"
              v-slot="{ edit, remove, busy: actionsBusy }"
              :card="card"
              :projects="availableProjects"
              :disabled="navigationBusy || busy"
              @start-draft="emit('startDraft', card)"
              @card-deleted="emit('cardDeleted', $event)"
            >
              <KanbanSessionMenu
                :card="card"
                :disabled="navigationBusy || busy || actionsBusy"
                @edit="edit"
                @delete="remove"
                @open="emit('open', card)"
                @export="emit('export', $event)"
              >
                <button
                  type="button"
                  :data-kanban-card="card.id"
                  :aria-pressed="selectedId === card.id"
                  :disabled="navigationBusy"
                  :draggable="!navigationBusy"
                  :aria-description="t('kanban.reorderCard')"
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  class="block w-full min-w-0 space-y-2 rounded-lg border bg-card p-3 text-left text-card-foreground shadow-xs transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                  :class="[
                    selectedId === card.id ? 'border-primary/70 ring-1 ring-primary/30' : 'border-border/60',
                    {
                      'opacity-50': sorting.source?.id === card.id,
                      'border-t-primary border-t-2': sorting.target?.id === card.id && !sorting.target.after,
                      'border-b-primary border-b-2': sorting.target?.id === card.id && sorting.target.after,
                    },
                  ]"
                  @dragstart="sorting.startDrag($event, card)"
                  @dragover="sorting.overCard($event, card)"
                  @dragend="sorting.endDrag"
                  @keydown="sorting.moveWithKeyboard($event, card)"
                  @click="!sorting.source && card.status !== 'todo' && emit('open', card)"
                >
                  <span class="block truncate text-sm font-medium" :title="titleFor(card)">{{ titleFor(card) }}</span>
                  <span
                    class="text-xs leading-relaxed text-muted-foreground"
                    :class="
                      card.status === 'running' ? 'block truncate' : 'line-clamp-2 whitespace-pre-wrap break-words'
                    "
                    :title="previewFor(card)"
                    >{{ previewFor(card) }}</span
                  >
                  <span v-if="card.failed" class="flex items-center gap-1 text-[10px] text-destructive">
                    <AlertCircle class="size-3" aria-hidden="true" />
                    {{ t("kanban.failed") }}
                  </span>
                  <span class="flex min-w-0 items-center gap-2 text-muted-foreground">
                    <span
                      v-if="card.project && !card.projectless"
                      class="flex min-w-0 flex-1 items-center gap-1.5 text-[11px]"
                    >
                      <Folder class="size-3 shrink-0" aria-hidden="true" />
                      <span class="truncate" :title="card.project">{{
                        card.projectName || card.project || t("kanban.noProject")
                      }}</span>
                    </span>
                    <time
                      class="ml-auto shrink-0 whitespace-nowrap text-[10px]"
                      :datetime="
                        currentRoundStartedAt(card) === null ? dateFor(card.updatedAt)?.toISOString() : undefined
                      "
                      :title="cardTimeTitle(card)"
                      >{{ cardTime(card) }}</time
                    >
                  </span>
                </button>
              </KanbanSessionMenu>
            </KanbanCardActions>
            <p v-if="!groups[column.id].length" class="px-2 py-8 text-center text-xs text-muted-foreground">
              {{ t("kanban.emptyColumn") }}
            </p>
            <Button
              v-if="column.id === 'idle' && groups.idle.length > idleLimit"
              variant="ghost"
              size="sm"
              class="w-full text-xs text-muted-foreground"
              @click="idleLimit += idlePageSize"
            >
              <ChevronDown class="size-3.5" aria-hidden="true" />
              {{ t("kanban.loadMoreIdle", { count: groups.idle.length - idleLimit }) }}
            </Button>
          </div>
        </section>
      </div>
    </div>

    <Dialog :open="createOpen" @update:open="setCreateOpen">
      <DialogContent :show-close-button="false" class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{{ t("kanban.create") }}</DialogTitle>
          <DialogDescription>{{ t("kanban.createDescription") }}</DialogDescription>
        </DialogHeader>
        <div class="min-w-0 space-y-4">
          <label class="block space-y-2 text-sm font-medium" :for="`${id}-project`">
            <span>{{ t("kanban.project") }}</span>
            <select
              :id="`${id}-project`"
              v-model="draftProject"
              required
              :disabled="createBusy"
              class="h-9 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <option value="" disabled>{{ t("kanban.selectProject") }}</option>
              <option v-for="project in availableProjects" :key="project.value" :value="project.value">
                {{ project.label }}
              </option>
            </select>
          </label>
          <label class="flex w-fit items-center gap-2 text-sm font-medium">
            <Checkbox v-model="startImmediately" :disabled="createBusy" />
            <span>{{ t("kanban.startImmediately") }}</span>
          </label>
          <div class="space-y-2">
            <p class="text-sm font-medium">{{ t("kanban.draftMessage") }}</p>
            <WorkspaceContext
              v-if="draftProject"
              v-model="draftSelection"
              :project="draftProject"
              :disabled="createBusy"
              :project-picker="false"
            />
            <ChatPromptInput
              v-model:bridge="bridge"
              :disabled="createBusy"
              :placeholder="t('kanban.messagePlaceholder')"
              :submit="submit"
              @error="inputError"
              @preview-image="previewImage = $event"
            >
              <template #model>
                <ModelThinkingSelect
                  v-model="modelKey"
                  :thinking-level="thinkingLevel"
                  :available-thinking="availableThinking"
                  :models="models"
                  :disabled="createBusy || !models.length"
                  @update:thinking-level="setThinkingLevel"
                />
              </template>
              <template #actions>
                <Button type="button" variant="ghost" :disabled="createBusy" @click="setCreateOpen(false)">
                  {{ t("kanban.cancel") }}
                </Button>
                <Button type="submit" :disabled="!canCreate">
                  <LoaderCircle v-if="createBusy" class="size-3.5 animate-spin" aria-hidden="true" />
                  {{ t(submitLabel) }}
                </Button>
              </template>
            </ChatPromptInput>
          </div>
          <p v-if="createError || error" role="alert" class="text-sm text-destructive">{{ createError || error }}</p>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog :open="!!previewImage" @update:open="previewImage = null">
      <ImagePreviewContent v-if="previewImage" :src="previewImage" :alt="t('chat.previewImage')" />
    </Dialog>
  </section>
</template>
