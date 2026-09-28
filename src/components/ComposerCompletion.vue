<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue"
import { useI18n } from "vue-i18n"
import { useSessionStore } from "@/stores/conversations"
import { useWorkspaceStore } from "@/stores/workspace"
import { searchFiles, type FileHit } from "@/api/piClient"
import {
  completionToken,
  insertCompletion,
  insertSessionCompletion,
  desktopCommands,
  mergeWorkspaceFiles,
} from "@/lib/completion"
import { editorSelection, setEditorCaret } from "@/lib/composerTokens"
import {
  usePromptInput,
  PromptInputCommand,
  PromptInputCommandList,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputButton,
} from "@/components/ai-elements/prompt-input"
import { Loader } from "@/components/ai-elements/loader"

const props = defineProps<{ project: string; connected: boolean; ensureStarted: () => Promise<boolean> }>()
const { t } = useI18n()
const session = useSessionStore()
const workspace = useWorkspaceStore()
const roots = computed(() => workspace.projectFolders(props.project))
const { textInput, setTextInput } = usePromptInput()
const id = useId()
const anchor = ref<HTMLElement | null>(null)
const panelLeft = ref(0)
const panelWidth = ref(0)
const panelBottom = ref(0)
const panelStyle = computed(() => ({
  left: `${panelLeft.value}px`,
  width: `${panelWidth.value}px`,
  bottom: `${panelBottom.value}px`,
}))
function updatePanelPosition() {
  if (!open.value || !anchor.value) return
  const rect = anchor.value.getBoundingClientRect()
  panelLeft.value = rect.left
  panelWidth.value = rect.width
  panelBottom.value = window.innerHeight - rect.top + 6
}
const caret = ref(0),
  selectionEnd = ref(0),
  focused = ref(false),
  dismissed = ref(false)
const active = ref(0),
  loading = ref(false),
  error = ref("")
const files = ref<FileHit[]>([])
let editor: HTMLElement | null = null
let sequence = 0
let timer: ReturnType<typeof setTimeout> | undefined
const initiating = ref(false)
const composing = ref(false)
let starting: Promise<boolean> | null = null
let commandsLoaded = false
let commandLoad: Promise<void> | null = null
let commandEpoch = 0
watch(
  [() => props.project, () => props.connected],
  () => {
    commandsLoaded = false
    commandLoad = null
    ++commandEpoch
  },
  { flush: "sync" },
)
const token = computed(() => completionToken(textInput.value, caret.value, selectionEnd.value))
const open = computed(() => focused.value && !dismissed.value && token.value !== null)
const commands = computed(() => [
  ...session.commands,
  ...desktopCommands
    .filter(name => !session.commands.some(c => c.name === name))
    .map(name => ({ name, description: t("completion.command_" + name), source: "builtin" })),
])
const sessionItems = computed(() => {
  if (token.value?.kind !== "file") return []
  const query = token.value.query.toLowerCase()
  const seen = new Set<string>()
  return Object.values(workspace.histories)
    .flat()
    .filter(row => {
      if (row.file === session.sessionFile || seen.has(row.file)) return false
      seen.add(row.file)
      return `${row.title ?? ""} ${row.preview ?? ""} ${row.id} ${workspace.projectName(row.cwd)}`
        .toLowerCase()
        .includes(query)
    })
    .slice(0, 20)
    .map(row => ({
      kind: "session" as const,
      value: row.file,
      label: row.title || row.preview || row.id,
      description: workspace.projectName(row.cwd),
      source: t("chat.sessions"),
    }))
})
const items = computed(() =>
  token.value?.kind === "command"
    ? commands.value
        .filter(c => `${c.name} ${c.description ?? ""}`.toLowerCase().includes(token.value!.query.toLowerCase()))
        .map(c => ({
          kind: "command" as const,
          value: c.name,
          label: `/${c.name}`,
          description: c.description ?? "",
          source: t(`completion.${c.source}`),
        }))
    : [
        ...sessionItems.value,
        ...files.value.map(f => ({
          kind: "file" as const,
          value: f.path,
          label: f.name,
          description: f.path,
          source: t("chat.files"),
        })),
      ],
)

function syncAccessibility() {
  if (!editor) return
  editor.setAttribute("aria-autocomplete", "list")
  editor.setAttribute("aria-expanded", String(open.value))
  if (open.value) editor.setAttribute("aria-controls", id)
  else editor.removeAttribute("aria-controls")
  const row = document.getElementById(id)?.querySelectorAll('[data-slot="command-item"]')[active.value]
  if (open.value && row?.id) editor.setAttribute("aria-activedescendant", row.id)
  else editor.removeAttribute("aria-activedescendant")
  row?.scrollIntoView({ block: "nearest" })
}
watch([open, active, items, loading], () =>
  nextTick(() => {
    syncAccessibility()
    updatePanelPosition()
  }),
)

