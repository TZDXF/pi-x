/**
 * aux（辅助对话）的**父上下文**：取材归一、截断规则、32k 护栏与折叠块拼装/剥离。
 *
 * 规格来源 `docs/aux-chat-spec.md` §3/§4。本文件保持**零依赖**（不引入任何模块），
 * 因为三处调用方对它的期望不同却必须共用同一份实现：
 * - `lib/promptContexts.ts`（解析/组装，首发与读回共用）；
 * - `lib/conversationTimeline.ts`（摘要只要提问文本，且该文件在单测里用最小
 *   require 垫片加载）；
 * - `stores/session/history.ts`（历史重建：完整 prompt + 可见正文）。
 *
 * 截断规则（**三源同一**）：以"本轮已提交的 realUser"为锚点，排除其后的
 * assistant/toolResult —— 不是"删掉所有 assistant/tool 只留 user 文本"。
 * `live` 标记**不作为**提交判据（最终消息同样标 live）；提交与否由来源身份
 * （`get_entries` 的 entry id / 消息的 `_entryId`）决定，未在已接纳集合里的消息
 * 一律丢弃（这正是"流式半轮"进不来的地方）。
 */

export const AUX_PARENT_CONTEXT_START = "<aux_parent_context>"
export const AUX_PARENT_CONTEXT_END = "</aux_parent_context>"

/**
 * 父上下文的硬护栏（字符数）。
 *
 * 这个上限存在的理由就是成本：父上下文前缀在后续**每一轮**都作为历史被全价重发
 * （不主张任何前缀缓存收益），所以它是护栏而不是"目标"。
 */
export const AUX_PARENT_CONTEXT_MAX_CHARS = 32_000

/** 父会话确实还没有已提交输入时的顶部提示（不报错，只是把事实说清楚）。 */
export const AUX_PARENT_CONTEXT_EMPTY_NOTICE = "未取到父上下文：父会话还没有已提交的对话内容。"

/** 整组丢弃后的尾部标注；`{count}` 是被省略的轮次数（组数）。 */
export const AUX_PARENT_CONTEXT_TRUNCATED_NOTE = "（已省略 {count} 轮更早的对话）"

const ROLE_LABELS = {
  user: "【用户】",
  assistant: "【助手】",
  toolResult: "【工具结果】",
  compaction: "【压缩摘要】",
  modelChange: "【切换模型】",
} as const

export type AuxContextRole = keyof typeof ROLE_LABELS

/** 归一化后的一条已提交消息（三源共用同一形状）。 */
export interface AuxContextMessage {
  role: AuxContextRole
  text: string
  /** 来源提供的已提交身份（session entry id / 消息 `_entryId`）。 */
  entryId?: string
  /** 工具调用与结果的配对键；同一组内的配对绝不按字符拆开。 */
  toolCallId?: string
  /** assistant 消息里的工具调用 id（跨组配对的另一半）。 */
  toolCallIds?: string[]
}

/** 一个"轮次组"：一条 user 消息 + 其后的 assistant/toolResult，直到下一条 user。 */
export interface AuxContextGroup {
  messages: AuxContextMessage[]
  text: string
  chars: number
}

export interface StripAuxParentContextResult {
  /** **原样**块（含标签，不含分隔空行）；无块时为 `null`。 */
  block: string | null
  /** 块内正文（去掉首尾各一个换行）。 */
  inner: string
  /** 块之后的其余 prompt（尾部 userselect / Code comments 块原样保留）。 */
  rest: string
}

/**
 * 剥离 prompt 最前面的 `<aux_parent_context>…</aux_parent_context>` 块。
 *
 * 只有"整块"（开标签 + 闭合标签 + 分隔空行）才算命中：正文里恰好写了这个字样
 * （比如贴了一段文档）不会被误伤，用户的提问也不会被吞掉。
 *
 * `rest` 保留尾部上下文块（userselect / Code comments），因为历史气泡还要靠它们
 * 渲染引用 chips —— 这里只负责拆父上下文块。
 */
