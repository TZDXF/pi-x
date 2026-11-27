import { reactive } from "vue"
import { draftFilesFromSubmit, type SubmittedAttachment } from "@/lib/attachments"

/**
 * aux（辅助对话）的草稿：**仅内存**。
 *
 * 三条硬约束（`docs/aux-chat-spec.md` §5）：
 * 1. 零 localStorage：不写 `pix.composerDrafts`，也不碰 `stores/composerDrafts`
 *    的公共键 —— aux 关闭即销毁，草稿没有跨会话/跨重启的语义；
 * 2. 附件保留**原始 `File`**：blob URL 归 `PromptInput` 所有，由它的
 *    `onBeforeUnmount` 撤销；这里存 URL 会在重挂载后指向已撤销的 blob；
 * 3. 按 aux `runtimeId` 分桶：一个 aux 实例关闭即丢弃自己的草稿，互不影响。
 */
export interface AuxDraft {
  text: string
  files: File[]
}

const EMPTY_DRAFT: AuxDraft = { text: "", files: [] }
const drafts = reactive(new Map<string, AuxDraft>())

/** 只读快照；没有草稿时返回同一份空草稿（调用方不该写它）。 */
export function auxDraftFor(runtimeId: string): AuxDraft {
  return drafts.get(runtimeId) ?? EMPTY_DRAFT
}

/** 保存（空草稿直接删除条目，避免空 Map 项堆积）。 */
export function saveAuxDraft(runtimeId: string, draft: AuxDraft) {
  if (!draft.text && !draft.files.length) {
    drafts.delete(runtimeId)
    return
  }
  drafts.set(runtimeId, draft)
}

/** 关闭 Tab 时清掉该实例的草稿（销毁顺序第 5 步）。 */
export function clearAuxDraft(runtimeId: string) {
  drafts.delete(runtimeId)
}

/** 草稿条目数（诊断与测试用）。 */
export function auxDraftCount() {
  return drafts.size
}

/**
 * 失败提交的回填（`completion.startFailed` 的「输入与附件都不丢」，TZD-155）。
 *
 * aux 的失败态会把输入区整块换成错误页，`ChatComposer` 连同 `bridge` 一起卸载：
 * `useChatSendControl` 的 `setTextInput` 无处可写，只能把这次提交的内容交给这里。
 *
 * 附件取自**调用方给的提交件**（带原始 `File` 时优先用原件，否则按已解码的 base64 重建）：
 * `PromptInput.submitForm` 在提交瞬间已清空输入区，而 `useAuxDraft.persist()` 那一拍刚写过
 * `files: []` —— 从草稿里回读附件只会拿到空数组，图片会静默消失。
 */
export function saveFailedSubmitDraft(
  runtimeId: string,
  failed: {
    text: string
    images: readonly { data: string; mimeType: string }[]
    files: readonly SubmittedAttachment[]
  },
) {
  saveAuxDraft(runtimeId, { text: failed.text, files: draftFilesFromSubmit(failed.files, failed.images) })
}
