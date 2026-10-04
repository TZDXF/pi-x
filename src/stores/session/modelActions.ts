import type { Ref } from "vue"
import { i18n } from "@/i18n"
import type { rpcRequest } from "@/api/piClient"
import type { Model, SessionState, ThinkingLevel } from "@/api/protocol"

interface ModelActionsContext {
  rpcRequest: typeof rpcRequest
  state: Ref<SessionState | null>
  /** Only a started worker records a pending model change for the next entry. */
  started: Ref<boolean>
  /** Model switch to annotate the next user entry with, consumed by send(). */
  pendingModelChange: Ref<{ from: string; to: string } | null>
  desiredModelKey: Ref<string | null>
  desiredThinkingLevel: Ref<ThinkingLevel | null>
  rpcThinkingLevels: Ref<ThinkingLevel[]>
  remember(model?: Model, thinking?: ThinkingLevel, levels?: ThinkingLevel[]): void
  syncSessionFile(): Promise<void>
  refreshState(): Promise<void>
  refreshThinkingLevels(): Promise<void>
}

/** set_model / set_thinking_level / cycle_model / cycle_thinking_level: the
 *  two shared switch implementations plus their four thin shells. */
export function createModelActions(context: ModelActionsContext) {
  const {
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
  } = context

  /** Shared body of set_model / cycle_model: refresh the runtime view and
   *  remember the switch. `requireModel` (cycle_model) treats a null data
   *  model as "nothing to switch to" and reports false. */
  async function applyModelSwitch(
    command: Record<string, unknown>,
    opts?: { recordChange?: boolean; requireModel?: boolean },
  ): Promise<boolean> {
    const previous =
      pendingModelChange.value?.from ?? (state.value?.model && `${state.value.model.provider}/${state.value.model.id}`)
    const result = await rpcRequest<{ model: Model | null }>(command)
    if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.modelSwitch"))
    if (opts?.requireModel && !result.data?.model) return false
    desiredModelKey.value = null
    // Pi appends a model_change entry to the session file. Mark this as our
    // own write before the file watcher can mistake it for an external edit
    // and restart the worker while the picker is still refreshing.
    await syncSessionFile()
    await refreshState()
    await refreshThinkingLevels()
    if (state.value?.model) {
      const current = `${state.value.model.provider}/${state.value.model.id}`
      if ((opts?.recordChange ?? true) && started.value && previous)
        pendingModelChange.value = previous === current ? null : { from: previous, to: current }
      remember(state.value.model, state.value.thinkingLevel, rpcThinkingLevels.value)
    }
    return true
  }

  async function setModel(provider: string, modelId: string, recordChange = true) {
    await applyModelSwitch({ type: "set_model", provider, modelId }, { recordChange })
  }

  async function setThinkingLevel(level: ThinkingLevel) {
    await applyThinkingSwitch({ type: "set_thinking_level", level }, { fallbackLevel: level })
  }

  /** cycle_model: switch to the next available model. Returns false when no
   *  other model is configured (pi answers success with null data). */
  async function cycleModel(): Promise<boolean> {
    return applyModelSwitch({ type: "cycle_model" }, { requireModel: true })
  }

  /** Shared body of set_thinking_level / cycle_thinking_level. `requireLevel`
   *  (cycle_thinking_level) treats a null data level as "the model does not
   *  support thinking" and reports false. */
  async function applyThinkingSwitch(
    command: Record<string, unknown>,
    opts?: { requireLevel?: boolean; fallbackLevel?: ThinkingLevel },
  ): Promise<boolean> {
    const result = await rpcRequest<{ level: ThinkingLevel | null }>(command)
    if (!result.success) throw new Error(result.error || i18n.global.t("chat.errors.thinkingSwitch"))
    if (opts?.requireLevel && !result.data?.level) return false
    desiredThinkingLevel.value = null
    // Changing thinking level also appends to the session log.
    await syncSessionFile()
    await refreshState()
    await refreshThinkingLevels()
    remember(
      state.value?.model ?? undefined,
      state.value?.thinkingLevel ?? result.data?.level ?? opts?.fallbackLevel,
      rpcThinkingLevels.value,
    )
    return true
  }

  /** cycle_thinking_level: next thinking level of the current model. Returns
   *  false when the model does not support thinking (pi answers success with
   *  null data). */
  async function cycleThinkingLevel(): Promise<boolean> {
    return applyThinkingSwitch({ type: "cycle_thinking_level" }, { requireLevel: true })
  }

  return { applyModelSwitch, setModel, setThinkingLevel, cycleModel, applyThinkingSwitch, cycleThinkingLevel }
}
