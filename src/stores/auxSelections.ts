import { reactive } from "vue"
import {
  appendConversationSelection,
  createConversationSelectionId,
  type ConversationSelectionAppendResult,
} from "@/lib/conversationSelections"
import { auxSelectionWire, type AuxAskPayload, type PendingAuxSelection } from "@/lib/auxSelection"

/**
 * aux（辅助对话）的待发送划词引用 —— **按 runtime 分桶**（TZD-103）。
 *
 * 与主会话 `stores/conversationSelections.ts` 的**单例**是两套独立状态：
 * 主会话仍按"会话/项目 scope"归属、语义不变；aux 的每个实例一个桶，键是 aux 自己的
 * `runtimeId`（`aux:` 前缀，做到一实例一桶，不需要 scope 漂移判断）。
 *
 * 硬约束：
 * 1. **互不消费**：发送成功后只清本桶，主会话发送只清主桶；切 scope/切 Tab 也不清对方；
 * 2. 上限不变：复用 `appendConversationSelection`（单条 8000 / 8 条 / 总 16000），
 *    去重键只看 wire 字段（`{path, text, comment}`），同一段文字从两个入口来只进一条；
 * 3. 关闭即销毁：`closeAux` 对该 runtime 调 `clearBucketFor`，不落盘、不进 localStorage。
 *
 * 为什么不用一个 Pinia store：桶是 aux 实例的附属物，实例本身活在模块级注册表
 * （`stores/auxChat.ts`）里、关闭时被拆除；跟着 `runtimeId` 走的模块级 Map 与
 * `stores/auxDrafts.ts` 同构，避免为每个 aux 实例建一个 Pinia store。
 */
const buckets = reactive(new Map<string, PendingAuxSelection[]>())

/** 只读快照；没有条目时返回同一份空数组（调用方不该写它）。 */
export function auxSelectionItems(runtimeId: string): readonly PendingAuxSelection[] {
  return buckets.get(runtimeId) ?? []
}

/** 桶内条目数（诊断与测试用）。 */
export function auxSelectionCount(runtimeId: string): number {
  return auxSelectionItems(runtimeId).length
}

/**
 * 追加一条引用到该 runtime 的桶。
 *
 * 返回值与主会话同源（`appendConversationSelection` 的 `ok/reason/duplicate`），
 * 调用方据此复用同一套提示文案。重复条目不写入，也不改变桶内已有内容。
 */
export function addAuxSelection(runtimeId: string, payload: AuxAskPayload): ConversationSelectionAppendResult {
  const current = auxSelectionItems(runtimeId)
  const result = appendConversationSelection(current, auxSelectionWire(payload))
  if (!result.ok) return result
  if (result.duplicate) return result
  const item: PendingAuxSelection = {
    ...auxSelectionWire(payload),
    id: createConversationSelectionId(),
    ...(payload.source ? { source: payload.source } : {}),
    ...(payload.sourceRuntimeId?.trim() ? { sourceRuntimeId: payload.sourceRuntimeId } : {}),
    ...(typeof payload.messageId === "number" && Number.isFinite(payload.messageId)
      ? { messageId: payload.messageId }
      : {}),
    ...(typeof payload.startOffset === "number" ? { startOffset: payload.startOffset } : {}),
    ...(typeof payload.endOffset === "number" ? { endOffset: payload.endOffset } : {}),
    ...(payload.lineRange ? { lineRange: { ...payload.lineRange } } : {}),
  }
  const bucket = buckets.get(runtimeId)
  if (bucket) bucket.push(item)
  else buckets.set(runtimeId, [item])
  return { ok: true, selections: auxSelectionItems(runtimeId), duplicate: false }
}

/** 更新批注（空批注即删除该字段，与主会话一致）。 */
export function updateAuxSelection(runtimeId: string, id: string, comment: string) {
  const bucket = buckets.get(runtimeId)
  if (!bucket?.some(item => item.id === id)) return
  const trimmed = comment.trim()
  const next = bucket.map(item =>
    item.id === id ? { ...item, ...(trimmed ? { comment: trimmed } : { comment: undefined }) } : item,
  )
  buckets.set(runtimeId, next)
}

export function removeAuxSelection(runtimeId: string, id: string) {
  const bucket = buckets.get(runtimeId)
  if (!bucket) return
  const next = bucket.filter(item => item.id !== id)
  if (next.length) buckets.set(runtimeId, next)
  else buckets.delete(runtimeId)
}

/**
 * 清空**本桶**（发送成功、关闭实例时调用）。
 *
 * 刻意只有这一个动词、且必须带 runtimeId：任何"清全部"的入口都会把
 * "只清自己那桶"的契约变成一句口头约定（主会话桶与其它 aux 桶都会跟着没）。
 */
export function clearAuxSelectionBucket(runtimeId: string) {
  buckets.delete(runtimeId)
}

/** 仅测试用：清空所有桶（用例之间隔离）。 */
export function resetAuxSelectionsForTest() {
  buckets.clear()
}
