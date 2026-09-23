import { defineStore } from "pinia"
import { ref } from "vue"
import { listSessions, updateSession, type SessionMeta } from "@/api/piClient"

/** Registered by the app shell so metadata writes (rename/archive) can record
 *  the resulting mtime; lets the session watcher tell its own writes from
 *  external ones without importing the conversation stores (cycle). */
let sessionMtimeSync: ((file: string, mtimeMs: number) => void) | null = null
export function registerSessionMtimeSync(sync: (file: string, mtimeMs: number) => void) {
  sessionMtimeSync = sync
}
function notifySessionMtimeSync(file: string, mtimeMs: number) {
  sessionMtimeSync?.(file, mtimeMs)
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const gitBusy = ref(false)
  const projects = ref<string[]>([])
  const pinnedProjects = ref<string[]>([])
  const histories = ref<Record<string, SessionMeta[]>>({})
  const sessionOrder = ref<Record<string, string[]>>({})
  const pending = new Map<string, SessionMeta>()
  const versions: Record<string, number> = {}
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.recentProjects") || "[]")
    if (Array.isArray(stored)) projects.value = stored.filter((p): p is string => typeof p === "string")
  } catch { /* Optional storage. */ }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.pinnedProjects") || "[]")
    if (Array.isArray(stored)) pinnedProjects.value = stored.filter((p): p is string => typeof p === "string" && projects.value.includes(p))
  } catch { /* Optional storage. */ }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.sessionOrder") || "{}")
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [path, files] of Object.entries(stored)) {
        if (Array.isArray(files)) sessionOrder.value[path] = files.filter((f): f is string => typeof f === "string")
      }
    }
  } catch { /* Optional storage. */ }
  function persistProjects() {
    try {
      localStorage.setItem("pix.recentProjects", JSON.stringify(projects.value))
      localStorage.setItem("pix.pinnedProjects", JSON.stringify(pinnedProjects.value))
    } catch { /* Optional storage. */ }
  }
  function persistSessionOrder() {
    try {
      localStorage.setItem("pix.sessionOrder", JSON.stringify(sessionOrder.value))
    } catch { /* Optional storage. */ }
  }
  function orderedProjects() {
    return [...projects.value].sort((a, b) => Number(pinnedProjects.value.includes(b)) - Number(pinnedProjects.value.includes(a)))
  }
  /** Persist a manual project ordering. Pinned projects still stay on top. */
  function reorderProjects(ordered: string[]) {
    const seen = new Set(ordered)
    projects.value = [...ordered, ...projects.value.filter(p => !seen.has(p))]
    persistProjects()
  }
  function applySessionOrder(path: string) {
    const rows = histories.value[path]
    if (!rows) return
    const order = (sessionOrder.value[path] || []).filter(f => rows.some(r => r.file === f))
    sessionOrder.value[path] = order
    const index = new Map(order.map((f, i) => [f, i]))
    histories.value[path] = [...rows].sort((a, b) => {
      const ia = index.get(a.file) ?? Number.MAX_SAFE_INTEGER
      const ib = index.get(b.file) ?? Number.MAX_SAFE_INTEGER
      return ia - ib || b.mtimeMs - a.mtimeMs
    })
  }
  /** Persist a manual ordering for the given sessions of a project. */
  function reorderSessions(path: string, orderedFiles: string[]) {
    const rest = (sessionOrder.value[path] || []).filter(f => !orderedFiles.includes(f))
    sessionOrder.value[path] = [...orderedFiles, ...rest]
    applySessionOrder(path)
    persistSessionOrder()
  }
  function togglePin(path: string) {
    if (!projects.value.includes(path)) return
    pinnedProjects.value = pinnedProjects.value.includes(path)
      ? pinnedProjects.value.filter(p => p !== path) : [...pinnedProjects.value, path]
    persistProjects()
  }
  function removeProject(path: string) {
    projects.value = projects.value.filter(p => p !== path)
    pinnedProjects.value = pinnedProjects.value.filter(p => p !== path)
    delete sessionOrder.value[path]
    versions[path] = (versions[path] || 0) + 1
    delete histories.value[path]
    for (const [file, row] of pending) if (row.cwd === path) pending.delete(file)
    persistProjects()
    persistSessionOrder()
  }
  function remember(path: string) {
    if (!path) return
    if (!projects.value.includes(path)) projects.value = [path, ...projects.value]
    persistProjects()
  }
  async function refresh(path: string) {
    const version = versions[path] = (versions[path] || 0) + 1
    const rows = await listSessions(path)
    if (versions[path] === version) {
      for (const row of rows) pending.delete(row.file)
      const previews = [...pending.values()].filter(row => row.cwd === path)
      histories.value[path] = [...rows, ...previews].sort((a, b) => b.mtimeMs - a.mtimeMs)
      applySessionOrder(path)
    }
  }
  // pi does not flush a new session to disk until its first assistant response.
  function preview(row: SessionMeta) {
    const rows = histories.value[row.cwd] ?? []
    if (rows.some(s => s.file === row.file)) return
    pending.set(row.file, row)
    histories.value[row.cwd] = [row, ...rows]
  }
  function generatedTitle(file: string, title: string) {
    for (const rows of Object.values(histories.value)) {
      const row = rows.find(s => s.file === file)
      if (row && !row.title) row.title = title
    }
    const draft = pending.get(file)
    if (draft && !draft.title) draft.title = title
  }
  /** Lets the app shell record the mtime of metadata writes (rename/archive)
   *  so the session watcher can tell its own writes from external ones. */
  async function update(row: SessionMeta, title: string | null, archived: boolean) {
    const mtime = await updateSession(row.file, title, archived)
    if (typeof mtime === "number") notifySessionMtimeSync(row.file, mtime)
    for (const [path, rows] of Object.entries(histories.value)) {
      const match = rows.find(s => s.file === row.file)
      if (match) {
        versions[path] = (versions[path] || 0) + 1
        Object.assign(match, { title, archived })
      }
    }
  }
  /** Drop a deleted session from every cached history so the sidebar stays in sync. */
  function removeSession(file: string) {
    pending.delete(file)
    for (const [path, rows] of Object.entries(histories.value)) {
      const next = rows.filter(s => s.file !== file)
      if (next.length !== rows.length) {
        versions[path] = (versions[path] || 0) + 1
        histories.value[path] = next
      }
    }
  }
  return { gitBusy, projects, pinnedProjects, orderedProjects, reorderProjects, togglePin, removeProject, histories, reorderSessions, remember, refresh, update, removeSession, preview, generatedTitle }
})
