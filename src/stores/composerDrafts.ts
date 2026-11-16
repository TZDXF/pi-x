import { reactive } from "vue"

export interface ComposerDraft {
  /** Unsent text belongs to the project until the conversation gets a file. */
  project: string
  file: string | null
  text: string
  /** Original files survive composer remounts; preview URLs belong to the view. */
  files: File[]
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
      if (
        typeof project !== "string" ||
        !(file === null || typeof file === "string") ||
        typeof text !== "string" ||
        !text
      )
        continue
      drafts.set(file ? fileKey(file) : projectKey(project), { project, file, text, files: [] })
    }
  }
} catch {
  /* Local storage is optional. */
}

function persist() {
  try {
    // Files stay in memory: serializing them would lose their bytes and storing
    // base64 images here would quickly exhaust the text draft storage quota.
    const saved = [...drafts.values()]
      .filter(draft => draft.text)
      .map(({ project, file, text }) => ({ project, file, text }))
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
  } catch {
    /* Keep the in-memory draft if storage is unavailable or full. */
  }
}

export function composerDraftText(project: string, file: string | null): string {
  return (file ? drafts.get(fileKey(file)) : drafts.get(projectKey(project)))?.text ?? ""
}

export function composerDraftFiles(project: string, file: string | null): File[] {
  return [...((file ? drafts.get(fileKey(file)) : drafts.get(projectKey(project)))?.files ?? [])]
}

export function recordComposerDraft(project: string, file: string | null, text: string, files: readonly File[] = []) {
  // Project and saved-session buffers are independent; submitting clears the
  // project buffer through the empty text update before pi creates its file.
  const key = file ? fileKey(file) : projectKey(project)
  if (text || files.length) drafts.set(key, { project, file, text, files: [...files] })
  else drafts.delete(key)
  persist()
}