export function stripAuxParentContextBlock(content: string, start: number = 0): StripAuxParentContextResult {
  if (!content.startsWith(AUX_PARENT_CONTEXT_START, start)) return { block: null, inner: "", rest: content }
  const from = start + AUX_PARENT_CONTEXT_START.length
  const end = content.indexOf(AUX_PARENT_CONTEXT_END, from)
  if (end < 0) return { block: null, inner: "", rest: content }
  const block = content.slice(start, end + AUX_PARENT_CONTEXT_END.length)
  const after = content.slice(end + AUX_PARENT_CONTEXT_END.length)
  // 块与提问正文之间用一个空行分隔；容忍 CRLF 与多余空行，不吞掉正文首行。
  const separator = /^[ \t]*\r?\n[ \t]*\r?\n/.exec(after)
  const rest = separator ? after.slice(separator[0].length) : after.replace(/^[ \t]*\r?\n?/, "")
  const inner = block
    .slice(AUX_PARENT_CONTEXT_START.length, block.length - AUX_PARENT_CONTEXT_END.length)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "")
  return { block, inner, rest }
}

/** 组装折叠块：`<aux_parent_context>` + 正文 + `</aux_parent_context>`。 */
export function buildAuxParentContextBlock(inner: string): string {
  return [AUX_PARENT_CONTEXT_START, inner.trim(), AUX_PARENT_CONTEXT_END].join("\n")
}

/** 把折叠块置于 prompt **最前**，后接一个空行与提问正文（§4 的格式契约）。 */
export function withAuxParentContext(block: string | null, prompt: string): string {
  const rest = prompt.trim()
  if (!block) return prompt
  return rest ? `${block}\n\n${rest}` : block
}

/** 只取"提问正文"（摘要/时间线/复制用），不包含父上下文块。 */
export function withoutAuxParentContext(content: string): string {
  return stripAuxParentContextBlock(content).rest
}

/** 消息 `content` 的纯文本（字符串或 text 块的拼接；非文本块不贡献）。 */
export function auxContextText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .map(part => {
      const block = part as { type?: unknown; text?: unknown }
      return block?.type === "text" && typeof block.text === "string" ? block.text : ""
    })
    .join("")
}

/** 工具调用渲染成一行，保留"调用 ↔ 结果"的配对可读性（不参与字符级切分）。 */
function toolCallLines(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const lines: string[] = []
  for (const part of content) {
    const block = part as { type?: unknown; name?: unknown; arguments?: unknown; argsText?: unknown }
    if (block?.type !== "toolCall") continue
    const name = typeof block.name === "string" ? block.name : "tool"
    const args =
      typeof block.argsText === "string"
        ? block.argsText
        : typeof block.arguments === "string"
          ? block.arguments
          : block.arguments === undefined
            ? ""
            : JSON.stringify(block.arguments)
    lines.push(`→ ${name}(${args})`)
  }
  return lines
}

/** 工具调用的 id 列表（跨组配对修复用：组被丢弃后不留孤立的工具结果）。 */
function toolCallIds(content: unknown): string[] {
  if (!Array.isArray(content)) return []
  const ids: string[] = []
  for (const part of content) {
    const block = part as { type?: unknown; id?: unknown; callId?: unknown }
    if (block?.type !== "toolCall") continue
    const id = typeof block.id === "string" ? block.id : typeof block.callId === "string" ? block.callId : ""
    if (id) ids.push(id)
  }
  return ids
}

/**
 * 从 `get_entries` 的条目数组重建**已提交活动分支**：`leafId` 沿 `parentId` 回溯。
 *
 * 这是主路径（§3）：`get_entries` 只返回会话管理器里**已追加**的条目，流式中的
 * 半轮根本不在里面；回溯是为了不把被 fork/编辑后遗留的旁支当成当前对话。
 */
export function activeBranchEntries(entries: readonly unknown[], leafId: string | null): unknown[] {
  const parents = new Map<string, string | null>()
  let lastId: string | null = null
  for (const raw of entries) {
    const entry = raw as { id?: unknown; parentId?: unknown }
    if (typeof entry?.id !== "string") continue
    parents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null)
    lastId = entry.id
  }
  let cursor = leafId ?? lastId
  const branch = new Set<string>()
  while (cursor && !branch.has(cursor)) {
    branch.add(cursor)
    cursor = parents.get(cursor) ?? null
  }
  return entries.filter(raw => {
    const id = (raw as { id?: unknown })?.id
    return typeof id === "string" && branch.has(id)
  })
}

