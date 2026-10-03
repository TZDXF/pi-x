import { defineStore } from "pinia"
import { ref } from "vue"

import {
  appendConversationSelection,
  createConversationSelectionId,
  type ConversationSelectionSource,
  type PendingConversationSelection,
} from "@/lib/conversationSelections"

/** 已确认、等待随下一条消息发出的对话划词引用。 */
export type { PendingConversationSelection, ConversationSelectionSource }

/**
 * 挂在 composer 上的待发送划词引用（对齐 ZCode 的 conversation selections）。
 * 引用按会话归属：会话文件为空（尚未落盘）时退回项目维度，切换会话即重置，
 * 避免把 A 会话的引用发进 B 会话。
 */
export const useConversationSelectionsStore = defineStore("conversationSelections", () => {
  const scope = ref("")
  const items = ref<PendingConversationSelection[]>([])

  function add(forScope: string, draft: Omit<PendingConversationSelection, "id">) {
    if (scope.value !== forScope) {
      scope.value = forScope
      items.value = []
    }
    const result = appendConversationSelection(items.value, draft)
    if (result.ok && !result.duplicate) items.value.push({ ...draft, id: createConversationSelectionId() })
    return result
  }
  function update(id: string, comment: string) {
    const trimmed = comment.trim()
    items.value = items.value.map(item =>
      item.id === id ? { ...item, ...(trimmed ? { comment: trimmed } : { comment: undefined }) } : item,
    )
  }
  function remove(id: string) {
    items.value = items.value.filter(item => item.id !== id)
  }
  function clear() {
    items.value = []
  }
  return { scope, items, add, update, remove, clear }
})
