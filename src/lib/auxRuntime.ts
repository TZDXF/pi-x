/**
 * aux（辅助对话）runtime 的纯逻辑：前缀判定、实例上限、id 生成与序号分配。
 *
 * 保持零依赖（只读字符串 + `lib/uuid`），因为 `stores/session/events.ts`、
 * `stores/ui.ts` 与 `lib/workspaceRuntime.ts` 需要在**不**引入 conversations/piClient
 * 的情况下判断"这条事件属于 aux"，否则会形成模块循环。
 */
import { createUuid } from "@/lib/uuid"

/** 后端 `aux_spawn` 强制的 runtimeId 前缀（`src-tauri/src/commands/pi_aux.rs`）。 */
export const AUX_RUNTIME_PREFIX = "aux:"

/**
 * 同时存活的 aux 实例上限（成员裁定）。
 *
 * 这是 `auxChat` 自己的计数（**创建中的实例同样计入**）：与侧栏单组 20 条
 * （`MAX_SIDEBAR_TABS`）和内存组数 24（`MAX_SIDEBAR_TAB_GROUPS`）**无关**，
 * 不要合并这两个语义，也不要借这里放宽主侧栏的上限。
 */
export const AUX_MAX_TABS = 5

export function isAuxRuntimeId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.startsWith(AUX_RUNTIME_PREFIX)
}

export function createAuxRuntimeId(): string {
  return `${AUX_RUNTIME_PREFIX}${createUuid()}`
}

/**
 * 同一父会话里新实例的标题序号：取**当前存活实例**中最小的未占用正整数。
 *
 * 关闭后再开一个复用序号（1、2 关掉 1 再开 → 1），这样用户看到的是"当前有几个"
 * 而不是历史累计值。
 */
export function nextAuxOrdinal(ordinals: readonly number[]): number {
  const used = new Set(ordinals)
  let ordinal = 1
  while (used.has(ordinal)) ordinal += 1
  return ordinal
}
