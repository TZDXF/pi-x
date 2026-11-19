import { AUX_MAX_TABS } from "@/lib/auxRuntime"
import type { AuxAskPayload, AuxAskTarget } from "@/lib/auxSelection"
import { CONVERSATION_SELECTION_MAX_COUNT } from "@/lib/conversationSelections"
import { askInAux, type AuxAskOutcome } from "@/stores/auxChat"

/** 一次划词投递失败时该给用户看的文案（`null` 表示不需要提示）。 */
export interface AuxAskToast {
  message: string
  kind: "info" | "warning" | "error"
}

/**
 * 划词投递结果 → 用户可见提示（TZD-103）。
 *
 * 保持无 Vue/Pinia 依赖：`ProjectFilePreview` 的脚本单测会剥掉 import 后直接执行
 * `script setup`，任何在这一层调用的 composable 都会在那种环境里变成 `undefined`。
 * 因此"投递 + 提示"拆成纯函数，组件只在事件处理器里调用（测试不会走进那条路径）。
 */
export function describeAuxAskResult(
  t: (key: string, params?: Record<string, unknown>) => string,
  outcome: AuxAskOutcome | { ok: true; duplicate: boolean },
): AuxAskToast | null {
  if (outcome.ok) return outcome.duplicate ? { message: t("chat.selectionDuplicate"), kind: "info" } : null
  if (outcome.reason === "limit")
    return { message: t("auxChat.limitReached", { count: AUX_MAX_TABS }), kind: "warning" }
  if (outcome.reason === "append") {
    if (outcome.appendReason === "count")
      return { message: t("chat.selectionLimitCount", { count: CONVERSATION_SELECTION_MAX_COUNT }), kind: "error" }
    if (outcome.appendReason === "total") return { message: t("chat.selectionLimitTotal"), kind: "error" }
    return { message: t("chat.selectionLimitSingle"), kind: "error" }
  }
  // `noParent` / `unavailable`：没有可投递的 aux（父会话不存在或入口未接线）。
  return { message: t("auxChat.askFailed"), kind: "warning" }
}

/**
 * 把一次划词手势投给该父会话的 aux，并把失败原因翻译成提示。
 *
 * 路由在 `stores/auxChat.ts`：显式 target 精确投递/新建；缺省 target 保留单实例自动路由。
 * 这里只负责"用户看到了什么"。
 */
export async function askAuxSelection(options: {
  parentRuntimeId: string
  payload: AuxAskPayload
  /** 多实例时由用户明确选择：已有 runtimeId，或 `null` 表示新建。 */
  target?: AuxAskTarget
  t: (key: string, params?: Record<string, unknown>) => string
  toast: (message: string, kind: AuxAskToast["kind"]) => void
}): Promise<AuxAskOutcome> {
  const outcome = await askInAux(options.parentRuntimeId, options.payload, options.target)
  const notice = describeAuxAskResult(options.t, outcome)
  if (notice) options.toast(notice.message, notice.kind)
  return outcome
}
