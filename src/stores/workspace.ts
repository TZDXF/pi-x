import { defineStore } from "pinia"
import { ref } from "vue"
import { i18n } from "@/i18n"
import { baseName, samePath } from "@/lib/paths"
import { listSessions, resolveProjectlessDir, updateSession, type SessionMeta } from "@/api/piClient"
import { invoke } from "@/api/transport"

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

export interface ProjectGroup {
  name: string
  folders: string[]
  primary: string
}

export const useWorkspaceStore = defineStore("workspace", () => {
  const gitBusy = ref(false)
  const projects = ref<string[]>([])
  const pinnedProjects = ref<string[]>([])
  const projectGroups = ref<Record<string, ProjectGroup>>({})
  const histories = ref<Record<string, SessionMeta[]>>({})
  const sessionOrder = ref<Record<string, string[]>>({})
  /** 无项目会话的工作目录（后端解析结果），空值表示尚未解析。 */
  const projectless = ref("")
  const projectlessDefault = ref("")
  let projectlessRequest: Promise<string> | null = null
  const pending = new Map<string, SessionMeta>()
  const versions: Record<string, number> = {}
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.recentProjects") || "[]")
    if (Array.isArray(stored)) projects.value = stored.filter((p): p is string => typeof p === "string")
  } catch {
    /* Optional storage. */
  }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.pinnedProjects") || "[]")
    if (Array.isArray(stored))
      pinnedProjects.value = stored.filter((p): p is string => typeof p === "string" && projects.value.includes(p))
  } catch {
    /* Optional storage. */
  }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.sessionOrder") || "{}")
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [path, files] of Object.entries(stored)) {
        if (Array.isArray(files)) sessionOrder.value[path] = files.filter((f): f is string => typeof f === "string")
      }
    }
  } catch {
    /* Optional storage. */
  }
  try {
    const stored: unknown = JSON.parse(localStorage.getItem("pix.projectGroups") || "{}")
    if (stored && typeof stored === "object" && !Array.isArray(stored)) {
      for (const [primary, value] of Object.entries(stored)) {
        if (!projects.value.includes(primary) || !value || typeof value !== "object") continue
        const group = value as Partial<ProjectGroup>
        if (
          typeof group.name === "string" &&
          Array.isArray(group.folders) &&
          group.folders.every(p => typeof p === "string") &&
          group.folders.includes(primary)
        ) {
          projectGroups.value[primary] = { name: group.name, folders: group.folders, primary }
        }
      }
    }
  } catch {
    /* Optional storage. */
  }
  function persistProjects() {
    try {
      localStorage.setItem("pix.recentProjects", JSON.stringify(projects.value))
      localStorage.setItem("pix.pinnedProjects", JSON.stringify(pinnedProjects.value))
      localStorage.setItem("pix.projectGroups", JSON.stringify(projectGroups.value))
    } catch {
      /* Optional storage. */
    }
  }
  function persistSessionOrder() {
    try {
      localStorage.setItem("pix.sessionOrder", JSON.stringify(sessionOrder.value))
    } catch {
      /* Optional storage. */
    }
  }
  function orderedProjects() {
    return [...projects.value].sort(
      (a, b) => Number(pinnedProjects.value.includes(b)) - Number(pinnedProjects.value.includes(a)),
    )
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
    histories.value[path] = sortSessions(rows, sessionOrder.value[path] || [])
  }
  function sortSessions(rows: SessionMeta[], order: string[]) {
    const index = new Map(order.map((f, i) => [f, i]))
    return [...rows].sort((a, b) => {
      const ia = index.get(a.file) ?? Number.MAX_SAFE_INTEGER
      const ib = index.get(b.file) ?? Number.MAX_SAFE_INTEGER
      return ia - ib || b.mtimeMs - a.mtimeMs
    })
  }
  /** A project can span several folders; its sidebar order belongs to the project. */
  function orderedSessions(path: string) {
    const folders = projectFolders(path)
    if (folders.length === 1) return histories.value[folders[0]] || []
    return sortSessions(
      folders.flatMap(folder => histories.value[folder] || []),
      sessionOrder.value[projectRoot(path)] || [],
    )
  }
  /** Persist a manual ordering for the given sessions of a project. */
  function reorderSessions(path: string, orderedFiles: string[]) {
    const rest = (sessionOrder.value[path] || []).filter(f => !orderedFiles.includes(f))
    sessionOrder.value[path] = [...orderedFiles, ...rest]
    applySessionOrder(path)
    persistSessionOrder()
  }
  function createProject(group: ProjectGroup) {
    const { primary, folders, name } = group
    if (
      !primary ||
      !name.trim() ||
      !folders.includes(primary) ||
      new Set(folders).size !== folders.length ||
      folders.some(
        path =>
          projects.value.includes(path) ||
          Object.values(projectGroups.value).some(existing => existing.folders.includes(path)),
      )
    ) {
      throw new Error("Project folders must be unique and not belong to another project")
    }
    projects.value = [primary, ...projects.value]
    projectGroups.value[primary] = { name: name.trim(), folders: [...folders], primary }
    persistProjects()
  }
  function projectRoot(path: string) {
    return Object.values(projectGroups.value).find(group => group.folders.includes(path))?.primary || path
  }
  // ---- 无项目会话：未打开项目时使用的固定工作目录 ----
  /** 解析（并由后端按需创建）无项目会话目录；并发调用共享同一次请求。 */
  function ensureProjectless() {
    if (projectless.value) return Promise.resolve(projectless.value)
    if (!projectlessRequest) {
      projectlessRequest = resolveProjectlessDir()
        .then(info => {
          projectlessDefault.value = info.defaultDir
          projectless.value = info.dir
          return info.dir
        })
        .catch(error => {
          projectlessRequest = null
          throw error
        })
    }
    return projectlessRequest
  }
  /** 设置中的目录改动后重新解析，下一次无项目会话使用新目录。 */
  async function refreshProjectless() {
    projectlessRequest = null
    projectless.value = ""
    return ensureProjectless()
  }
  function isProjectless(path: string) {
    return !!projectless.value && samePath(path, projectless.value)
  }
  function updateProject(oldPrimary: string, group: ProjectGroup) {
    if (!projects.value.includes(oldPrimary)) throw new Error("Project not found")
    const { primary, folders, name } = group
    if (
      !primary ||
      !name.trim() ||
      !folders.includes(primary) ||
      new Set(folders).size !== folders.length ||
      folders.some(
        folder =>
          projects.value.some(path => path !== oldPrimary && path === folder) ||
          Object.entries(projectGroups.value).some(
            ([path, existing]) => path !== oldPrimary && existing.folders.includes(folder),
          ),
      )
    ) {
      throw new Error("Project folders must be unique and not belong to another project")
    }
    projects.value = projects.value.map(path => (path === oldPrimary ? primary : path))
    pinnedProjects.value = pinnedProjects.value.map(path => (path === oldPrimary ? primary : path))
    delete projectGroups.value[oldPrimary]
    projectGroups.value[primary] = { name: name.trim(), folders: [...folders], primary }
    persistProjects()
  }
  function projectName(path: string) {
    if (isProjectless(path)) return i18n.global.t("projectless.name")
    return projectGroups.value[projectRoot(path)]?.name || baseName(path) || path
  }
  function projectFolders(path: string) {
    return projectGroups.value[projectRoot(path)]?.folders || [path]
  }
  function togglePin(path: string) {
    if (!projects.value.includes(path)) return
    pinnedProjects.value = pinnedProjects.value.includes(path)
      ? pinnedProjects.value.filter(p => p !== path)
      : [...pinnedProjects.value, path]
    persistProjects()
  }
  function removeProject(path: string) {
    projects.value = projects.value.filter(p => p !== path)
    pinnedProjects.value = pinnedProjects.value.filter(p => p !== path)
    delete projectGroups.value[path]
    delete sessionOrder.value[path]
    versions[path] = (versions[path] || 0) + 1
    delete histories.value[path]
    for (const [file, row] of pending) if (row.cwd === path) pending.delete(file)
    persistProjects()
    persistSessionOrder()
  }
  function remember(path: string) {
    if (!path) return
    if (!projects.value.includes(path) && projectRoot(path) === path) projects.value = [path, ...projects.value]
    persistProjects()
  }
  async function refresh(path: string) {
    const version = (versions[path] = (versions[path] || 0) + 1)
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
    // Delete the checkpoint manifest file for the removed session.
    invoke("session_checkpoint_manifest_delete", { file }).catch(() => {
      // Silently ignore errors — the manifest may not exist.
    })
  }
  return {
    gitBusy,
    projects,
    pinnedProjects,
    projectGroups,
    createProject,
    updateProject,
    projectRoot,
    projectName,
    projectFolders,
    projectless,
    projectlessDefault,
    ensureProjectless,
    refreshProjectless,
    isProjectless,
    orderedProjects,
    reorderProjects,
    orderedSessions,
    togglePin,
    removeProject,
    histories,
    reorderSessions,
    remember,
    refresh,
    update,
    removeSession,
    preview,
    generatedTitle,
  }
})
