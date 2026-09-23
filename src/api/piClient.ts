import { activeRuntimeId } from "@/stores/runtime"
import { RECONNECTED_EVENT, invoke, listen } from "./transport"
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

export interface ModelRef {
  provider: string
  modelId: string
}

export interface AppConfig {
  piPath?: string
  lastProject?: string
  /** Custom title model; ignored while titleFollowMain is set. */
  titleModel?: ModelRef
  /** Title generation follows the default model instead of titleModel. */
  titleFollowMain?: boolean
}

export interface PiSettings {
  defaultProvider?: string | null
  defaultModel?: string | null
  defaultThinkingLevel?: import("./protocol").ThinkingLevel
  modelThinkingLevels?: Record<string, import("./protocol").ThinkingLevel>
  skills: string[]
}
export const getPiSettings = () => invoke<PiSettings>("pi_settings_get")
export const savePiSettings = (settings: Partial<Pick<PiSettings, "defaultProvider" | "defaultModel" | "skills">>) =>
  invoke<void>("pi_settings_save", { settings })

export interface HostedSkill {
  name: string
  description: string
  path: string
  kind: "directory" | "file"
  enabled: boolean
}
export const listHostedSkills = () => invoke<HostedSkill[]>("skills_hosted_list")
export const importHostedSkills = (sources: string[], overwrite = false) =>
  invoke<{ imported: string[]; conflicts: string[] }>("skills_hosted_import", { sources, overwrite })
export const deleteHostedSkill = (path: string) => invoke<void>("skills_hosted_delete", { path })
export const setHostedSkillsEnabled = (paths: string[]) =>
  invoke<void>("skills_hosted_set_enabled", { paths })

/** A skill Pi auto-discovers outside ~/.pix/skills (read-only). */
export interface DiscoveredSkill {
  name: string
  description: string
  path: string
  scope: "user" | "project"
  hosted: boolean
}
export const listDiscoveredSkills = (project?: string | null) =>
  invoke<DiscoveredSkill[]>("skills_discovered_list", { project: project ?? null })

export const detectPi = (customPath?: string) =>
  invoke<PiInfo>("pi_detect", { customPath: customPath ?? null })

export const getConfig = () => invoke<AppConfig>("app_config_get")

export const saveConfig = (config: AppConfig) => invoke<void>("app_config_save", { config })

export const getGlobalPrompt = () => invoke<string>("global_prompt_get")

export const saveGlobalPrompt = (prompt: string) =>
  invoke<void>("global_prompt_save", { prompt })

export const trustStatus = (project: string) => invoke<TrustStatus>("trust_status", { project })

export const trustSave = (project: string, trusted: boolean, trustParent: boolean) =>
  invoke<unknown>("trust_save", { project, trusted, trustParent })

export const spawnPi = (project: string, sessionFile?: string, runtimeId = activeRuntimeId.value) =>
  invoke<void>("rpc_spawn", { project, sessionFile: sessionFile ?? null, runtimeId })

export const killPi = (runtimeId = activeRuntimeId.value) => invoke<void>("rpc_kill", { runtimeId })

export const piRunning = (runtimeId = activeRuntimeId.value) => invoke<boolean>("rpc_running", { runtimeId })

export interface SessionMeta {
  file: string
  id: string
  cwd: string
  timestamp?: string
  mtimeMs: number
  title?: string | null
  archived?: boolean
  preview?: string | null
}

export const listSessions = (project: string) =>
  invoke<SessionMeta[]>("session_list", { project })

/** On-disk mtime of a session file, used to detect external edits. */
export const sessionMtime = (file: string) => invoke<number>("session_mtime", { file })

/** Session files under ~/.pi/agent/sessions changed on disk (possibly externally). */
export function onSessionsChanged(handler: (files: string[]) => void): Promise<() => void> {
  return listen<{ files: string[] }>("pi://sessions-changed", e => handler(e.payload.files))
}

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
export function rpcRequest<T = unknown>(command: Record<string, unknown>, runtimeId = activeRuntimeId.value): Promise<RpcResponse<T>> {
  return invoke<RpcResponse<T>>("rpc_request", { command, runtimeId })
}

/** Fire-and-forget write (extension_ui_response has no response record). */
export function rpcNotify(command: ExtensionUiResponse | Record<string, unknown>, runtimeId = activeRuntimeId.value): Promise<void> {
  return invoke<void>("rpc_notify", { command, runtimeId })
}

/** Subscribe to all non-response stdout records (agent events, extension UI requests). */
export function onPiEvent(handler: (event: Record<string, any>) => void): Promise<() => void> {
  return listen<Record<string, any>>("pi://event", e => handler(e.payload))
}

export function onPiExit(handler: (runtimeId?: string) => void): Promise<() => void> {
  return listen<{ runtimeId?: string }>("pi://exit", e => handler(e.payload.runtimeId))
}

export function onPiStderr(handler: (line: string, runtimeId?: string) => void): Promise<() => void> {
  return listen<{ line: string; runtimeId?: string }>("pi://stderr", e => handler(e.payload.line, e.payload.runtimeId))
}

/** Remote transport re-established after an unexpected drop (never fired on
 *  desktop). Events during the gap are lost; handlers should re-sync state. */
export function onReconnected(handler: () => void): Promise<() => void> {
  return listen(RECONNECTED_EVENT, () => handler())
}

