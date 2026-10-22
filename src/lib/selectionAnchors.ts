/**
 * 划词引用锚点的 DOM 工具：把 DOM 选区换算为相对消息正文根节点的字符区间，
 * 并支持从字符区间还原页面选区、求任意偏移处的边界矩形。
 * 索引数字标记由 Vue 以覆盖层渲染，闪亮高亮仅追加无文本覆盖层，避免改写正文与虚拟 DOM 冲突；
 * 依赖真实 document/window；单元测试通过模拟 DOM 几何数据覆盖定位分支。
 */

/** (node, offset) 边界相对 root 的前缀文本长度；node 越界或无效时返回 null。 */
function prefixLength(root: Element, node: Node, offset: number): number | null {
  try {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.setEnd(node, offset)
    return range.toString().length
  } catch {
    return null
  }
}

export interface SelectionOffsets {
  start: number
  end: number
}

/** 捕获选区相对 root 的字符区间（start<=end，与选区方向无关）。 */
export function captureOffsets(root: Element, range: Range): SelectionOffsets | null {
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null
  const start = prefixLength(root, range.startContainer, range.startOffset)
  const end = prefixLength(root, range.endContainer, range.endOffset)
  if (start === null || end === null) return null
  return { start: Math.min(start, end), end: Math.max(start, end) }
}

/** 在 range 上把 start 或 end 设到 root 内第 target 个字符处的边界；内容变短时钳制到末尾。 */
function locateBoundary(root: Element, target: number, range: Range, which: "start" | "end"): boolean {
  const set = which === "start" ? range.setStart.bind(range) : range.setEnd.bind(range)
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let acc = 0
  let current = walker.nextNode()
  let last: Text | null = null
  while (current) {
    const text = current as Text
    const length = text.data.length
    if (target <= acc + length) {
      set(text, target - acc)
      return true
    }
    acc += length
    last = text
    current = walker.nextNode()
  }
  if (last) {
    set(last, last.data.length)
    return true
  }
  // 空正文：边界只能落在 root 自身上。
  set(root, 0)
  return true
}

/** 把字符区间还原为页面选区（划词回显）；root 或内容不匹配时返回 false。 */
export function restoreSelection(root: Element, start: number, end: number): boolean {
  const range = document.createRange()
  if (!locateBoundary(root, start, range, "start")) return false
  if (!locateBoundary(root, end, range, "end")) return false
  const selection = window.getSelection()
  if (!selection) return false
  selection.removeAllRanges()
  selection.addRange(range)
  return true
}

/** 字符偏移前的末字符矩形（视口坐标），用于把索引标记固定在已选文本末行。 */
export function boundaryRect(root: Element, offset: number): DOMRect | null {
  const range = document.createRange()
  // 折行边界的折叠 Range 可能落在下一行行首，优先读取已选末字符的矩形。
  if (offset > 0) {
    locateBoundary(root, offset - 1, range, "start")
    locateBoundary(root, offset, range, "end")
    const rects = range.getClientRects()
    for (let i = rects.length - 1; i >= 0; i--) {
      const rect = rects[i]!
      if (rect.width > 0 && rect.height > 0) return rect
    }
  }
  if (!locateBoundary(root, offset, range, "start")) return null
  range.collapse(true)
  const rects = range.getClientRects()
  if (rects.length) return rects[rects.length - 1]
  const rect = range.getBoundingClientRect()
  if (rect.width || rect.height || rect.top || rect.left) return rect
  return null
}

/** 选区末端的矩形（多行选区取最后一行），用于把浮层锚定在划词结束处。 */
export function selectionEndRect(range: Range): DOMRect | null {
  const rects = range.getClientRects()
  if (rects.length) return rects[rects.length - 1]
  const rect = range.getBoundingClientRect()
  if (rect.width || rect.height || rect.top || rect.left) return rect
  return null
}

/** 用无文本覆盖层闪亮原文，不改动正文节点或浏览器选区；返回提前清理函数。 */
export function flashSelection(root: Element, start: number, end: number): () => void {
  const range = document.createRange()
  locateBoundary(root, start, range, "start")
  locateBoundary(root, end, range, "end")
  const origin = root.getBoundingClientRect()
  const overlays: HTMLElement[] = []
  for (const rect of Array.from(range.getClientRects())) {
    if (!rect.width || !rect.height) continue
    const overlay = document.createElement("span")
    overlay.setAttribute("aria-hidden", "true")
    Object.assign(overlay.style, {
      position: "absolute",
      pointerEvents: "none",
      left: `${rect.left - origin.left + root.scrollLeft}px`,
      top: `${rect.top - origin.top + root.scrollTop}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      borderRadius: "2px",
      background: "color-mix(in srgb, var(--primary) 28%, transparent)",
    })
    root.appendChild(overlay)
    overlay.animate([{ opacity: 1 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }], {
      duration: 1500,
      easing: "ease-out",
      fill: "forwards",
    })
    overlays.push(overlay)
  }
  const timer = setTimeout(cleanup, 1500)
  function cleanup() {
    clearTimeout(timer)
    overlays.forEach(overlay => overlay.remove())
  }
  return cleanup
}
