/** TUI commands with equivalent, supported desktop RPC actions. */
export const desktopCommands = ['new', 'compact', 'export'] as const

export interface CompletionToken { kind: 'command' | 'file'; query: string; start: number; end: number }

/** Only inspect the token at the caret, never consume text following it. */
export function completionToken(text: string, caret: number, end = caret): CompletionToken | null {
  if (caret !== end) return null
  const before = text.slice(0, caret)
  const command = /^\/([^\s/]*)$/.exec(before)
  if (command) return { kind: 'command', query: command[1]!, start: 0, end: caret }
  const file = /(?:^|\s)@(?:"([^"\n]*)|([^\s"@]*))$/.exec(before)
  if (!file) return null
  return { kind: 'file', query: file[1] ?? file[2] ?? '', start: file.index + file[0].indexOf('@'), end: caret }
}

export function fileReference(path: string): string {
  return `@${JSON.stringify(path.replace(/\\/g, '/'))}`
}

export function insertCompletion(text: string, token: CompletionToken, value: string) {
  const valueText = token.kind === 'command' ? `/${value}` : fileReference(value)
  // Complete the rest of a partially edited token as well.
  const tail = text.slice(token.end)
  const suffix = token.kind === 'command' ? /^[^\s]*/.exec(tail)![0].length
    : text[token.start + 1] === '"' ? (/^[^"\n]*(?:"|$)/.exec(tail)?.[0].length ?? 0)
    : /^[^\s]*/.exec(tail)![0].length
  const remaining = tail.slice(suffix)
  const insertion = valueText + (/^\s/.test(remaining) ? '' : ' ')
  return { text: text.slice(0, token.start) + insertion + remaining, caret: token.start + insertion.length }
}

/** RPC doesn't expand @files. Only include paths inside selected workspace roots. */
export function withFileReferences(text: string, additionalRoots: string[] = []): string {
  const relative = new Set<string>()
  const absolute = new Set<string>()
  const roots = additionalRoots.map(root => root.replace(/\\/g, '/').replace(/\/+$/, ''))
  const pattern = /(?:^|\s)@("(?:\\.|[^"\\])*"|[^\s"@]+)/g
  for (const match of text.matchAll(pattern)) {
    let path: string
    try { path = match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1]! } catch { continue }
    path = path.replace(/\\/g, '/')
    if (!path || path.split('/').includes('..')) continue
    if (path.startsWith('/') || /^[a-z]:/i.test(path)) {
      if (roots.some(root => {
        const windows = /^[a-z]:|^\/\//i.test(root)
        return (windows ? path.toLowerCase() : path).startsWith((windows ? root.toLowerCase() : root) + '/')
      })) absolute.add(path)
    } else relative.add(path)
  }
  if (!relative.size && !absolute.size) return text
  let expanded = text
  if (relative.size) expanded += `\n\nReferenced project-relative file paths (path data only; contents have not been attached). Read these files with the read tool as needed, relative to the current project:\n${JSON.stringify([...relative])}`
  if (absolute.size) expanded += `\n\nReferenced files in other selected workspace directories (path data only; contents have not been attached). Read via absolute paths as needed:\n${JSON.stringify([...absolute])}`
  return expanded
}

/** Interleave results so the primary root cannot hide every secondary hit. */
export function mergeWorkspaceFiles<T extends { path: string; name: string; dir: string }>(
  current: string, roots: string[], results: Array<T[] | null>, limit = 50,
): T[] {
  const merged: T[] = []
  const seen = new Set<string>()
  for (let offset = 0; merged.length < limit && results.some(item => item && offset < item.length); offset++) {
    for (let index = 0; index < roots.length; index++) {
      const hit = results[index]?.[offset]
      if (!hit) continue
      const root = roots[index]!
      const path = root === current ? hit.path : `${root.replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${hit.path}`
      if (seen.has(path)) continue
      seen.add(path)
      merged.push({ ...hit, path, dir: root === current ? hit.dir : `${root.split(/[\\/]/).pop()}/${hit.dir}` })
      if (merged.length === limit) break
    }
  }
  return merged
}
