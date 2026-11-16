/** Display directory containing `path` ("" for project-root entries). */
export function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/")
  return index < 0 ? "" : path.slice(0, index)
}

/**
 * Directories to re-list after a filesystem change.
 *
 * A change can affect a directory in two ways: an entry inside it changed (its
 * parent needs a new listing) or the entry is itself a loaded directory that
 * was removed, renamed or replaced (it needs a new listing too). Only
 * directories that are already loaded are refreshed: a change deeper in the
 * tree cannot affect a directory the user never expanded, and re-listing it
 * would break the lazily loaded tree. The project root is always refreshed so
 * top-level additions and removals appear even when only a subdirectory is
 * loaded.
 */
export function directoriesToReload(paths: string[], loaded: Record<string, unknown>): string[] {
  // 顺序固定为：根 → 每个变化涉及的父目录 → 变化涉及的已加载目录本身。
  const parents = new Set<string>([""])
  const selves = new Set<string>()
  for (const path of paths) {
    if (path === "") continue
    if (path in loaded) selves.add(path)
    const dir = parentDirectory(path)
    if (dir === "" || dir in loaded) parents.add(dir)
  }
  return [...parents, ...[...selves].filter(path => !parents.has(path))]
}

/** True when the open preview must be re-read because its file changed on disk. */
export function previewNeedsReload(selected: string | null, paths: string[]): boolean {
  return !!selected && paths.includes(selected)
}

/**
 * Directories the user can actually see (expanded ones) plus the previewed
 * file: the scope reported to the backend.
 *
 * A collapsed directory is still cached, but its contents are off screen, so
 * keeping it out of `interest` stops events for invisible subtrees; expanding
 * again re-lists it (see `ProjectFiles.toggle`), which keeps the cached
 * children from going stale.
 */
export function interestPaths(visibleDirectories: Iterable<string>, selected: string | null): string[] {
  const paths = [""]
  for (const dir of visibleDirectories) if (dir && !paths.includes(dir)) paths.push(dir)
  if (selected && !paths.includes(selected)) paths.push(selected)
  return paths
}
