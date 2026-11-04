<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, useId, watch } from "vue"
import { useI18n } from "vue-i18n"
import { AlertCircle, ChevronDown, Folder, LoaderCircle, Plus, RotateCcw } from "@lucide/vue"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import { useKanbanCardSorting } from "@/composables/useKanbanCardSorting"
import { formatKanbanTime } from "@/lib/kanbanTime"
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
  create: [payload: KanbanCreatePayload]
  retry: []
  reorder: [column: KanbanStatus, ids: string[]]
}>()
defineSlots<{ actions?(): unknown }>()
defineExpose({ openCreate })

const { t, locale } = useI18n()
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
  ),
)
const availableProjects = computed(() => props.projects.filter(project => project.value !== ""))
const idlePageSize = 30
const idleLimit = ref(idlePageSize)
const createOpen = ref(false)
const draftProject = ref("")
const draftMessage = ref("")
const submitted = ref(false)
const now = ref(Date.now())
let timeTicker: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  timeTicker = setInterval(() => (now.value = Date.now()), 30_000)
})
onBeforeUnmount(() => clearInterval(timeTicker))
const createBusy = computed(() => props.busy || submitted.value)
const canCreate = computed(
  () =>
    !createBusy.value &&
    availableProjects.value.some(project => project.value === draftProject.value) &&
    !!draftMessage.value.trim(),
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
watch(
  () => props.busy,
  (busy, previous) => {
    if (previous && !busy && submitted.value) finishCreate()
  },
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

function selectProject(event: Event) {
  emit("update:selectedProject", (event.target as HTMLSelectElement).value)
}

function setCreateOpen(open: boolean) {
  if (createBusy.value) return
  if (open) openCreate()
  else createOpen.value = false
}

/** Parent title-bar actions may open creation with an optional project preset. */
function openCreate(project = props.selectedProject) {
  if (createBusy.value || !availableProjects.value.length) return
  draftProject.value = availableProjects.value.some(option => option.value === project) ? project : ""
  draftMessage.value = ""
  createOpen.value = true
}

function finishCreate() {
  submitted.value = false
  if (!props.error) createOpen.value = false
}

async function submit() {
  if (!canCreate.value) return
  // Lock synchronously: the parent's busy prop is only reflected on the next render.
  submitted.value = true
  emit("create", { project: draftProject.value, message: draftMessage.value.trim() })
  await nextTick()
  // A parent may save synchronously without supplying busy; async parents hold the dialog open.
  if (!props.busy && submitted.value) finishCreate()
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
        <Button size="sm" :disabled="createBusy || !availableProjects.length" @click="setCreateOpen(true)">
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

    <div class="min-h-0 flex-1 overflow-x-auto overflow-y-hidden p-4" :aria-busy="loading">
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
            <button
              v-for="card in visibleCards(column.id)"
              :key="card.id"
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
              @click="!sorting.source && emit('open', card)"
            >
              <span class="line-clamp-2 text-sm font-medium break-words" :title="titleFor(card)">{{
                titleFor(card)
              }}</span>
              <span
                v-if="card.project && !card.projectless"
                class="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <Folder class="size-3 shrink-0" aria-hidden="true" />
                <span class="truncate" :title="card.project">{{
                  card.projectName || card.project || t("kanban.noProject")
                }}</span>
              </span>
              <span
                class="line-clamp-2 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground break-words"
                :title="previewFor(card)"
                >{{ previewFor(card) }}</span
              >
              <span class="flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
                <time :datetime="dateFor(card.updatedAt)?.toISOString()" :title="fullTime(card.updatedAt)">{{
                  formatTime(card.updatedAt)
                }}</time>
                <span v-if="card.failed" class="ml-auto inline-flex items-center gap-1 text-destructive">
                  <AlertCircle class="size-3" aria-hidden="true" />
                  {{ t("kanban.failed") }}
                </span>
              </span>
            </button>
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
      <DialogContent :show-close-button="false" class="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ t("kanban.create") }}</DialogTitle>
          <DialogDescription>{{ t("kanban.createDescription") }}</DialogDescription>
        </DialogHeader>
        <form class="min-w-0 space-y-4" @submit.prevent="submit">
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
          <label class="block space-y-2 text-sm font-medium" :for="`${id}-message`">
            <span>{{ t("kanban.draftMessage") }}</span>
            <Textarea
              :id="`${id}-message`"
              v-model="draftMessage"
              required
              :disabled="createBusy"
              class="min-h-36 max-h-[45dvh] resize-y overflow-y-auto"
              :placeholder="t('kanban.messagePlaceholder')"
            />
          </label>
          <p v-if="error" role="alert" class="text-sm text-destructive">{{ error }}</p>
          <div class="flex justify-end gap-2">
            <Button type="button" variant="outline" :disabled="createBusy" @click="setCreateOpen(false)">{{
              t("kanban.cancel")
            }}</Button>
            <Button type="submit" :disabled="!canCreate">
              <LoaderCircle v-if="createBusy" class="size-3.5 animate-spin" aria-hidden="true" />
              {{ t(createBusy ? "kanban.saving" : "kanban.saveDraft") }}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  </section>
</template>
