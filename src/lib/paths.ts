/** Display helpers for filesystem paths shown in the UI. */

/** True when `path` looks like a Windows path (drive letter, UNC, or backslashes). */
export function isWindowsPath(path: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.includes("\\")
}

/**
 * Join path segments for display using the separator style of `base`, so a
 * Windows project root never renders as `C:\project/.pi/settings.json`.
 */
export function joinDisplayPath(base: string, ...segments: string[]): string {
  const sep = isWindowsPath(base) ? "\\" : "/"
  const root = base.replace(/[\\/]+$/, "")
  const rest = segments
    .map((s) => s.replace(/^[\\/]+/, "").replace(/[\\/]+$/, "").replace(/\//g, sep))
    .filter((s) => s.length > 0)
  return [root, ...rest].filter((s) => s.length > 0).join(sep)
}
