import type { Ref } from "vue"
import type PromptInputBridge from "@/components/PromptInputBridge.vue"
import { commentFilePath, formatCodeCommentForComposer } from "@/lib/codeComments"
import { appendComposerText } from "@/lib/composer"
import { useCodeCommentsStore, type PendingCodeComment } from "@/stores/codeComments"

/** Insert editable code annotations only where this session's composer can receive them. */
export function useCodeCommentInsertion(bridge: Ref<InstanceType<typeof PromptInputBridge> | null>) {
  const codeComments = useCodeCommentsStore()

  function insertCodeComment(comment: PendingCodeComment) {
    const target = bridge.value
    if (!target) return
    const editable = formatCodeCommentForComposer({ ...comment, path: commentFilePath(comment) })
    target.setTextInput(appendComposerText(target.textInput || "", editable))
    // 只有实际写入成功才消费 chip；历史预览或无接收方时不得静默丢失。
    codeComments.remove(comment.id)
  }

  return { insertCodeComment }
}
