import { isAbsolutePath, normalizeSlashes, relativeDisplayPath } from "./paths"
import { isRemoteUri } from "./ssh"

/** Resolve serialized cross-folder paths only against registered project roots. */
export function resolveCodeCommentFile(
  path: string,
  roots: readonly string[],
): { project: string; path: string } | null {
  const file = normalizeSlashes(path)
  const validRelative = (value: string) =>
    !!value &&
    !isAbsolutePath(value) &&
    !isRemoteUri(value) &&
    value.split("/").every(part => !!part && part !== "." && part !== "..")
  if (isAbsolutePath(file) || isRemoteUri(file)) {
    for (const root of [...roots].sort((a, b) => b.length - a.length)) {
      const relative = relativeDisplayPath(file, root)
      if (relative !== file && validRelative(relative)) return { project: root, path: relative }
    }
    return null
  }
  return roots[0] && validRelative(file) ? { project: roots[0], path: file } : null
}
