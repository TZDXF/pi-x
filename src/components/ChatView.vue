<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue"
import { useI18n } from "vue-i18n"
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useSessionStore } from "@/stores/session"
import { useUiStore } from "@/stores/ui"
import type { ThinkingLevel } from "@/api/protocol"
import type { FileHit } from "@/api/piClient"
import { rpcRequest, searchFiles } from "@/api/piClient"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  PromptInputCommand,
  PromptInputCommandEmpty,
  PromptInputCommandGroup,
  PromptInputCommandItem,
  PromptInputCommandList,
  PromptInputHeader,
} from "@/components/ai-elements/prompt-input"
import ConversationModelSelect from "@/components/ConversationModelSelect.vue"
import AssistantBlocks from "@/components/AssistantBlocks.vue"
import StatusBar from "@/components/StatusBar.vue"
import ExtensionDialog from "@/components/ExtensionDialog.vue"
import PromptInputBridge from "@/components/PromptInputBridge.vue"
import SessionTree from "@/components/SessionTree.vue"
import { openPath } from "@/api/piClient"
import WorkspaceContext from "@/components/WorkspaceContext.vue"
import { useWorkspaceStore } from "@/stores/workspace"
import { Copy } from "@lucide/vue"

const session = useSessionStore()
const ui = useUiStore()
const { t } = useI18n()

const props = defineProps<{ project: string; ensureStarted: () => Promise<boolean>; connecting: boolean; connected: boolean }>()
const emit = defineEmits<{ selectProject: [path: string]; openProject: [] }>()
const workspace = useWorkspaceStore()
const currentTitle = computed(() => workspace.histories[props.project]?.find(s => s.file === session.sessionFile)?.title)


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
  if (tok === null) return []
  return session.commands.filter(
    (c) =>
      c.name.toLowerCase().includes(tok) ||
      (c.description ?? "").toLowerCase().includes(tok),
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
  return m
    ? { token: m[1]!, index: m.index + m[0].length - m[1]!.length - 1 }
    : null
})

watch(atToken, (tok) => {
  fileOpen.value = tok !== null
  if (tok) void queryFiles(tok.token)
})

async function queryFiles(token: string) {
  const seq = ++fileQuerySeq
  try {
    const hits = await searchFiles(props.project, token)
    if (seq === fileQuerySeq) fileHits.value = hits
  } catch {
    if (seq === fileQuerySeq) fileHits.value = []
  }
}

function pickFile(path: string) {
  const tok = atToken.value
  const text = bridge.value?.textInput ?? ""
  if (tok) {
    const before = text.slice(0, tok.index)
    const after = text.slice(tok.index + 1 + tok.token.length)
    bridge.value?.setTextInput(`${before}@${path} ${after}`)
  } else {
    bridge.value?.setTextInput(`${text}@${path} `)
  }
  fileOpen.value = false
}

// ---- attachments (images) ----
const attachments = computed(() => bridge.value?.files ?? [])

function dataUrlToImage(d: string): { data: string; mimeType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(d)
  return m ? { data: m[2]!, mimeType: m[1]! } : null
}

function isImageUrl(url?: string): boolean {
  return (
    !!url &&
    (url.startsWith("data:image/") ||
      /^https?:\/\/.*\.(png|jpe?g|gif|webp)/i.test(url))
  )
}

// ---- fork (restart from a previous prompt) ----
const forkOpen = ref(false)
const forkMessages = ref<{ entryId: string; text: string }[]>([])
const treeOpen = ref(false)

