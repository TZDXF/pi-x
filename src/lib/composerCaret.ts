/** Reveal the selection focus without scrolling the surrounding conversation. */
export function revealEditorCaret(root: HTMLElement): void {
  const selection = root.ownerDocument.getSelection()
  if (root.ownerDocument.activeElement !== root || !selection?.focusNode || !root.contains(selection.focusNode)) return
  const range = root.ownerDocument.createRange()
  range.setStart(selection.focusNode, selection.focusOffset)
  range.collapse(true)
  let rect = Array.from(range.getClientRects()).find(rect => rect.height > 0)
  // Collapsed element-boundary ranges (notably empty lines) may have no box.
  // Measure the following BR/text instead, without inserting nodes or touching undo history.
  if (!rect && selection.focusNode.nodeType === 1) {
    const next = selection.focusNode.childNodes[selection.focusOffset]
    if (next) {
      range.selectNode(next)
      rect = Array.from(range.getClientRects()).find(rect => rect.height > 0)
    }
  }
  if (!rect) return
  const bounds = root.getBoundingClientRect()
  const top = bounds.top + root.clientTop + 8
  const bottom = bounds.top + root.clientTop + root.clientHeight - 8
  if (rect.bottom > bottom) root.scrollTop += rect.bottom - bottom
  else if (rect.top < top) root.scrollTop -= top - rect.top
}
