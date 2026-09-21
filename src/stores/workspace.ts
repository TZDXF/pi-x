import { defineStore } from "pinia"
import { ref } from "vue"
import { listSessions, updateSession, type SessionMeta } from "@/api/piClient"

export const useWorkspaceStore = defineStore("workspace", () => {
  const gitBusy = ref(false)
  const projects = ref<string[]>([])
  const histories = ref<Record<string, SessionMeta[]>>({})
  const pending = new Map<string, SessionMeta>()
  const versions: Record<string, number> = {}
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.recentProjects") || "[]")
    if (Array.isArray(stored)) projects.value = stored.filter((p): p is string => typeof p === "string").slice(0, 8)
  } catch { /* Optional storage. */ }
  function remember(path: string) {
    if (!path) return
    if (!projects.value.includes(path)) projects.value = [path, ...projects.value].slice(0, 8)
    try { localStorage.setItem("pix.recentProjects", JSON.stringify(projects.value)) } catch { /* Optional storage. */ }
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
  return { gitBusy, projects, histories, remember, refresh, update, preview, generatedTitle }
})
