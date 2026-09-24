export interface ComposerPart { kind: 'text' | 'file' | 'session' | 'command'; raw: string; label: string }

/** Keep transport text intact; only replace complete references in the editor display. */
export function composerParts(text: string): ComposerPart[] {
  const parts: ComposerPart[] = []
  const pattern = /@session\("(?:\\.|[^"\\])*"\)|@"(?:\\.|[^"\\])*"|@[^\s"@]+(?=\s)|^\/[^\s/]+(?=\s)/g
  let cursor = 0
  for (const match of text.matchAll(pattern)) {
    const raw = match[0]
    const start = match.index
    if (start > 0 && !/\s/.test(text[start - 1]!)) continue
    let kind: ComposerPart['kind']
    let label: string
    if (raw.startsWith('/')) {
      kind = 'command'
      label = raw.slice(1)
    } else {
      const session = raw.startsWith('@session(')
      const value = session ? raw.slice(9, -1) : raw.slice(1)
      try { label = value.startsWith('"') ? JSON.parse(value) as string : value } catch { continue }
      if (!label || label.split(/[\\/]/).includes('..')) continue
      label = label.replace(/\\/g, '/').split('/').pop() || label
      kind = session ? 'session' : 'file'
    }
    if (start > cursor) parts.push({ kind: 'text', raw: text.slice(cursor, start), label: text.slice(cursor, start) })
    parts.push({ kind, raw, label })
    cursor = start + raw.length
  }
  if (cursor < text.length) parts.push({ kind: 'text', raw: text.slice(cursor), label: text.slice(cursor) })
  return parts
}

/** DOM length differs from displayed text length for atomic reference chips. */
export function editorText(root: HTMLElement): string {
  function read(node: Node): string {
    if (node instanceof HTMLElement && node.dataset.raw) return node.dataset.raw
    if (node.nodeName === 'BR') return '\n'
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || ''
    return Array.from(node.childNodes).map(read).join('')
  }
  return read(root)
}

export function editorSelection(root: HTMLElement): { start: number; end: number } {
  const selection = window.getSelection()
  function position(node: Node | null, offset: number): number {
    if (!node || !root.contains(node)) return editorText(root).length
    let count = 0
    function visit(current: Node): boolean {
      if (current === node) {
        if (current.nodeType === Node.TEXT_NODE) count += Math.min(offset, current.textContent?.length || 0)
        else for (let i = 0; i < Math.min(offset, current.childNodes.length); i++) count += editorText(current.childNodes[i] as HTMLElement).length
        return true
      }
      if (current instanceof HTMLElement && current.dataset.raw) { count += current.dataset.raw.length; return false }
      if (current.nodeName === 'BR') { count++; return false }
      if (current.nodeType === Node.TEXT_NODE) { count += current.textContent?.length || 0; return false }
      for (const child of current.childNodes) if (visit(child)) return true
      return false
    }
    visit(root)
    return count
  }
  const a = position(selection?.anchorNode || null, selection?.anchorOffset || 0)
  const b = position(selection?.focusNode || null, selection?.focusOffset || 0)
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

export function setEditorCaret(root: HTMLElement, offset: number): void {
  const range = document.createRange()
  let remaining = offset
  function seek(node: Node): boolean {
    if (node instanceof HTMLElement && node.dataset.raw) return false
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length || 0
      if (remaining <= length) { range.setStart(node, remaining); return true }
      remaining -= length
      return false
    }
    if (node.nodeName === 'BR') { remaining--; return false }
    for (const child of node.childNodes) {
      if (child instanceof HTMLElement && child.dataset.raw) {
        if (remaining <= child.dataset.raw.length) {
          range.setStartBefore(child)
          if (remaining > child.dataset.raw.length / 2) range.setStartAfter(child)
          return true
        }
        remaining -= child.dataset.raw.length
      } else if (seek(child)) return true
    }
    return false
  }
  if (!seek(root)) {
    range.selectNodeContents(root)
    range.collapse(false)
  } else range.collapse(true)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}
