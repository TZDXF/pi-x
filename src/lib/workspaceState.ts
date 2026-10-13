import { samePath } from "@/lib/paths"

export interface ProjectGroup {
  name: string
  folders: string[]
  primary: string
}
export interface WorkspaceState {
  revision: number
  projects: string[]
  pinnedProjects: string[]
  projectGroups: Record<string, ProjectGroup>
  removedProjects: string[]
  sessionOrder: Record<string, string[]>
}
export interface PathChanges {
  add: string[]
  remove: string[]
  order?: string[]
}
/** Changes, not whole snapshots: concurrent clients must not overwrite unrelated projects. */
export interface WorkspaceStatePatch {
  projects?: PathChanges
  pinnedProjects?: PathChanges
  removedProjects?: PathChanges
  projectGroups?: Record<string, ProjectGroup | null>
  sessionOrder?: Record<string, string[] | null>
}
export function emptyWorkspaceState(): WorkspaceState {
  return { revision: 0, projects: [], pinnedProjects: [], projectGroups: {}, removedProjects: [], sessionOrder: {} }
}
export function diffWorkspaceState(before: WorkspaceState, after: WorkspaceState): WorkspaceStatePatch {
  const patch: WorkspaceStatePatch = {}
  for (const key of ["projects", "pinnedProjects", "removedProjects"] as const) {
    if (JSON.stringify(before[key]) === JSON.stringify(after[key])) continue
    patch[key] = {
      add: after[key].filter(path => !before[key].some(old => samePath(old, path))),
      remove: before[key].filter(path => !after[key].some(next => samePath(next, path))),
      ...(key === "projects" ? { order: [...after[key]] } : {}),
    }
  }
  for (const key of ["projectGroups", "sessionOrder"] as const) {
    const changes: Record<string, ProjectGroup | string[] | null> = {}
    for (const path of new Set([...Object.keys(before[key]), ...Object.keys(after[key])])) {
      if (JSON.stringify(before[key][path]) !== JSON.stringify(after[key][path]))
        changes[path] = after[key][path] ?? null
    }
    if (Object.keys(changes).length) Object.assign(patch, { [key]: changes })
  }
  return JSON.parse(JSON.stringify(patch))
}
export function applyWorkspaceStatePatch(state: WorkspaceState, patch: WorkspaceStatePatch): WorkspaceState {
  const next = structuredClone(state)
  for (const key of ["projects", "pinnedProjects", "removedProjects"] as const) {
    const changes = patch[key]
    if (!changes) continue
    next[key] = next[key].filter(path => !changes.remove.some(removed => samePath(removed, path)))
    for (const path of changes.add) if (!next[key].some(old => samePath(old, path))) next[key].push(path)
    if (changes.order) {
      const ordered = changes.order.flatMap(path => next[key].find(old => samePath(old, path)) ?? [])
      next[key] = [...new Set([...ordered, ...next[key]])]
    }
  }
  for (const key of ["projectGroups", "sessionOrder"] as const) {
    for (const [path, value] of Object.entries(patch[key] ?? {})) {
      if (value === null) delete next[key][path]
      else Object.assign(next[key], { [path]: value })
    }
  }
  return next
}
