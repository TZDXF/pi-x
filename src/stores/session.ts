import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { useWorkspaceStore } from "@/stores/workspace"
import { generateSessionTitle, rpcRequest } from "@/api/piClient"
import type {
  AssistantMessageEvent,
  CommandInfo,
  Model,
  SessionState,
  SessionStats,
  ThinkingLevel,
  Usage,
} from "@/api/protocol"

// ---- render model ----

export interface ToolRun {
  id: string
  name: string
  argsText: string
  outputText: string
  state: "input-streaming" | "input-available" | "output-available" | "output-error"
}

export interface TextBlock { type: "text", text: string }
export interface ThinkingBlock { type: "thinking", text: string, streaming: boolean }
export interface ToolCallBlock { type: "toolCall", callId: string, name: string, argsText: string }
export type Block = TextBlock | ThinkingBlock | ToolCallBlock

export interface UserEntry { kind: "user", id: number, text: string, images?: { url: string }[] }
export interface AssistantEntry { kind: "assistant", id: number, blocks: Block[] }
export type Entry = UserEntry | AssistantEntry

function contentText(content: unknown): string {
  if (typeof content === "string")
    return content
  if (Array.isArray(content))
    return content
      .map((c: any) => (c && c.type === "text" ? c.text : ""))
      .join("")
  return ""
}

let entrySeq = 0
const nextId = () => ++entrySeq

