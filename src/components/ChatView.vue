<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation"
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
} from "@/components/ai-elements/message"
import { Loader } from "@/components/ai-elements/loader"
import {
  QueueItem,
  QueueItemContent,
  QueueList,
  QueueSection,
} from "@/components/ai-elements/queue"
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"
import type { ThinkingLevel } from "@/api/protocol"
import type { FileHit, SessionMeta } from "@/api/piClient"
import { listSessions, rpcRequest, searchFiles } from "@/api/piClient"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputHeader,
} from "@/components/ai-elements/prompt-input"
import AssistantBlocks from "@/components/AssistantBlocks.vue"
import StatusBar from "@/components/StatusBar.vue"
import ExtensionDialog from "@/components/ExtensionDialog.vue"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import SessionTree from "@/components/SessionTree.vue"
import SettingsDialog from "@/components/SettingsDialog.vue"
import { openPath } from "@/api/piClient"
import { Copy } from "@lucide/vue"

const session = useSessionStore()
const ui = useUiStore()

const props = defineProps<{ project: string }>()
const emit = defineEmits<{ switchProject: [], resumeSession: [file: string] }>()

const bridge = ref<InstanceType<typeof PromptInputBridge> | null>(null)

// ---- slash command palette ----
const cmdOpen = ref(false)
const slashToken = computed(() => {
  const t = bridge.value?.textInput ?? ""
  return /^\/[\w:-]*$/.test(t) ? t.slice(1).toLowerCase() : null
})
watch(slashToken, (tok) => {
  cmdOpen.value = tok !== null
})
const filteredCommands = computed(() => {
  const tok = slashToken.value
  if (tok === null)
    return []
  return session.commands.filter(
    c => c.name.toLowerCase().includes(tok) || (c.description ?? "").toLowerCase().includes(tok),
  )
})

function pickCommand(name: string) {
  bridge.value?.setTextInput(`/${name} `)
  cmdOpen.value = false
}

// ---- @file mention completion ----
const fileOpen = ref(false)
const fileHits = ref<FileHit[]>([])
let fileQuerySeq = 0

const atToken = computed(() => {
  const t = bridge.value?.textInput ?? ""
  const m = /(?:^|\s)@([^\s]*)$/.exec(t)
  return m ? { token: m[1]!, index: m.index + m[0].length - m[1]!.length - 1 } : null
})

watch(atToken, (tok) => {
  fileOpen.value = tok !== null
  if (tok)
    void queryFiles(tok.token)
})

async function queryFiles(token: string) {
  const seq = ++fileQuerySeq
  try {
    const hits = await searchFiles(props.project, token)
    if (seq === fileQuerySeq)
      fileHits.value = hits
  }
  catch {
    if (seq === fileQuerySeq)
      fileHits.value = []
  }
}

function pickFile(path: string) {
  const tok = atToken.value
  const text = bridge.value?.textInput ?? ""
  if (tok) {
    const before = text.slice(0, tok.index)
    const after = text.slice(tok.index + 1 + tok.token.length)
    bridge.value?.setTextInput(`${before}@${path} ${after}`)
  }
  else {
    bridge.value?.setTextInput(`${text}@${path} `)
  }
  fileOpen.value = false
}

// ---- attachments (images) ----
const attachments = computed(() => bridge.value?.files ?? [])

function dataUrlToImage(d: string): { data: string, mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(d)
  return m ? { data: m[2]!, mimeType: m[1]! } : null
}

function isImageUrl(url?: string): boolean {
  return !!url && (url.startsWith("data:image/") || /^https?:\/\/.*\.(png|jpe?g|gif|webp)/i.test(url))
}

// ---- fork (restart from a previous prompt) ----
const forkOpen = ref(false)
const forkMessages = ref<{ entryId: string, text: string }[]>([])
const treeOpen = ref(false)

async function openFork() {
  try {
    const res = await rpcRequest<{ messages: { entryId: string, text: string }[] }>({ type: "get_fork_messages" })
    if (!res.success)
      throw new Error(res.error ?? "fork list failed")
    forkMessages.value = (res.data?.messages ?? []).slice().reverse()
    forkOpen.value = true
  }
  catch (e) {
    ui.pushToast(String(e), "error")
  }
}

async function doFork(entryId: string) {
  forkOpen.value = false
  treeOpen.value = false
  try {
    const res = await rpcRequest<{ text?: string, cancelled?: boolean }>({ type: "fork", entryId })
    if (!res.success)
      throw new Error(res.error ?? "fork failed")
    if (res.data?.cancelled) {
      ui.pushToast("Fork cancelled by an extension", "info")
      return
    }
    session.clear()
    await session.refreshState()
    await session.loadHistory()
    ui.pushToast("Forked from earlier prompt", "info")
  }
  catch (e) {
    ui.pushToast(String(e), "error")
  }
}

