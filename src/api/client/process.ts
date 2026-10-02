import { activeRuntimeId } from "@/stores/runtime"
import { invoke } from "../transport"

export interface PiInfo {
  found: boolean
  path: string | null
  version: string | null
  source: "config" | "path" | "fallback" | null
  hint: string
}

export const detectPi = (customPath?: string) => invoke<PiInfo>("pi_detect", { customPath: customPath ?? null })

export interface WorkspaceContext {
  name: string
  primary: string
  roots: string[]
}

export const spawnPi = (
  project: string,
  sessionFile?: string,
  runtimeId = activeRuntimeId.value,
  workspace?: WorkspaceContext,
) => invoke<void>("rpc_spawn", { project, sessionFile: sessionFile ?? null, runtimeId, workspace: workspace ?? null })

export const killPi = (runtimeId = activeRuntimeId.value) => invoke<void>("rpc_kill", { runtimeId })

export const piRunning = (runtimeId = activeRuntimeId.value) => invoke<boolean>("rpc_running", { runtimeId })

/** Fire-and-forget diagnostic log line, persisted by the backend to ~/.pix/logs. */
export const pixLog = (message: string, runtimeId: string | null = null) => {
  try {
    void invoke("pix_log", { message, runtimeId }).catch(() => {})
  } catch {
    /* tests / offline */
  }
}

export interface RunningSession {
  runtimeId: string
  project: string
  state: import("../protocol").SessionState
}
export const listRunningSessions = () => invoke<RunningSession[]>("rpc_sessions")
