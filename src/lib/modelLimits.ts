/** Structured editing of the model fields pi added in 0.85+: `inputLimits`,
 *  `promptCache` and `compat.allowedFallbackModels`. They live in the advanced
 *  JSON next to unknown pi options, so every setter copies the object it was
 *  given and touches only its own keys. Readers stay lenient (a malformed
 *  value blanks the form and is reported by `parseModelAdvanced`); writers and
 *  validators throw a `ModelFieldError` the panel renders through i18n. */
import type { ModelCostRates, ModelFallbackModel, ModelInputLimits, ModelPromptCache } from "@/api/piClient"

/** Error codes, rendered as `settings.modelFieldErrors.<code>`. */
export const modelFieldErrors = {
  notJson: "notJson",
  notObject: "notObject",
  notArray: "notArray",
  notPositiveInteger: "notPositiveInteger",
  notSeconds: "notSeconds",
  notQuality: "notQuality",
  notNumber: "notNumber",
  emptyString: "emptyString",
  tooManyItems: "tooManyItems",
} as const
export type ModelFieldErrorCode = (typeof modelFieldErrors)[keyof typeof modelFieldErrors]

export class ModelFieldError extends Error {
  readonly code: ModelFieldErrorCode
  /** Dotted models.json path of the offending value. */
  readonly path: string
  constructor(code: ModelFieldErrorCode, path: string) {
    super(`${path}: ${code}`)
    this.name = "ModelFieldError"
    this.code = code
    this.path = path
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
/** A pi byte/pixel/count limit: a positive integer. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}
/** A cache lifetime in seconds. pi's schema is `exclusiveMinimum: 0`, so 0 is
 *  not a lifetime; an omitted field is what disables cache warming for a tier. */
function isSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}
function isRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}
function text(value: unknown): string {
  return typeof value === "number" ? String(value) : ""
}
/** Parse a form field, or return undefined when the field is left blank. */
function readInt(raw: string): number | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : Number.NaN
}
function readRates(value: unknown, path: string): ModelCostRates {
  if (!isObject(value)) throw new ModelFieldError("notObject", path)
  const rates = { ...value } as ModelCostRates
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const rate = value[key]
    if (!isRate(rate)) throw new ModelFieldError("notNumber", `${path}.${key}`)
    rates[key] = rate
  }
  return rates
}

export interface InputLimitsForm {
  maxRequestBytes: string
  maxWidth: string
  maxHeight: string
  maxBytes: string
  jpegQuality: string
  maxPerMessage: string
  maxPerRequest: string
}

export function emptyInputLimitsForm(): InputLimitsForm {
  return {
    maxRequestBytes: "",
    maxWidth: "",
    maxHeight: "",
    maxBytes: "",
    jpegQuality: "",
    maxPerMessage: "",
    maxPerRequest: "",
  }
}

/** Fill the form from a models.json object; blank means "pi's default". */
export function inputLimitsForm(model: Record<string, unknown>): InputLimitsForm {
  const limits = isObject(model.inputLimits) ? model.inputLimits : {}
  const images = isObject(limits.images) ? limits.images : {}
  const resize = isObject(images.resize) ? images.resize : {}
  return {
    maxRequestBytes: text(limits.maxRequestBytes),
    maxWidth: text(resize.maxWidth),
    maxHeight: text(resize.maxHeight),
    maxBytes: text(resize.maxBytes),
    jpegQuality: text(resize.jpegQuality),
    maxPerMessage: text(images.maxPerMessage),
    maxPerRequest: text(images.maxPerRequest),
  }
}

function setCount(target: Record<string, unknown>, key: string, raw: string, path: string) {
  const value = readInt(raw)
  if (value === undefined) return
  if (!isCount(value)) throw new ModelFieldError("notPositiveInteger", path)
  target[key] = value
}
function setQuality(target: Record<string, unknown>, key: string, raw: string, path: string) {
  const value = readInt(raw)
  if (value === undefined) return
  if (!isCount(value) || value > 100) throw new ModelFieldError("notQuality", path)
  target[key] = value
}
function setSeconds(target: Record<string, unknown>, key: string, raw: string, path: string) {
  const value = readInt(raw)
  if (value === undefined) return
  if (!isSeconds(value)) throw new ModelFieldError("notSeconds", path)
  target[key] = value
}

/** Merge the form into a copy of `model`, dropping limits the user cleared. */
export function withInputLimits(model: Record<string, unknown>, form: InputLimitsForm): Record<string, unknown> {
  const next = { ...model }
  const limits: Record<string, unknown> = {}
  const images: Record<string, unknown> = {}
  const resize: Record<string, unknown> = {}
  setCount(limits, "maxRequestBytes", form.maxRequestBytes, "inputLimits.maxRequestBytes")
  setCount(images, "maxPerMessage", form.maxPerMessage, "inputLimits.images.maxPerMessage")
  setCount(images, "maxPerRequest", form.maxPerRequest, "inputLimits.images.maxPerRequest")
  setCount(resize, "maxWidth", form.maxWidth, "inputLimits.images.resize.maxWidth")
  setCount(resize, "maxHeight", form.maxHeight, "inputLimits.images.resize.maxHeight")
  setCount(resize, "maxBytes", form.maxBytes, "inputLimits.images.resize.maxBytes")
  setQuality(resize, "jpegQuality", form.jpegQuality, "inputLimits.images.resize.jpegQuality")
  if (Object.keys(resize).length) images.resize = resize
  if (Object.keys(images).length) limits.images = images
  if (Object.keys(limits).length) next.inputLimits = limits
  else delete next.inputLimits
  return next
}

