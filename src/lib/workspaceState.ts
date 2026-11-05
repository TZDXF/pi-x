import { samePath } from "@/lib/paths"
import type { ThinkingLevel } from "@/api/protocol"
import type { WorkspaceSelection } from "@/api/piClient"

export interface BoardDraftAttachment {
  filename?: string
  mediaType: string
  /** Durable inline bytes; object URLs are owned by the editor. */
  url: string
}

export interface ProjectGroup {
  name: string
  folders: string[]
  primary: string
}
export interface BoardDraft {
  id: string
  project: string
  message: string
  createdAt: number
  updatedAt: number
  sessionFile?: string
  runtimeId?: string
  modelKey?: string
  thinkingLevel?: ThinkingLevel
  attachments?: BoardDraftAttachment[]
  /** Git environment chosen when the todo is created; applied on its first start. */
  selection?: WorkspaceSelection
}
export interface SessionActivity {
  file: string
  project: string
  status: "running" | "completed" | "error" | "idle"
  runId: string
  updatedAt: number
}
export function shouldApplySessionActivity(previous: SessionActivity | undefined, incoming: SessionActivity): boolean {
  return (
    !previous ||
    (previous.runId.startsWith("local:") && !incoming.runId.startsWith("local:")) ||
    incoming.updatedAt >= previous.updatedAt
  )
}
interface KanbanWorkspaceState {
  boardColumnOrder: Record<string, string[]>
  boardDrafts: Record<string, BoardDraft>
  sessionActivities: Record<string, SessionActivity>
  sessionAcknowledgements: Record<string, string>
}
export interface WorkspaceState extends Partial<KanbanWorkspaceState> {
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
  boardColumnOrder?: Record<string, string[] | null>
  boardDrafts?: Record<string, BoardDraft | null>
  sessionActivities?: Record<string, SessionActivity | null>
  sessionAcknowledgements?: Record<string, string | null>
}
export function emptyWorkspaceState(): WorkspaceState & KanbanWorkspaceState {
  return {
    revision: 0,
    projects: [],
    pinnedProjects: [],
    projectGroups: {},
    removedProjects: [],
    sessionOrder: {},
    boardColumnOrder: {},
    boardDrafts: {},
    sessionActivities: {},
    sessionAcknowledgements: {},
  }
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
  for (const key of [
    "projectGroups",
    "sessionOrder",
    "boardColumnOrder",
    "boardDrafts",
    "sessionActivities",
    "sessionAcknowledgements",
  ] as const) {
    const previous = before[key] ?? {}
    const next = after[key] ?? {}
    const changes: Record<string, unknown> = {}
    for (const path of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (JSON.stringify(previous[path]) !== JSON.stringify(next[path])) changes[path] = next[path] ?? null
    }
    if (Object.keys(changes).length) Object.assign(patch, { [key]: changes })
  }
  return JSON.parse(JSON.stringify(patch))
}
export function applyWorkspaceStatePatch(
  state: WorkspaceState,
  patch: WorkspaceStatePatch,
): WorkspaceState & KanbanWorkspaceState {
  const next = structuredClone({
    ...state,
    boardColumnOrder: state.boardColumnOrder ?? {},
    boardDrafts: state.boardDrafts ?? {},
    sessionActivities: state.sessionActivities ?? {},
    sessionAcknowledgements: state.sessionAcknowledgements ?? {},
  })
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
  for (const key of ["projectGroups", "sessionOrder", "boardColumnOrder", "boardDrafts"] as const) {
    for (const [path, value] of Object.entries(patch[key] ?? {})) {
      if (value === null) delete next[key][path]
      else Object.assign(next[key], { [path]: value })
    }
  }
  // These keys are opaque session identities, including remote endpoint information.
  for (const [key, activity] of Object.entries(patch.sessionActivities ?? {})) {
    if (activity === null) delete next.sessionActivities[key]
    else if (shouldApplySessionActivity(next.sessionActivities[key], activity))
      next.sessionActivities[key] = structuredClone(activity)
  }
  for (const [key, runId] of Object.entries(patch.sessionAcknowledgements ?? {})) {
    if (runId === null) delete next.sessionAcknowledgements[key]
    else if (!next.sessionActivities[key] || next.sessionActivities[key].runId === runId)
      next.sessionAcknowledgements[key] = runId
  }
  return next
}
