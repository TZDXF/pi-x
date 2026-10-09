import { clampThinkingLevel } from "@/lib/thinkingLevels"
import { defineStore } from "pinia"
import { computed, ref } from "vue"
import { i18n, tBackendError } from "@/i18n"
import { useWorkspaceStore } from "@/stores/workspace"
import { setSessionRunStatus } from "@/stores/sessionRunStatus"
import {
  generateSessionTitle,
  getPiSettings,
  pixLog,
  rpcRequest as requestForRuntime,
  sessionMtime,
} from "@/api/piClient"
import { sessionChanges } from "@/lib/sessionChanges"
import { mergeArtifactChanges, type FileChangeArtifact } from "@/lib/fileChangeArtifacts"
import { builtinExtensionPath, isBuiltinExtensionPath } from "@/lib/extensionNames"
import type {
  CommandInfo,
  Model,
  QueueDeliveryMode,
  SessionState,
  SessionStats,
  ThinkingLevel,
  Usage,
} from "@/api/protocol"
import { createEventHandler, errorBlock } from "./session/events"
import { createModelSelection } from "./session/modelSelection"
import { createModelActions } from "./session/modelActions"
import { createSessionArtifacts } from "./session/artifacts"
import { createSessionHistory } from "./session/history"
import { createPromptQueue } from "./session/promptQueue"
import { createTurnCheckpoints } from "./session/checkpoints"
import type { Block, Entry, QueuedPrompt, RetryInfo, SessionFlow, ToolRun, UserEntry } from "./session/types"

export type {
  AssistantEntry,
  Block,
  CompactionEntry,
  ContextEditEntry,
  Entry,
  ErrorBlock,
  ModelChangeEntry,
  QueuedPrompt,
  RetryInfo,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  ToolRun,
  UserEntry,
} from "./session/types"

let entrySeq = 0
const nextId = () => ++entrySeq

/** 毫秒计时；部分测试 VM 环境没有 performance 全局。 */
const nowMs = () => (typeof performance === "undefined" ? Date.now() : performance.now())

