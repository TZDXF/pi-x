/**
 * 对话划词引用的纯逻辑：对齐 ZCode 的 "# userselect:" 约定——选中文本以
 * JSON 数组放进 ```userselect 围栏追加到 prompt 尾部，发送合同只保留
 * {text}（文件来源保留 {path, text}），内部身份字段不随消息发出。
 * 本文件保持无依赖以便单元测试直接加载。
 */

export type ConversationSelectionSource = "user" | "assistant"

/** wire/展示共用的最小引用：历史解析只恢复这些字段。 */
export interface ConversationSelectionText {
  text: string
  path?: string
}

export interface PendingConversationSelection extends ConversationSelectionText {
  id: string
  source: ConversationSelectionSource
}

export interface ParsedConversationSelection extends ConversationSelectionText {
  id: string
}

/** 单条引用文本上限，超长整条拒绝（对齐 ZCode CONVERSATION_SELECTION_MAX_TEXT_LENGTH）。 */
export const CONVERSATION_SELECTION_MAX_TEXT_LENGTH = 8_000
export const CONVERSATION_SELECTION_MAX_COUNT = 8
export const CONVERSATION_SELECTION_MAX_TOTAL_LENGTH = 16_000

export type ConversationSelectionLimitReason = "count" | "single" | "total"

/** 对齐 ZCode 的 attachment id 生成：优先 crypto.randomUUID，非安全上下文退回时间戳随机串。 */
export function createConversationSelectionId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `conversation-selection-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function dedupeKey(selection: ConversationSelectionText) {
  return [selection.path ?? "", selection.text].join("\0")
}

export type ConversationSelectionAppendResult =
  | { ok: true; selections: readonly ConversationSelectionText[]; duplicate: boolean }
  | { ok: false; reason: ConversationSelectionLimitReason }

/**
 * 追加一条引用：单条超限 → single；重复文本 → duplicate（不重复添加）；
 * 条数满 → count；累计长度超限 → total。选中文字与已有引用完全一致时视为重复。
 */
export function appendConversationSelection(
  current: readonly ConversationSelectionText[],
  draft: ConversationSelectionText,
): ConversationSelectionAppendResult {
  if (draft.text.length > CONVERSATION_SELECTION_MAX_TEXT_LENGTH) return { ok: false, reason: "single" }
  if (current.some(item => dedupeKey(item) === dedupeKey(draft)))
    return { ok: true, selections: current, duplicate: true }
  if (current.length >= CONVERSATION_SELECTION_MAX_COUNT) return { ok: false, reason: "count" }
  const totalLength = current.reduce((sum, item) => sum + item.text.length, 0)
  if (totalLength + draft.text.length > CONVERSATION_SELECTION_MAX_TOTAL_LENGTH) return { ok: false, reason: "total" }
  return { ok: true, selections: [...current, draft], duplicate: false }
}

/**
 * 引用块追加到消息末尾；没有引用时原样返回（仅 trimEnd，同代码批注的约定）。
 * 只发送 {text}（及可选 {path}），不带 source 等内部身份字段。
 */
export function buildPromptWithConversationSelections(
  visibleContent: string,
  selections: readonly ConversationSelectionText[],
): string {
  const content = visibleContent.trimEnd()
  if (!selections.length) return content.trim()
  const wire = selections.map(selection =>
    selection.path?.trim() ? { path: selection.path, text: selection.text } : { text: selection.text },
  )
  const block = ["# userselect:", "```userselect", JSON.stringify(wire), "```"].join("\n")
  return `${content}${content ? "\n\n" : ""}${block}`
}

const USER_SELECT_BLOCK_PATTERN = /(?:^|\n\n)# userselect:\n```userselect\n([\s\S]*?)\n```\s*$/

function isConversationSelectionText(value: unknown): value is ConversationSelectionText {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Partial<ConversationSelectionText>
  if (typeof candidate.text !== "string") return false
  if ("path" in value && (typeof candidate.path !== "string" || !candidate.path.trim())) return false
  return Object.keys(value).every(key => key === "text" || key === "path")
}

/**
 * 解析 prompt 尾部的 "# userselect:" 块：气泡只显示块之前的正文，
 * 块内 JSON 还原为引用列表。识别不到或 JSON 不合法时原文原样返回。
 * 注意不能用 multiline 的 `$` 定位块头，否则会匹配到正文里任意行尾。
 */
export function parsePromptConversationSelections(content: string): {
  visibleContent: string
  selections: ParsedConversationSelection[]
} {
  const blockMatch = USER_SELECT_BLOCK_PATTERN.exec(content)
  if (!blockMatch) return { visibleContent: content, selections: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(blockMatch[1] ?? "[]")
  } catch {
    return { visibleContent: content, selections: [] }
  }
  if (!Array.isArray(parsed)) return { visibleContent: content, selections: [] }
  const selections: ParsedConversationSelection[] = []
  for (const value of parsed) {
    if (!isConversationSelectionText(value)) return { visibleContent: content, selections: [] }
    selections.push({
      id: `parsed-conversation-selection-${selections.length + 1}`,
      text: value.text,
      ...(value.path?.trim() ? { path: value.path } : {}),
    })
  }
  if (!selections.length) return { visibleContent: content, selections: [] }
  return { visibleContent: content.slice(0, blockMatch.index).trimEnd(), selections }
}
