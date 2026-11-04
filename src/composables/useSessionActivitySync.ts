import { getCurrentScope, onScopeDispose, watch } from "vue"
import { useWorkspaceStore } from "@/stores/workspace"
import { sessionIdentityKey } from "@/lib/sessionIdentity"
import {
  mergeSessionActivity,
  mergeSessionAcknowledgement,
  registerSessionActivitySync,
  type SessionActivity,
  type SessionActivitySync,
} from "@/stores/sessionRunStatus"

export interface SessionActivityWorkspace extends SessionActivitySync {
  sessionActivities: Record<string, SessionActivity>
  sessionAcknowledgements: Record<string, string>
}

/** App-level bridge. Remote hydration never calls the local write registration. */
export function useSessionActivitySync(workspace: SessionActivityWorkspace = useWorkspaceStore()) {
  const unregister = registerSessionActivitySync({
    recordSessionActivity: activity => workspace.recordSessionActivity(activity),
    acknowledgeSessionActivity: (file, project, runId) => workspace.acknowledgeSessionActivity(file, project, runId),
  })
  const stopWatching = watch(
    () => [workspace.sessionActivities, workspace.sessionAcknowledgements] as const,
    () => {
      // Merge activities before receipts so only exact runIds are acknowledged.
      for (const activity of Object.values(workspace.sessionActivities)) mergeSessionActivity(activity)
      for (const activity of Object.values(workspace.sessionActivities)) {
        const runId = workspace.sessionAcknowledgements[sessionIdentityKey(activity.file, activity.project)]
        if (runId) mergeSessionAcknowledgement(activity.file, activity.project, runId)
      }
    },
    { immediate: true, deep: true, flush: "sync" },
  )
  const stop = () => {
    stopWatching()
    unregister()
  }
  if (getCurrentScope()) onScopeDispose(stop)
  return { stop }
}