/** `get_entries` 条目 → 归一化消息（message / compaction / model_change）。 */
export function auxMessagesFromEntries(entries: readonly unknown[]): AuxContextMessage[] {
  const messages: AuxContextMessage[] = []
  for (const raw of entries) {
    const entry = raw as {
      id?: unknown
      type?: unknown
      message?: { role?: unknown; content?: unknown; toolCallId?: unknown }
      summary?: unknown
      provider?: unknown
      modelId?: unknown
    }
    if (!entry || typeof entry !== "object") continue
    const entryId = typeof entry.id === "string" ? entry.id : undefined
    const type = typeof entry.type === "string" ? entry.type : ""
    if (type === "message") {
      const message = entry.message ?? {}
      const role = typeof message.role === "string" ? message.role : ""
      if (role === "user") {
        messages.push({ role: "user", text: auxContextText(message.content), ...(entryId ? { entryId } : {}) })
      } else if (role === "assistant") {
        const text = [auxContextText(message.content), ...toolCallLines(message.content)]
          .filter(part => part.trim())
          .join("\n")
        const calls = toolCallIds(message.content)
        messages.push({
          role: "assistant",
          text,
          ...(entryId ? { entryId } : {}),
          ...(calls.length ? { toolCallIds: calls } : {}),
        })
      } else if (role === "toolResult") {
        messages.push({
          role: "toolResult",
          text: auxContextText(message.content),
          ...(entryId ? { entryId } : {}),
          ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
        })
      }
      continue
    }
    if (type === "compaction") {
      messages.push({
        role: "compaction",
        text: typeof entry.summary === "string" ? entry.summary : "",
        ...(entryId ? { entryId } : {}),
      })
      continue
    }
    if (type === "model_change") {
      const provider = typeof entry.provider === "string" ? entry.provider : ""
      const modelId = typeof entry.modelId === "string" ? entry.modelId : ""
      messages.push({
        role: "modelChange",
        text: [provider, modelId].filter(Boolean).join("/"),
        ...(entryId ? { entryId } : {}),
      })
    }
  }
  return messages
}

/**
 * 消息数组（`session_history` 的文件投影、RPC `get_messages` 投影）→ 归一化消息。
 *
 * 两种投影的 role 形状一致（`user`/`assistant`/`toolResult`/`compactionSummary`/
 * `model_change`），因此同一个归一化函数覆盖它们 —— 这正是"三源同一"的落点。
 */
export function auxMessagesFromMessages(messages: readonly unknown[]): AuxContextMessage[] {
  const result: AuxContextMessage[] = []
  for (const raw of messages) {
    const message = raw as {
      role?: unknown
      content?: unknown
      summary?: unknown
      type?: unknown
      provider?: unknown
      modelId?: unknown
      toolCallId?: unknown
      _entryId?: unknown
    }
    if (!message || typeof message !== "object") continue
    const entryId = typeof message._entryId === "string" ? message._entryId : undefined
    if (message.type === "model_change") {
      const provider = typeof message.provider === "string" ? message.provider : ""
      const modelId = typeof message.modelId === "string" ? message.modelId : ""
      result.push({
        role: "modelChange",
        text: [provider, modelId].filter(Boolean).join("/"),
        ...(entryId ? { entryId } : {}),
      })
      continue
    }
    const role = typeof message.role === "string" ? message.role : ""
    if (role === "user") {
      result.push({ role: "user", text: auxContextText(message.content), ...(entryId ? { entryId } : {}) })
    } else if (role === "assistant") {
      const text = [auxContextText(message.content), ...toolCallLines(message.content)]
        .filter(part => part.trim())
        .join("\n")
      const calls = toolCallIds(message.content)
      result.push({
        role: "assistant",
        text,
        ...(entryId ? { entryId } : {}),
        ...(calls.length ? { toolCallIds: calls } : {}),
      })
    } else if (role === "toolResult") {
      result.push({
        role: "toolResult",
        text: auxContextText(message.content),
        ...(entryId ? { entryId } : {}),
        ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
      })
    } else if (role === "compactionSummary") {
      result.push({
        role: "compaction",
        text: typeof message.summary === "string" ? message.summary : "",
        ...(entryId ? { entryId } : {}),
      })
    }
  }
  return result
}

export interface AuxCommittedAnchorOptions {
  /** 父会话是否正在流式：是则只保留到最后一条已提交 user（其后是半轮）。 */
  streaming?: boolean
  /**
   * 已接纳的 entry 身份集合（`get_entries` 的成功返回）。
   *
   * - 给了集合 → **权威**判据：消息必须带 `entryId` 且在集合里；无 id 的一律丢掉。
   * - 没给集合 → **不能**当“全部已提交”：改用**来源自证**（消息必须自带
   *   `entryId`/`_entryId`），无 id 的一律丢掉。这正是“拿不到集合就全放行”的反面。
   */
  committedIds?: ReadonlySet<string>
}