// ---- session history ----
const historyOpen = ref(false)
const history = ref<SessionMeta[]>([])
const historyLoading = ref(false)

watch(historyOpen, (open) => {
  if (open)
    void loadHistoryList()
})

async function loadHistoryList() {
  historyLoading.value = true
  try {
    history.value = await listSessions(props.project)
  }
  catch (e) {
    ui.pushToast(String(e), "error")
  }
  finally {
    historyLoading.value = false
  }
}

function formatTime(s: SessionMeta): string {
  const d = s.timestamp ? new Date(s.timestamp) : new Date(s.mtimeMs)
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString()
}

// ---- settings / export / copy ----
const settingsOpen = ref(false)
const exporting = ref(false)

async function exportSession() {
  exporting.value = true
  try {
    const res = await rpcRequest<{ path?: string }>({ type: "export_html" })
    if (!res.success || !res.data?.path)
      throw new Error(res.error || "export failed")
    await openPath(res.data.path)
    ui.pushToast("Session exported", "info")
  }
  catch (e) {
    ui.pushToast(String(e), "error")
  }
  finally {
    exporting.value = false
  }
}

function blocksText(blocks: { type: string, text?: string }[]): string {
  return blocks.filter(b => b.type === "text").map(b => b.text ?? "").join("\n\n")
}

async function copyText(t: string) {
  try {
    await navigator.clipboard.writeText(t)
    ui.pushToast("Copied", "info")
  }
  catch (e) {
    ui.pushToast(String(e), "error")
  }
}

// extensions can push text into the editor (set_editor_text)
watch(
  () => ui.pendingEditorText,
  (text) => {
    if (text !== null) {
      bridge.value?.setTextInput(text)
      ui.pendingEditorText = null
    }
  },
)

const submitStatus = computed(() => {
  if (session.isStreaming) return "streaming" as const
  return "ready" as const
})

const modelKey = computed({
  get: () => {
    const m = session.currentModel
    return m ? `${m.provider}/${m.id}` : ""
  },
  set: (key: string) => {
    const [provider, ...rest] = key.split("/")
    void session.setModel(provider, rest.join("/"))
  },
})

const modelGroups = computed(() => {
  const groups = new Map<string, typeof session.models>()
  for (const m of session.models) {
    const list = groups.get(m.provider) ?? []
    list.push(m)
    groups.set(m.provider, list)
  }
  return Array.from(groups.entries()).map(([provider, models]) => ({ provider, models }))
})

async function onSubmit(message: { text?: string, files?: { url?: string }[] }) {
  if (session.isStreaming) {
    await abort()
    return
  }
  const text = (message.text ?? "").trim()
  const images = (message.files ?? [])
    .map(f => f.url)
    .filter((u): u is string => isImageUrl(u))
    .map(u => dataUrlToImage(u))
    .filter((im): im is { data: string, mimeType: string } => im !== null)
  if (!text && !images.length)
    return
  await session.send(text, images.length ? images : undefined)
}

