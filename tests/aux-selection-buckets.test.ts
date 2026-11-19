/**
 * aux 引用桶（TZD-103）：桶隔离、去重键只看 wire 字段、上限（8000 / 8 / 16000）、
 * clear 只清自己那桶、删除/批注编辑、失败提示的映射。
 *
 * 全部是纯逻辑 + 模块级 Map，不需要 Vue 渲染环境；主会话单例用真实 Pinia store，
 * 用来证明"aux 桶与主桶互不影响"这条契约。
 *
 * `lib/auxAsk.ts` 经 `stores/auxChat.ts` 间接引入 `api/piClient`（其 transport 读
 * sessionStorage/location）；`vi.mock` 是提升到 import 求值之前的，替身写在这里即可。
 */
vi.mock("@/api/piClient", () => ({
  modelProviderId: value => value,
  rpcRequest: async () => ({ success: true, data: {} }),
  rpcNotify: async () => {},
  killPi: async () => {},
}))
vi.mock("@/api/transport", () => ({ invoke: async () => null, isDesktop: false }))
vi.mock("@/i18n", () => ({
  i18n: { global: { t: key => key } },
  tBackendError: value => String(value ?? ""),
}))

import { afterEach, expect, test, vi } from "vitest"
import {
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
} from "@/lib/conversationSelections"
import {
  addAuxSelection,
  auxSelectionCount,
  auxSelectionItems,
  clearAuxSelectionBucket,
  removeAuxSelection,
  resetAuxSelectionsForTest,
  updateAuxSelection,
} from "@/stores/auxSelections"
import { useConversationSelectionsStore } from "@/stores/conversationSelections"
import { createPinia, setActivePinia } from "pinia"
import { auxSelectionLabel, auxSelectionWire } from "@/lib/auxSelection"
import { describeAuxAskResult } from "@/lib/auxAsk"

/**
 * aux 引用桶（TZD-103）：桶隔离、去重键只看 wire 字段、上限（8000 / 8 / 16000）、
 * clear 只清自己那桶、删除/批注编辑。
 *
 * 全部是**纯逻辑 + 模块级 Map**，不需要 Vue 渲染环境；主会话单例用真实 Pinia store，
 * 用来证明"aux 桶与主桶互不影响"这条契约。
 */
afterEach(() => {
  resetAuxSelectionsForTest()
  setActivePinia(createPinia())
})

test("each aux runtime has its own bucket and never mixes entries", () => {
  addAuxSelection("aux:a", { text: "A 的引用", source: "assistant", messageId: 3, startOffset: 0, endOffset: 5 })
  addAuxSelection("aux:b", { text: "B 的引用", source: "user", messageId: 4, startOffset: 0, endOffset: 5 })
  expect(auxSelectionItems("aux:a").map(item => item.text)).toEqual(["A 的引用"])
  expect(auxSelectionItems("aux:b").map(item => item.text)).toEqual(["B 的引用"])
  expect(auxSelectionCount("aux:c")).toBe(0)
  // 未知桶返回同一份空数组（调用方不该写它）。
  expect(auxSelectionItems("aux:c")).toEqual([])
})

test("clearing one bucket leaves every other bucket untouched", () => {
  addAuxSelection("aux:a", { text: "a" })
  addAuxSelection("aux:b", { text: "b" })
  clearAuxSelectionBucket("aux:a")
  expect(auxSelectionCount("aux:a")).toBe(0)
  expect(auxSelectionItems("aux:b").map(item => item.text)).toEqual(["b"])
})

test("the aux bucket never touches the main session singleton", () => {
  setActivePinia(createPinia())
  const main = useConversationSelectionsStore()
  // 会话 scope 相同（同项目、同一 sessionFile）也不影响：aux 只读写自己的桶。
  main.add("session-1", { text: "主会话引用", source: "assistant", messageId: 1, startOffset: 0, endOffset: 6 })
  addAuxSelection("aux:x", { text: "aux 引用", source: "user", messageId: 2, startOffset: 0, endOffset: 3 })
  expect(main.items.map(item => item.text)).toEqual(["主会话引用"])
  expect(auxSelectionItems("aux:x").map(item => item.text)).toEqual(["aux 引用"])
  clearAuxSelectionBucket("aux:x")
  expect(main.items).toHaveLength(1)
  main.clear()
  expect(auxSelectionCount("aux:x")).toBe(0)
})

test("duplicate detection uses the wire shape only (text + path + comment)", () => {
  // 同一段文字、不同消息区间 → 只进一条（区间属于页内定位，不是 wire 内容）。
  const first = addAuxSelection("aux:a", {
    text: "同一段",
    source: "assistant",
    messageId: 1,
    startOffset: 0,
    endOffset: 3,
  })
  expect(first).toMatchObject({ ok: true, duplicate: false })
  const again = addAuxSelection("aux:a", {
    text: "同一段",
    source: "user",
    messageId: 9,
    startOffset: 40,
    endOffset: 43,
  })
  expect(again).toMatchObject({ ok: true, duplicate: true })
  expect(auxSelectionCount("aux:a")).toBe(1)
  // 同一段文字来自不同文件 → 两条（path 是 wire 字段）。
  addAuxSelection("aux:a", { text: "同一段", path: "src/a.ts", lineRange: { start: 3, end: 3 } })
  expect(auxSelectionCount("aux:a")).toBe(2)
  // 行区间不参与 wire：同路径同文本、行号不同 → 仍判重。
  const dupLine = addAuxSelection("aux:a", { text: "同一段", path: "src/a.ts", lineRange: { start: 8, end: 9 } })
  expect(dupLine).toMatchObject({ ok: true, duplicate: true })
})

