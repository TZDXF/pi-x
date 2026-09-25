/** Conversion between a ModelEntry and its editable form representation.
 *  Numeric fields stay as strings while typing; `advanced` holds every
 *  non-basic field as JSON, including unknown pi options. */
import { modelAdvancedJson, parseModelAdvanced } from "@/lib/modelAdvanced"
import type { ModelEntry } from "@/api/piClient"

export interface ModelForm {
  advanced: string
  id: string
  name: string
  api: string
  reasoning: boolean
  image: boolean
  contextWindow: string
  maxTokens: string
}

export function emptyModelForm(): ModelForm {
  return {
    advanced: "{}",
    id: "",
    name: "",
    api: "",
    reasoning: false,
    image: true,
    contextWindow: "",
    maxTokens: "",
  }
}

export function modelFormFromEntry(m: ModelEntry): ModelForm {
  return {
    advanced: modelAdvancedJson(m),
    id: m.id,
    name: m.name ?? "",
    api: m.api ?? "",
    reasoning: m.reasoning === true,
    image: (m.input ?? ["text"]).includes("image"),
    contextWindow: m.contextWindow != null ? String(m.contextWindow) : "",
    maxTokens: m.maxTokens != null ? String(m.maxTokens) : "",
  }
}

export function parseSize(raw: string): number | null {
  const v = raw.trim()
  if (!v) return null
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null
}

/** Build the stored entry from the form; `id` is the already-validated id. */
export function modelEntryFromForm(f: ModelForm, id: string): ModelEntry {
  // Advanced JSON contains every non-basic field, including unknown pi options.
  const entry = { ...parseModelAdvanced(f.advanced) } as ModelEntry
  entry.id = id
  if (f.name.trim()) entry.name = f.name.trim()
  else delete entry.name
  if (f.api) entry.api = f.api
  else delete entry.api
  entry.reasoning = f.reasoning
  entry.input = f.image ? ["text", "image"] : ["text"]
  const ctx = parseSize(f.contextWindow)
  if (ctx != null) entry.contextWindow = ctx
  else delete entry.contextWindow
  const max = parseSize(f.maxTokens)
  if (max != null) entry.maxTokens = max
  else delete entry.maxTokens
  return entry
}