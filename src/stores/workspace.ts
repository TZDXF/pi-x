import { defineStore } from "pinia"
import { ref } from "vue"
import { listSessions, updateSession, type SessionMeta } from "@/api/piClient"

export const useWorkspaceStore = defineStore("workspace", () => {
  const gitBusy = ref(false)
  const projects = ref<string[]>([])
  const pinnedProjects = ref<string[]>([])
  const histories = ref<Record<string, SessionMeta[]>>({})
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
  function persistProjects() {
    try {
      localStorage.setItem("pix.recentProjects", JSON.stringify(projects.value))
      localStorage.setItem("pix.pinnedProjects", JSON.stringify(pinnedProjects.value))
    } catch { /* Optional storage. */ }
  }
  function orderedProjects() {
    return [...projects.value].sort((a, b) => Number(pinnedProjects.value.includes(b)) - Number(pinnedProjects.value.includes(a)))
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
    versions[path] = (versions[path] || 0) + 1
    delete histories.value[path]
    for (const [file, row] of pending) if (row.cwd === path) pending.delete(file)
    persistProjects()
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
  async function update(row: SessionMeta, title: string | null, archived: boolean) {
    await updateSession(row.file, title, archived)
    for (const [path, rows] of Object.entries(histories.value)) {
      const match = rows.find(s => s.file === row.file)
      if (match) {
        versions[path] = (versions[path] || 0) + 1
        Object.assign(match, { title, archived })
      }
    }
  }
  return { gitBusy, projects, pinnedProjects, orderedProjects, togglePin, removeProject, histories, remember, refresh, update, preview, generatedTitle }
})