test("the single-entry limit rejects an oversized selection without writing", () => {
  const result = addAuxSelection("aux:a", { text: "x".repeat(CONVERSATION_SELECTION_MAX_TEXT_LENGTH + 1) })
  expect(result).toEqual({ ok: false, reason: "single" })
  expect(auxSelectionCount("aux:a")).toBe(0)
})

test("the count and total limits match the main session (8 / 16000)", () => {
  for (let index = 0; index < CONVERSATION_SELECTION_MAX_COUNT; index++)
    expect(addAuxSelection("aux:a", { text: `第${index}段` }).ok).toBe(true)
  expect(addAuxSelection("aux:a", { text: "再一条" })).toEqual({ ok: false, reason: "count" })
  expect(auxSelectionCount("aux:a")).toBe(CONVERSATION_SELECTION_MAX_COUNT)

  resetAuxSelectionsForTest()
  const half = CONVERSATION_SELECTION_MAX_TOTAL_LENGTH / 2 - 100
  expect(addAuxSelection("aux:b", { text: "x".repeat(half) }).ok).toBe(true)
  expect(addAuxSelection("aux:b", { text: "y".repeat(half) }).ok).toBe(true)
  expect(addAuxSelection("aux:b", { text: "z".repeat(300) })).toEqual({ ok: false, reason: "total" })
  // 上限按桶各算：另一个桶不受影响。
  expect(addAuxSelection("aux:c", { text: "z".repeat(300) }).ok).toBe(true)
})

test("update edits only its own entry and remove keeps the rest of the bucket", () => {
  addAuxSelection("aux:a", { text: "第一条" })
  addAuxSelection("aux:a", { text: "第二条" })
  const [first, second] = auxSelectionItems("aux:a")
  updateAuxSelection("aux:a", first!.id, "  批注  ")
  expect(auxSelectionItems("aux:a")[0]!.comment).toBe("批注")
  expect(auxSelectionItems("aux:a")[1]!.comment).toBeUndefined()
  // 空批注 = 删除该字段（与主会话一致）。
  updateAuxSelection("aux:a", first!.id, "   ")
  expect(auxSelectionItems("aux:a")[0]!.comment).toBeUndefined()
  removeAuxSelection("aux:a", first!.id)
  expect(auxSelectionItems("aux:a").map(item => item.id)).toEqual([second!.id])
  // 删空后桶条目消失（不留空数组）。
  removeAuxSelection("aux:a", second!.id)
  expect(auxSelectionCount("aux:a")).toBe(0)
  // 跨桶删除无效：不能拿 A 的 id 删 B 的条目。
  addAuxSelection("aux:b", { text: "b" })
  removeAuxSelection("aux:b", first!.id)
  expect(auxSelectionCount("aux:b")).toBe(1)
})

test("wire payload keeps only path/text so the userselect contract is unchanged", () => {
  expect(auxSelectionWire({ text: "正文", path: " src/a.ts " })).toEqual({ path: " src/a.ts ", text: "正文" })
  expect(auxSelectionWire({ text: "副目录", path: "same.ts", root: "C:/qa-extra/" })).toEqual({
    path: "C:/qa-extra/same.ts",
    text: "副目录",
  })
  expect(auxSelectionWire({ text: "正文", path: "   " })).toEqual({ text: "正文" })
  expect(auxSelectionWire({ text: "正文", messageId: 4, startOffset: 2, endOffset: 9 })).toEqual({ text: "正文" })
})

test("the summary label shows path and line range only for code references", () => {
  expect(auxSelectionLabel({ path: "src/a.ts", lineRange: { start: 3, end: 3 } })).toBe("src/a.ts:3")
  expect(auxSelectionLabel({ path: "src/a.ts", lineRange: { start: 3, end: 9 } })).toBe("src/a.ts:3-9")
  expect(auxSelectionLabel({ path: "docs/a.md" })).toBe("docs/a.md")
  expect(auxSelectionLabel({})).toBeNull()
})

test("every rejection maps to one user-visible toast and successes stay silent", () => {
  const t = (key: string, params?: Record<string, unknown>) => `${key}:${JSON.stringify(params ?? {})}`
  expect(describeAuxAskResult(t, { ok: true, duplicate: false })).toBeNull()
  expect(describeAuxAskResult(t, { ok: true, duplicate: true })).toMatchObject({ kind: "info" })
  expect(describeAuxAskResult(t, { ok: false, reason: "append", appendReason: "single" })).toMatchObject({
    kind: "error",
  })
  expect(describeAuxAskResult(t, { ok: false, reason: "append", appendReason: "total" })?.message).toContain(
    "chat.selectionLimitTotal",
  )
  expect(describeAuxAskResult(t, { ok: false, reason: "append", appendReason: "count" })?.message).toContain(
    "chat.selectionLimitCount",
  )
  // 没有可投递的 aux：给通用失败提示（父会话不存在 / 入口未接线）。
  expect(describeAuxAskResult(t, { ok: false, reason: "unavailable" })).toMatchObject({ kind: "warning" })
  expect(describeAuxAskResult(t, { ok: false, reason: "noParent" })?.message).toContain("auxChat.askFailed")
})
