import { reactive } from "vue"
import { sessionIdentityKey } from "@/lib/sessionIdentity"

/** Status of the most recent turn, keyed by session file rather than selected runtime.
 * Keep terminal statuses after a dormant conversation store is evicted. */
export type SessionRunStatus = "running" | "completed" | "error"
const statuses = reactive(new Map<string, SessionRunStatus>())
const key = sessionIdentityKey

export interface SessionActivity {
  file: string
  project: string
  status: SessionRunStatus | "idle"
  runId: string
  updatedAt: number
}

export interface SessionActivitySync {
  recordSessionActivity(activity: SessionActivity): void
  acknowledgeSessionActivity(file: string, project: string, runId: string): void
}

const activities = reactive(new Map<string, Readonly<SessionActivity>>())
const acknowledgements = new Map<string, string>()
const pendingActivities = new Map<string, SessionActivity>()
const pendingAcknowledgements = new Map<string, SessionActivity>()
let sync: SessionActivitySync | undefined
let sequence = 0
const isProvisionalRunId = (runId: string) => runId.startsWith("local:")

export interface SessionRunMetadata {
  runId: string
  updatedAt: number
}

function projectActivity(activity: Readonly<SessionActivity>) {
  const identity = key(activity.file, activity.project)
  if (
    activity.status === "idle" ||
    (activity.status !== "running" && acknowledgements.get(identity) === activity.runId)
  )
    statuses.delete(identity)
  else statuses.set(identity, activity.status)
}

/** Immutable snapshot, also reactive when read inside a computed/watch. */
export function sessionActivitySnapshot(file: string, project?: string): Readonly<SessionActivity> | undefined {
  return activities.get(key(file, project))
}

export function sessionRunRevision(file: string, project?: string): string | undefined {
  return sessionActivitySnapshot(file, project)?.runId
}

/** Import persisted state without notifying the local write bridge. */
export function mergeSessionActivity(activity: SessionActivity) {
  const identity = key(activity.file, activity.project)
  const previous = activities.get(identity)
  if (
    previous &&
    previous.updatedAt > activity.updatedAt &&
    (!isProvisionalRunId(previous.runId) || isProvisionalRunId(activity.runId))
  )
    return
  // A delayed running echo cannot reopen a settled turn at the same timestamp.
  if (
    previous?.runId === activity.runId &&
    previous.status !== "running" &&
    activity.status === "running" &&
    previous.updatedAt === activity.updatedAt
  )
    return
  const snapshot = Object.freeze({ ...activity })
  activities.set(identity, snapshot)
  projectActivity(snapshot)
}

export function mergeSessionAcknowledgement(file: string, project: string | undefined, runId: string) {
  const identity = key(file, project)
  const activity = activities.get(identity)
  // Stale receipts must not replace the receipt for the currently visible run.
  if (activity && activity.runId !== runId) return
  acknowledgements.set(identity, runId)
  if (activity) projectActivity(activity)
}

/** Register at App setup; replay writes made before setup or while detached. */
export function registerSessionActivitySync(bridge: SessionActivitySync): () => void {
  sync = bridge
  for (const activity of pendingActivities.values()) bridge.recordSessionActivity({ ...activity })
  pendingActivities.clear()
  for (const activity of pendingAcknowledgements.values())
    bridge.acknowledgeSessionActivity(activity.file, activity.project, activity.runId)
  pendingAcknowledgements.clear()
  return () => {
    if (sync === bridge) sync = undefined
  }
}

export function sessionRunStatus(file: string, project?: string): SessionRunStatus | undefined {
  return statuses.get(key(file, project))
}

export function setSessionRunStatus(
  file: string | null,
  status: SessionRunStatus | null,
  project?: string,
  metadata?: SessionRunMetadata,
) {
  if (!file) return
  const identity = key(file, project)
  const previous = activities.get(identity)
  const nextStatus = status ?? "idle"
  if (metadata && (!metadata.runId || !Number.isFinite(metadata.updatedAt))) metadata = undefined
  if (metadata && previous && !isProvisionalRunId(previous.runId) && previous.updatedAt > metadata.updatedAt) return
  if (
    metadata &&
    previous?.runId === metadata.runId &&
    previous.status !== "running" &&
    nextStatus === "running" &&
    previous.updatedAt === metadata.updatedAt
  )
    return
  // Retry/reattach events repeat running; only a transition into running starts a turn.
  const runId =
    metadata?.runId ??
    (!previous || (status === "running" && previous.status !== "running")
      ? `local:${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}-${++sequence}`}`
      : previous.runId)
  const activity: SessionActivity = {
    file,
    project: project ?? "",
    status: nextStatus,
    runId,
    updatedAt:
      metadata?.updatedAt ??
      (previous && (previous.status === nextStatus || (runId === previous.runId && !isProvisionalRunId(runId)))
        ? previous.updatedAt
        : Math.max(Date.now(), (previous?.updatedAt ?? 0) + 1)),
  }
  activities.set(identity, Object.freeze(activity))
  // Preserve the legacy setter contract even when a caller repeats a terminal status.
  if (metadata) projectActivity(activity)
  else if (status) statuses.set(identity, status)
  else statuses.delete(identity)
  if (sync) sync.recordSessionActivity({ ...activity })
  else pendingActivities.set(identity, activity)
}

/** A viewed terminal result is acknowledged; an in-flight turn stays visible. */
export function acknowledgeSessionRunStatus(file: string | null, project?: string, runId?: string) {
  if (!file) return
  const activity = sessionActivitySnapshot(file, project)
  if (!activity || (runId !== undefined && activity.runId !== runId)) return
  const status = sessionRunStatus(file, project)
  if (status !== "completed" && status !== "error") return
  const identity = key(file, project)
  acknowledgements.set(identity, activity.runId)
  statuses.delete(identity)
  if (sync) sync.acknowledgeSessionActivity(file, project ?? "", activity.runId)
  else pendingAcknowledgements.set(identity, { ...activity })
}