/** 身份判据来源（诊断/测试用）：权威集合 / 来源自证 / 没有可用身份。 */
export type AuxContextIdentity = "authoritative" | "source" | "none"

/**
 * 截断规则（三源同一）：身份过滤 + 锚点切片。
 *
 * 1. **身份**（见 `committedIds`）：权威集合优先；没有集合时只接受**自带 id** 的消息。
 *    两条都不成立的输入不算已提交 —— `live:true` 之外，身份是唯一可靠判据（最终
 *    消息也标 live，所以不能用它）。
 * 2. **锚点**：父会话正在流式时，最后一条 user 就是本轮提问，**其后**的
 *    assistant/toolResult 属于半轮，必须排除（不是“删掉所有 assistant”）。
 *    非流式时整段对话都是已提交内容，一条不删。
 */
export function applyCommittedAnchor(
  messages: readonly AuxContextMessage[],
  options: AuxCommittedAnchorOptions = {},
): { messages: AuxContextMessage[]; identity: AuxContextIdentity } {
  const ids = options.committedIds
  const kept = ids
    ? messages.filter(message => !!message.entryId && ids.has(message.entryId))
    : messages.filter(message => !!message.entryId)
  const identity: AuxContextIdentity = !kept.length ? "none" : ids ? "authoritative" : "source"
  if (!options.streaming) return { messages: kept, identity }
  let anchor = -1
  for (let index = kept.length - 1; index >= 0; index--) {
    if (kept[index]?.role === "user") {
      anchor = index
      break
    }
  }
  return { messages: anchor < 0 ? kept : kept.slice(0, anchor + 1), identity }
}

function renderMessage(message: AuxContextMessage): string {
  const label = ROLE_LABELS[message.role]
  const text = message.text.trim()
  return text ? `${label}${text}` : ""
}

/** 按"轮次组"切分：一条 user + 其后的 assistant/toolResult（组内配对不拆）。 */
export function groupAuxContextMessages(messages: readonly AuxContextMessage[]): AuxContextGroup[] {
  const groups: AuxContextGroup[] = []
  let current: AuxContextMessage[] | null = null
  for (const message of messages) {
    if (message.role === "user" || current === null) {
      current = []
      groups.push({ messages: current, text: "", chars: 0 })
    }
    current.push(message)
  }
  for (const group of groups) {
    group.text = group.messages.map(renderMessage).filter(Boolean).join("\n")
    group.chars = group.text.length
  }
  return groups.filter(group => group.text)
}

export interface AuxContextTruncation {
  kept: AuxContextGroup[]
  omittedGroups: number
  /** 最后一组自己就超过上限时为 `true`（绝不按字符切断工具调用与结果配对）。 */
  overLimit: boolean
}

/**
 * 32k 护栏：按**最旧完整轮次组整组丢弃**，绝不在组内按字符切。
 *
 * 两条边界：
 * - **预算真实**：分隔空行（`\n\n`）与尾部省略标注都计入成品长度，否则“刚好不超”
 *   的成品能比上限多出几十字符。
 * - **跨组配对**：工具调用在组 A、结果在组 B（中间隔着一条 steering 的 user 消息）时，
 *   丢掉 A 会留下无调用的结果。切完预算后再清一遍孤儿结果（调用已不在保留集里）。
 */
export function truncateAuxContextGroups(
  groups: readonly AuxContextGroup[],
  maxChars: number = AUX_PARENT_CONTEXT_MAX_CHARS,
): AuxContextTruncation {
  // 成品长度 = 组内文本 + 组分隔空行 + 尾部标注（标注自身也算“成品”）。
  const bodyChars = (list: readonly AuxContextGroup[]) =>
    list.reduce((sum, group) => sum + group.chars, 0) + Math.max(0, list.length - 1) * 2
  const noteChars = (omitted: number) =>
    omitted > 0 ? 2 + AUX_PARENT_CONTEXT_TRUNCATED_NOTE.replace("{count}", String(omitted)).length : 0

  let kept = [...groups]
  while (kept.length > 1) {
    const omitted = groups.length - kept.length
    if (bodyChars(kept) + noteChars(omitted) <= maxChars) break
    kept = kept.slice(1)
  }
  // 跨组配对：先按预算切完，再清掉“调用被丢、结果留下”的孤儿结果（只缩不胀）。
  kept = dropOrphanToolResults(kept)
  const omittedGroups = groups.length - kept.length
  const innerChars = bodyChars(kept) + noteChars(omittedGroups)
  return { kept, omittedGroups, overLimit: kept.length > 0 && innerChars > maxChars }
}