async function openFork() {
  try {
    const res = await rpcRequest<{
      messages: { entryId: string; text: string }[]
    }>({ type: "get_fork_messages" })
    if (!res.success) throw new Error(res.error ?? "fork list failed")
    forkMessages.value = (res.data?.messages ?? []).slice().reverse()
    forkOpen.value = true
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

async function doFork(entryId: string) {
  forkOpen.value = false
  treeOpen.value = false
  try {
    const res = await rpcRequest<{ text?: string; cancelled?: boolean }>({
      type: "fork",
      entryId,
    })
    if (!res.success) throw new Error(res.error ?? "fork failed")
    if (res.data?.cancelled) {
      ui.pushToast(t("chat.toastForkCancelled"), "info")
      return
    }
    session.clear()
    await session.refreshState()
    await session.loadHistory()
    ui.pushToast(t("chat.toastForked"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}

// ---- settings / export / copy ----
const exporting = ref(false)

async function exportSession() {
  exporting.value = true
  try {
    const res = await rpcRequest<{ path?: string }>({ type: "export_html" })
    if (!res.success || !res.data?.path)
      throw new Error(res.error || "export failed")
    await openPath(res.data.path)
    ui.pushToast(t("chat.toastExported"), "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  } finally {
    exporting.value = false
  }
}

function blocksText(blocks: { type: string; text?: string }[]): string {
  return blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("\n\n")
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ui.pushToast(t("chat.toastCopied"), "info")
  } catch (e) {
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
    if (session.desiredModelKey) return session.desiredModelKey
    const m = session.currentModel
    return m ? `${m.provider}/${m.id}` : ""
  },
  set: (key: string) => {
    const [provider, ...rest] = key.split("/")
    // pi starts lazily: queue the choice until init() applies it.
    if (!props.connected) {
      session.setDesiredModel(key)
      return
    }
    session.setModel(provider, rest.join("/"))
      .catch(e => ui.pushToast(String(e), "error"))
  },
})

async function onSubmit(message: {
  text?: string
  files?: { url?: string }[]
}) {
  if (workspace.gitBusy || props.connecting) return
  if (session.isStreaming) {
    await abort()
    return
  }
  const text = (message.text ?? "").trim()
  const images = (message.files ?? [])
    .map((f) => f.url)
    .filter((u): u is string => isImageUrl(u))
    .map((u) => dataUrlToImage(u))
    .filter((im): im is { data: string; mimeType: string } => im !== null)
  if (!text && !images.length) return
  if (!await props.ensureStarted()) {
    bridge.value?.setTextInput(text)
    return
  }
  await session.send(text, images.length ? images : undefined)
}

function onThinkingChange(v: unknown) {
  if (typeof v !== "string") return
  session.setThinkingLevel(v as ThinkingLevel)
    .catch(e => ui.pushToast(String(e), "error"))
}

async function abort() {
  const restored = await session.abortAndRestore()
  if (restored) bridge.value?.setTextInput(restored)
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.isComposing) return
  if (cmdOpen.value || fileOpen.value) {
    e.preventDefault()
    cmdOpen.value = false
    fileOpen.value = false
    return
  }
  if (ui.activeDialog) return // dialog handles its own cancel
  if (session.isStreaming) {
    e.preventDefault()
    void abort()
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown))
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown))
</script>

<template>
  <div class="chat-workspace">
    <header class="workspace-header">
      <div class="min-w-0">
        <h1 class="truncate text-sm font-medium">
          {{ currentTitle || session.entries.find((e) => e.kind === "user")?.text || t("chat.newSession") }}
        </h1>
        <p class="text-muted-foreground truncate text-xs">
          {{ project.split(/[\\/]/).filter(Boolean).pop() }}
          <span class="mx-1">/</span> {{ t("common.localWorkspace") }}
        </p>
      </div>
      <div class="header-actions">
        <span v-if="session.retryInfo" class="text-xs text-amber-500">{{
          session.retryInfo
        }}</span>
        <span v-if="session.isCompacting" class="text-xs animate-pulse"
          >{{ t("chat.compacting") }}</span
        >
        <button class="quiet-button" @click="treeOpen = true">{{ t("chat.sessionTree") }}</button>
        <button class="quiet-button" @click="openFork">{{ t("chat.fork") }}</button>
        <button
          class="quiet-button"
          :disabled="exporting"
          @click="exportSession"
        >
          {{ exporting ? t("chat.exporting") : t("chat.export") }}
        </button>
        <button
          class="quiet-button"
          :disabled="session.isStreaming || !connected"
          @click="session.compact()"
        >
          {{ t("chat.compactContext") }}
        </button>
      </div>
    </header>

    <!-- conversation -->
    <Conversation class="min-h-0 flex-1">
      <ConversationContent
        class="conversation-column mx-auto w-full max-w-3xl px-6 py-10"
      >
        <ConversationEmptyState
          class="chat-empty"
          v-if="session.entries.length === 0"
          :title="t('workspace.emptyTitle', { project: project.split(/[\\/]/).filter(Boolean).pop() })"
          :description="t('chat.emptyDesc')"
        />

        <template v-for="entry in session.entries" :key="entry.id">
          <Message :from="entry.kind === 'user' ? 'user' : 'assistant'">
            <MessageContent>
              <div
                v-if="entry.kind === 'user'"
                class="bg-muted rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
              >
                {{ entry.text }}
                <div
                  v-if="entry.images?.length"
                  class="mt-1.5 flex flex-wrap gap-1.5"
                >
                  <img
                    v-for="(im, i) in entry.images"
                    :key="i"
                    :src="im.url"
                    class="max-h-40 max-w-xs rounded-md border object-contain"
                  />
                </div>
              </div>
              <AssistantBlocks
                v-else
                :blocks="entry.blocks"
                :runs="session.runs"
              />
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
            <AssistantBlocks
              :blocks="session.partialBlocks"
              :runs="session.runs"
            />
          </MessageContent>
        </Message>

        <!-- waiting indicator before any content arrives -->
        <div
          v-if="session.isStreaming && !session.partialBlocks"
          class="text-muted-foreground flex items-center gap-2 text-sm"
        >
          <Loader />
          <span>{{ t("chat.thinking") }}</span>
        </div>

        <!-- pending steering / follow-up -->
        <QueueSection v-if="session.pendingCount > 0" class="mt-2">
          <QueueList>
            <QueueItem
              v-for="(s, i) in [...session.steering, ...session.followUp]"
              :key="i"
            >
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
    <div class="composer-dock mx-auto w-full max-w-3xl px-6 pb-5 pt-3">
      <WorkspaceContext v-if="!session.entries.length && !session.isStreaming" :project="project" @select-project="emit('selectProject', $event)" @open-project="emit('openProject')" />
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
              />
              <span
                v-else
                class="text-muted-foreground flex h-full items-center justify-center p-1 text-[10px] break-all"
              >
                {{ f.filename ?? "file" }}
              </span>
              <button
                type="button"
                class="bg-background/80 absolute top-0.5 right-0.5 size-4 rounded-full text-[10px] leading-none"
                :title="t('chat.removeAttachment')"
                @click="bridge?.removeFile?.(f.id)"
              >
                ×
              </button>
            </div>
          </div>

          <PromptInputCommand v-if="fileOpen" class="w-full rounded-md border">
            <PromptInputCommandList>
              <PromptInputCommandEmpty
                >{{ t("chat.noMatchingFiles") }}</PromptInputCommandEmpty
              >
              <PromptInputCommandGroup :heading="t('chat.files')">
                <PromptInputCommandItem
                  v-for="f in fileHits"
                  :key="f.path"
                  :value="f.path"
                  @select="pickFile(f.path)"
                >
                  <span class="font-mono text-xs">{{ f.name }}</span>
                  <span class="text-muted-foreground truncate text-xs">{{
                    f.dir
                  }}</span>
                </PromptInputCommandItem>
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>

          <PromptInputCommand v-if="cmdOpen" class="w-full rounded-md border">
            <PromptInputCommandList>
              <PromptInputCommandEmpty
                >{{ t("chat.noMatchingCommand") }}</PromptInputCommandEmpty
              >
              <PromptInputCommandGroup :heading="t('chat.commands')">
                <PromptInputCommandItem
                  v-for="c in filteredCommands"
                  :key="c.name"
                  :value="c.name"
                  @select="pickCommand(c.name)"
                >
                  <span class="font-mono text-xs">/{{ c.name }}</span>
                  <span class="text-muted-foreground truncate text-xs">{{
                    c.description
                  }}</span>
                </PromptInputCommandItem>
              </PromptInputCommandGroup>
            </PromptInputCommandList>
          </PromptInputCommand>
        </PromptInputHeader>
        <PromptInputTextarea
          :placeholder="t('chat.inputPlaceholder')"
          :disabled="workspace.gitBusy || connecting"
          class="min-h-14"
        />
        <div class="composer-controls flex items-center justify-between">
          <div class="composer-options flex items-center gap-1">
            <button
              type="button"
              class="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md px-2 py-1.5 text-xs"
              :title="t('chat.attachImage')"
              @click="bridge?.openFileDialog?.()"
            >
              + {{ t("chat.attachment") }}
            </button>
            <ConversationModelSelect v-model="modelKey" :models="session.models" :disabled="!connected && session.models.length === 0" />

            <Select
              :model-value="session.thinkingLevel"
              :disabled="!connected"
              @update:model-value="onThinkingChange"
            >
              <SelectTrigger class="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="lv in session.availableThinking"
                  :key="lv"
                  :value="lv"
                  class="text-xs"
                >
                  {{ t("chat.thinkingLevel") }}: {{ lv }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <PromptInputSubmit :status="submitStatus" :disabled="workspace.gitBusy || connecting" />
        </div>
      </PromptInput>
      <StatusBar />
    </div>

    <!-- session tree dialog -->
    <Dialog v-model:open="treeOpen">
      <DialogContent class="max-h-[75vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ t("chat.sessionTreeTitle") }}</DialogTitle>
        </DialogHeader>
        <SessionTree
          :open="treeOpen"
          @fork="doFork"
          @close="treeOpen = false"
        />
      </DialogContent>
    </Dialog>

    <!-- fork dialog -->
    <Dialog v-model:open="forkOpen">
      <DialogContent class="max-h-[70vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{{ t("chat.forkTitle") }}</DialogTitle>
        </DialogHeader>
        <p class="text-muted-foreground text-xs">
          {{ t("chat.forkDesc") }}
        </p>
        <div class="flex flex-col gap-1">
          <button
            type="button"
            v-for="m in forkMessages"
            :key="m.entryId"
            class="hover:bg-accent rounded-md border px-3 py-2 text-left text-xs"
            @click="doFork(m.entryId)"
          >
            <span class="line-clamp-2">{{ m.text }}</span>
          </button>
          <p v-if="!forkMessages.length" class="text-muted-foreground text-xs">
            {{ t("chat.forkEmpty") }}
          </p>
        </div>
      </DialogContent>
    </Dialog>

    <!-- extension UI dialogs -->
    <ExtensionDialog />
  </div>
</template>
