import { computed, ref, type Ref } from "vue"
import { getModelsConfig, getPiSettings } from "@/api/piClient"
import type { Model, SessionState, ThinkingLevel } from "@/api/protocol"
import { ALL_THINKING_LEVELS, supportedThinkingLevels, clampThinkingLevel } from "@/lib/thinkingLevels"

/** pi's DEFAULT_THINKING_LEVEL (core/defaults.js). */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium"

const SELECTION_KEY = "pix.conversationSelection"
interface RememberedSelection {
  model?: Model
  thinking?: ThinkingLevel
  levels?: ThinkingLevel[]
}
// Cache display metadata only, never provider headers or credentials from RPC models.
function selectionModel(model: Model): Model {
  return {
    id: model.id,
    provider: model.provider,
    name: model.name || model.id,
    reasoning: model.reasoning === true,
    api: "",
    baseUrl: "",
    input: [],
    contextWindow: 0,
    maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }
}
function readSelection(): RememberedSelection {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_KEY) || "{}")
    if (!value || typeof value !== "object") return {}
    return {
      model:
        typeof value.model?.provider === "string" && typeof value.model?.id === "string"
          ? selectionModel(value.model)
          : undefined,
      thinking: ALL_THINKING_LEVELS.includes(value.thinking) ? value.thinking : undefined,
      levels: Array.isArray(value.levels)
        ? value.levels.filter((v: ThinkingLevel) => ALL_THINKING_LEVELS.includes(v))
        : undefined,
    }
  } catch {
    return {}
  }
}

/** Offline picker preferences contain display metadata only, never provider secrets. */
export function createModelSelection(state: Ref<SessionState | null>, models: Ref<Model[]>) {
  /** Explicit pre-start model choice, consumed once by init. */
  const remembered = ref<RememberedSelection>(readSelection())
  const desiredModelKey = ref<string | null>(null)
  const piDefaultModelKey = ref<string | null>(null)
  const offlineDefaultModelKey = computed(() =>
    remembered.value.model
      ? `${remembered.value.model.provider}/${remembered.value.model.id}`
      : piDefaultModelKey.value,
  )
  const offlineDefaultThinking = ref<ThinkingLevel | null>(null)
  const rpcThinkingLevels = ref<ThinkingLevel[]>(["off"])
  /** Per-model thinking levels derived from models.json while pi is down. */
  const offlineThinkingLevels = ref<Record<string, ThinkingLevel[]>>({})
  /** Explicit pre-start thinking choice, consumed once by init. */
  const desiredThinkingLevel = ref<ThinkingLevel | null>(null)

  if (remembered.value.model) models.value = [remembered.value.model]
  let offlineLoadVersion = 0

  function remember(model?: Model, thinking?: ThinkingLevel, levels?: ThinkingLevel[]) {
    remembered.value = {
      ...remembered.value,
      ...(model ? { model: selectionModel(model) } : {}),
      ...(thinking ? { thinking } : {}),
      ...(levels ? { levels } : {}),
    }
    try {
      localStorage.setItem(SELECTION_KEY, JSON.stringify(remembered.value))
    } catch {
      /* Optional UI preference. */
    }
  }

  const currentModel = computed(() => state.value?.model ?? null)
  /** RPC levels once pi runs; config-derived levels (of the desired model) before. */
  const availableThinking = computed<ThinkingLevel[]>(() => {
    if (state.value) return rpcThinkingLevels.value
    const key = desiredModelKey.value ?? offlineDefaultModelKey.value
    const saved = remembered.value.model
    if (saved && key === `${saved.provider}/${saved.id}` && remembered.value.levels?.length)
      return remembered.value.levels
    return (key && offlineThinkingLevels.value[key]) || ["off"]
  })
  const thinkingLevel = computed<ThinkingLevel>(() => {
    if (state.value)
      return clampThinkingLevel(
        state.value.thinkingLevel ?? remembered.value.thinking ?? DEFAULT_THINKING_LEVEL,
        availableThinking.value,
      )
    return clampThinkingLevel(
      desiredThinkingLevel.value ?? remembered.value.thinking ?? offlineDefaultThinking.value ?? DEFAULT_THINKING_LEVEL,
      availableThinking.value,
    )
  })
  /** Record a model choice made while pi is not running; applied on init. */
  function setDesiredModel(key: string | null) {
    desiredModelKey.value = key
    const model = models.value.find(m => `${m.provider}/${m.id}` === key)
    if (model) remember(model, undefined, supportedThinkingLevels(model))
  }

  /** Record a thinking level picked while pi is not running; applied on init. */
  function setDesiredThinkingLevel(level: ThinkingLevel) {
    desiredThinkingLevel.value = level
    remember(undefined, level)
  }

  /** Fill the model picker from ~/.pi/agent/models.json while pi is down. */
  async function loadOfflineModels() {
    const version = ++offlineLoadVersion
    try {
      const [config, settings] = await Promise.all([getModelsConfig(), getPiSettings()])
      const offline: Model[] = []
      const levels: Record<string, ThinkingLevel[]> = {}
      for (const [provider, entry] of Object.entries(config.providers ?? {})) {
        for (const m of entry.models ?? []) {
          offline.push({
            id: m.id,
            name: m.name ?? m.id,
            api: m.api ?? entry.api ?? "",
            provider,
            baseUrl: m.baseUrl ?? entry.baseUrl ?? "",
            reasoning: m.reasoning ?? false,
            thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> | undefined,
            input: m.input ?? ["text"],
            contextWindow: m.contextWindow ?? 0,
            maxTokens: m.maxTokens ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          })
          levels[`${provider}/${m.id}`] = supportedThinkingLevels(m)
        }
      }
      if (version !== offlineLoadVersion || state.value) return
      const saved = remembered.value.model
      if (saved && !offline.some(m => m.provider === saved.provider && m.id === saved.id)) offline.unshift(saved)
      models.value = offline
      offlineThinkingLevels.value = levels
      piDefaultModelKey.value =
        settings.defaultProvider && settings.defaultModel
          ? `${settings.defaultProvider}/${settings.defaultModel}`
          : offline[0]
            ? `${offline[0].provider}/${offline[0].id}`
            : null
      const key = desiredModelKey.value ?? offlineDefaultModelKey.value
      offlineDefaultThinking.value =
        (key && settings.modelThinkingLevels?.[key]) || settings.defaultThinkingLevel || null
    } catch (e) {
      console.warn("[pi] failed to load offline models:", e)
    }
  }

  function invalidateOfflineModels() {
    ++offlineLoadVersion
  }
  return {
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
  }
}