async function load(retry = false) {
  if (retry) commandsLoaded = false
  const seq = ++sequence
  clearTimeout(timer)
  files.value = []
  error.value = ""
  loading.value = false
  active.value = 0
  if (!open.value || !token.value) return
  const current = token.value
  const project = props.project
  const searchRoots = [...new Set([project, ...roots.value])]
  loading.value = true
  if (current.kind === "file") {
    timer = setTimeout(async () => {
      try {
        const results = await Promise.allSettled(searchRoots.map(root => searchFiles(root, current.query)))
        if (seq === sequence) {
          const hits = mergeWorkspaceFiles(
            project,
            searchRoots,
            results.map(result => (result.status === "fulfilled" ? result.value : null)),
          )
          files.value = hits
          if (!hits.length && results.every(result => result.status === "rejected"))
            throw (results[0] as PromiseRejectedResult).reason
        }
      } catch (e) {
        if (seq === sequence) error.value = String(e)
      } finally {
        if (seq === sequence) loading.value = false
      }
    }, 150)
  } else {
    try {
      if (!props.connected) {
        if (!starting) {
          initiating.value = true
          starting = props.ensureStarted().finally(() => {
            starting = null
            initiating.value = false
          })
        }
        if (!(await starting)) throw new Error(t("completion.startFailed"))
      }
      if (seq === sequence && !commandsLoaded) {
        const epoch = commandEpoch
        commandLoad ??= session
          .refreshCommands()
          .then(() => {
            if (epoch === commandEpoch) commandsLoaded = true
          })
          .finally(() => {
            if (epoch === commandEpoch) commandLoad = null
          })
        await commandLoad
      }
    } catch (e) {
      if (seq === sequence) error.value = String(e)
    } finally {
      if (seq === sequence) loading.value = false
    }
  }
}
watch([token, open, () => props.project, () => props.connected, () => JSON.stringify(roots.value)], () => load())

async function onEditorEvent(event: Event) {
  if (event.type === "compositionstart") composing.value = true
  if (event.type === "compositionend") composing.value = false
  editor = event.target as HTMLElement
  anchor.value = editor?.closest('[data-slot="input-group"]')
  if (event.type === "blur") {
    focused.value = false
    return
  }
  await nextTick()
  focused.value = true
  const selection = editorSelection(editor)
  const changed = caret.value !== selection.start || selectionEnd.value !== selection.end
  caret.value = selection.start
  selectionEnd.value = selection.end
  if (changed || event.type === "input") dismissed.value = false
  syncAccessibility()
}
async function pick(item: (typeof items.value)[number]) {
  if (!token.value) return
  const result =
    item.kind === "session"
      ? insertSessionCompletion(textInput.value, token.value, item.value)
      : insertCompletion(textInput.value, token.value, item.value)
  dismissed.value = true
  setTextInput(result.text)
  caret.value = selectionEnd.value = result.caret
  await nextTick()
  editor?.focus()
  if (editor) setEditorCaret(editor, result.caret)
}
function onKeydown(event: KeyboardEvent) {
  if (!open.value || composing.value || event.isComposing || event.keyCode === 229) return
  if (event.key === "Escape") {
    event.preventDefault()
    event.stopPropagation()
    dismissed.value = true
  } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault()
    event.stopPropagation()
    if (items.value.length)
      active.value = (active.value + (event.key === "ArrowDown" ? 1 : -1) + items.value.length) % items.value.length
  } else if ((event.key === "Enter" && !event.shiftKey) || (event.key === "Tab" && !event.shiftKey)) {
    // Never let Enter submit a partial command while results are loading.
    if (event.key === "Tab" && !items.value.length) return
    event.preventDefault()
    event.stopPropagation()
    if (
      items.value[active.value] &&
      (items.value[active.value]!.kind === "session" || (!loading.value && !error.value))
    )
      void pick(items.value[active.value]!)
  }
}
onMounted(() => {
  window.addEventListener("resize", updatePanelPosition)
  window.addEventListener("scroll", updatePanelPosition, true)
})
onBeforeUnmount(() => {
  ++sequence
  clearTimeout(timer)
  window.removeEventListener("resize", updatePanelPosition)
  window.removeEventListener("scroll", updatePanelPosition, true)
})
defineExpose({ onEditorEvent, onKeydown, initiating })
</script>

<template>
  <Teleport to="body">
    <PromptInputCommand
      v-if="open"
      class="fixed z-50 h-auto max-h-[60vh] rounded-xl border shadow-lg"
      :style="panelStyle"
      @mousedown.prevent
    >
      <PromptInputCommandList
        :id="id"
        class="max-h-56"
        :aria-label="t(token?.kind === 'command' ? 'chat.commands' : 'chat.references')"
      >
        <PromptInputCommandGroup :heading="t(token?.kind === 'command' ? 'chat.commands' : 'chat.references')">
          <div
            v-if="loading && !items.length"
            role="status"
            class="flex items-center gap-2 p-3 text-xs text-muted-foreground"
          >
            <Loader :size="14" />{{ t("completion.loading") }}
          </div>
          <div v-else-if="error && !items.length" role="alert" class="p-3 text-xs text-destructive">
            {{ t("completion.failed") }}: {{ error }}
            <PromptInputButton size="sm" @click="load(true)">{{ t("completion.retry") }}</PromptInputButton>
          </div>
          <div v-else-if="!items.length" role="status" class="p-3 text-xs text-muted-foreground">
            {{ t(token?.kind === "command" ? "chat.noMatchingCommand" : "chat.noMatchingReferences") }}
          </div>
          <template v-else>
            <PromptInputCommandItem
              v-for="(item, index) in items"
              :key="item.value"
              :value="item.value"
              :class="index === active ? 'bg-accent text-accent-foreground' : ''"
              @pointermove="active = index"
              @select="pick(item)"
            >
              <span class="min-w-0 flex-1"
                ><span class="block truncate font-mono text-xs">{{ item.label }}</span
                ><span class="block truncate text-xs text-muted-foreground">{{ item.description }}</span></span
              >
              <span v-if="item.source" class="text-xs text-muted-foreground">{{ item.source }}</span>
            </PromptInputCommandItem>
          </template>
        </PromptInputCommandGroup>
      </PromptInputCommandList>
      <div class="border-t px-3 py-2 text-xs text-muted-foreground">
        {{ t("completion.keys") }}<span v-if="token?.kind === 'file'"> · {{ t("completion.pathOnly") }}</span>
      </div>
    </PromptInputCommand>
  </Teleport>
</template>
