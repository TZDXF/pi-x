/**
 * aux（辅助对话）划词引用的纯逻辑（TZD-103）：
 *
 * 两个入口共用同一份"手势 → 引用草稿"的转换 ——
 * 1. 会话正文划词（`ConversationSelectionMenu` 的聊天模式，payload 带消息 id 与字符区间）；
 * 2. 代码预览划词（同一浮层的代码模式，payload 带 `path` 与行区间）。
 *
 * wire 形态仍是 `lib/conversationSelections.ts` 的 `ConversationSelectionText`
 * （`{path, text}` + 可选 comment），因此 `# userselect:` 契约一字未改；行号等元数据
 * 只用于摘要展示与诊断，不参与去重、上限与序列化。
 *
 * 本文件保持无依赖（只读类型），便于单测直接加载。
 */
import type { ConversationSelectionSource, ConversationSelectionText } from "@/lib/conversationSelections"

/** 代码预览的 1 基闭区间行号。 */
export interface CodeSelectionRange {
  start: number
  end: number
}

/** 划词投递目标：已有 aux 的 runtimeId；`null` 表示明确新建。缺省参数仍走自动路由。 */
export type AuxAskTarget = string | null

/** 多 aux 时浮层里的可选项（只暴露展示与路由所需字段）。 */
export interface AuxTargetOption {
  runtimeId: string
  title: string
}

/**
 * 一次"在辅助对话中提问"的手势产物。
 *
 * 两种来源共用一个形状：聊天来源填 `source`/`messageId`/`startOffset`/`endOffset`，
 * 代码来源填 `path`/`lineRange`。两者都不完整时也能进桶（只是摘要少一行标签）。
 */
export interface AuxAskPayload {
  text: string
  /**
   * 该手势**发生所在**的会话 runtime（消息 id / 字符区间的归属者；TZD-103 P2-5）。
   *
   * 为什么必须记下来：主会话划词会把 `messageId` 写进 aux 的桶，而 aux 正文里有自己的
   * 消息 1 —— 不记来源就会在 aux 面板里"就近"恢复到无关内容。文件来源不带（路径与
   * 行号是文件维度，跨 runtime 仍然有效）。
   */
  sourceRuntimeId?: string
  /** 代码预览来源的文件路径（相对会话目录）；聊天来源不带。 */
  path?: string
  /** 代码预览来源的行区间；聊天来源不带。 */
  lineRange?: CodeSelectionRange
  source?: ConversationSelectionSource
  messageId?: number
  startOffset?: number
  endOffset?: number
}

/** 桶内待发送的 aux 引用：wire 字段 + 身份与定位元数据。 */
export interface PendingAuxSelection extends ConversationSelectionText {
  id: string
  /** 消息 id / 偏移的归属 runtime（见 `AuxAskPayload.sourceRuntimeId`）。 */
  sourceRuntimeId?: string
  source?: ConversationSelectionSource
  messageId?: number
  startOffset?: number
  endOffset?: number
  lineRange?: CodeSelectionRange
}

/**
 * 只保留 wire 字段交给 `appendConversationSelection`：
 *
 * 去重键与 8000/8/16000 上限都必须只看"会发给 agent"的内容，
 * 否则同一段文字在不同来源（行号不同、消息 id 不同）下会被当成两条。
 */
export function auxSelectionWire(payload: AuxAskPayload): ConversationSelectionText {
  return { text: payload.text, ...(payload.path?.trim() ? { path: payload.path } : {}) }
}

/**
 * 摘要里的来源标签：代码引用显示 `path:起-止`（`path:12` 表示单行），
 * 聊天引用返回 `null`（由 `source` 决定"提问/回复"标签）。
 */
export function auxSelectionLabel(item: Pick<PendingAuxSelection, "path" | "lineRange">): string | null {
  const path = item.path?.trim()
  if (!path) return null
  const range = item.lineRange
  if (!range) return path
  return range.start === range.end ? `${path}:${range.start}` : `${path}:${range.start}-${range.end}`
}
