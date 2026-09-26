<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, Pause, Play, Clock } from '@lucide/vue'
import { TimeFieldInput, TimeFieldRoot, type TimeValue } from 'reka-ui'
import { Time } from '@internationalized/date'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import ConversationModelSelect from '@/components/ConversationModelSelect.vue'
import { useWorkspaceStore } from '@/stores/workspace'
import { useSessionStore } from '@/stores/conversations'
import { getModelsConfig } from '@/api/piClient'
import { listScheduledTasks, saveScheduledTask, deleteScheduledTask, type ScheduledTask, type ScheduledTaskInput } from '@/api/schedules'
import { scheduleExpression, parseScheduleExpression, scheduleFrequencies, scheduleWeekdays, type ScheduleFrequency } from '@/lib/schedules'
import { supportedThinkingLevels } from '@/lib/thinkingLevels'
import type { ThinkingLevel } from '@/api/protocol'

const props = defineProps<{ project: string }>()
const emit = defineEmits<{ resumeSession: [file: string, project: string] }>()
const { t, locale } = useI18n()
const workspace = useWorkspaceStore()
const session = useSessionStore()
const tasks = ref<ScheduledTask[]>([])
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const editing = ref(false)
const deleting = ref<string | null>(null)
const frequency = ref<ScheduleFrequency>('daily')
const timeValue = shallowRef<TimeValue>(new Time(9, 0))
const time = computed(() => `${String(timeValue.value.hour).padStart(2, '0')}:${String(timeValue.value.minute).padStart(2, '0')}`)
const weekday = ref('MON')
const day = ref(1)
const custom = ref('0 9 * * *')
const modelKey = ref('')
const modelLevels = ref<Record<string, ThinkingLevel[]>>({})
const draft = ref<ScheduledTaskInput>(emptyDraft())
function emptyDraft(): ScheduledTaskInput {
  return { id: null, title: '', prompt: '', project: props.project || workspace.projects[0] || '', provider: '', model: '', thinking: 'medium', expression: '0 9 * * *', enabled: true }
}
const projects = computed(() => [...new Set([...workspace.projects, draft.value.project].filter(Boolean))])
const models = computed(() => {
  const list = [...session.models]
  if (draft.value.provider && draft.value.model && !list.some(m => m.provider === draft.value.provider && m.id === draft.value.model)) {
    return [...list, { provider: draft.value.provider, id: draft.value.model, name: draft.value.model }]
  }
  return list
})
const levels = computed(() => modelLevels.value[modelKey.value] ?? supportedThinkingLevels(session.models.find(m => `${m.provider}/${m.id}` === modelKey.value) ?? {}))
watch(levels, values => { if (!values.includes(draft.value.thinking)) draft.value.thinking = values.includes('medium') ? 'medium' : values[0] ?? 'off' })
let timer: ReturnType<typeof setInterval> | undefined
let generation = 0
async function refresh() {
  const own = generation
  const result = await listScheduledTasks()
  if (own === generation) tasks.value = result
}
async function initialize() {
  generation++
  const own = generation
  error.value = ''
  editing.value = false
  deleting.value = null
  loading.value = true
  try {
    await refresh()
    if (!session.models.length) await session.loadOfflineModels()
    const config = await getModelsConfig()
    const mapping: Record<string, ThinkingLevel[]> = {}
    for (const [provider, entry] of Object.entries(config.providers ?? {})) {
      for (const model of entry.models ?? []) mapping[`${provider}/${model.id}`] = supportedThinkingLevels(model)
    }
    if (own !== generation) return
    if (session.currentModel) {
      const current = session.currentModel
      mapping[`${current.provider}/${current.id}`] = session.availableThinking
    }
    modelLevels.value = mapping
    timer = setInterval(() => { if (!busy.value) void refresh().catch(e => { error.value = String(e) }) }, 5000)
  } catch (e) { if (own === generation) error.value = String(e) }
  finally { if (own === generation) loading.value = false }
}
void initialize()
onBeforeUnmount(() => { generation++; clearInterval(timer) })
function edit(task?: ScheduledTask) {
  error.value = ''
  draft.value = task ? { ...task } : emptyDraft()
  const parsed = parseScheduleExpression(draft.value.expression)
  frequency.value = parsed.frequency
  const [hour, minute] = parsed.time.split(':').map(Number)
  timeValue.value = new Time(hour, minute)
  weekday.value = parsed.weekday
  day.value = parsed.day
  custom.value = parsed.custom
  const model = task ? models.value.find(m => m.provider === task.provider && m.id === task.model) : session.currentModel ?? models.value[0]
  modelKey.value = model ? `${model.provider}/${model.id}` : ''
  editing.value = true
}
async function action(work: () => Promise<unknown>) {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await work(); await refresh() }
  catch (e) { error.value = String(e) }
  finally { busy.value = false }
}
async function save() {
  await action(async () => {
    const model = models.value.find(m => `${m.provider}/${m.id}` === modelKey.value)
    if (!model) throw new Error(t('schedules.modelRequired'))
    await saveScheduledTask({ ...draft.value, provider: model.provider, model: model.id,
      expression: scheduleExpression(frequency.value, time.value, weekday.value, Number(day.value), custom.value) })
    editing.value = false
  })
}
function formatDate(value: number) { return new Date(value).toLocaleString() }
function openResult(task: ScheduledTask) {
  if (!task.sessionFile) return
  emit('resumeSession', task.sessionFile, task.project)
}
</script>

