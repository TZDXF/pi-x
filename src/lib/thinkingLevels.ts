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

/** How one level is overridden in a models.json thinkingLevelMap. */
export type ThinkingLevelMode = "inherit" | "disabled" | "custom"

/** Read one level's override; a missing entry means the pi default applies. */
export function thinkingLevelMode(map: Record<string, unknown> | undefined, level: ThinkingLevel): ThinkingLevelMode {
  const mapped = map?.[level]
  if (mapped === null) return "disabled"
  if (typeof mapped !== "string") return "inherit"
  return mapped === level ? "inherit" : "custom"
}

/** Provider value for a level, falling back to the level's own name. */
export function thinkingLevelValue(map: Record<string, unknown> | undefined, level: ThinkingLevel): string {
  const mapped = map?.[level]
  return typeof mapped === "string" ? mapped : level
}

/** Immutable update; `undefined` drops the entry so the level inherits again. */
export function withThinkingLevel(
  map: Record<string, unknown> | undefined,
  level: ThinkingLevel,
  value: string | null | undefined,
): Record<string, unknown> {
  const next = { ...(map ?? {}) }
  if (value === undefined) delete next[level]
  else next[level] = value
  return next
}

/** pi only offers the two extra levels once the map names them explicitly. */
export function needsExplicitMapping(level: ThinkingLevel): boolean {
  return level === "xhigh" || level === "max"
}

/**
 * Store a provider mapping for one level. Blank input means "pi default" and
 * drops the override; so does the level's own name, except for the levels pi
 * only enables through an explicit entry.
 */
export function setThinkingMapping(
  map: Record<string, unknown> | undefined,
  level: ThinkingLevel,
  value: string,
): Record<string, unknown> {
  const mapped = value.trim()
  if (!mapped) return withThinkingLevel(map, level, undefined)
  return withThinkingLevel(map, level, mapped === level && !needsExplicitMapping(level) ? undefined : mapped)
}

/**
 * Button-group toggle: unavailable (null) <-> available. Levels pi enables
 * explicitly get a same-name mapping so turning them back on actually works.
 */
export function toggleThinkingLevel(
  map: Record<string, unknown> | undefined,
  level: ThinkingLevel,
): Record<string, unknown> {
  if (thinkingLevelMode(map, level) !== "disabled") return withThinkingLevel(map, level, null)
  return withThinkingLevel(map, level, needsExplicitMapping(level) ? level : undefined)
}
