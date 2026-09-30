/** Naming of pi's built-in extensions and tools.
 *
 *  Since pi 0.99 they are named `builtin:<name>` (`builtin:mcp`, `builtin:read`)
 *  in errors, diagnostics and RPC source info. Earlier releases spelled the same
 *  built-ins `<builtin:name>` or `<inline:name>`, so cached data and strings
 *  captured from older pi versions can still carry those. Every parser here
 *  accepts both spellings, and the display helpers always emit the current one. */

/** Current pi prefix of a built-in extension or tool name. */
export const BUILTIN_PREFIX = "builtin:"

/** Legacy angle-bracket spellings: `<builtin:name>` and `<inline:name>`. */
const LEGACY_BUILTIN = /^<(builtin|inline):(.+)>$/

/**
 * Bare `<name>` of a built-in extension or tool, accepting the legacy
 * `<builtin:name>` / `<inline:name>` spellings, or null for a real file path.
 */
export function builtinExtensionName(path: string | null | undefined): string | null {
  const value = path?.trim()
  if (!value) return null
  if (value.startsWith(BUILTIN_PREFIX)) return value.slice(BUILTIN_PREFIX.length) || null
  return LEGACY_BUILTIN.exec(value)?.[2] || null
}

/** True when `path` names a built-in extension rather than a file on disk. */
export function isBuiltinExtensionPath(path: string | null | undefined): boolean {
  return builtinExtensionName(path) !== null
}

/**
 * Canonical `builtin:<name>` for a built-in path; any other path is returned
 * unchanged, so callers can normalize pi-provided values without a branch.
 */
export function builtinExtensionPath(path: string): string {
  const name = builtinExtensionName(path)
  return name ? BUILTIN_PREFIX + name : path
}
