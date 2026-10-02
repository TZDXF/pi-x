import { activeRuntimeId } from "@/stores/runtime"
import { open as chooseDirectory } from "@tauri-apps/plugin-dialog"
import { join } from "@tauri-apps/api/path"
import { baseName } from "@/lib/paths"
import { invoke, isDesktop, listen } from "../transport"
import { openPath } from "./files"
import { rpcRequest } from "./rpc"

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

export const listSessions = (project: string) => invoke<SessionMeta[]>("session_list", { project })

/** On-disk mtime of a session file, used to detect external edits. */
export const sessionMtime = (file: string) => invoke<number>("session_mtime", { file })

/** Full current-branch transcript from the session file. Unlike RPC
 *  get_messages (projected context), this keeps turns collapsed by
 *  compaction and the compaction entries themselves. */
export const sessionHistory = (file: string) => invoke<unknown[]>("session_history", { file })

export interface SessionLastError {
  /** `message.timestamp` (ms since epoch) of the failed assistant message. */
  timestamp?: number
  errorMessage: string
}

/**
 * Last provider error recorded in the session file. pi drops most retried
 * failures from the RPC message projection, so history supplements the final
 * failure from disk.
 */
export const sessionLastError = (file: string) => invoke<SessionLastError | null>("session_last_error", { file })

/** Duplicate a saved session file with a fresh id; returns the new file path. */
export const duplicateSessionFile = (file: string) => invoke<string>("session_duplicate", { file })

/** Session files under ~/.pi/agent/sessions changed on disk (possibly externally). */
export function onSessionsChanged(handler: (files: string[]) => void): Promise<() => void> {
  return listen<{ files: string[] }>("pi://sessions-changed", e => handler(e.payload.files))
}

async function chooseExportPath(sessionFile?: string | null, directoryTitle?: string): Promise<string | null> {
  const directory = await chooseDirectory({ directory: true, title: directoryTitle })
  if (typeof directory !== "string") return null
  const base = baseName(sessionFile ?? "").replace(/\.jsonl$/i, "") || `session-${Date.now()}`
  const filename = `pi-session-${base.replace(/[^a-zA-Z0-9._-]/g, "_")}.html`
  return join(directory, filename)
}

function downloadExport(path: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }))
  try {
    const link = document.createElement("a")
    link.href = url
    link.download = baseName(path) || "session.html"
    document.body.append(link)
    link.click()
    link.remove()
  } finally {
    // Keep the object URL alive until the browser has consumed the download.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
  }
}

/** Export the current runtime. Desktop picks a destination folder; remote
 * browsers download to their browser-managed location. */
export async function exportSessionHtml(
  runtimeId = activeRuntimeId.value,
  sessionFile?: string | null,
  directoryTitle?: string,
): Promise<boolean> {
  if (isDesktop) {
    const outputPath = await chooseExportPath(sessionFile, directoryTitle)
    if (!outputPath) return false
    const result = await rpcRequest<{ path?: string }>({ type: "export_html", outputPath }, runtimeId)
    if (!result.success || !result.data?.path) throw new Error(result.error ?? "Export failed")
    await openPath(result.data.path)
    return true
  }
  const { path, html } = await invoke<{ path: string; html: string }>("session_export_html", { runtimeId })
  downloadExport(path, html)
  return true
}

/** Export a saved session by file path without selecting it or touching any
 * Pi runtime, including when another conversation is currently active. */
export async function exportSessionFileHtml(file: string, directoryTitle?: string): Promise<boolean> {
  if (isDesktop) {
    const outputPath = await chooseExportPath(file, directoryTitle)
    if (!outputPath) return false
    const path = await invoke<string>("session_export_file", { file, outputPath })
    await openPath(path)
    return true
  }
  const { path, html } = await invoke<{ path: string; html: string }>("session_export_html", { file })
  downloadExport(path, html)
  return true
}

/** Returns the resulting session-file mtime so callers can sync change detection. */
export const updateSession = (file: string, title: string | null, archived: boolean) =>
  invoke<number>("session_update", { file, title, archived })

/** List archived sessions across every project, newest first. */
export const listArchivedSessions = () => invoke<SessionMeta[]>("session_list_archived")

/** Permanently delete a session file (and its PiX metadata sidecar). */
export const deleteSession = (file: string) => invoke<void>("session_delete", { file })

/** Independent, tool-free title generation; never changes the active RPC model.
 *  `overwrite` replaces an existing session name (first-question edits). */
export const generateSessionTitle = (file: string, message: string, overwrite = false) =>
  invoke<string | null>("session_generate_title", { file, message, overwrite })
