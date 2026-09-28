/** Shared scoring helpers for locating a settings menu from localized text. */
export function settingsSearchText(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  return Object.values(value).map(settingsSearchText).join(" ")
}

function searchTerms(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

export function matchesSettingsSearch(query: string, text: string): boolean {
  const terms = searchTerms(query)
  const normalized = text.toLocaleLowerCase()
  return terms.length > 0 && terms.every(term => normalized.includes(term))
}

export interface SettingsSearchFields {
  /** Menu title; receives the highest weight. */
  title: string
  /** Parent settings tab title. */
  category: string
  /** Raw i18n key, retained so English keys are also searchable. */
  key?: string
  /** Localized options and descriptions used as low-weight fallback text. */
  details?: string
}

export interface SettingsSearchScore {
  score: number
  /** Context shown when only fallback text matched. */
  snippet: string
}

const FIELD_WEIGHTS = { title: 100, category: 20, key: 10, details: 1 } as const
const SNIPPET_RADIUS = 24

/** Return a compact context around the first matching term, or an empty string. */
export function searchSnippet(text: string, query: string): string {
  const terms = searchTerms(query)
  if (!terms.length) return ""
  const compact = text.replace(/\s+/g, " ").trim()
  const normalized = compact.toLocaleLowerCase()
  let first = -1
  let termLength = 0
  for (const term of terms) {
    const index = normalized.indexOf(term)
    if (index >= 0 && (first < 0 || index < first)) {
      first = index
      termLength = term.length
    }
  }
  if (first < 0) return ""
  const start = Math.max(0, first - SNIPPET_RADIUS)
  const end = Math.min(compact.length, first + termLength + SNIPPET_RADIUS)
  return `${start > 0 ? "…" : ""}${compact.slice(start, end)}${end < compact.length ? "…" : ""}`
}

/**
 * Score by field strength: title > category > i18n key > details.
 * Every query term must match; each term contributes its strongest matching field.
 */
export function scoreSettingsSearch(query: string, fields: SettingsSearchFields): SettingsSearchScore | null {
  const terms = searchTerms(query)
  if (!terms.length) return null
  const normalized = {
    title: fields.title.toLocaleLowerCase(),
    category: fields.category.toLocaleLowerCase(),
    key: (fields.key ?? "").toLocaleLowerCase(),
    details: (fields.details ?? "").toLocaleLowerCase(),
  }
  let score = 0
  let detailOnly = false
  for (const term of terms) {
    let termScore = 0
    if (normalized.title.includes(term)) termScore = FIELD_WEIGHTS.title
    else if (normalized.category.includes(term)) termScore = FIELD_WEIGHTS.category
    else if (normalized.key.includes(term)) termScore = FIELD_WEIGHTS.key
    else if (normalized.details.includes(term)) {
      termScore = FIELD_WEIGHTS.details
      detailOnly = true
    }
    if (!termScore) return null
    score += termScore
  }
  return {
    score,
    snippet: detailOnly ? searchSnippet(fields.details ?? "", query) : "",
  }
}
