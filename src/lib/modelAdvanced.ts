import { validateFallbackModels, validateInputLimits, validatePromptCache } from "@/lib/modelLimits"

/** Fields owned by the basic model form, not the advanced JSON editor. */
const basicFields = new Set(["id", "name", "api", "reasoning", "input", "contextWindow", "maxTokens"])
export const compatFlags = [
  "supportsDeveloperRole",
  "supportsStore",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsStrictMode",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
] as const

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

export function modelAdvancedJson(model: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(model).filter(([key]) => !basicFields.has(key))), null, 2)
}

/** Preserve future pi fields, but reject malformed common options before saving. */
export function parseModelAdvanced(raw: string): Record<string, unknown> {
  const value: unknown = JSON.parse(raw.trim() || "{}")
  if (!isObject(value)) throw new Error("JSON: expected an object / 必须是对象")
  for (const key of Object.keys(value)) {
    if (basicFields.has(key)) throw new Error(`${key}: use the basic form / 请使用基础配置`)
  }
  for (const key of ["compat", "headers", "cost", "samplingParams", "thinkingLevelMap", "inputLimits", "promptCache"]) {
    if (key in value && !isObject(value[key])) throw new Error(`${key}: expected an object / 必须是对象`)
  }
  validateInputLimits(value.inputLimits)
  validatePromptCache(value.promptCache)
  if ("baseUrl" in value && (typeof value.baseUrl !== "string" || !value.baseUrl.trim())) {
    throw new Error("baseUrl: expected a non-empty string / 必须是非空字符串")
  }
  if (isObject(value.headers) && Object.values(value.headers).some(v => typeof v !== "string")) {
    throw new Error("headers: values must be strings / 值必须是字符串")
  }
  if (isObject(value.thinkingLevelMap)) {
    for (const [level, mapped] of Object.entries(value.thinkingLevelMap)) {
      if (mapped !== null && typeof mapped !== "string")
        throw new Error(`thinkingLevelMap.${level}: expected a string or null / 必须是字符串或 null`)
    }
  }
  if (isObject(value.compat)) {
    for (const key of compatFlags) {
      if (key in value.compat && typeof value.compat[key] !== "boolean")
        throw new Error(`compat.${key}: expected boolean / 必须是布尔值`)
    }
    if (
      "maxTokensField" in value.compat &&
      !["max_tokens", "max_completion_tokens"].includes(String(value.compat.maxTokensField))
    ) {
      throw new Error("compat.maxTokensField: max_tokens | max_completion_tokens")
    }
    validateFallbackModels(value.compat.allowedFallbackModels)
  }
  return value
}
