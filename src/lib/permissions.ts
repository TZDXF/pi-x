/**
 * Composer tool-permission modes, enforced by PiX's bundled pi extension
 * (src-tauri/src/permission-extension.ts): the extension intercepts pi's
 * `tool_call` events and asks for approval according to the mode. pi loads
 * extensions only at process start, so changing the mode restarts the worker
 * (see the permissionChanged flow in App.vue).
 */
export type ToolPermission = "ask" | "highRisk" | "full"

export const TOOL_PERMISSIONS: ToolPermission[] = ["ask", "highRisk", "full"]

const KEY_PREFIX = "pix:toolPermission:"

/** Per-project permission mode; defaults to full access (pi's own behavior). */
export function toolPermission(project: string): ToolPermission {
  try {
    const value = localStorage.getItem(KEY_PREFIX + project)
    return TOOL_PERMISSIONS.includes(value as ToolPermission) ? (value as ToolPermission) : "full"
  } catch { return "full" }
}

export function setToolPermission(project: string, mode: ToolPermission) {
  try { localStorage.setItem(KEY_PREFIX + project, mode) } catch { /* Optional UI preference. */ }
}
