/**
 * composer 上下文契约的组合层（对齐 ZCode composerPromptContexts）：
 * 各类 context parser 都只识别 prompt 尾块，因此序列化顺序与解析顺序必须严格相反。
 * 当前包含两类：对话划词引用（userselect）与代码批注（Code comments）。
 */

import { buildPromptWithCodeComments, parsePromptCodeComments, type ParsedCodeComment } from "./codeComments"
import {
  buildPromptWithConversationSelections,
  parsePromptConversationSelections,
  type ConversationSelectionText,
  type ParsedConversationSelection,
} from "./conversationSelections"

/**
 * 序列化：先拼 userselect 块再在外层追加 Code comments 块，
 * 最终 prompt 为「正文 + userselect + Code comments」。
 */
export function serializeComposerPromptContexts(
  text: string,
  contexts: {
    comments: Parameters<typeof buildPromptWithCodeComments>[1]
    selections: readonly ConversationSelectionText[]
  },
): string {
  const withSelections = buildPromptWithConversationSelections(text, contexts.selections)
  return buildPromptWithCodeComments(withSelections, contexts.comments)
}

/** 解析与序列化相反：先剥 Code comments 尾块，再从剩余正文剥 userselect 尾块。 */
export function parseComposerPromptContexts(content: string): {
  visibleContent: string
  comments: ParsedCodeComment[]
  selections: ParsedConversationSelection[]
} {
  const code = parsePromptCodeComments(content)
  const selections = parsePromptConversationSelections(code.visibleContent)
  return {
    visibleContent: selections.visibleContent,
    comments: code.comments,
    selections: selections.selections,
  }
}
