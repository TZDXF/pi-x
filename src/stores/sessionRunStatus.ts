import { reactive } from "vue"
import { sessionIdentityKey } from "@/lib/sessionIdentity"

/** Status of the most recent turn, keyed by session file rather than selected runtime.
 * Keep terminal statuses after a dormant conversation store is evicted. */
export type SessionRunStatus = "running" | "completed" | "error"
const statuses = reactive(new Map<string, SessionRunStatus>())
const key = sessionIdentityKey

export function sessionRunStatus(file: string, project?: string): SessionRunStatus | undefined {
  return statuses.get(key(file, project))
}

export function setSessionRunStatus(file: string | null, status: SessionRunStatus | null, project?: string) {
  if (!file) return
  if (status) statuses.set(key(file, project), status)
  else statuses.delete(key(file, project))
}

/** A viewed terminal result is acknowledged; an in-flight turn stays visible. */
export function acknowledgeSessionRunStatus(file: string | null, project?: string) {
  if (!file) return
  const status = sessionRunStatus(file, project)
  if (status === "completed" || status === "error") statuses.delete(key(file, project))
}