/** 保留集里现有的全部工具调用 id（assistant 消息的 `toolCallIds`）。 */
function keptToolCallIds(groups: readonly AuxContextGroup[]): Set<string> {
  const ids = new Set<string>()
  for (const group of groups) {
    for (const message of group.messages) {
      if (message.role !== "assistant") continue
      for (const id of message.toolCallIds ?? []) ids.add(id)
    }
  }
  return ids
}

/** 丢掉“调用已不在保留集里”的孤立工具结果；组被洗干净为空则整组移除。 */
function dropOrphanToolResults(groups: readonly AuxContextGroup[]): AuxContextGroup[] {
  const calls = keptToolCallIds(groups)
  const result: AuxContextGroup[] = []
  for (const group of groups) {
    const messages = group.messages.filter(
      message => message.role !== "toolResult" || !message.toolCallId || calls.has(message.toolCallId),
    )
    const text = messages.map(renderMessage).filter(Boolean).join("\n")
    if (text) result.push({ messages, text, chars: text.length })
  }
  return result
}

export interface AuxParentContextInput {
  /** 归一化消息（三源任一归一化后的结果）。 */
  messages: readonly AuxContextMessage[]
  streaming?: boolean
  committedIds?: ReadonlySet<string>
  maxChars?: number
}

export interface AuxParentContextResult {
  /** 折叠块原文（含标签）。 */
  block: string
  /** 折叠块**内文**（不含标签）；`applyCommittedAnchor` 之后的成品，序列化用它。 */
  inner: string
  /** 是否真的拿到了已提交的父会话内容（`false` 时块里是顶部提示）。 */
  hasContext: boolean
  omittedGroups: number
  overLimit: boolean
  /** 参与拼装的轮次组数（诊断/测试用）。 */
  groupCount: number
  /** 身份判据来源：权威集合 / 来源自证 / 没有任何可用身份。 */
  identity: AuxContextIdentity
}

/** 父上下文块：取材归一 → 锚点截断 → 32k 整组丢弃 → 折叠块正文。 */
export function buildAuxParentContext(input: AuxParentContextInput): AuxParentContextResult {
  const anchored = applyCommittedAnchor(
    input.messages.filter(message => message.text.trim()),
    {
      streaming: input.streaming,
      committedIds: input.committedIds,
    },
  )
  const groups = groupAuxContextMessages(anchored.messages)
  if (!groups.length) {
    return {
      block: buildAuxParentContextBlock(AUX_PARENT_CONTEXT_EMPTY_NOTICE),
      inner: AUX_PARENT_CONTEXT_EMPTY_NOTICE,
      hasContext: false,
      omittedGroups: 0,
      overLimit: false,
      groupCount: 0,
      identity: anchored.identity,
    }
  }
  const truncated = truncateAuxContextGroups(groups, input.maxChars)
  if (!truncated.kept.length) {
    // 跨组配对清理后可能什么都不剩（保留集里只有孤儿工具结果）：仍按“没有可用内容”收口。
    return {
      block: buildAuxParentContextBlock(AUX_PARENT_CONTEXT_EMPTY_NOTICE),
      inner: AUX_PARENT_CONTEXT_EMPTY_NOTICE,
      hasContext: false,
      omittedGroups: truncated.omittedGroups,
      overLimit: false,
      groupCount: 0,
      identity: anchored.identity,
    }
  }
  const body = truncated.kept.map(group => group.text).join("\n\n")
  const note =
    truncated.omittedGroups > 0
      ? AUX_PARENT_CONTEXT_TRUNCATED_NOTE.replace("{count}", String(truncated.omittedGroups))
      : ""
  const inner = [body, note].filter(Boolean).join("\n\n")
  return {
    block: buildAuxParentContextBlock(inner),
    inner,
    hasContext: true,
    omittedGroups: truncated.omittedGroups,
    overLimit: truncated.overLimit,
    groupCount: truncated.kept.length,
    identity: anchored.identity,
  }
}
