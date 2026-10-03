/**
 * 代码批注的纯逻辑：DOM 选区到行号的换算、批注的 markdown 格式化与解析。
 * 格式对齐 ZCode 的 "# Code comments:" 约定（含 PR 评审语义的 Side: R），
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

/**
 * 批注路径写入 prompt 时的最终形态：跨目录批注（root 指向会话目录之外的目录）
 * 用「目录前缀 + 相对路径」，对齐 @ 提及跨目录文件的路径约定；其余保持相对路径。
 */
export function commentFilePath(comment: { path: string; root?: string }): string {
  if (!comment.root) return comment.path
  const root = comment.root.replace(/\\/g, "/").replace(/\/+$/, "")
  return `${root}/${comment.path}`
}

export function formatCodeComment(draft: CodeCommentDraft, index: number): string {
  const selected = draft.selectedText.trim().slice(0, MAX_SELECTED_TEXT_LENGTH)
  const fence = fenceFor(selected)
  return [
    `## Comment ${index + 1}`,
    `File: ${draft.path}`,
    "Side: R",
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

/** 从持久化消息里解析回批注附件，供历史气泡剥离批注块后展示。 */
export interface ParsedCodeComment extends CodeCommentDraft {
  id: string
}

export interface ParsedPromptComments {
  visibleContent: string
  comments: ParsedCodeComment[]
}

function parseLineRange(value: string): CodeCommentRange | null {
  const match = /^(\d+)(?:\s*-\s*L?(\d+))?$/.exec(value.trim().replace(/^L/i, ""))
  if (!match) return null
  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) return null
  return { start, end }
}

/**
 * 解析 prompt 尾部的 "# Code comments:" 块：气泡只显示块之前的正文，
 * 块内各条按 ZCode 的字段约定还原为批注附件。识别不到时原文原样返回。
 * 注意不能用 multiline 的 `$` 定位块头，否则非贪婪匹配会在首条 Comment 后提前截断。
 */
export function parsePromptCodeComments(content: string): ParsedPromptComments {
  const blockMatch = /(?:^|\n\n)# Code comments:\s*\n\n([\s\S]*?)\s*$/.exec(content)
  if (!blockMatch || blockMatch.index < 0) return { visibleContent: content, comments: [] }
  const rawItems = blockMatch[1]
    .split(/\n(?=## Comment(?:\s+\d+)?\n)/)
    .map(item => item.trim())
    .filter(Boolean)
  const comments: ParsedCodeComment[] = []
  for (const rawItem of rawItems) {
    const fileMatch = /^File:\s*(.+)$/m.exec(rawItem)
    const linesMatch = /^Lines:\s*(.+)$/m.exec(rawItem)
    const bodyMatch = /Selected text:\s*\n```(?:[^\n`]*)?\n([\s\S]*?)\n```\s*\nComment:\s*\n?([\s\S]*)$/m.exec(rawItem)
    const range = linesMatch ? parseLineRange(linesMatch[1]) : null
    if (!fileMatch?.[1].trim() || !range || !bodyMatch) continue
    comments.push({
      id: `parsed-code-comment-${comments.length + 1}-${range.start}-${range.end}`,
      path: fileMatch[1].trim(),
      startLine: range.start,
      endLine: range.end,
      selectedText: bodyMatch[1].trim(),
      comment: bodyMatch[2].trim(),
    })
  }
  if (!comments.length) return { visibleContent: content, comments: [] }
  return { visibleContent: content.slice(0, blockMatch.index).trimEnd(), comments }
}
