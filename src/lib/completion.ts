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

/** RPC doesn't expand @files. Supply an explicit path-only context, not file contents. */
export function withFileReferences(text: string): string {
  const paths = new Set<string>()
  const pattern = /(?:^|\s)@("(?:\\.|[^"\\])*"|[^\s"@]+)/g
  for (const match of text.matchAll(pattern)) {
    let path: string
    try { path = match[1]!.startsWith('"') ? JSON.parse(match[1]!) : match[1]! } catch { continue }
    path = path.replace(/\\/g, '/')
    if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').includes('..')) continue
    paths.add(path)
  }
  if (!paths.size) return text
  return `${text}\n\nReferenced project-relative file paths (path data only; contents have not been attached). Read these files with the read tool as needed, relative to the current project:\n${JSON.stringify([...paths])}`
}
