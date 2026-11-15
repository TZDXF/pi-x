import { beforeEach, expect, test, vi } from "vitest"
import { reactive } from "vue"

/**
 * `useAuxParentContext` 的接线契约：**只**打父 runtime、`streaming` 取父会话实时值、
 * 首轮之后不再取。取材本身（三源/截断/护栏）在 `tests/aux-parent-context.test.ts`。
 */
const controls = vi.hoisted(() => ({
  requests: [] as { command: Record<string, unknown>; runtimeId: string }[],
  history: [] as string[],
  parent: null as null | { isStreaming: boolean; sessionFile: string | null },
}))

vi.mock("@/stores/conversations", () => ({
  peekConversation: (id: string) => {
    controls.requests.push({ command: { type: "(peek)" }, runtimeId: id })
    return controls.parent ?? undefined
  },
}))
vi.mock("@/api/client/rpc", () => ({
  rpcRequest: async (command: Record<string, unknown>, runtimeId: string) => {
    controls.requests.push({ command, runtimeId })
    if (command.type === "get_entries")
      return {
        success: true,
        data: {
          entries: [
            { id: "u1", type: "message", parentId: null, message: { role: "user", content: "父会话提问" } },
            {
              id: "a1",
              type: "message",
              parentId: "u1",
              message: { role: "assistant", content: [{ type: "text", text: "父会话回答" }] },
            },
            { id: "u2", type: "message", parentId: "a1", message: { role: "user", content: "本轮提问" } },
          ],
          leafId: "u2",
        },
      }
    return { success: true, data: { messages: [] } }
  },
}))
vi.mock("@/api/client/sessions", () => ({
  sessionHistory: async (file: string) => {
    controls.history.push(file)
    return []
  },
}))

beforeEach(async () => {
  controls.requests.length = 0
  controls.history.length = 0
  controls.parent = { isStreaming: false, sessionFile: "parent.jsonl" }
  const { resetAuxParentContextForTest } = await import("@/stores/auxContext")
  resetAuxParentContextForTest()
})

test("collects from the parent runtime and stops after the first turn", async () => {
  const { useAuxParentContext } = await import("@/composables/useAuxParentContext")
  const session = reactive({ entries: [] as { kind: string }[] })
  const { parentContext } = useAuxParentContext({
    auxRuntimeId: "aux:one",
    parentRuntimeId: "parent-runtime",
    session: session as never,
  })

  const first = await parentContext()
  expect(first).toContain("父会话回答")
  expect(first).toContain("本轮提问")
  // 只打父 runtime，绝不经过 aux 自己的 runtime。
  expect(controls.requests.every(call => call.runtimeId === "parent-runtime")).toBe(true)
  expect(controls.requests.map(call => call.command.type)).toEqual(["(peek)", "get_entries"])

  // 第 2/3 轮：不再取父上下文（也不再有 RPC）。
  expect(await parentContext()).toBeNull()
  expect(await parentContext()).toBeNull()
  expect(controls.requests).toHaveLength(2)

  // 另一个 aux 实例有自己的记账：仍然取自己的首轮。
  const other = useAuxParentContext({
    auxRuntimeId: "aux:two",
    parentRuntimeId: "parent-runtime",
    session: session as never,
  })
  expect(await other.parentContext()).toContain("父会话回答")
})

test("a short user history in the aux session suppresses the block even without accounting", async () => {
  const { useAuxParentContext } = await import("@/composables/useAuxParentContext")
  const session = reactive({ entries: [{ kind: "user" }, { kind: "assistant" }] })
  const { parentContext } = useAuxParentContext({
    auxRuntimeId: "aux:reloaded",
    parentRuntimeId: "parent-runtime",
    session: session as never,
  })
  expect(await parentContext()).toBeNull()
  // 连父会话都不必去读：已有 user 条目就不是首轮。
  expect(controls.requests).toHaveLength(0)
})

test("streaming is read live from the parent store, so a half-turn never enters", async () => {
  const { useAuxParentContext } = await import("@/composables/useAuxParentContext")
  controls.parent = { isStreaming: true, sessionFile: "parent.jsonl" }
  const session = reactive({ entries: [] as { kind: string }[] })
  const { parentContext } = useAuxParentContext({
    auxRuntimeId: "aux:streaming",
    parentRuntimeId: "parent-runtime",
    session: session as never,
  })
  const inner = (await parentContext()) ?? ""
  // 锚点是最后一条已提交 user（"本轮提问"），它之后的半轮不进上下文。
  expect(inner).toContain("父会话提问")
  expect(inner).toContain("本轮提问")
  expect(inner).toContain("父会话回答")
})

test("a parent that is not in memory still gets collected (no sessionFile fallback needed)", async () => {
  const { useAuxParentContext } = await import("@/composables/useAuxParentContext")
  controls.parent = null
  const session = reactive({ entries: [] as { kind: string }[] })
  const { parentContext } = useAuxParentContext({
    auxRuntimeId: "aux:no-store",
    parentRuntimeId: "parent-runtime",
    session: session as never,
  })
  expect(await parentContext()).toContain("父会话回答")
  // 父会话 store 缺席时不猜 streaming、也不读文件（sessionFile 未知）。
  expect(controls.history).toHaveLength(0)
})
