import { reactive } from "vue"

export interface ComposerDraft {
  /** Unsent text belongs to the project until the conversation gets a file. */
  project: string
  file: string | null
  text: string
}

const STORAGE_KEY = "pix.composerDrafts"
const drafts = reactive(new Map<string, ComposerDraft>())
const fileKey = (file: string) => `file:${file.replace(/[\\/]/g, "/")}`
const projectKey = (project: string) => `project:${project.replace(/[\\/]/g, "/")}`

try {
  const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]")
  if (Array.isArray(stored)) {
    for (const item of stored) {
      if (!item || typeof item !== "object") continue
      const { project, file, text } = item as Partial<ComposerDraft>
      if (typeof project !== "string" || !(file === null || typeof file === "string") ||
          typeof text !== "string" || !text) continue
      drafts.set(file ? fileKey(file) : projectKey(project), { project, file, text })
    }
  }
} catch { /* Local storage is optional. */ }

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...drafts.values()])) }
  catch { /* Keep the in-memory draft if storage is unavailable or full. */ }
}

export function composerDraftText(project: string, file: string | null): string {
  return (file ? drafts.get(fileKey(file)) : drafts.get(projectKey(project)))?.text ?? ""
}

export function recordComposerDraft(project: string, file: string | null, text: string) {
  // Project and saved-session buffers are independent; submitting clears the
  // project buffer through the empty text update before pi creates its file.
  const key = file ? fileKey(file) : projectKey(project)
  if (text) drafts.set(key, { project, file, text })
  else drafts.delete(key)
  persist()
}