export const useSessionStore = defineStore("session", () => {
  // ---- state ----
  const entries = ref<Entry[]>([])
  const runs = ref<Record<string, ToolRun>>({})
  /** In-progress assistant message being assembled from streaming deltas. */
  const partialBlocks = ref<Block[] | null>(null)
  const isStreaming = ref(false)
  const isCompacting = ref(false)
  const retryInfo = ref<string | null>(null)
  const steering = ref<string[]>([])
  const followUp = ref<string[]>([])
  const state = ref<SessionState | null>(null)
  /** File path of the active pi session (null until persisted). */
  const sessionFile = ref<string | null>(null)
  const stats = ref<SessionStats | null>(null)
  const lastUsage = ref<Usage | null>(null)
  const commands = ref<CommandInfo[]>([])
  const models = ref<Model[]>([])
  const availableThinking = ref<ThinkingLevel[]>(["off"])
  const cwd = ref("")

  // streaming assembly

  const currentModel = computed(() => state.value?.model ?? null)
  const thinkingLevel = computed(() => state.value?.thinkingLevel ?? "off")
  const pendingCount = computed(() => steering.value.length + followUp.value.length)

  // ---- event ingestion ----
  function handleEvent(ev: Record<string, any>) {
    switch (ev.type) {
      case "agent_start":
        isStreaming.value = true
        break

      case "agent_settled":
        isStreaming.value = false
        void refreshStats()
        void refreshState()
        break

      case "message_start": {
        const msg = ev.message
        if (msg?.role === "assistant") {
          partialBlocks.value = []
        }
        break
      }

      case "message_update": {
        const usage = ev.usage
        if (usage && usage.totalTokens)
          lastUsage.value = usage
        const delta = ev.assistantMessageEvent as AssistantMessageEvent | undefined
        if (!delta || !partialBlocks.value)
          break
        applyDelta(partialBlocks.value, delta)
        break
      }

      case "message_end": {
        const msg = ev.message
        if (msg?.role === "assistant") {
          // authoritative replace
          const blocks = blocksFromMessage(msg)
          entries.value.push({ kind: "assistant", id: nextId(), blocks })
          if (msg.usage)
            lastUsage.value = msg.usage
        }
        // user / toolResult messages are rendered from local state + tool runs
        partialBlocks.value = null
        break
      }

      case "tool_execution_start": {
        runs.value[ev.toolCallId] = {
          id: ev.toolCallId,
          name: ev.toolName,
          argsText: safeJson(ev.args),
          outputText: "",
          state: "input-available",
        }
        break
      }

      case "tool_execution_update": {
        const run = runs.value[ev.toolCallId]
        if (run && ev.partialResult) {
          // partialResult is the accumulated output so far (per rpc.md)
          run.outputText = contentText(ev.partialResult.content)
        }
        break
      }

      case "tool_execution_end": {
        const run = runs.value[ev.toolCallId]
        if (run) {
          run.outputText = ev.result ? contentText(ev.result.content) : run.outputText
          run.state = ev.isError ? "output-error" : "output-available"
        }
        break
      }

      case "queue_update":
        steering.value = ev.steering ?? []
        followUp.value = ev.followUp ?? []
        break

      case "compaction_start":
        isCompacting.value = true
        break

      case "compaction_end":
        isCompacting.value = false
        void refreshStats()
        break

      case "auto_retry_start":
        retryInfo.value = `retrying (${ev.attempt}/${ev.maxAttempts}): ${ev.errorMessage ?? ""}`
        break

      case "auto_retry_end":
        retryInfo.value = null
        if (!ev.success)
          void refreshState()
        break

      case "extension_error":
        console.warn("[pi] extension error:", ev.extensionPath, ev.error)
        break
    }
  }

  function applyDelta(blocks: Block[], delta: AssistantMessageEvent) {
    const i = delta.contentIndex
    switch (delta.type) {
      case "text_start":
        blocks[i] = { type: "text", text: "" }
        break
      case "text_delta": {
        const b = ensure(blocks, i, "text") as TextBlock
        b.text += delta.delta
        break
      }
      case "text_end":
        if (delta.content !== undefined)
          blocks[i] = { type: "text", text: delta.content }
        break
      case "thinking_start":
        blocks[i] = { type: "thinking", text: "", streaming: true }
        break
      case "thinking_delta": {
        const b = ensure(blocks, i, "thinking") as ThinkingBlock
        b.text += delta.delta
        break
      }
      case "thinking_end": {
        const b = ensure(blocks, i, "thinking") as ThinkingBlock
        if (delta.thinking !== undefined)
          b.text = delta.thinking
        b.streaming = false
        break
      }
      case "toolcall_start":
        blocks[i] = { type: "toolCall", callId: delta.id, name: delta.toolName, argsText: "" }
        break
      case "toolcall_delta": {
        const b = ensure(blocks, i, "toolCall") as ToolCallBlock
        b.argsText += delta.delta
        break
      }
      case "toolcall_end": {
        const call = delta.toolCall
        blocks[i] = {
          type: "toolCall",
          callId: call.id,
          name: call.name,
          argsText: typeof call.arguments === "string"
            ? call.arguments
            : JSON.stringify(call.arguments ?? {}, null, 2),
        }
        break
      }
    }
  }

  function ensure(blocks: Block[], i: number, type: Block["type"]): Block {
    if (!blocks[i] || blocks[i].type !== type) {
      blocks[i] = type === "text"
        ? { type: "text", text: "" }
        : type === "thinking"
          ? { type: "thinking", text: "", streaming: true }
          : { type: "toolCall", callId: "unknown", name: "unknown", argsText: "" }
    }
    return blocks[i]
  }

  function blocksFromMessage(msg: any): Block[] {
    const out: Block[] = []
    for (const c of msg.content ?? []) {
      if (c.type === "text" && c.text)
        out.push({ type: "text", text: c.text })
      else if (c.type === "thinking" && c.thinking)
        out.push({ type: "thinking", text: c.thinking, streaming: false })
      else if (c.type === "toolCall")
        out.push({
          type: "toolCall",
          callId: c.id,
          name: c.name,
          argsText: typeof c.arguments === "string"
            ? c.arguments
            : JSON.stringify(c.arguments ?? {}, null, 2),
        })
    }
    return out
  }

  function safeJson(v: unknown): string {
    try {
      return JSON.stringify(v ?? {}, null, 2)
    }
    catch {
      return String(v)
    }
  }

  // ---- actions ----
  async function send(text: string, images?: { data: string, mimeType: string }[]) {
    const trimmed = text.trim()
    if (!trimmed && !images?.length)
      return
    const firstMessage = !entries.value.some(entry => entry.kind === "user") && !(state.value?.messageCount)
    // Capture identity now: completion must never name a subsequently selected session.
    const titleFile = sessionFile.value
    const titleProject = cwd.value
    const titleSessionId = state.value?.sessionId
    const promptText = trimmed || "(see attached image)"
    entries.value.push({ kind: "user", id: nextId(), text: trimmed, images: images?.map(im => ({ url: `data:${im.mimeType};base64,${im.data}` })) })
    const command: Record<string, unknown> = { type: "prompt", message: promptText }
    if (images?.length)
      command.images = images.map(im => ({ type: "image", data: im.data, mimeType: im.mimeType }))
    if (isStreaming.value)
      command.streamingBehavior = "steer"
    // resolves after the full run finishes; events drive the UI meanwhile
    rpcRequest(command)
      .then(async (res) => {
        if (!res.success)
          console.error("[pi] prompt rejected:", res.error)
      })
      .catch((e) => {
        entries.value.push({
          kind: "assistant",
          id: nextId(),
          blocks: [{ type: "text", text: `**Error:** ${String(e)}` }],
        })
      })
      .finally(() => {
        void refreshState()
        void refreshStats()
      })
    if (firstMessage && titleFile && titleSessionId) {
      const workspace = useWorkspaceStore()
      workspace.preview({ file: titleFile, id: titleSessionId, cwd: titleProject,
        mtimeMs: Date.now(), timestamp: new Date().toISOString(), preview: promptText.replace(/\s+/g, " ").slice(0, 120) })
      // Independent IPC call: do not await it or switch the active model.
      void generateSessionTitle(titleFile, promptText).then(async title => {
        if (title) workspace.generatedTitle(titleFile, title)
        await workspace.refresh(titleProject)
      }).catch(error => console.warn("[pi] title generation failed; keeping preview:", error))
    }
  }

  /** Esc: take back queued messages, then abort. Returns text to restore. */
  async function abortAndRestore(): Promise<string> {
    const restored: string[] = []
    try {
      const res = await rpcRequest<{ steering?: string[], followUp?: string[] }>({ type: "clear_queue" })
      restored.push(...(res.data?.steering ?? []), ...(res.data?.followUp ?? []))
    }
    catch {
      // ignore
    }
    try {
      await rpcRequest({ type: "abort" })
    }
    catch {
      // ignore
    }
    await refreshState()
    return restored.join("\n")
  }

  async function newSession() {
    const result = await rpcRequest<{ cancelled?: boolean }>({ type: "new_session" })
    if (!result.success) throw new Error(result.error || "新建会话失败")
    if (result.data?.cancelled) return
    entries.value = []
    runs.value = {}
    partialBlocks.value = null
    await refreshState()
    await refreshStats()
  }

  async function compact(customInstructions?: string) {
    isCompacting.value = true
    try {
      const command: Record<string, unknown> = { type: "compact" }
      if (customInstructions)
        command.customInstructions = customInstructions
      await rpcRequest(command)
    }
    finally {
      isCompacting.value = false
      await refreshStats()
    }
  }

  async function setModel(provider: string, modelId: string) {
    await rpcRequest({ type: "set_model", provider, modelId })
    await refreshState()
  }

  async function setThinkingLevel(level: ThinkingLevel) {
    await rpcRequest({ type: "set_thinking_level", level })
    await refreshState()
    await refreshThinkingLevels()
  }

  // ---- queries ----
  async function refreshState() {
    const res = await rpcRequest<SessionState & { sessionFile?: string }>({ type: "get_state" })
    if (res.success && res.data) {
      state.value = res.data
      sessionFile.value = res.data.sessionFile ?? null
    }
  }

  /** Rebuild the visible conversation from the session's stored messages. */
  function loadMessages(msgs: any[]) {
    entries.value = []
    runs.value = {}
    partialBlocks.value = null
    for (const msg of msgs) {
      if (msg.role === "user") {
        const text = contentText(msg.content)
        if (text.trim())
          entries.value.push({ kind: "user", id: nextId(), text })
      }
      else if (msg.role === "assistant") {
        const blocks = blocksFromMessage(msg)
        if (blocks.length)
          entries.value.push({ kind: "assistant", id: nextId(), blocks })
      }
      else if (msg.role === "toolResult") {
        const callId = String(msg.toolCallId ?? msg.id ?? "")
        if (!callId)
          continue
        runs.value[callId] = {
          id: callId,
          name: "tool",
          argsText: "",
          outputText: contentText(msg.content),
          state: msg.isError ? "output-error" : "output-available",
        }
      }
    }
  }

  /** Fetch full history from a resumed session and render it. */
  async function loadHistory() {
    const res = await rpcRequest<{ messages: any[] }>({ type: "get_messages" })
    if (res.success)
      loadMessages(res.data?.messages ?? [])
  }

  async function refreshStats() {
    const res = await rpcRequest<SessionStats>({ type: "get_session_stats" })
    if (res.success && res.data)
      stats.value = res.data
  }

  async function refreshCommands() {
    const res = await rpcRequest<{ commands: CommandInfo[] }>({ type: "get_commands" })
    if (res.success && res.data)
      commands.value = res.data.commands ?? []
  }

  async function refreshModels() {
    const res = await rpcRequest<{ models: Model[] }>({ type: "get_available_models" })
    if (res.success && res.data)
      models.value = res.data.models ?? []
  }

  async function refreshThinkingLevels() {
    const res = await rpcRequest<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" })
    if (res.success && res.data)
      availableThinking.value = res.data.levels ?? ["off"]
  }

  async function init(project: string) {
    cwd.value = project
    await Promise.all([refreshState(), refreshCommands(), refreshModels(), refreshStats()])
    await refreshThinkingLevels()
  }

  function clear() {
    entries.value = []
    runs.value = {}
    partialBlocks.value = null
    steering.value = []
    followUp.value = []
    state.value = null
    stats.value = null
    lastUsage.value = null
    commands.value = []
  }

  return {
    entries,
    runs,
    partialBlocks,
    isStreaming,
    isCompacting,
    retryInfo,
    steering,
    followUp,
    state,
    stats,
    lastUsage,
    commands,
    models,
    availableThinking,
    cwd,
    sessionFile,
    currentModel,
    thinkingLevel,
    pendingCount,
    handleEvent,
    send,
    abortAndRestore,
    newSession,
    compact,
    setModel,
    setThinkingLevel,
    refreshState,
    refreshStats,
    refreshModels,
    loadHistory,
    loadMessages,
    init,
    clear,
  }
})
