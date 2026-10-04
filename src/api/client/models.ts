import { invoke } from "../transport"

/** pi's per-model cost rates (models.json `cost`). pi also accepts extra keys
 *  such as `tiers`, which must survive a round-trip through the editor. */
export interface ModelCostRates {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  [key: string]: unknown
}

/** One server-side fallback model of `compat.allowedFallbackModels`. */
export interface ModelFallbackModel {
  provider: string
  model: string
  cost: ModelCostRates
  [key: string]: unknown
}

/** pi's `compat` object. Known boolean flags have structured UI controls;
 *  the fallback list is typed here, and unknown fields remain lossless through
 *  the advanced JSON editor. */
export interface ModelCompat {
  allowedFallbackModels?: ModelFallbackModel[]
  [key: string]: unknown
}

/** Image resize profile applied before a new image enters history. */
export interface ModelImageResize {
  maxWidth?: number
  maxHeight?: number
  /** Max base64-encoded payload in bytes. */
  maxBytes?: number
  jpegQuality?: number
}

export interface ModelImageInputLimits {
  resize?: ModelImageResize
  maxPerMessage?: number
  maxPerRequest?: number
}

/** pi's `inputLimits`: per model entry and per modelOverrides entry. */
export interface ModelInputLimits {
  maxRequestBytes?: number
  images?: ModelImageInputLimits
}

/** Best-effort prompt cache lifetime in seconds per retention tier. */
export interface ModelPromptCache {
  short?: number
  long?: number
}

/** One model entry inside a provider's `models` array. Unknown fields
 *  (cost, headers, samplingParams, thinkingLevelMap, …) are kept verbatim so
 *  editing never silently drops pi features. */
export interface ModelEntry {
  id: string
  name?: string
  api?: string
  /** Model-level override of the provider `baseUrl`; pi prefers it. */
  baseUrl?: string
  reasoning?: boolean
  input?: ("text" | "image")[]
  inputLimits?: ModelInputLimits
  promptCache?: ModelPromptCache
  compat?: ModelCompat
  contextWindow?: number
  maxTokens?: number
  [key: string]: unknown
}

/** One provider entry under `providers` in models.json. */
export interface ProviderEntry {
  name?: string
  baseUrl?: string
  api?: string
  apiKey?: string
  headers?: Record<string, string>
  compat?: ModelCompat
  models?: ModelEntry[]
  [key: string]: unknown
}

/** pi's `~/.pi/agent/models.json` document. */
export interface ModelsConfig {
  providers: Record<string, ProviderEntry>
  [key: string]: unknown
}

export const getModelsConfig = () => invoke<ModelsConfig>("models_config_get")

export const saveModelsConfig = (config: ModelsConfig) => invoke<void>("models_config_save", { config })

/** Model discovered from a provider's `/models` listing endpoint. */
export interface FetchedModel {
  id: string
  name?: string
}

/** Ask a provider for its advertised model list (OpenAI/Anthropic/Google styles). */
export const fetchProviderModels = (provider: ProviderEntry) => invoke<FetchedModel[]>("models_fetch", { provider })