async function abort() {
  const restored = await session.abortAndRestore()
  if (restored)
    bridge.value?.setTextInput(restored)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing)
    return
  if (cmdOpen.value || fileOpen.value) {
    e.preventDefault()
    cmdOpen.value = false
    fileOpen.value = false
    return
  }
  if (ui.activeDialog)
    return // dialog handles its own cancel
  if (session.isStreaming) {
    e.preventDefault()
    void abort()
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- toolbar -->
    <header class="border-border flex items-center gap-2 border-b px-4 py-2">
      <span class="text-sm font-semibold">Pi X</span>
      <span class="text-muted-foreground truncate font-mono text-xs">{{ session.cwd }}</span>

      <div class="flex-1" />

      <span v-if="session.retryInfo" class="text-xs text-amber-500">{{ session.retryInfo }}</span>
      <span v-if="session.isCompacting" class="text-muted-foreground animate-pulse text-xs">compacting…</span>

      <Select v-model="modelKey">
        <SelectTrigger class="h-8 w-56 text-xs">
          <SelectValue placeholder="Select model" />
        </SelectTrigger>
        <SelectContent>
          <template v-for="group in modelGroups" :key="group.provider">
            <SelectItem
              v-for="m in group.models"
              :key="m.provider + '/' + m.id"
              :value="m.provider + '/' + m.id"
              class="text-xs"
            >
              {{ m.provider }} / {{ m.name }}
            </SelectItem>
          </template>
        </SelectContent>
      </Select>

      <Select
        :model-value="session.thinkingLevel"
        @update:model-value="(v: any) => { if (typeof v === 'string') void session.setThinkingLevel(v as ThinkingLevel) }"
      >
        <SelectTrigger class="h-8 w-24 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="lv in session.availableThinking" :key="lv" :value="lv" class="text-xs">
            thinking: {{ lv }}
          </SelectItem>
        </SelectContent>
      </Select>

      <button
        class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs"
        @click="treeOpen = true"
      >
        Tree
      </button>
      <button
        class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs"
        @click="openFork"
      >
        Fork
      </button>

      <button
        class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs"
        :disabled="exporting"
        @click="exportSession"
      >
        {{ exporting ? "Exporting…" : "Export" }}
      </button>
      <button
        class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs"
        @click="settingsOpen = true"
      >
        Settings
      </button>

      <Popover v-model:open="historyOpen">
        <PopoverTrigger as-child>
          <button class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs">
            History
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" class="w-96 p-0">
          <p class="text-muted-foreground border-b px-3 py-2 text-xs font-medium">
            {{ historyLoading ? "Loading…" : `Sessions (${history.length})` }}
          </p>
          <div class="max-h-80 overflow-y-auto">
            <button
              v-for="s in history"
              :key="s.id"
              class="hover:bg-accent flex w-full flex-col items-start gap-0.5 border-b px-3 py-2 text-left last:border-b-0"
              :class="s.file === session.sessionFile ? 'bg-accent/60' : ''"
              @click="emit('resumeSession', s.file); historyOpen = false"
            >
              <span class="text-foreground w-full truncate text-xs font-medium">{{ s.preview ?? "(no user message)" }}</span>
              <span class="text-muted-foreground text-[11px]">{{ formatTime(s) }} · {{ s.id.slice(0, 8) }}</span>
            </button>
            <p v-if="!historyLoading && history.length === 0" class="text-muted-foreground px-3 py-4 text-xs">
              No stored sessions for this project.
            </p>
          </div>
        </PopoverContent>
      </Popover>

      <button
        class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs"
        @click="session.newSession()"
      >
        New
      </button>
      <button
        class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs"
        @click="session.compact()"
      >
        Compact
      </button>
      <button
        class="border-input hover:bg-accent rounded-md border px-2.5 py-1.5 text-xs"
        @click="$emit('switchProject')"
      >
        Switch project
      </button>
    </header>

    <!-- conversation -->
    <Conversation class="min-h-0 flex-1">
      <ConversationContent class="mx-auto max-w-3xl px-4 py-6">
        <ConversationEmptyState
          v-if="session.entries.length === 0"
          title="Pi is ready"
          :description="'Working in ' + session.cwd"
        />

        <template v-for="entry in session.entries" :key="entry.id">
          <Message :from="entry.kind === 'user' ? 'user' : 'assistant'">
            <MessageContent>
              <div
                v-if="entry.kind === 'user'"
                class="bg-muted rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
              >
                {{ entry.text }}
                <div v-if="entry.images?.length" class="mt-1.5 flex flex-wrap gap-1.5">
                  <img
                    v-for="(im, i) in entry.images"
                    :key="i"
                    :src="im.url"
                    class="max-h-40 max-w-xs rounded-md border object-contain"
                  >
                </div>
              </div>
              <AssistantBlocks v-else :blocks="entry.blocks" :runs="session.runs" />
                <MessageActions v-if="entry.kind === 'assistant'" class="mt-1">
                  <MessageAction
                    tooltip="Copy reply"
                    @click="copyText(blocksText(entry.blocks))"
                  >
                    <Copy />
                  </MessageAction>
                </MessageActions>
            </MessageContent>
          </Message>
        </template>

        <!-- streaming assistant message (assembled from deltas) -->
        <Message v-if="session.partialBlocks" from="assistant">
          <MessageContent>
            <AssistantBlocks :blocks="session.partialBlocks" :runs="session.runs" />
          </MessageContent>
        </Message>

        <!-- waiting indicator before any content arrives -->
        <div v-if="session.isStreaming && !session.partialBlocks" class="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader />
          <span>thinking…</span>
        </div>

        <!-- pending steering / follow-up -->
        <QueueSection v-if="session.pendingCount > 0" class="mt-2">
          <QueueList>
            <QueueItem v-for="(s, i) in [...session.steering, ...session.followUp]" :key="i">
              <QueueItemContent>{{ s }}</QueueItemContent>
            </QueueItem>
          </QueueList>
        </QueueSection>
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>

    <!-- extension widget -->
    <div
      v-if="ui.widget"
      class="border-border bg-muted/40 border-t px-4 py-2 font-mono text-xs whitespace-pre-wrap"
    >
      {{ ui.widget.lines.join("\n") }}
    </div>

    <!-- composer -->
    <div class="border-border mx-auto w-full max-w-3xl border-t p-3">
      <PromptInput @submit="onSubmit">
        <PromptInputBridge ref="bridge" />
        <PromptInputHeader>
          <!-- pending image attachments -->
          <div v-if="attachments.length" class="flex flex-wrap gap-2 px-1">
            <div
              v-for="f in attachments"
              :key="f.id"
              class="border-border bg-muted relative size-16 overflow-hidden rounded-md border"
            >
              <img
                v-if="isImageUrl(f.url)"
                :src="f.url"
                class="size-full object-cover"
                alt="attachment"
              >
              <span v-else class="text-muted-foreground flex h-full items-center justify-center p-1 text-[10px] break-all">
                {{ f.filename ?? "file" }}
              </span>
              <button
                class="bg-background/80 absolute top-0.5 right-0.5 size-4 rounded-full text-[10px] leading-none"
                title="Remove"
                @click="bridge?.removeFile?.(f.id)"
              >
                ×
              </button>
            </div>
          </div>

          <PromptInputCommand v-if="fileOpen" class="w-full rounded-md border">
            <PromptInputCommandList>
              <PromptInputCommandEmpty>No matching files.</PromptInputCommandEmpty>
              <PromptInputCommandGroup heading="Files">
                <PromptInputCommandItem
                  v-for="f in fileHits"
                  :key="f.path"
                  :value="f.path"
                  @select="pickFile(f.path)"
                >
                  <span class="font-mono text-xs">{{ f.name }}</span>
                  <span class="text-muted-foreground truncate text-xs">{{ f.dir }}</span>
                </PromptInputCommandItem>
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>

          <PromptInputCommand v-if="cmdOpen" class="w-full rounded-md border">
            <PromptInputCommandList>
              <PromptInputCommandEmpty>No matching command.</PromptInputCommandEmpty>
              <PromptInputCommandGroup heading="Commands">
                <PromptInputCommandItem
                  v-for="c in filteredCommands"
                  :key="c.name"
                  :value="c.name"
                  @select="pickCommand(c.name)"
                >
                  <span class="font-mono text-xs">/{{ c.name }}</span>
                  <span class="text-muted-foreground truncate text-xs">{{ c.description }}</span>
                </PromptInputCommandItem>
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>
        </PromptInputHeader>
        <PromptInputTextarea
          placeholder="Message pi… (Enter to send, Esc to abort)"
          class="min-h-16"
        />
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-1">
            <button
              class="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-2 py-1.5 text-xs"
              title="Attach image"
              @click="bridge?.openFileDialog?.()"
            >
              + Image
            </button>
            <StatusBar />
          </div>
          <PromptInputSubmit :status="submitStatus" />
        </div>
      </PromptInput>
    </div>

    <!-- settings dialog -->
    <SettingsDialog :open="settingsOpen" @close="settingsOpen = false" />

    <!-- session tree dialog -->
    <Dialog v-model:open="treeOpen">
      <DialogContent class="max-h-[75vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Session tree</DialogTitle>
        </DialogHeader>
        <SessionTree :open="treeOpen" @fork="doFork" @close="treeOpen = false" />
      </DialogContent>
    </Dialog>

    <!-- fork dialog -->
    <Dialog v-model:open="forkOpen">
      <DialogContent class="max-h-[70vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Fork from an earlier prompt</DialogTitle>
        </DialogHeader>
        <p class="text-muted-foreground text-xs">
          Continues the conversation from the selected prompt, discarding everything after it.
        </p>
        <div class="flex flex-col gap-1">
          <button
            v-for="m in forkMessages"
            :key="m.entryId"
            class="hover:bg-accent rounded-md border px-3 py-2 text-left text-xs"
            @click="doFork(m.entryId)"
          >
            <span class="line-clamp-2">{{ m.text }}</span>
          </button>
          <p v-if="!forkMessages.length" class="text-muted-foreground text-xs">
            No user messages available yet.
          </p>
        </div>
      </DialogContent>
    </Dialog>

    <!-- extension UI dialogs -->
    <ExtensionDialog />
  </div>
</template>
