<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSessionStore } from '@/stores/session'
import { searchFiles, type FileHit } from '@/api/piClient'
import { completionToken, insertCompletion, desktopCommands } from '@/lib/completion'
import { usePromptInput, PromptInputCommand, PromptInputCommandList, PromptInputCommandGroup, PromptInputCommandItem, PromptInputButton } from '@/components/ai-elements/prompt-input'
import { Loader } from '@/components/ai-elements/loader'

const props = defineProps<{ project: string; connected: boolean; ensureStarted: () => Promise<boolean> }>()
const { t } = useI18n()
const session = useSessionStore()
const { textInput, setTextInput } = usePromptInput()
const id = useId()
const caret = ref(0), selectionEnd = ref(0), focused = ref(false), dismissed = ref(false)
const active = ref(0), loading = ref(false), error = ref('')
const files = ref<FileHit[]>([])
let editor: HTMLTextAreaElement | null = null
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
const initiating = ref(false)
let starting: Promise<boolean> | null = null
let commandsLoaded = false
let commandLoad: Promise<void> | null = null
let commandEpoch = 0
watch([() => props.project, () => props.connected], () => {
  commandsLoaded = false
  commandLoad = null
  ++commandEpoch
}, { flush: 'sync' })
const token = computed(() => completionToken(textInput.value, caret.value, selectionEnd.value))
const open = computed(() => focused.value && !dismissed.value && token.value !== null)
const commands = computed(() => [
  ...session.commands,
  ...desktopCommands.filter(name => !session.commands.some(c => c.name === name)).map(name => ({ name, description: t('completion.command_' + name), source: 'builtin' })),
])
const items = computed(() => token.value?.kind === 'command'
  ? commands.value.filter(c => `${c.name} ${c.description ?? ''}`.toLowerCase().includes(token.value!.query.toLowerCase())).map(c => ({ value: c.name, label: `/${c.name}`, description: c.description ?? '', source: t(`completion.${c.source}`) }))
  : files.value.map(f => ({ value: f.path, label: f.name, description: f.path, source: '' })))

function syncAccessibility() {
  if (!editor) return
  editor.setAttribute('aria-autocomplete', 'list')
  editor.setAttribute('aria-expanded', String(open.value))
  if (open.value) editor.setAttribute('aria-controls', id)
  else editor.removeAttribute('aria-controls')
  const row = document.getElementById(id)?.querySelectorAll('[data-slot="command-item"]')[active.value]
  if (open.value && row?.id) editor.setAttribute('aria-activedescendant', row.id)
  else editor.removeAttribute('aria-activedescendant')
  row?.scrollIntoView({ block: 'nearest' })
}
watch([open, active, items, loading], () => nextTick(syncAccessibility))

async function load(retry = false) {
  if (retry) commandsLoaded = false
  const seq = ++sequence
  clearTimeout(timer)
  files.value = []
  error.value = ''
  loading.value = false
  active.value = 0
  if (!open.value || !token.value) return
  const current = token.value
  const project = props.project
  loading.value = true
  if (current.kind === 'file') {
    timer = setTimeout(async () => {
      try {
        const hits = await searchFiles(project, current.query)
        if (seq === sequence) files.value = hits
      } catch (e) { if (seq === sequence) error.value = String(e) }
      finally { if (seq === sequence) loading.value = false }
    }, 150)
  } else {
    try {
      if (!props.connected) {
        if (!starting) {
          initiating.value = true
          starting = props.ensureStarted().finally(() => { starting = null; initiating.value = false })
        }
        if (!await starting) throw new Error(t('completion.startFailed'))
      }
      if (seq === sequence && !commandsLoaded) {
        const epoch = commandEpoch
        commandLoad ??= session.refreshCommands().then(() => {
          if (epoch === commandEpoch) commandsLoaded = true
        }).finally(() => { if (epoch === commandEpoch) commandLoad = null })
        await commandLoad
      }
    } catch (e) { if (seq === sequence) error.value = String(e) }
    finally { if (seq === sequence) loading.value = false }
  }
}
watch([token, open, () => props.project, () => props.connected], () => load())

async function onEditorEvent(event: Event) {
  editor = event.target as HTMLTextAreaElement
  if (event.type === 'blur') { focused.value = false; return }
  await nextTick()
  focused.value = true
  const changed = caret.value !== editor.selectionStart || selectionEnd.value !== editor.selectionEnd
  caret.value = editor.selectionStart
  selectionEnd.value = editor.selectionEnd
  if (changed || event.type === 'input') dismissed.value = false
  syncAccessibility()
}
async function pick(value: string) {
  if (!token.value) return
  const result = insertCompletion(textInput.value, token.value, value)
  dismissed.value = true
  setTextInput(result.text)
  caret.value = selectionEnd.value = result.caret
  await nextTick()
  editor?.focus()
  editor?.setSelectionRange(result.caret, result.caret)
}
function onKeydown(event: KeyboardEvent) {
  if (!open.value || event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    event.preventDefault(); event.stopPropagation(); dismissed.value = true
  } else if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); event.stopPropagation()
    if (items.value.length) active.value = (active.value + (event.key === 'ArrowDown' ? 1 : -1) + items.value.length) % items.value.length
  } else if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
    // Never let Enter submit a partial command while results are loading.
    if (event.key === 'Tab' && !items.value.length) return
    event.preventDefault(); event.stopPropagation()
    if (!loading.value && !error.value && items.value[active.value]) void pick(items.value[active.value]!.value)
  }
}
onBeforeUnmount(() => { ++sequence; clearTimeout(timer) })
defineExpose({ onEditorEvent, onKeydown, initiating })
</script>

<template>
  <PromptInputCommand v-if="open" class="w-full rounded-md border" @mousedown.prevent>
    <PromptInputCommandList :id="id" class="max-h-56" :aria-label="t(token?.kind === 'command' ? 'chat.commands' : 'chat.files')">
      <PromptInputCommandGroup :heading="t(token?.kind === 'command' ? 'chat.commands' : 'chat.files')">
        <div v-if="loading" role="status" class="flex items-center gap-2 p-3 text-xs text-muted-foreground"><Loader :size="14" />{{ t('completion.loading') }}</div>
        <div v-else-if="error" role="alert" class="p-3 text-xs text-destructive">{{ t('completion.failed') }}: {{ error }} <PromptInputButton size="sm" @click="load(true)">{{ t('completion.retry') }}</PromptInputButton></div>
        <div v-else-if="!items.length" role="status" class="p-3 text-xs text-muted-foreground">{{ t(token?.kind === 'command' ? 'chat.noMatchingCommand' : 'chat.noMatchingFiles') }}</div>
        <template v-else>
          <PromptInputCommandItem v-for="(item, index) in items" :key="item.value" :value="item.value" :class="index === active ? 'bg-accent text-accent-foreground' : ''" @pointermove="active = index" @select="pick(item.value)">
            <span class="min-w-0 flex-1"><span class="block truncate font-mono text-xs">{{ item.label }}</span><span class="block truncate text-xs text-muted-foreground">{{ item.description }}</span></span>
            <span v-if="item.source" class="text-xs text-muted-foreground">{{ item.source }}</span>
          </PromptInputCommandItem>
        </template>
      </PromptInputCommandGroup>
    </PromptInputCommandList>
    <div class="border-t px-3 py-2 text-xs text-muted-foreground">{{ t('completion.keys') }}<span v-if="token?.kind === 'file'"> · {{ t('completion.pathOnly') }}</span></div>
  </PromptInputCommand>
</template>
