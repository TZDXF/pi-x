import { reactive } from "vue"

/** Status of the most recent turn, keyed by session file rather than selected runtime.
 * Keep terminal statuses after a dormant conversation store is evicted. */
export type SessionRunStatus = "running" | "completed" | "error"
const statuses = reactive(new Map<string, SessionRunStatus>())
const key = (file: string) => file.replace(/\\/g, "/")

export function sessionRunStatus(file: string): SessionRunStatus | undefined {
  return statuses.get(key(file))
}

export function setSessionRunStatus(file: string | null, status: SessionRunStatus | null) {
  if (!file) return
  if (status) statuses.set(key(file), status)
  else statuses.delete(key(file))
}

/** A viewed terminal result is acknowledged; an in-flight turn stays visible. */
export function acknowledgeSessionRunStatus(file: string | null) {
  if (!file) return
  const status = sessionRunStatus(file)
  if (status === "completed" || status === "error") statuses.delete(key(file))
}