<template>
  <ScrollArea class="flex-1 min-h-0 h-full" viewport-class="h-full">
    <div class="mx-auto w-full max-w-4xl space-y-5 px-6 py-8 max-[640px]:px-4">
      <header class="space-y-1">
        <h1 class="flex items-center gap-2 text-lg font-semibold"><Clock :size="18" />{{ t('schedules.title') }}</h1>
        <p class="text-xs text-muted-foreground">{{ t('schedules.description') }}</p>
      </header>
      <p v-if="error" role="alert" class="text-sm text-destructive break-words">{{ error }}</p>
      <form v-if="editing" class="grid gap-4" @submit.prevent="save">
        <label class="grid gap-1.5 text-sm">{{ t('schedules.taskTitle') }}<Input v-model="draft.title" required maxlength="100" /></label>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5 text-sm"><label for="schedule-frequency">{{ t('schedules.frequency') }}</label>
            <Select v-model="frequency"><SelectTrigger id="schedule-frequency" class="w-full"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem v-for="item in scheduleFrequencies" :key="item" :value="item">{{ t(`schedules.${item}`) }}</SelectItem>
            </SelectContent></Select>
          </div>
          <div v-if="frequency !== 'custom'" class="grid gap-1.5 text-sm">
            <span id="schedule-time-label">{{ t(frequency === 'hourly' ? 'schedules.minuteHint' : 'schedules.time') }}</span>
            <TimeFieldRoot v-slot="{ segments }" v-model="timeValue" :locale="locale" aria-labelledby="schedule-time-label" :hour-cycle="24" granularity="minute" class="flex h-8 w-full items-center rounded-lg border border-input bg-transparent px-2.5 text-sm focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-input/30">
              <TimeFieldInput v-for="(segment, index) in segments" :key="index" :part="segment.part" :class="segment.part === 'literal' ? 'text-muted-foreground' : 'rounded-sm px-0.5 tabular-nums focus:bg-accent focus:outline-none'">{{ segment.value }}</TimeFieldInput>
            </TimeFieldRoot>
          </div>
          <div v-if="frequency === 'weekly'" class="grid gap-1.5 text-sm"><label for="schedule-weekday">{{ t('schedules.weekday') }}</label>
            <Select v-model="weekday"><SelectTrigger id="schedule-weekday" class="w-full"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem v-for="value in scheduleWeekdays" :key="value" :value="value">{{ t(`schedules.days.${value}`) }}</SelectItem>
            </SelectContent></Select>
          </div>
          <label v-if="frequency === 'monthly'" class="grid gap-1.5 text-sm">{{ t('schedules.day') }}<Input v-model="day" type="number" min="1" max="31" required /></label>
          <label v-if="frequency === 'custom'" class="col-span-2 grid gap-1.5 text-sm">{{ t('schedules.cron') }}<Input v-model="custom" required placeholder="0 9 * * MON-FRI" class="font-mono" /><span class="text-xs text-muted-foreground">{{ t('schedules.cronHint') }}</span></label>
        </div>
        <p v-if="frequency === 'monthly'" class="text-xs text-muted-foreground">{{ t('schedules.monthHint') }}</p>
        <div class="grid gap-1.5 text-sm"><label for="schedule-project">{{ t('schedules.project') }}</label>
          <Select v-model="draft.project"><SelectTrigger id="schedule-project" class="w-full"><SelectValue /></SelectTrigger><SelectContent>
            <SelectItem v-for="path in projects" :key="path" :value="path">{{ workspace.projectName(path) }}</SelectItem>
          </SelectContent></Select>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-1.5 text-sm"><label for="schedule-model">{{ t('schedules.model') }}</label><ConversationModelSelect id="schedule-model" v-model="modelKey" :models="models" trigger-class="h-9 w-full min-w-0 text-xs" /></div>
          <div class="grid gap-1.5 text-sm"><label for="schedule-thinking">{{ t('schedules.thinking') }}</label>
            <Select v-model="draft.thinking"><SelectTrigger id="schedule-thinking" class="w-full"><SelectValue /></SelectTrigger><SelectContent>
              <SelectItem v-for="value in levels" :key="value" :value="value">{{ t(`chat.thinkingLevels.${value}`) }}</SelectItem>
            </SelectContent></Select>
          </div>
        </div>
        <label class="grid gap-1.5 text-sm">{{ t('schedules.prompt') }}<Textarea v-model="draft.prompt" required maxlength="30000" class="min-h-32" :placeholder="t('schedules.promptHint')" /></label>
        <div class="flex justify-end gap-2"><Button type="button" variant="outline" :disabled="busy" @click="editing = false">{{ t('schedules.cancel') }}</Button><Button type="submit" :disabled="busy || !modelKey || !draft.project">{{ t(busy ? 'schedules.saving' : 'schedules.save') }}</Button></div>
      </form>
      <template v-else>
        <div class="flex justify-end"><Button :disabled="loading || busy" @click="edit()"><Plus :size="16" />{{ t('schedules.create') }}</Button></div>
        <p v-if="loading" class="text-sm text-muted-foreground">{{ t('schedules.loading') }}</p>
        <p v-else-if="!tasks.length" class="py-8 text-center text-sm text-muted-foreground">{{ t('schedules.empty') }}</p>
        <div v-for="task in tasks" :key="task.id!" class="rounded-lg border p-3 space-y-2">
          <div class="flex justify-between gap-3"><h3 class="font-medium break-words">{{ task.title }}</h3><span class="shrink-0 text-xs text-muted-foreground">{{ t(`schedules.${task.enabled ? task.status : 'paused'}`) }}</span></div>
          <p class="text-xs text-muted-foreground break-all">{{ workspace.projectName(task.project) }} · {{ task.provider }}/{{ task.model }} · {{ task.expression }}</p>
          <p v-if="task.enabled" class="text-xs">{{ t('schedules.next') }}: {{ formatDate(task.nextRun) }}</p>
          <p v-if="task.lastRun" class="text-xs text-muted-foreground">{{ t('schedules.last') }}: {{ formatDate(task.lastRun) }}</p>
          <p v-if="task.error" class="text-xs text-destructive break-words">{{ task.error }}</p>
          <div class="flex gap-1 justify-end">
            <Button v-if="task.sessionFile" variant="ghost" size="sm" @click="openResult(task)">{{ t('schedules.result') }}</Button>
            <Button variant="ghost" size="sm" :disabled="busy || task.status === 'running'" :aria-label="t('schedules.edit')" @click="edit(task)"><Pencil :size="15" /></Button>
            <Button variant="ghost" size="sm" :disabled="busy || task.status === 'running'" :aria-label="t(task.enabled ? 'schedules.pause' : 'schedules.resume')" @click="action(() => saveScheduledTask({ ...task, enabled: !task.enabled }))"><Pause v-if="task.enabled" :size="15" /><Play v-else :size="15" /></Button>
            <Button variant="ghost" size="sm" :disabled="busy || task.status === 'running'" :aria-label="t('schedules.delete')" @click="deleting = task.id"><Trash2 :size="15" /></Button>
          </div>
          <div v-if="deleting === task.id" class="flex items-center justify-end gap-2 text-sm"><span>{{ t('schedules.deleteConfirm') }}</span><Button variant="outline" size="sm" :disabled="busy" @click="deleting = null">{{ t('schedules.cancel') }}</Button><Button variant="destructive" size="sm" :disabled="busy" @click="action(async () => { await deleteScheduledTask(task.id!); deleting = null })">{{ t('schedules.delete') }}</Button></div>
        </div>
      </template>
    </div>
  </ScrollArea>
</template>
