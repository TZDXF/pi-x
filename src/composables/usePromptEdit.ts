import { computed, nextTick, ref, watch, type Ref } from "vue"
import { useI18n } from "vue-i18n"
import { withSessionReferences } from "@/lib/completion"
import { dataUrlToImage } from "@/lib/attachments"
import { parseComposerPromptContexts } from "@/lib/promptContexts"
import { withAuxParentContext } from "@/lib/auxParentContext"
import type { KnownSession } from "@/lib/completion"
import type { SessionStore, UserEntry } from "@/stores/session"
import type { UiStore } from "@/stores/ui"
import { useWorkspaceStore } from "@/stores/workspace"

type WorkspaceStore = ReturnType<typeof useWorkspaceStore>

/**
 * 重发时的 prompt：只换提问正文，`<aux_parent_context>` 块**字节不变**地留在最前
 * （`docs/aux-chat-spec.md` §4 第 4 条落地）。
 *
 * 为什么不能让块跟着编辑一起重算：块是“打开面板那一刻父会话的快照”，重算会把它变成
 * “现在”的内容，历史气泡与模型看到的前缀就不再是同一份。aux 本身不重发（`editBlocked`
 * 恒真、`rewind_prompt` 被 M0 拒绝），这条路径服务的是主会话里出现过该块的消息。
 *
 * 历史重建时块原文存在 `parentContextBlock` 上；实时消息则从 `contextText`（完整 prompt）
 * 里剥出来 —— 两者都是“原样”，不重新拼装。
 */
export function promptPreservingParentContextBlock(entry: UserEntry, question: string): string {
  const block =
    entry.parentContextBlock ?? parseComposerPromptContexts(entry.contextText ?? entry.text).parentContextBlock
  if (!block) return question
  return withAuxParentContext(block, question)
}

export interface PromptEditTextarea {
  $el: HTMLTextAreaElement
}

/**
 * Inline editing of the last question: replaces it at its original position
 * via the store's resendPrompt, without creating a session fork.
 */
export function usePromptEdit(deps: {
  session: SessionStore
  ui: UiStore
  workspace: WorkspaceStore
  /** Textarea element handle, owned by the view (bound via ref="editTextarea"). */
  editTextarea: Ref<PromptEditTextarea | null>
  /** Reactive props of the chat view, read through getters to stay live. */
  project: () => string
  connecting: () => boolean
  connected: () => boolean
  knownSessions: () => KnownSession[]
  /** 重发成功后触发，用于滚动回对话底部。 */
  onResent?: () => void
}) {
  const { t } = useI18n()
  const { session, ui, workspace, editTextarea } = deps
  const { connecting, connected, knownSessions } = deps

  // Resend the edited question in this session, interrupting the current answer first.
  const editedPrompt = ref<UserEntry | null>(null)
  const editedText = ref("")
  const editBusy = ref(false)
  const lastUserPromptId = computed(() => {
    for (let i = session.entries.length - 1; i >= 0; i--) {
      if (session.entries[i]?.kind === "user") return session.entries[i].id
    }
    return null
  })
  const editBlocked = computed(
    () =>
      editBusy.value ||
      connecting() ||
      !connected() ||
      workspace.gitBusy ||
      session.isResending ||
      session.historyLoading,
  )

  async function startEditPrompt(entry: UserEntry) {
    if (editBlocked.value || entry.id !== lastUserPromptId.value) return
    editedPrompt.value = entry
    // `entry.text` 在历史重建后已经是**可见正文**（不含父上下文块与尾块），所以编辑框
    // 里只有用户写的问题；块只在重发时原样拼回去（见 `promptPreservingParentContextBlock`）。
    editedText.value = parseComposerPromptContexts(entry.text).visibleContent
    await nextTick()
    editTextarea.value?.$el.focus()
  }

  function cancelEditedPrompt() {
    if (!editBusy.value) editedPrompt.value = null
  }

  watch(
    () => session.sessionFile,
    () => {
      editedPrompt.value = null
    },
  )
  watch(lastUserPromptId, id => {
    if (editedPrompt.value?.id !== id) cancelEditedPrompt()
  })

  async function resendEditedPrompt() {
    const entry = editedPrompt.value
    const text = editedText.value.trim()
    if (!entry || entry.id !== lastUserPromptId.value || editBlocked.value || (!text && !entry.images?.length)) return
    // Validate attachments before stopping the current answer.
    const images = (entry.images ?? []).map(image => dataUrlToImage(image.url))
    if (images.some(image => image === null)) {
      ui.pushToast(t("chat.editAttachmentError"), "error")
      return
    }
    editBusy.value = true
    try {
      await session.resendPrompt(
        text,
        images.length ? (images as { data: string; mimeType: string }[]) : undefined,
        promptPreservingParentContextBlock(entry, withSessionReferences(text, knownSessions())),
      )
      editedPrompt.value = null
      deps.onResent?.()
    } catch (error) {
      ui.pushToast(String(error), "error")
    } finally {
      editBusy.value = false
    }
  }

  return {
    editedPrompt,
    editedText,
    editBusy,
    lastUserPromptId,
    editBlocked,
    startEditPrompt,
    cancelEditedPrompt,
    resendEditedPrompt,
  }
}
