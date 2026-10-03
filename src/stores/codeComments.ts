import { defineStore } from "pinia"
import { ref } from "vue"

/** 已确认、等待随下一条消息发出的代码批注。 */
export interface PendingCodeComment {
  id: string
  path: string
  /** 文件相对路径所属目录；缺省表示会话目录本身（多目录项目跨目录批注时记录）。 */
  root?: string
  startLine: number
  endLine: number
  selectedText: string
  comment: string
}

const MAX_COMMENTS = 20

/** 对齐 ZCode 的 attachment id 生成：优先 crypto.randomUUID，非安全上下文退回时间戳随机串。 */
function createCodeCommentId() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID()
  return `code-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 挂在 composer 上的待发送批注（参考 ZCode 的 code-comment contexts）。
 * 批注按项目归属：切换项目即重置，避免把 A 项目的批注发进 B 项目的会话。
 */
export const useCodeCommentsStore = defineStore("codeComments", () => {
  const project = ref("")
  const comments = ref<PendingCodeComment[]>([])

  function add(forProject: string, draft: Omit<PendingCodeComment, "id">) {
    if (project.value !== forProject) {
      project.value = forProject
      comments.value = []
    }
    if (comments.value.length >= MAX_COMMENTS) return false
    comments.value.push({ ...draft, id: createCodeCommentId() })
    return true
  }
  function remove(id: string) {
    comments.value = comments.value.filter(comment => comment.id !== id)
  }
  function clear() {
    comments.value = []
  }
  return { project, comments, add, remove, clear }
})
