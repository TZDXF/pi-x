import type { ThinkingLevel } from "@/api/protocol"

export const ALL_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]

/** pi's getSupportedThinkingLevels: derive levels from a models.json entry. */
export function supportedThinkingLevels(model: { reasoning?: boolean; thinkingLevelMap?: unknown }): ThinkingLevel[] {
  if (!model.reasoning) return ["off"]
  const map = (model.thinkingLevelMap ?? {}) as Record<string, unknown>
  return ALL_THINKING_LEVELS.filter(level => {
    const mapped = map[level]
    if (mapped === null) return false
    if (level === "xhigh" || level === "max") return mapped !== undefined
    return true
  })
}

/** pi's clampThinkingLevel: nearest available level, upward first. */
export function clampThinkingLevel(level: ThinkingLevel, available: ThinkingLevel[]): ThinkingLevel {
  if (available.includes(level)) return level
  const idx = ALL_THINKING_LEVELS.indexOf(level)
  if (idx === -1) return available[0] ?? "off"
  for (let i = idx; i < ALL_THINKING_LEVELS.length; i++)
    if (available.includes(ALL_THINKING_LEVELS[i])) return ALL_THINKING_LEVELS[i]
  for (let i = idx - 1; i >= 0; i--) if (available.includes(ALL_THINKING_LEVELS[i])) return ALL_THINKING_LEVELS[i]
  return available[0] ?? "off"
}
