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

const COMMENT_HEADING = /^## Comment(?:[ \t]+\d+)?[ \t]*\r?$/m
const COMMENT_FENCE = /^`{3,}code-comment[ \t]*$/

export function formatCodeComment(draft: CodeCommentDraft, index: number): string {
  const selected = draft.selectedText.trim().slice(0, MAX_SELECTED_TEXT_LENGTH)
  const fence = fenceFor(selected)
  const comment = draft.comment.trim()
  // 正文可以包含完整的伪条目，单靠字段 lookahead 无法消歧；仅在需要时加围栏。
  // 保留标记本身也是合法正文，需再包一层，避免解析时误当成外层围栏。
  const protectComment = COMMENT_HEADING.test(comment) || COMMENT_FENCE.test(comment.split(/\r?\n/)[0])
  let commentBody = comment
  if (protectComment) {
    const commentFence = fenceFor(comment)
    commentBody = [commentFence + "code-comment", comment, commentFence].join("\n")
  }
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
    commentBody,
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

/** 只接受与开头同长度的闭合围栏，不让内层 Markdown 围栏提前结束引用。 */
function readFencedText(lines: readonly string[], start: number): { text: string; nextLine: number } | null {
  const opening = /^(`{3,})[^`]*$/.exec((lines[start] ?? "").trimEnd())
  if (!opening) return null
  for (let end = start + 1; end < lines.length; end++) {
    if (lines[end].trimEnd() === opening[1]) {
      return {
        text: lines
          .slice(start + 1, end)
          .join("\n")
          .trim(),
        nextLine: end + 1,
      }
    }
  }
  return null
}

/**
 * 解析 prompt 尾部的 "# Code comments:" 块：按字段顺序读取，选区围栏内不识别条目头。
 * 普通批注只有「Comment 标题 + File 字段」才是下一条的边界；受保护批注完整读到闭合围栏。
 * 任一条目不能解析就原样返回整个块，避免剥离时隐藏损坏条目或未知内容。
 */
export function parsePromptCodeComments(content: string): ParsedPromptComments {
  const unparsed = { visibleContent: content, comments: [] }
  const blockMatch = /(?:^|\n\n)# Code comments:\s*\n\n([\s\S]*?)\s*$/.exec(content)
  if (!blockMatch) return unparsed
  // 保留正文行尾的 CR；只在读取结构字段时去掉它，避免改变 Windows 选区内容。
  const lines = blockMatch[1].split("\n")
  const lineAt = (index: number) => (lines[index] ?? "").replace(/\r$/, "")
  const comments: ParsedCodeComment[] = []
  let cursor = 0
  const skipBlankLines = () => {
    while (cursor < lines.length && !lines[cursor].trim()) cursor++
  }
  const isItemStart = (line: number) => COMMENT_HEADING.test(lines[line] ?? "") && /^File:/.test(lines[line + 1] ?? "")

  while (cursor < lines.length) {
    skipBlankLines()
    if (cursor === lines.length) break
    // 兼容旧消息中首条不带 Comment 标题的写法。
    if (COMMENT_HEADING.test(lines[cursor])) cursor++
    const fileMatch = /^File:[ \t]*(.+)$/.exec(lineAt(cursor++))
    if (/^Side:/.test(lines[cursor] ?? "")) cursor++
    const linesMatch = /^Lines:[ \t]*(.+)$/.exec(lineAt(cursor++))
    const range = linesMatch ? parseLineRange(linesMatch[1]) : null
    if (!fileMatch?.[1].trim() || !range || !/^Selected text:[ \t]*$/.test(lineAt(cursor++))) return unparsed
    const selected = readFencedText(lines, cursor)
    if (!selected) return unparsed
    cursor = selected.nextLine
    skipBlankLines()
    const commentMatch = /^Comment:[ \t]*(.*)$/.exec(lineAt(cursor++))
    if (!commentMatch) return unparsed

    let comment: string
    if (!commentMatch[1] && COMMENT_FENCE.test(lineAt(cursor))) {
      const body = readFencedText(lines, cursor)
      if (!body) return unparsed
      comment = body.text
      cursor = body.nextLine
      skipBlankLines()
      // 围栏外的非结构文本不能被静默丢弃。
      if (cursor < lines.length && !isItemStart(cursor)) return unparsed
    } else {
      const start = cursor
      while (cursor < lines.length && !isItemStart(cursor)) cursor++
      comment = [commentMatch[1], ...lines.slice(start, cursor)].join("\n").trim()
    }
    comments.push({
      id: `parsed-code-comment-${comments.length + 1}-${range.start}-${range.end}`,
      path: fileMatch[1].trim(),
      startLine: range.start,
      endLine: range.end,
      selectedText: selected.text,
      comment,
    })
  }
  if (!comments.length) return unparsed
  return { visibleContent: content.slice(0, blockMatch.index).trimEnd(), comments }
}
