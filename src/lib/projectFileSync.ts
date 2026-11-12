/** Display directory containing `path` ("" for project-root entries). */
export function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/")
  return index < 0 ? "" : path.slice(0, index)
}

/**
 * Directories to re-list after a filesystem change.
 *
 * Only directories that are currently loaded are refreshed: a change deeper in
 * the tree cannot affect a directory the user never expanded, and re-listing
 * it would break the lazily loaded tree. The project root is always refreshed
 * so new top-level entries appear even when only a subdirectory was loaded.
 */
export function directoriesToReload(paths: string[], loaded: Record<string, unknown>): string[] {
  const result = new Set<string>([""])
  for (const path of paths) {
    const dir = parentDirectory(path)
    if (dir === "" || dir in loaded) result.add(dir)
  }
  return [...result]
}

/** True when the open preview must be re-read because its file changed on disk. */
export function previewNeedsReload(selected: string | null, paths: string[]): boolean {
  return !!selected && paths.includes(selected)
}
