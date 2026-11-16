/**
 * composer 上下文契约的组合层（对齐 ZCode composerPromptContexts）：
 * 各类 context parser 都只识别 prompt 尾块，因此序列化顺序与解析顺序必须严格相反。
 * 会话引用附加段位于最内层，其后依次为对话划词引用（userselect）与代码批注（Code comments）。
 *
 * aux 的父上下文块位于**最前**（`<aux_parent_context>…</aux_parent_context>` + 空行
 * + 提问正文，`docs/aux-chat-spec.md` §4）。它也是唯一的前置块，所以"剥最前的块、
 * 再剥尾块"这条顺序对所有调用方都成立：主会话没有该块时解析结果为空、行为不变。
 */

import { buildPromptWithCodeComments, parsePromptCodeComments, type ParsedCodeComment } from "./codeComments"
import { stripSessionReferenceContext } from "./completion"
import {
  buildPromptWithConversationSelections,
  parsePromptConversationSelections,
  type ConversationSelectionText,
  type ParsedConversationSelection,
} from "./conversationSelections"
import { buildAuxParentContextBlock, stripAuxParentContextBlock, withAuxParentContext } from "./auxParentContext"

/**
 * 序列化：先拼 userselect 块再在外层追加 Code comments 块，
 * 最终 prompt 为「正文 + userselect + Code comments」。
 *
 * 给了父上下文时把折叠块置于**最前**（`<aux_parent_context>…</aux_parent_context>` +
 * 空行 + 正文），与解析顺序严格相反 —— 序列化与解析必须互逆，否则历史读回与首发
 * 会看到不同的提示词。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: {
    comments: Parameters<typeof buildPromptWithCodeComments>[1]
    selections: readonly ConversationSelectionText[]
    /** 父上下文块**内文**（不含标签）；`null`/空表示不带父上下文。 */
    parentContext?: string | null
  },
): string {
  const withSelections = buildPromptWithConversationSelections(text, contexts.selections)
  const withComments = buildPromptWithCodeComments(withSelections, contexts.comments)
  const inner = contexts.parentContext?.trim()
  if (!inner) return withComments
  return withAuxParentContext(buildAuxParentContextBlock(inner), withComments)
}

/** 解析与序列化相反：依次剥区块、Code comments、userselect 与会话引用附加段。 */
export function parseComposerPromptContexts(content: string): {
  visibleContent: string
  comments: ParsedCodeComment[]
  selections: ParsedConversationSelection[]
  /** 折叠块**内文**（不含标签）；没有该块时为 `null`。 */
  parentContext: string | null
  /** 折叠块原文（含标签，不含分隔空行）；气泡折叠展示与"块字节不变"判据用它。 */
  parentContextBlock: string | null
} {
  const leading = stripAuxParentContextBlock(content)
  const code = parsePromptCodeComments(leading.rest)
  const selections = parsePromptConversationSelections(code.visibleContent)
  return {
    visibleContent: stripSessionReferenceContext(selections.visibleContent),
    comments: code.comments,
    selections: selections.selections,
    parentContext: leading.block === null ? null : leading.inner,
    parentContextBlock: leading.block,
  }
}

/**
 * 只取提问正文（剥离父上下文块与所有尾块）。时间线摘要、气泡展示与"复制只用
 * 可见正文"都用它，避免三处各自拼一遍剥离逻辑。
 */
export function composerPromptQuestion(content: string): string {
  return parseComposerPromptContexts(content).visibleContent
}
