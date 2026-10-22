import { defineStore } from "pinia"
import { ref } from "vue"
import { i18n } from "@/i18n"
import { baseName, normalizeProjectPath, samePath } from "@/lib/paths"
import { isRemoteProject, forgetSshProjectConnection } from "@/lib/ssh"
import { requireSshConnectionId } from "@/lib/sshTrust"
import {
  listSessions,
  pixLog,
  resolveProjectlessDir,
  updateSession,
  sshConnectionList,
  sshSessions,
  getWorkspaceState,
  updateWorkspaceState,
  workspaceGitInfo,
  type SessionMeta,
  type WorkspaceGitInfo,
} from "@/api/piClient"
import {
  applyWorkspaceStatePatch,
  diffWorkspaceState,
  emptyWorkspaceState,
  type WorkspaceState,
  type WorkspaceStatePatch,
} from "@/lib/workspaceState"
import type { ProjectGroup } from "@/lib/workspaceState"
export type { ProjectGroup } from "@/lib/workspaceState"

/** 毫秒计时；部分测试 VM 环境没有 performance 全局。 */
const nowMs = () => (typeof performance === "undefined" ? Date.now() : performance.now())

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
  const worktreeOwners = ref<Record<string, string>>({})
  const projects = ref<string[]>([])
  const pinnedProjects = ref<string[]>([])
  const projectGroups = ref<Record<string, ProjectGroup>>({})
  const histories = ref<Record<string, SessionMeta[]>>({})
  const sessionOrder = ref<Record<string, string[]>>({})
  /** 远程项目会话列表的加载状态（契约 §2.4），驱动侧栏刷新按钮 spinner。 */
  const remoteSessionsLoading = ref<Record<string, boolean>>({})
  /** 无项目会话的工作目录（后端解析结果），空值表示尚未解析。 */
  const projectless = ref("")
  const projectlessDefault = ref("")
  let projectlessRequest: Promise<string> | null = null
  const pending = new Map<string, SessionMeta>()
  const versions: Record<string, number> = {}
  const removedProjects = ref<string[]>([])
  const persistenceError = ref<unknown>(null)
  let revision = -1
  let recorded = emptyWorkspaceState()
  let authoritative = emptyWorkspaceState()
  let initialized = false
  let loading: Promise<void> | null = null
  let saving: Promise<void> | null = null
  const changes: WorkspaceStatePatch[] = []

  function snapshot(): WorkspaceState {
    // JSON cloning also unwraps Vue's reactive arrays and objects.
    return JSON.parse(
      JSON.stringify({
        revision,
        projects: projects.value,
        pinnedProjects: pinnedProjects.value,
        projectGroups: projectGroups.value,
        removedProjects: removedProjects.value,
        sessionOrder: sessionOrder.value,
      }),
    )
  }
  /** Apply authoritative state, then replay edits not yet acknowledged by the backend. */
  function applyState(state: WorkspaceState) {
    if (state.revision >= revision) {
      revision = state.revision
      authoritative = structuredClone(state)
    }
    const next = changes.reduce(applyWorkspaceStatePatch, structuredClone(authoritative))
    // Avoid retriggering sidebar/Git loads when only pins or session ordering changed.
    if (JSON.stringify(projects.value) !== JSON.stringify(next.projects)) projects.value = next.projects
    if (JSON.stringify(pinnedProjects.value) !== JSON.stringify(next.pinnedProjects))
      pinnedProjects.value = next.pinnedProjects
    if (JSON.stringify(projectGroups.value) !== JSON.stringify(next.projectGroups))
      projectGroups.value = next.projectGroups
    if (JSON.stringify(removedProjects.value) !== JSON.stringify(next.removedProjects))
      removedProjects.value = next.removedProjects
    sessionOrder.value = next.sessionOrder
    recorded = snapshot()
    for (const path of Object.keys(histories.value)) applySessionOrder(path)
  }
  async function loadState() {
    if (loading) return loading
    loading = (async () => {
      applyState(await getWorkspaceState())
      initialized = true
    })().finally(() => {
      loading = null
    })
    return loading
  }
  async function initialize() {
    if (!initialized) await loadState()
  }
  /** Retry queued writes after reconnect; never replace the backend with a stale snapshot. */
  async function flushPersistence() {
    if (saving) return saving
    saving = (async () => {
      await initialize()
      while (changes.length) {
        const state = await updateWorkspaceState(changes[0]!)
        changes.shift()
        applyState(state)
      }
      persistenceError.value = null
    })()
      .catch(error => {
        persistenceError.value = error
        throw error
      })
      .finally(() => {
        saving = null
        if (!persistenceError.value && changes.length)
          void flushPersistence().catch(error => console.warn("[pi] workspace persistence failed:", error))
      })
    return saving
  }
  async function syncState() {
    await loadState()
    await flushPersistence()
  }
  function persistState() {
    const next = snapshot()
    const patch = diffWorkspaceState(recorded, next)
    recorded = next
    if (!Object.keys(patch).length) return
    changes.push(patch)
    void flushPersistence().catch(error => console.warn("[pi] workspace persistence failed:", error))
  }
  const persistProjects = persistState
  const persistSessionOrder = persistState
  const persistRemovedProjects = persistState
  /** Whether the user explicitly removed this project, so automatic paths must not re-add it. */
  function isRemovedProject(path: string) {
    path = normalizeProjectPath(path)
    return !!path && removedProjects.value.some(existing => samePath(existing, path))
  }
  /** Clear the removed marker; only explicit add flows (dialog, folder pick) call this. */
  function unremoveProject(path: string, persist = true) {
    path = normalizeProjectPath(path)
    if (!path) return
    const targets = [path]
    const root = projectRoot(path)
    if (root !== path) targets.push(root)
    const next = removedProjects.value.filter(existing => !targets.some(target => samePath(existing, target)))
    if (next.length === removedProjects.value.length) return
    removedProjects.value = next
    if (persist) persistRemovedProjects()
  }
  function orderedProjects() {
    return [...projects.value].sort(
      (a, b) => Number(pinnedProjects.value.includes(b)) - Number(pinnedProjects.value.includes(a)),
    )
  }
  /** Persist a manual project ordering. Pinned projects still stay on top. */
  function reorderProjects(ordered: string[]) {
    const normalized = ordered.map(normalizeProjectPath)
    projects.value = [...normalized, ...projects.value.filter(p => !normalized.some(path => samePath(path, p)))]
    persistProjects()
  }
  function applySessionOrder(path: string) {
    const rows = histories.value[path]
    if (!rows) return
    histories.value[path] = sortSessions(rows, sessionOrder.value[path] || [])
  }
  function sortSessions(rows: SessionMeta[], order: string[]) {
    const index = new Map(order.map((f, i) => [f, i]))
    const createdAt = (row: SessionMeta) => Date.parse(row.timestamp || "") || 0
    // New sessions precede the saved drag order; archived rows are not in the sidebar's drag list.
    const position = (row: SessionMeta) =>
      index.get(row.file) ?? (order.length && row.archived ? Number.MAX_SAFE_INTEGER : -1)
    return [...rows].sort((a, b) => {
      const ia = position(a)
      const ib = position(b)
      return ia - ib || createdAt(b) - createdAt(a) || b.file.localeCompare(a.file)
    })
  }
  /** A project can span several folders; its sidebar order belongs to the project. */
  function orderedSessions(path: string) {
    path = normalizeProjectPath(path)
    const folders = projectFolders(path)
    if (folders.length === 1) return histories.value[folders[0]] || []
    return sortSessions(
      folders.flatMap(folder => histories.value[folder] || []),
      sessionOrder.value[projectRoot(path)] || [],
    )
  }
  /** Persist a manual ordering for the given sessions of a project. */
  function reorderSessions(path: string, orderedFiles: string[]) {
    path = normalizeProjectPath(path)
    const rest = (sessionOrder.value[path] || []).filter(f => !orderedFiles.includes(f))
    sessionOrder.value[path] = [...orderedFiles, ...rest]
    applySessionOrder(path)
    persistSessionOrder()
  }
  function createProject(group: ProjectGroup) {
    const { name } = group
    const primary = normalizeProjectPath(group.primary)
    const folders = group.folders.map(normalizeProjectPath)
    if (
      !primary ||
      !name.trim() ||
      !folders.includes(primary) ||
      folders.some((folder, index) => folders.slice(0, index).some(existing => samePath(existing, folder))) ||
      folders.some(
        path =>
          projects.value.some(existing => samePath(existing, path)) ||
          Object.values(projectGroups.value).some(existing => existing.folders.some(folder => samePath(folder, path))),
      )
    ) {
      throw new Error("Project folders must be unique and not belong to another project")
    }
    projects.value = [primary, ...projects.value]
    projectGroups.value[primary] = { name: name.trim(), folders: [...folders], primary }
    // Re-adding a project explicitly also lifts its removed marker.
    unremoveProject(primary, false)
    for (const folder of folders) unremoveProject(folder, false)
    persistProjects()
  }
  function projectRoot(path: string) {
    path = normalizeProjectPath(path)
    const explicit = Object.values(projectGroups.value).find(group =>
      group.folders.some(folder => samePath(folder, path)),
    )
    if (explicit) return explicit.primary
    path = Object.entries(worktreeOwners.value).find(([tree]) => samePath(tree, path))?.[1] || path
    return (
      Object.values(projectGroups.value).find(group => group.folders.some(folder => samePath(folder, path)))?.primary ||
      projects.value.find(existing => samePath(existing, path)) ||
      path
    )
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
    oldPrimary = projectRoot(oldPrimary)
    if (!projects.value.includes(oldPrimary)) throw new Error("Project not found")
    const { name } = group
    const primary = normalizeProjectPath(group.primary)
    const folders = group.folders.map(normalizeProjectPath)
    if (
      !primary ||
      !name.trim() ||
      !folders.includes(primary) ||
      folders.some((folder, index) => folders.slice(0, index).some(existing => samePath(existing, folder))) ||
      folders.some(
        folder =>
          projects.value.some(path => path !== oldPrimary && samePath(path, folder)) ||
          Object.entries(projectGroups.value).some(
            ([path, existing]) => path !== oldPrimary && existing.folders.some(path => samePath(path, folder)),
          ),
      )
    ) {
      throw new Error("Project folders must be unique and not belong to another project")
    }
    projects.value = projects.value.map(path => (path === oldPrimary ? primary : path))
    pinnedProjects.value = pinnedProjects.value.map(path => (path === oldPrimary ? primary : path))
    delete projectGroups.value[oldPrimary]
    if (oldPrimary !== primary && sessionOrder.value[oldPrimary]) {
      sessionOrder.value[primary] = sessionOrder.value[oldPrimary]
      delete sessionOrder.value[oldPrimary]
    }
    projectGroups.value[primary] = { name: name.trim(), folders: [...folders], primary }
    unremoveProject(primary, false)
    for (const folder of folders) unremoveProject(folder, false)
    persistProjects()
  }
  function projectName(path: string) {
    path = normalizeProjectPath(path)
    if (isProjectless(path)) return i18n.global.t("projectless.name")
    return projectGroups.value[projectRoot(path)]?.name || baseName(projectRoot(path)) || path
  }
  function projectFolders(path: string) {
    path = normalizeProjectPath(path)
    const root = projectRoot(path)
    const folders = projectGroups.value[root]?.folders || [root]
    return [
      ...folders,
      ...Object.keys(worktreeOwners.value).filter(
        tree => samePath(projectRoot(tree), root) && !folders.some(folder => samePath(folder, tree)),
      ),
    ]
  }
  function togglePin(path: string) {
    path = projectRoot(path)
    if (!projects.value.includes(path)) return
    pinnedProjects.value = pinnedProjects.value.includes(path)
      ? pinnedProjects.value.filter(p => p !== path)
      : [...pinnedProjects.value, path]
    persistProjects()
  }
  function removeProject(path: string) {
    path = projectRoot(path)
    if (isRemoteProject(path)) forgetSshProjectConnection(path)
    if (!isRemovedProject(path)) {
      removedProjects.value = [path, ...removedProjects.value]
    }
    projects.value = projects.value.filter(p => p !== path)
    pinnedProjects.value = pinnedProjects.value.filter(p => p !== path)
    delete projectGroups.value[path]
    delete sessionOrder.value[path]
    versions[path] = (versions[path] || 0) + 1
    delete histories.value[path]
    for (const [file, row] of pending) if (samePath(row.cwd, path)) pending.delete(file)
    persistProjects()
    persistSessionOrder()
  }
  /** Git lists the main checkout first, regardless of the queried worktree. */
  function registerWorktrees(info: WorkspaceGitInfo) {
    const main = info.worktrees[0]?.path
    if (!main) return
    const primary = normalizeProjectPath(main)
    for (const tree of info.worktrees.slice(1)) {
      const path = normalizeProjectPath(tree.path)
      worktreeOwners.value[path] = primary
      // Explicitly configured projects retain their ownership.
      if (Object.values(projectGroups.value).some(group => group.folders.some(folder => samePath(folder, path))))
        continue
      const root = projectRoot(primary)
      const duplicate = projects.value.find(p => samePath(p, path))
      if (!duplicate) continue
      projects.value = projects.value.map(p => (p === duplicate ? root : p))
      projects.value = projects.value.filter((p, i, all) => all.findIndex(other => samePath(p, other)) === i)
      pinnedProjects.value = [...new Set(pinnedProjects.value.map(p => (p === duplicate ? root : p)))]
      sessionOrder.value[root] = [
        ...new Set([...(sessionOrder.value[root] || []), ...(sessionOrder.value[duplicate] || [])]),
      ]
      delete sessionOrder.value[duplicate]
    }
    persistProjects()
    persistSessionOrder()
  }
  /** Sidebar hydration discovers worktrees but must not re-add a removed group member. */
  async function registerProjectWorktrees(path: string) {
    try {
      const info = await workspaceGitInfo(path)
      if (projects.value.some(project => samePath(project, projectRoot(path)))) registerWorktrees(info)
    } catch {
      // Non-Git and unavailable directories remain ordinary projects.
    }
  }
  async function rememberWorkspace(path: string, knownInfo?: WorkspaceGitInfo) {
    if (!path) return
    // 远程项目跳过本地 git 查询（契约 §5），直接进项目列表。
    if (isRemoteProject(path)) {
      remember(path)
      return
    }
    try {
      registerWorktrees(knownInfo ?? (await workspaceGitInfo(path)))
    } catch {
      // Non-Git and unavailable directories remain ordinary projects.
    }
    remember(projectRoot(path))
  }
  function isWorktree(path: string) {
    return Object.keys(worktreeOwners.value).some(tree => samePath(tree, path))
  }
  function remember(path: string) {
    path = normalizeProjectPath(path)
    // Removed projects only come back through explicit add flows.
    if (!path || isRemovedProject(path)) return
    if (!projects.value.includes(path) && projectRoot(path) === path) projects.value = [path, ...projects.value]
    persistProjects()
  }
  async function refresh(path: string) {
    path = normalizeProjectPath(path)
    // 远程项目走 ssh_sessions 远程列表（契约 §2.4）；失败置空并上抛由调用方 toast。
    if (isRemoteProject(path)) {
      const version = (versions[path] = (versions[path] || 0) + 1)
      remoteSessionsLoading.value[path] = true
      try {
        const connectionId = requireSshConnectionId(path, await sshConnectionList())
        const rows = await sshSessions(path, connectionId)
        if (versions[path] === version) {
          histories.value[path] = rows
          applySessionOrder(path)
        }
      } catch (error) {
        if (versions[path] === version) histories.value[path] = []
        throw error
      } finally {
        remoteSessionsLoading.value[path] = false
      }
      return
    }
    const version = (versions[path] = (versions[path] || 0) + 1)
    const start = nowMs()
    const rows = await listSessions(path)
    pixLog(`[perf] listSessions ${path} ${Math.round(nowMs() - start)}ms rows=${rows.length}`)
    if (versions[path] === version) {
      for (const row of rows) pending.delete(row.file)
      const previews = [...pending.values()].filter(row => samePath(row.cwd, path))
      histories.value[path] = [...rows, ...previews]
      applySessionOrder(path)
    }
  }
  // pi does not flush a new session to disk until its first assistant response.
  function preview(row: SessionMeta) {
    const path = normalizeProjectPath(row.cwd)
    const rows = histories.value[path] ?? []
    if (rows.some(s => s.file === row.file)) return
    pending.set(row.file, row)
    histories.value[path] = [row, ...rows]
    applySessionOrder(path)
  }
  function generatedTitle(file: string, title: string) {
    for (const rows of Object.values(histories.value)) {
      const row = rows.find(s => s.file === file)
      if (row && !row.title) row.title = title
    }
    const draft = pending.get(file)
    if (draft && !draft.title) draft.title = title
  }
  /** Like generatedTitle, but overwrites an existing title: editing the first
   *  question replaces the wording the old title was generated from. */
  function regeneratedTitle(file: string, title: string) {
    for (const rows of Object.values(histories.value)) {
      const row = rows.find(s => s.file === file)
      if (row) row.title = title
    }
    const draft = pending.get(file)
    if (draft) draft.title = title
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
  return {
    initialize,
    syncState,
    applyState,
    flushPersistence,
    persistenceError,
    gitBusy,
    registerWorktrees,
    registerProjectWorktrees,
    rememberWorkspace,
    isWorktree,
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
    isRemovedProject,
    unremoveProject,
    histories,
    remoteSessionsLoading,
    reorderSessions,
    remember,
    refresh,
    update,
    removeSession,
    preview,
    generatedTitle,
    regeneratedTitle,
  }
})