/** Reject a hand-edited `inputLimits` that pi would not accept. */
export function validateInputLimits(value: unknown): ModelInputLimits | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new ModelFieldError("notObject", "inputLimits")
  if (value.maxRequestBytes !== undefined && !isCount(value.maxRequestBytes))
    throw new ModelFieldError("notPositiveInteger", "inputLimits.maxRequestBytes")
  if (value.images !== undefined) {
    if (!isObject(value.images)) throw new ModelFieldError("notObject", "inputLimits.images")
    for (const key of ["maxPerMessage", "maxPerRequest"] as const) {
      const limit = value.images[key]
      if (limit !== undefined && !isCount(limit))
        throw new ModelFieldError("notPositiveInteger", `inputLimits.images.${key}`)
    }
    if (value.images.resize !== undefined) {
      if (!isObject(value.images.resize)) throw new ModelFieldError("notObject", "inputLimits.images.resize")
      for (const key of ["maxWidth", "maxHeight", "maxBytes"] as const) {
        const limit = value.images.resize[key]
        if (limit !== undefined && !isCount(limit))
          throw new ModelFieldError("notPositiveInteger", `inputLimits.images.resize.${key}`)
      }
      const quality = value.images.resize.jpegQuality
      if (quality !== undefined && (!isCount(quality) || quality > 100))
        throw new ModelFieldError("notQuality", "inputLimits.images.resize.jpegQuality")
    }
  }
  return value as ModelInputLimits
}

export interface PromptCacheForm {
  short: string
  long: string
}

export function emptyPromptCacheForm(): PromptCacheForm {
  return { short: "", long: "" }
}

export function promptCacheForm(model: Record<string, unknown>): PromptCacheForm {
  const cache = isObject(model.promptCache) ? model.promptCache : {}
  return { short: text(cache.short), long: text(cache.long) }
}

export function withPromptCache(model: Record<string, unknown>, form: PromptCacheForm): Record<string, unknown> {
  const next = { ...model }
  const cache: Record<string, unknown> = {}
  setSeconds(cache, "short", form.short, "promptCache.short")
  setSeconds(cache, "long", form.long, "promptCache.long")
  if (Object.keys(cache).length) next.promptCache = cache
  else delete next.promptCache
  return next
}

export function validatePromptCache(value: unknown): ModelPromptCache | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new ModelFieldError("notObject", "promptCache")
  for (const key of ["short", "long"] as const) {
    const seconds = value[key]
    if (seconds !== undefined && !isSeconds(seconds)) throw new ModelFieldError("notSeconds", `promptCache.${key}`)
  }
  return value as ModelPromptCache
}

/** The `compat.allowedFallbackModels` array as JSON for the editor. */
export function fallbackModelsJson(model: Record<string, unknown>): string {
  const compat = isObject(model.compat) ? model.compat : {}
  const models = Array.isArray(compat.allowedFallbackModels) ? compat.allowedFallbackModels : []
  return JSON.stringify(models, null, 2)
}

function validateFallbackModel(value: unknown, path: string): ModelFallbackModel {
  if (!isObject(value)) throw new ModelFieldError("notObject", path)
  for (const key of ["provider", "model"] as const) {
    if (typeof value[key] !== "string" || !value[key].trim()) throw new ModelFieldError("emptyString", `${path}.${key}`)
  }
  const next = { ...value } as Record<string, unknown>
  next.provider = String(value.provider).trim()
  next.model = String(value.model).trim()
  next.cost = readRates(value.cost, `${path}.cost`)
  return next as ModelFallbackModel
}

/** pi's schema caps `allowedFallbackModels` at 3 entries; exceeding it makes pi
 *  reject the whole models.json, so the editor must reject it first. */
const MAX_FALLBACK_MODELS = 3

/** Validate the fallback list; returns a normalized copy or throws. */
export function validateFallbackModels(value: unknown): ModelFallbackModel[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new ModelFieldError("notArray", "compat.allowedFallbackModels")
  if (value.length > MAX_FALLBACK_MODELS) throw new ModelFieldError("tooManyItems", "compat.allowedFallbackModels")
  return value.map((entry, index) => validateFallbackModel(entry, `compat.allowedFallbackModels[${index}]`))
}

/** Parse the editor's JSON text; blank text clears the list. */
export function parseFallbackModels(raw: string): ModelFallbackModel[] {
  const trimmed = raw.trim()
  if (!trimmed || trimmed === "[]") return []
  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    throw new ModelFieldError("notJson", "compat.allowedFallbackModels")
  }
  return validateFallbackModels(value) ?? []
}

export function withFallbackModels(
  model: Record<string, unknown>,
  fallbacks: ModelFallbackModel[],
): Record<string, unknown> {
  const next = { ...model }
  const compat = { ...(isObject(model.compat) ? model.compat : {}) }
  if (fallbacks.length) compat.allowedFallbackModels = fallbacks
  else delete compat.allowedFallbackModels
  if (Object.keys(compat).length) next.compat = compat
  else delete next.compat
  return next
}