export const createSessionStore = (runtimeId = "default") =>
  defineStore(`session:${runtimeId}`, () => {
    const rpcRequest = <T = unknown>(command: Record<string, unknown>) => {
      const type = typeof command.type === "string" ? command.type : "unknown"
      const start = nowMs()
      return requestForRuntime<T>(command, runtimeId).then(
        res => {
          pixLog(`[perf] rpc ${type} ${Math.round(nowMs() - start)}ms`, runtimeId)
          return res
        },
        error => {
          pixLog(`[perf] rpc ${type} failed after ${Math.round(nowMs() - start)}ms`, runtimeId)
          throw error
        },
      )
    }
    const started = ref(false)

    // ---- state ----
    const entries = ref<Entry[]>([])
    const runs = ref<Record<string, ToolRun>>({})
    const fileChangeArtifacts = ref<FileChangeArtifact[]>([])
    const revertedFileChangeCalls = ref(new Set<string>())
    /** In-progress assistant message being assembled from streaming deltas. */
    const partialBlocks = ref<Block[] | null>(null)
    const isStreaming = ref(false)
    const isCompacting = ref(false)
    const compactionError = ref<string | null>(null)
    const retryInfo = ref<RetryInfo | null>(null)
    /** Last prompt/steer/follow_up response disposition that needs surfacing
     *  (ChatView watches this and raises a toast). Null once consumed. */
    const dispositionNotice = ref<{ seq: number; message: string } | null>(null)
    let dispositionSeq = 0
    const promptQueue = ref<QueuedPrompt[]>([])
    const isResending = ref(false)
    let resendVersion = 0
    const steering = ref<string[]>([])
    const followUp = ref<string[]>([])
    const state = ref<SessionState | null>(null)
    /** Live follow-up delivery mode, mirrored from pi's get_state. */
    const followUpMode = ref<QueueDeliveryMode | null>(null)
    /** File path of the active pi session (null until persisted). */
    const sessionFile = ref<string | null>(null)
    /** Runtime auto-retry switch (set_auto_retry). pi reports no getter for it;
     *  the client tracks it, seeded from settings.json `retry.enabled` on init. */
    const autoRetry = ref<boolean | null>(null)
    /** On-disk mtime at the last time our own view of the file was synced;
     *  a watcher event reporting a different value means an external edit. */
    const syncedSessionMtime = ref<number | null>(null)
    let mtimeSyncSeq = 0
    /** Re-read the session file's mtime from disk after loading our own history
     *  or after one of our own runs settles. */
    async function syncSessionFile() {
      const seq = ++mtimeSyncSeq
      const file = sessionFile.value
      if (!file) return
      try {
        const mtime = await sessionMtime(file)
        if (seq === mtimeSyncSeq && sessionFile.value === file) syncedSessionMtime.value = mtime
      } catch {
        /* file missing or unreadable; keep previous value */
      }
    }
    /** Record a known mtime without hitting disk (e.g. after a rename via us). */
    function syncSessionMtime(mtime: number) {
      ++mtimeSyncSeq
      syncedSessionMtime.value = mtime
    }
    const stats = ref<SessionStats | null>(null)
    const lastUsage = ref<Usage | null>(null)
    const commands = ref<CommandInfo[]>([])
    const models = ref<Model[]>([])
    const cwd = ref("")
    /** Model switch to annotate the next user entry with, consumed by send(). */
    const pendingModelChange = ref<{ from: string; to: string } | null>(null)
    const {
      remembered,
      desiredModelKey,
      offlineDefaultModelKey,
      desiredThinkingLevel,
      rpcThinkingLevels,
      currentModel,
      availableThinking,
      thinkingLevel,
      remember,
      setDesiredModel,
      setDesiredThinkingLevel,
      loadOfflineModels,
      invalidateOfflineModels,
    } = createModelSelection(state, models)
    const { setModel, setThinkingLevel, cycleModel, cycleThinkingLevel } = createModelActions({
      rpcRequest,
      state,
      started,
      pendingModelChange,
      desiredModelKey,
      desiredThinkingLevel,
      rpcThinkingLevels,
      remember,
      syncSessionFile,
      refreshState,
      refreshThinkingLevels,
    })
    const { refreshFileRewindState, markFileRewinds, mergeFileChangeArtifact } = createSessionArtifacts({
      sessionFile,
      fileChangeArtifacts,
      revertedFileChangeCalls,
    })

    // streaming assembly

    const pendingCount = computed(() => promptQueue.value.length + steering.value.length + followUp.value.length)

    /** Reserved entry id for the in-flight assistant turn. Assigned at the
     *  first assistant message_start and reused when the entry is committed, so
     *  the UI can key the streaming turn stably across completion. */
    const streamingTurnId = ref<number | null>(null)

    let conversationVersion = 0
    const {
      historyMessages,
      historyCursor,
      historyLoading,
      olderHistoryLoading,
      hasOlderHistory,
      invalidateHistory,
      loadOlderHistory,
      loadMessages,
      loadHistory,
      timelineTurns,
      revealTimelineTurn,
    } = createSessionHistory({
      entries,
      runs,
      partialBlocks,
      streamingTurnId,
      sessionFile,
      isStreaming,
      rpcRequest,
      nextId,
      syncSessionFile,
      refreshFileRewindState,
      mergeFileChangeArtifact,
      resetArtifacts: () => {
        fileChangeArtifacts.value = []
        revertedFileChangeCalls.value = new Set()
      },
      invalidateConversation: () => {
        compactionError.value = null
        ++conversationVersion
      },
    })

    // Run-flow flags shared with the event handler and the queue scheduler
    // (session/events.ts, session/promptQueue.ts).
    const flow: SessionFlow = {
      turnFailed: false,
      turnAborted: false,
      lastErrorMessage: null,
      awaitingAgentStart: false,
      agentStartedAt: undefined,
      stopping: false,
      queuePaused: false,
    }

    const {
      schedulePrompt,
      removeQueuedPrompt,
      moveQueuedPrompt,
      executeQueuedPrompt,
      dispatchQueuedPrompt,
      clearQueueTimer,
    } = createPromptQueue({ promptQueue, isStreaming, isResending, isCompacting, flow, nextId, send })

    let userTurnCount = 0
    const turnCheckpoints = createTurnCheckpoints({
      cwd,
      sessionFile,
      userTurnCount: () => userTurnCount,
    })

    const handleEvent = createEventHandler({
      runtimeId,
      entries,
      runs,
      partialBlocks,
      isStreaming,
      isCompacting,
      compactionError,
      retryInfo,
      steering,
      followUp,
      lastUsage,
      streamingTurnId,
      sessionFile,
      cwd,
      flow,
      nextId,
      refreshStats,
      refreshState,
      syncSessionFile,
      dispatchQueuedPrompt,
      checkpointStart: turnCheckpoints.onAgentStart,
      checkpointSettle: turnCheckpoints.onAgentSettled,
      customEntryAppended: mergeFileChangeArtifact,
    })

    // ---- actions ----

    /** Surface a response `data.disposition` (rpc-commands.md) as a diagnostic
     *  log plus a notice whenever the message did NOT simply start a run: an
     *  extension consumed it ("handled") or pi queued it ("queued"). */
    function reportDisposition(command: string, data: unknown, queuedKey: string) {
      const disposition = (data as { disposition?: string } | undefined)?.disposition
      pixLog(`${command} disposition=${disposition ?? "unknown"}`, runtimeId)
      if (disposition === "handled")
        dispositionNotice.value = { seq: ++dispositionSeq, message: i18n.global.t("chat.dispositionHandled") }
      else if (disposition === "queued")
        dispositionNotice.value = { seq: ++dispositionSeq, message: i18n.global.t(queuedKey) }
    }

    /** Surface a failed action as an assistant error bubble in the conversation.
     *  Backend/transport errors go through tBackendError; plain messages
     *  (already translated) pass through unchanged. */
    function pushErrorEntry(error: unknown) {
      entries.value.push({
        kind: "assistant",
        id: nextId(),
        blocks: [errorBlock(tBackendError(error instanceof Error ? error.message : error))],
        failed: true,
        timestamp: Date.now(),
        live: true,
      })
    }

    async function send(
      text: string,
      images?: { data: string; mimeType: string }[],
      expandedText?: string,
      behavior: "queue" | "steer" = "steer",
      replacement?: UserEntry,
    ) {
      const trimmed = text.trim()
      if (!trimmed && !images?.length) return
      // The desktop /compact command runs locally between runs; it can never be
      // steered into an active run, so queue it behind one instead.
      const compactMatch = /^\/compact(?:\s+([\s\S]*))?$/.exec(trimmed)
      if (compactMatch && images?.length) {
        // Compaction runs locally and takes no attachments; forwarding the
        // literal command text plus images to the model would be wrong.
        compactionError.value = i18n.global.t("chat.compactImagesUnsupported")
        return
      }
      if (compactMatch && !commands.value.some(command => command.name === "compact")) {
        if (isStreaming.value || flow.stopping || isResending.value || isCompacting.value) {
          promptQueue.value.push({ id: nextId(), text: trimmed })
          return
        }
        try {
          await compact(compactMatch[1]?.trim() || undefined)
        } catch {
          // compact() stores the transient error separately from the transcript.
        }
        // compaction_end also drains the queue; cover RPC failures that emit none.
        if (!flow.stopping && !flow.queuePaused) dispatchQueuedPrompt()
        return
      }
      if (isStreaming.value && behavior === "queue") {
        // Keep queued messages in the client panel (delete / edit / run now /
        // drag to reorder); they are dispatched via `prompt` once the run
        // settles, so nothing is handed to the model while it is still busy.
        promptQueue.value.push({ id: nextId(), text: trimmed, images, expandedText })
        return
      }
      compactionError.value = null
      flow.queuePaused = false
      const wasStreaming = isStreaming.value
      isStreaming.value = true
      if (!wasStreaming) {
        flow.awaitingAgentStart = true
        flow.turnFailed = false
        flow.turnAborted = false
      }
      setSessionRunStatus(sessionFile.value, "running")
      const version = conversationVersion
      const firstMessage = !entries.value.some(entry => entry.kind === "user") && !state.value?.messageCount
      // Editing the first question replaces the session's identity: its title
      // must be regenerated from the new wording.
      const editingFirstQuestion = !!replacement && !entries.value.some(entry => entry.kind === "user")
      // Capture identity now: completion must never name a subsequently selected session.
      const titleFile = sessionFile.value
      const titleProject = cwd.value
      const titleSessionId = state.value?.sessionId
      const promptText = expandedText || trimmed || "(see attached image)"
      // Only a real question consumes the notice; queued prompts consume it when
      // dispatched, and slash commands leave it for the next question.
      const modelChange = trimmed.startsWith("/") ? undefined : (pendingModelChange.value ?? undefined)
      if (modelChange) pendingModelChange.value = null
      const turnIndex = ++userTurnCount
      entries.value.push({
        kind: "user",
        id: replacement?.id ?? nextId(),
        turnIndex,
        timestamp: Date.now(),
        text: trimmed,
        modelChange: modelChange ?? replacement?.modelChange,
        images: images?.map(im => ({ url: `data:${im.mimeType};base64,${im.data}` })),
        live: true,
      })
      const command: Record<string, unknown> = { type: "prompt", message: promptText }
      if (images?.length) command.images = images.map(im => ({ type: "image", data: im.data, mimeType: im.mimeType }))
      if (wasStreaming) command.streamingBehavior = "steer"
      // resolves after the full run finishes; events drive the UI meanwhile
      rpcRequest(command)
        .then(async res => {
          if (!res.success) throw new Error(res.error ?? i18n.global.t("chat.promptRejected"))
          // While steering, pi queues the message instead of starting a run;
          // make that (and extension consumption) visible either way.
          reportDisposition("prompt", res.data, wasStreaming ? "chat.steerQueued" : "chat.followUpQueued")
        })
        .catch(e => {
          if (version !== conversationVersion) return
          flow.turnFailed = true
          setSessionRunStatus(sessionFile.value, "error")
          if (!wasStreaming) {
            flow.awaitingAgentStart = false
            isStreaming.value = false
          }
          pushErrorEntry(e)
        })
        .finally(() => {
          if (version !== conversationVersion) return
          void refreshState()
          void refreshStats()
        })
      if ((firstMessage || editingFirstQuestion) && titleFile && titleSessionId) {
        emitTitlePreview({ titleFile, titleProject, titleSessionId, promptText, editingFirstQuestion })
      }
    }

    /** Fire-and-forget workspace preview plus title generation for the first
     *  question (or its edit). Independent IPC call: do not await it or switch
     *  the active model. */
    function emitTitlePreview(input: {
      titleFile: string
      titleProject: string
      titleSessionId: string
      promptText: string
      editingFirstQuestion: boolean
    }) {
      const { titleFile, titleProject, titleSessionId, promptText, editingFirstQuestion } = input
      const workspace = useWorkspaceStore()
      workspace.preview({
        file: titleFile,
        id: titleSessionId,
        cwd: titleProject,
        mtimeMs: Date.now(),
        timestamp: new Date().toISOString(),
        preview: promptText.replace(/\s+/g, " ").slice(0, 120),
      })
      const titleStart = nowMs()
      void generateSessionTitle(titleFile, promptText, editingFirstQuestion)
        .then(async title => {
          if (title) {
            if (editingFirstQuestion) workspace.regeneratedTitle(titleFile, title)
            else workspace.generatedTitle(titleFile, title)
          }
          await workspace.refresh(titleProject)
        })
        .catch(error => console.warn("[pi] title generation failed; keeping preview:", error))
        .finally(() => pixLog(`[perf] generateSessionTitle ${Math.round(nowMs() - titleStart)}ms`, runtimeId))
    }

    /** Replace the last question at its original position, without creating a session fork. */
    async function resendPrompt(text: string, images?: { data: string; mimeType: string }[], expandedText?: string) {
      if ((!text.trim() && !images?.length) || isResending.value) return
      let promptIndex = entries.value.length - 1
      while (promptIndex >= 0 && entries.value[promptIndex]?.kind !== "user") promptIndex--
      const original = entries.value[promptIndex] as UserEntry | undefined
      if (!original) return
      const operation = ++resendVersion
      let version = conversationVersion
      const file = sessionFile.value
      const assertCurrent = () => {
        if (version !== conversationVersion || file !== sessionFile.value)
          throw new Error(i18n.global.t("chat.editSessionChanged"))
      }
      isResending.value = true
      flow.stopping = true
      flow.queuePaused = true
      try {
        if (isStreaming.value || isCompacting.value || pendingCount.value > 0) {
          // Stop Pi's pending continuations from racing with the replacement question.
          // Keep them in the local queue rather than dropping the user's work.
          const queued = await rpcRequest<{ steering?: string[]; followUp?: string[] }>({ type: "clear_queue" })
          assertCurrent()
          if (!queued.success) throw new Error(queued.error ?? i18n.global.t("chat.editStopFailed"))
          promptQueue.value.unshift(
            ...[...(queued.data?.steering ?? []), ...(queued.data?.followUp ?? [])].map(text => ({
              id: nextId(),
              text,
            })),
          )
          steering.value = []
          followUp.value = []
          const aborted = await rpcRequest({ type: "abort" })
          assertCurrent()
          if (!aborted.success) throw new Error(aborted.error ?? i18n.global.t("chat.editStopFailed"))
        }
        // An abort response alone must not be treated as an idle event. Confirm it
        // before send(), otherwise the edited question could become steering text.
        const idle = await rpcRequest<SessionState>({ type: "get_state" })
        assertCurrent()
        if (!idle.success) throw new Error(idle.error ?? i18n.global.t("chat.editStopFailed"))
        if (!idle.data || idle.data.isStreaming || idle.data.isCompacting || idle.data.pendingMessageCount > 0)
          throw new Error(i18n.global.t("chat.editStopFailed"))
        if (idle.data.sessionFile !== file) throw new Error(i18n.global.t("chat.editSessionChanged"))
        const rewound = await rpcRequest({ type: "rewind_prompt", sessionFile: file })
        assertCurrent()
        if (!rewound.success) throw new Error(rewound.error ?? i18n.global.t("chat.editStopFailed"))
        const replaceIndex = entries.value.findIndex(entry => entry.id === original.id)
        if (replaceIndex < 0) throw new Error(i18n.global.t("chat.editSessionChanged"))
        entries.value.splice(replaceIndex)
        // Cached history also feeds the file-change summary; omit the old turn.
        let historyEnd = historyMessages.value.length - 1
        while (historyEnd >= 0 && historyMessages.value[historyEnd]?.role !== "user") historyEnd--
        if (!original.live && historyEnd >= historyCursor.value)
          historyMessages.value = historyMessages.value.slice(0, historyEnd)
        // Late completion/rejection of the interrupted prompt cannot mark the new
        // run failed or clear its streaming state.
        version = ++conversationVersion
        state.value = idle.data
        isStreaming.value = false
        isCompacting.value = false
        partialBlocks.value = null
        streamingTurnId.value = null
        retryInfo.value = null
        await send(text, images, expandedText, "steer", original)
      } finally {
        if (operation === resendVersion) {
          flow.stopping = false
          isResending.value = false
          // The edit owns the queue only while it runs; a failure in any step
          // above (clear_queue/abort/get_state/rewind_prompt) must still
          // release the scheduler or queued prompts would never dispatch.
          // abortAndRestore keeps its pause on purpose: the user took the
          // queued messages back into the composer.
          flow.queuePaused = false
        }
      }
    }

    /** Esc: take back queued messages, then abort. Returns text to restore. */
    async function abortAndRestore(): Promise<string> {
      flow.stopping = true
      flow.queuePaused = true
      const restored: string[] = []
      try {
        const res = await rpcRequest<{ steering?: string[]; followUp?: string[] }>({ type: "clear_queue" })
        restored.push(...(res.data?.steering ?? []), ...(res.data?.followUp ?? []))
      } catch {
        // ignore
      }
      try {
        await rpcRequest({ type: "abort" })
      } catch {
        // ignore
      }
      try {
        await refreshState()
      } finally {
        flow.turnAborted = true
        isStreaming.value = false
        setSessionRunStatus(sessionFile.value, null)
        flow.stopping = false
      }
      return restored.join("\n")
    }

    /** Reset per-conversation run-flow state so a run still in flight cannot
     *  leak streaming/queue flags across the switch (newSession used to leave
     *  isStreaming set, locking the UI forever once the in-flight prompt
     *  rejected against a bumped conversationVersion). Shared by newSession()
     *  and clear(); teardown specific to dropping the conversation (session
     *  file, commands, offline models, auto-retry) stays with clear(). */
    function resetRunFlow() {
      ++conversationVersion
      invalidateHistory()
      pendingModelChange.value = null
      userTurnCount = 0
      flow.agentStartedAt = undefined
      flow.turnFailed = false
      flow.turnAborted = false
      flow.lastErrorMessage = null
      flow.awaitingAgentStart = false
      promptQueue.value = []
      clearQueueTimer()
      flow.stopping = false
      ++resendVersion
      isResending.value = false
      flow.queuePaused = false
      isStreaming.value = false
      isCompacting.value = false
      compactionError.value = null
      retryInfo.value = null
      dispositionNotice.value = null
      steering.value = []
      followUp.value = []
      entries.value = []
      runs.value = {}
      partialBlocks.value = null
      streamingTurnId.value = null
      stats.value = null
      lastUsage.value = null
    }

    async function newSession() {
      const result = await rpcRequest<{ cancelled?: boolean }>({ type: "new_session" })
      if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.newSession"))
      if (result.data?.cancelled) return
      resetRunFlow()
      await refreshState()
      await applyRememberedSelection()
      await refreshStats()
    }

    async function compact(customInstructions?: string) {
      const version = conversationVersion
      const turnCount = userTurnCount
      compactionError.value = null
      isCompacting.value = true
      try {
        const command: Record<string, unknown> = { type: "compact" }
        if (customInstructions) command.customInstructions = customInstructions
        const result = await rpcRequest(command)
        if (!result.success) throw new Error(result.error ?? i18n.global.t("chat.errors.compaction"))
      } catch (error) {
        // A delayed RPC rejection must not restore an error after continuation
        // or after switching to another transcript.
        if (version === conversationVersion && turnCount === userTurnCount)
          compactionError.value = errorBlock(tBackendError(error instanceof Error ? error.message : error)).text
        throw error
      } finally {
        isCompacting.value = false
        await refreshStats()
      }
    }

    /** set_auto_retry: the runtime auto-retry switch of the running pi. */
    async function setAutoRetry(enabled: boolean) {
      const result = await rpcRequest({ type: "set_auto_retry", enabled })
      if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.autoRetrySwitch"))
      autoRetry.value = enabled
    }

    /** set_auto_compaction: toggles automatic compaction of the running pi;
     *  get_state reports the authoritative value, so re-read it. */
    async function setAutoCompaction(enabled: boolean) {
      const result = await rpcRequest({ type: "set_auto_compaction", enabled })
      if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.autoCompactionSwitch"))
      await refreshState()
    }

    /** abort_retry: cancel the pending retry delay and stop retrying; pi
     *  reports the cancellation through auto_retry_end(success:false). */
    async function abortRetry() {
      const result = await rpcRequest({ type: "abort_retry" })
      if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.abortRetry"))
    }

    // ---- queries ----
    /** Concurrent refreshes (events, actions, init) race the same get_state;
     *  only the newest request may write, so a stale response cannot restore
     *  an outdated state/sessionFile (same pattern as commandRequestVersion). */
    let stateRequestVersion = 0
    async function refreshState() {
      const version = ++stateRequestVersion
      const res = await rpcRequest<SessionState & { sessionFile?: string }>({ type: "get_state" })
      if (version !== stateRequestVersion) return
      if (res.success && res.data) {
        state.value = res.data
        sessionFile.value = res.data.sessionFile ?? null
        followUpMode.value = res.data.followUpMode ?? null
      }
    }

    /** Switch how queued follow-up messages are delivered in the running pi. */
    async function setFollowUpMode(mode: QueueDeliveryMode) {
      const res = await rpcRequest({ type: "set_follow_up_mode", mode })
      if (!res.success) throw new Error(res.error || i18n.global.t("chat.errors.followUpMode"))
      followUpMode.value = mode
    }

    /** Push the user's configured followUpMode and retry switch (pi global
     *  settings.json) into a session pi already started; unset means pi's
     *  default applies. */
    function applyConfiguredModes() {
      void getPiSettings()
        .then(settings => {
          autoRetry.value = settings.retry?.enabled ?? true
          if (settings.followUpMode && settings.followUpMode !== followUpMode.value)
            return setFollowUpMode(settings.followUpMode)
        })
        .catch(e => console.warn("[pi] configured modes:", e))
    }

    async function refreshStats() {
      const res = await rpcRequest<SessionStats>({ type: "get_session_stats" })
      if (res.success && res.data) stats.value = res.data
    }

    let commandRequestVersion = 0
    async function refreshCommands() {
      const version = ++commandRequestVersion
      const res = await rpcRequest<{
        commands: Array<
          CommandInfo & {
            sourceInfo?: { path?: string; scope?: "user" | "project" | "temporary" }
          }
        >
      }>({ type: "get_commands" })
      if (version !== commandRequestVersion) return
      if (!res.success) throw new Error(res.error ?? "Failed to load commands")
      // Pi nests the resource file path in `sourceInfo` instead of a top-level
      // `path`; flatten it so the loaded-skills list and "import loaded" work.
      // Built-in extensions carry a `builtin:<name>` pseudo-path (older pi used
      // `<builtin:name>` / `<inline:name>`), so normalize it and flag the
      // command: pi still reports those as `source: "extension"`.
      commands.value = (res.data?.commands ?? []).map(({ sourceInfo, ...command }) => {
        const path = command.path ?? sourceInfo?.path
        return {
          ...command,
          path: path && isBuiltinExtensionPath(path) ? builtinExtensionPath(path) : path,
          builtin: isBuiltinExtensionPath(path),
          location:
            command.location ??
            (sourceInfo?.scope === "user" || sourceInfo?.scope === "project" ? sourceInfo.scope : undefined),
        }
      })
    }

    async function refreshModels() {
      const res = await rpcRequest<{ models: Model[] }>({ type: "get_available_models" })
      if (res.success && res.data) models.value = res.data.models ?? []
    }

    async function refreshThinkingLevels() {
      const res = await rpcRequest<{ levels: ThinkingLevel[] }>({ type: "get_available_thinking_levels" })
      if (res.success && res.data) rpcThinkingLevels.value = res.data.levels ?? ["off"]
    }

    async function applyRememberedSelection() {
      const start = nowMs()
      // Snapshot both choices: setModel may update Pi's effective thinking level.
      const savedModel = remembered.value.model
      const modelKey = desiredModelKey.value ?? (savedModel ? `${savedModel.provider}/${savedModel.id}` : null)
      const level = desiredThinkingLevel.value ?? remembered.value.thinking
      desiredModelKey.value = null
      desiredThinkingLevel.value = null
      if (modelKey && `${state.value?.model?.provider}/${state.value?.model?.id}` !== modelKey) {
        const [provider, ...rest] = modelKey.split("/")
        await setModel(provider, rest.join("/"), false).catch(e =>
          console.warn("[pi] remembered model unavailable:", e),
        )
      }
      await refreshThinkingLevels()
      if (level) {
        const supported = clampThinkingLevel(level, availableThinking.value)
        if (supported !== state.value?.thinkingLevel) await setThinkingLevel(supported)
      }
      if (state.value?.model) remember(state.value.model, state.value.thinkingLevel, rpcThinkingLevels.value)
      pixLog(`[perf] applyRememberedSelection ${Math.round(nowMs() - start)}ms model=${modelKey ?? "-"}`, runtimeId)
    }

    async function init(project: string, fresh = false) {
      const start = nowMs()
      pixLog(`[perf] init begin project=${project} fresh=${fresh}`, runtimeId)
      invalidateOfflineModels()
      cwd.value = project
      await Promise.all([refreshState(), refreshCommands(), refreshModels(), refreshStats()])
      applyConfiguredModes()
      await refreshThinkingLevels()
      if (fresh) await applyRememberedSelection()
      else {
        // A restored session is authoritative, even when an offline draft had choices.
        desiredModelKey.value = null
        desiredThinkingLevel.value = null
      }
      pixLog(`[perf] init end ${Math.round(nowMs() - start)}ms`, runtimeId)
    }

    function clear() {
      resetRunFlow()
      autoRetry.value = null
      followUpMode.value = null
      sessionFile.value = null
      syncedSessionMtime.value = null
      ++mtimeSyncSeq
      invalidateOfflineModels()
      state.value = null
      ++stateRequestVersion
      ++commandRequestVersion
      commands.value = []
    }

    return {
      runtimeId,
      started,
      entries,
      fileChanges: computed(() =>
        mergeArtifactChanges(
          sessionChanges(historyMessages.value, entries.value, partialBlocks.value, runs.value),
          fileChangeArtifacts.value,
        ),
      ),
      fileChangeArtifacts,
      revertedFileChangeCalls,
      markFileRewinds,
      /** 轮次 Git 快照回滚记录（按 turnIndex 关联）。 */
      turnCheckpointRecords: turnCheckpoints.records,
      markTurnReverted: turnCheckpoints.markReverted,
      timelineTurns,
      revealTimelineTurn,
      runs,
      partialBlocks,
      streamingTurnId,
      isStreaming,
      markInterrupted: () => {
        pixLog(`interrupted: streaming=${isStreaming.value}`, runtimeId)
        if (!isStreaming.value) return
        setSessionRunStatus(sessionFile.value, "error")
        // The sidebar badge alone does not explain what happened; leave a
        // visible note in the conversation itself.
        entries.value.push({
          kind: "assistant",
          id: nextId(),
          blocks: [errorBlock(i18n.global.t("chat.processExited"))],
          failed: true,
          live: true,
        })
      },
      markRunning: () => setSessionRunStatus(sessionFile.value, "running"),
      isCompacting,
      compactionError,
      retryInfo,
      dispositionNotice,
      steering,
      followUp,
      followUpMode,
      setFollowUpMode,
      state,
      stats,
      lastUsage,
      commands,
      models,
      desiredModelKey,
      offlineDefaultModelKey,
      desiredThinkingLevel,
      availableThinking,
      cwd,
      sessionFile,
      syncedSessionMtime,
      syncSessionFile,
      syncSessionMtime,
      currentModel,
      thinkingLevel,
      pendingCount,
      promptQueue,
      schedulePrompt,
      removeQueuedPrompt,
      moveQueuedPrompt,
      executeQueuedPrompt,
      dispatchQueuedPrompt,
      handleEvent,
      send,
      abortAndRestore,
      resendPrompt,
      isResending,
      newSession,
      compact,
      setModel,
      setDesiredModel,
      setThinkingLevel,
      setDesiredThinkingLevel,
      autoRetry,
      setAutoRetry,
      setAutoCompaction,
      abortRetry,
      cycleModel,
      cycleThinkingLevel,
      refreshState,
      refreshStats,
      refreshModels,
      refreshCommands,
      loadOfflineModels,
      historyLoading,
      olderHistoryLoading,
      hasOlderHistory,
      loadOlderHistory,
      loadHistory,
      loadMessages,
      init,
      clear,
    }
  })

/** Store instance type for composables and helpers that operate on a session. */
export type SessionStore = ReturnType<ReturnType<typeof createSessionStore>>
