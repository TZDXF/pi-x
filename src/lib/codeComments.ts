/**
 * 代码批注的纯逻辑：DOM 选区到行号的换算、批注的 markdown 格式化。
 * 格式对齐 ZCode 的 "# Code comments:" 约定（省略 PR 评审语义的 Side 字段），
 * 批注随下一条消息发给 agent，本文件保持无依赖以便单元测试直接加载。
 */

export interface CodeCommentRange {
  start: number
  end: number
}

export interface CodeCommentDraft {
  path: string
  startLine: number
  endLine: number
  selectedText: string
  comment: string
}

/** 单条批注里引用的选中文本上限，避免整文件级别的选区撑爆消息。 */
export const MAX_SELECTED_TEXT_LENGTH = 2000

/**
 * 从 DOM 选区反推行号范围：两端锚点都必须落在 root 内的 [data-line] 行上。
 * 换行方向（anchor/focus 谁先谁后）不影响结果，统一取较小行为起点。
 */
export function selectionLineRange(root: Element | null, selection: Selection | null): CodeCommentRange | null {
  if (!root || !selection || selection.isCollapsed || selection.rangeCount === 0) return null
  const anchor = anchorLine(root, selection.anchorNode)
  const focus = anchorLine(root, selection.focusNode)
  if (anchor === null || focus === null) return null
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
}

function anchorLine(root: Element, node: Node | null): number | null {
  // 用 nodeType 判断元素节点而非 instanceof，便于在非 DOM 测试环境用桩对象覆盖。
  const element = node?.nodeType === 1 ? (node as Element) : node?.parentElement
  const line = element?.closest("[data-line]") as HTMLElement | null
  if (!line || !root.contains(line)) return null
  const value = Number(line.dataset.line)
  return Number.isFinite(value) && value >= 1 ? value : null
}

/** 选中内容里出现 ``` 时换更长的围栏，保证 markdown 代码块不提前闭合。 */
function fenceFor(text: string) {
  let fence = "```"
  while (text.includes(fence)) fence += "`"
  return fence
}

function lineLabel(start: number, end: number) {
  return start === end ? String(start) : `${start}-${end}`
}

export function formatCodeComment(draft: CodeCommentDraft, index: number): string {
  const selected = draft.selectedText.trim().slice(0, MAX_SELECTED_TEXT_LENGTH)
  const fence = fenceFor(selected)
  return [
    `## Comment ${index + 1}`,
    `File: ${draft.path}`,
    `Lines: ${lineLabel(draft.startLine, draft.endLine)}`,
    "Selected text:",
    fence,
    selected,
    fence,
    "Comment:",
    draft.comment.trim(),
  ].join("\n")
}

export function buildCodeCommentsBlock(drafts: readonly CodeCommentDraft[]): string {
  if (!drafts.length) return ""
  return `# Code comments:\n\n${drafts.map((draft, index) => formatCodeComment(draft, index)).join("\n\n")}`
}

/** 把批注块追加到消息末尾；没有批注时只做 trim，不改变原文。 */
export function buildPromptWithCodeComments(text: string, drafts: readonly CodeCommentDraft[]): string {
  const content = text.trimEnd()
  const block = buildCodeCommentsBlock(drafts)
  if (!block) return content.trim()
  return `${content}${content ? "\n\n" : ""}${block}`
}
