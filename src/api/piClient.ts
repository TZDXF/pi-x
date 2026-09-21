import { invoke } from "@tauri-apps/api/core"
import { listen } from "@tauri-apps/api/event"
import type { ExtensionUiResponse, RpcResponse } from "./protocol"

// ---- process / config commands (Rust side) ----

export interface PiInfo {
  found: boolean
  path: string | null
  version: string | null
  source: "config" | "path" | "fallback" | null
  hint: string
}

export interface TrustStatus {
  projectPath: string
  parentPath: string | null
  hasTrustRequiringResources: boolean
  decision: boolean | null
  needsDecision: boolean
}

export interface AppConfig {
  piPath?: string
  lastProject?: string
}

export const detectPi = (customPath?: string) =>
  invoke<PiInfo>("pi_detect", { customPath: customPath ?? null })

export const getConfig = () => invoke<AppConfig>("app_config_get")

export const saveConfig = (config: AppConfig) => invoke<void>("app_config_save", { config })

export const trustStatus = (project: string) => invoke<TrustStatus>("trust_status", { project })

export const trustSave = (project: string, trusted: boolean, trustParent: boolean) =>
  invoke<unknown>("trust_save", { project, trusted, trustParent })

export const spawnPi = (project: string, sessionFile?: string) =>
  invoke<void>("rpc_spawn", { project, sessionFile: sessionFile ?? null })

export const killPi = () => invoke<void>("rpc_kill")

export const piRunning = () => invoke<boolean>("rpc_running")

export interface SessionMeta {
  file: string
  id: string
  cwd: string
  timestamp?: string
  mtimeMs: number
  preview?: string | null
}

export const listSessions = (project: string) =>
  invoke<SessionMeta[]>("session_list", { project })

export interface FileHit {
  path: string
  name: string
  dir: string
}

export const searchFiles = (project: string, query: string) =>
  invoke<FileHit[]>("search_files", { project, query })

export const openPath = (path: string) => invoke<void>("open_path", { path })

// ---- RPC bridge ----

/** Correlated request: resolves with the `response` record that carries our id. */
export function rpcRequest<T = unknown>(command: Record<string, unknown>): Promise<RpcResponse<T>> {
  return invoke<RpcResponse<T>>("rpc_request", { command })
}

/** Fire-and-forget write (extension_ui_response has no response record). */
export function rpcNotify(command: ExtensionUiResponse | Record<string, unknown>): Promise<void> {
  return invoke<void>("rpc_notify", { command })
}

/** Subscribe to all non-response stdout records (agent events, extension UI requests). */
export function onPiEvent(handler: (event: Record<string, any>) => void): Promise<() => void> {
  return listen<Record<string, any>>("pi://event", e => handler(e.payload))
}

export function onPiExit(handler: () => void): Promise<() => void> {
  return listen("pi://exit", () => handler())
}

export function onPiStderr(handler: (line: string) => void): Promise<() => void> {
  return listen<{ line: string }>("pi://stderr", e => handler(e.payload.line))
}