export interface RemoteStatus { enabled: boolean; port: number; urls: string[] }
export const remoteStatus = () => invoke<RemoteStatus>("remote_status")
export const remoteSet = (enabled: boolean, port: number) => invoke<RemoteStatus>("remote_set", { enabled, port })

// ---- pi models.json (custom provider / model management) ----

/** One model entry inside a provider's `models` array. Unknown fields
 *  (cost, compat, headers, samplingParams, thinkingLevelMap, …) are kept
 *  verbatim so editing never silently drops pi features. */
export interface ModelEntry {
  id: string
  name?: string
  api?: string
  reasoning?: boolean
  input?: ("text" | "image")[]
  contextWindow?: number
  maxTokens?: number
  [key: string]: unknown
}

/** One provider entry under `providers` in models.json. */
export interface ProviderEntry {
  name?: string
  baseUrl?: string
  api?: string
  apiKey?: string
  authHeader?: boolean
  headers?: Record<string, string>
  models?: ModelEntry[]
  [key: string]: unknown
}

/** pi's `~/.pi/agent/models.json` document. */
export interface ModelsConfig {
  providers: Record<string, ProviderEntry>
  [key: string]: unknown
}

export const getModelsConfig = () => invoke<ModelsConfig>("models_config_get")

export const saveModelsConfig = (config: ModelsConfig) =>
  invoke<void>("models_config_save", { config })

/** Returns the resulting session-file mtime so callers can sync change detection. */
export const updateSession = (file: string, title: string | null, archived: boolean) =>
  invoke<number>("session_update", { file, title, archived })

/** List archived sessions across every project, newest first. */
export const listArchivedSessions = () => invoke<SessionMeta[]>("session_list_archived")

/** Permanently delete a session file (and its PiX metadata sidecar). */
export const deleteSession = (file: string) => invoke<void>("session_delete", { file })
export interface WorkspaceGitInfo { branch: string; branches: string[]; worktree: boolean }
export const workspaceGitInfo = (project: string) => invoke<WorkspaceGitInfo>("workspace_git_info", { project })
export const createWorkspaceGit = (project: string, branch: string, worktree: boolean) =>
  invoke<string>("workspace_git_create", { project, branch, worktree })

/** Independent, tool-free title generation; never changes the active RPC model. */
export const generateSessionTitle = (file: string, message: string) =>
  invoke<string | null>("session_generate_title", { file, message })

// ---- pi package management (official catalog + pi install/remove/update) ----

export interface CatalogPackage {
  name: string
  description: string
  author: string
  /** Downloads in the last month. */
  downloadsMonth: number
  /** Last publish time, unix epoch ms. */
  updatedMs: number
  /** Resource types: extension / skill / prompt / theme / package. */
  types: string[]
  /** Install source, e.g. "npm:pi-mcp-adapter". */
  source: string
  detailUrl: string
  npmUrl: string | null
}

export interface InstalledPackage {
  /** Install source as stored in settings.json. */
  source: string
  scope: "global" | "project"
  /** Resource filters when the object form is used (verbatim passthrough). */
  filters: Record<string, unknown> | null
}

/** Fetch the official pi package catalog (pi.dev/packages). */
export const packageCatalog = () => invoke<CatalogPackage[]>("package_catalog")

/** Installed packages from global settings and the given project's settings. */
export const packageList = (project?: string) =>
  invoke<InstalledPackage[]>("package_list", { project: project ?? null })

/** Install a package; scope "project" installs project-locally (pi install -l). */
export const packageInstall = (source: string, scope: "global" | "project" = "global", project?: string) =>
  invoke<string>("package_install", { source, scope, project: project ?? null })

/** Remove a package by its source string as shown in packageList. */
export const packageRemove = (source: string, scope: "global" | "project" = "global", project?: string) =>
  invoke<string>("package_remove", { source, scope, project: project ?? null })

/** Update one package, or all packages when source is omitted. */
export const packageUpdate = (source?: string) =>
  invoke<string>("package_update", { source: source ?? null })

/** One loadable resource (extension / skill / prompt / theme file) of an installed package. */
export interface PackageResource {
  resourceType: "extensions" | "skills" | "prompts" | "themes"
  /** Path relative to the package root. */
  path: string
  enabled: boolean
}

/** List an installed package's resources with their enabled state. */
export const packageResources = (source: string, scope: "global" | "project", project?: string) =>
  invoke<PackageResource[]>("package_resources", { source, scope, project: project ?? null })

/** Enable or disable one resource of an installed package (writes +path / -path filters). */
export const packageSetResource = (
  source: string,
  scope: "global" | "project",
  resourceType: PackageResource["resourceType"],
  path: string,
  enabled: boolean,
  project?: string,
) =>
  invoke<void>("package_set_resource", {
    source,
    scope,
    resourceType,
    path,
    enabled,
    project: project ?? null,
  })

/** Normalize an install source ("npm:@scope/pkg@1.2.3", "pkg", "@scope/pkg") to a bare package name. */
export function packageNameOf(source: string): string {
  let s = source.trim()
  if (s.startsWith("npm:")) s = s.slice(4)
  // strip version/tag suffix, keeping scoped names intact (@scope/pkg@1.0 → @scope/pkg)
  const at = s.lastIndexOf("@")
  if (at > 0) s = s.slice(0, at)
  return s
}

export interface RunningSession { runtimeId: string; project: string; state: import("./protocol").SessionState }
export const listRunningSessions = () => invoke<RunningSession[]>("rpc_sessions")
