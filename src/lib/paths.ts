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
    .map(s =>
      s
        .replace(/^[\\/]+/, "")
        .replace(/[\\/]+$/, "")
        .replace(/\//g, sep),
    )
    .filter(s => s.length > 0)
  return [root, ...rest].filter(s => s.length > 0).join(sep)
}

/** Separators normalized to forward slashes, so Windows paths compare and render consistently. */
export function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, "/")
}

/** Stable project key across folder pickers, config and stored session cwd values. */
export function normalizeProjectPath(path: string): string {
  const normalized = normalizeSlashes(path)
  if (/^[a-zA-Z]:\/+$/.test(normalized)) return `${normalized[0]}:/`
  if (/^\/+$/.test(normalized)) return normalized.startsWith("//") ? "//" : "/"
  return normalized.replace(/\/+$/, "")
}

/**
 * Final path segment (file or folder name) with separators normalized. Empty or
 * all-separator input returns the input itself, so callers can chain fallbacks.
 */
export function baseName(path: string): string {
  return normalizeSlashes(path).split("/").filter(Boolean).pop() ?? path
}

/**
 * Path shown in the UI: relative to `root` when the file lives inside the
 * project directory, the original path otherwise. Separator styles are
 * normalized to forward slashes; comparison folds letter case for Windows
 * drive-letter and UNC paths, so POSIX directories that differ by case stay
 * distinct.
 */
export function relativeDisplayPath(path: string, root: string): string {
  const target = normalizeSlashes(path)
  const base = normalizeSlashes(root).replace(/\/+$/, "")
  if (!base) return target
  const windows =
    /^[a-z]:\//i.test(base) || /^[a-z]:\//i.test(target) || base.startsWith("//") || target.startsWith("//")
  const fold = (value: string) => (windows ? value.toLowerCase() : value)
  if (!fold(target).startsWith(`${fold(base)}/`)) return target
  return target.slice(base.length + 1)
}

/**
 * True when `path` is absolute (POSIX root, Windows drive letter, UNC share) or
 * a home-relative path the backend expands. Relative paths are rejected because
 * the app never knows which directory they would resolve against.
 */
export function isAbsolutePath(path: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith("\\\\") ||
    path.startsWith("/") ||
    path === "~" ||
    path.startsWith("~/") ||
    path.startsWith("~\\")
  )
}

/**
 * Same-location comparison for paths coming from different sources (a picker,
 * the config file, pi's session header). Separators and trailing slashes are
 * normalized; letter case is folded only for Windows-style paths, so POSIX
 * directories that differ by case stay distinct.
 */
export function samePath(a: string, b: string): boolean {
  const normalize = (value: string) => normalizeSlashes(value).replace(/\/+$/, "")
  const left = normalize(a)
  const right = normalize(b)
  if (!left || !right) return false
  const windows = /^[a-z]:\//i.test(left) || /^[a-z]:\//i.test(right) || left.startsWith("//") || right.startsWith("//")
  return windows ? left.toLowerCase() === right.toLowerCase() : left === right
}
