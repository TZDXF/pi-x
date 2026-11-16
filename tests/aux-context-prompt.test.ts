import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createPinia, setActivePinia } from "pinia"

/**
 * 折叠块的**五处落点**（`docs/aux-chat-spec.md` §4）里可单测的三处：
 * 1. `stores/session/history.ts`：重建 user entry 时存完整 prompt + 拆出可见正文；
 * 2. `ChatUserPrompt.vue`：复制只用可见正文、折叠块默认收起；
 * 3. `usePromptEdit.ts`：编辑只改提问，块字节原样保留。
 *
 * 解析/序列化（第 1 处落点）在 `tests/aux-parent-context.test.ts`；
 * `conversationTimeline`（第 5 处）在 `tests/conversation-timeline.test.ts`。
 */
const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    piClient: {
      adoptSession: async () => {},
      sessionHistory: (...args) => state.sessionHistory(...args),
      pixLog: (...args) => state.pixLog(...args),
      sessionLastError: (...args) => state.sessionLastError(...args),
      sessionMtime: (...args) => state.sessionMtime(...args),
      rpcRequest: (...args) => state.rpcRequest(...args),
    },
    workspace: {},
  }
})

vi.mock("@/api/piClient", () => controls.piClient)
vi.mock("@/api/transport", () => ({ invoke: async () => null }))
vi.mock("@/i18n", () => ({
  i18n: { global: { t: key => key } },
  tBackendError: value => String(value ?? ""),
}))
vi.mock("@/lib/fileRewind", () => ({ fileRewindState: async () => [] }))
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {} }))
vi.mock("@/stores/sessionRunStatus", () => ({ setSessionRunStatus() {} }))
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => controls.workspace }))

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")

/** 落盘形态：块在 prompt 最前，其后一个空行与提问正文。 */
const persistedPrompt = [
  "<aux_parent_context>",
  "【用户】父会话第一轮",
  "【助手】父会话第一轮回答",
  "</aux_parent_context>",
  "",
  "本轮的提问",
].join("\n")

async function historyHarness() {
  Object.assign(controls.state, {
    sessionHistory: async () => [
      { role: "user", content: persistedPrompt, timestamp: 100 },
      { role: "assistant", content: [{ type: "text", text: "aux 的回答" }], timestamp: 200 },
      { role: "user", content: "第二轮提问", timestamp: 300 },
    ],
    sessionLastError: async () => null,
    sessionMtime: async () => 0,
    pixLog() {},
    rpcRequest: async () => ({ success: true, data: { messages: [] } }),
  })
  controls.workspace = { histories: {}, projectName: () => "project" }
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  const store = createSessionStore("aux-history")()
  store.sessionFile = "aux.jsonl"
  await store.loadHistory()
  return store
}

test("history rebuild keeps the full prompt and exposes only the question", async () => {
  const store = await historyHarness()
  const first = store.entries.find(entry => entry.kind === "user" && entry.timestamp === 100)
  expect(first).toMatchObject({
    kind: "user",
    text: "本轮的提问",
    parentContext: "【用户】父会话第一轮\n【助手】父会话第一轮回答",
    contextText: persistedPrompt,
  })
  // 老历史（没有块）行为不变：没有 parentContext / parentContextBlock。
  const second = store.entries.find(entry => entry.kind === "user" && entry.timestamp === 300)
  expect(second.text).toBe("第二轮提问")
  expect(second.parentContext).toBeUndefined()
  // 气泡展示与复制都只用可见正文（`text` 本身已是拆分后的正文）。
  expect(store.entries.map(entry => entry.text ?? "")).not.toContainEqual(
    expect.stringContaining("<aux_parent_context>"),
  )
})

test("FAIL_timeline_*: 摘要走同一解析器，区块与 userselect 尾块都不进时间线", async () => {
  const store = await historyHarness()
  const turns = store.timelineTurns
  expect(turns.map(turn => turn.question)).toContain("本轮的提问")
  expect(turns.every(turn => !turn.question.includes("aux_parent_context"))).toBe(true)
  // 尾块同样不是用户写的问题：`# userselect:` 与 `# Code comments:` 不得进摘要。
  const { buildTimelineTurns } = await import("@/lib/conversationTimeline")
  const selections = [{ text: "引用的回复" }]
  const { serializeComposerPromptContexts } = await import("@/lib/promptContexts")
  const prompt = serializeComposerPromptContexts("真实提问", { comments: [], selections })
  const timeline = buildTimelineTurns([], 0, [{ kind: "user", id: 7, text: prompt }])
  expect(timeline[0].question).toBe("真实提问")
  expect(timeline[0].question).not.toContain("userselect")
  expect(timeline[0].question).not.toContain("引用的回复")
  // 可失败性对照：绕过解析器直接截取原文时，尾块确实会出现在摘要里。
  expect(prompt).toContain("# userselect:")
  // 父上下文块 + 尾块同时存在时也只留提问正文。
  const both = serializeComposerPromptContexts("第二轮提问", { comments: [], selections, parentContext: "父会话内容" })
  expect(buildTimelineTurns([], 0, [{ kind: "user", id: 8, text: both }])[0].question).toBe("第二轮提问")
})

test("copy uses only the visible question (no `<aux_parent_context>`)", () => {
  const chat = source("../src/components/chat/ChatUserPrompt.vue")
  // 复制走拆分后的可见正文，而不是 entry.text 的原始 prompt。
  expect(chat).toMatch(
    /const visibleText = computed\(\(\) => parseComposerPromptContexts\(props\.entry\.text\)\.visibleContent\)/,
  )
  expect(chat).toMatch(/@click="emit\('copyText', visibleText\)"/)
  // 气泡**不再展示**父上下文块（也不再有折叠块/展开态）：块只存在于 prompt 数据里。
  expect(chat).not.toMatch(/data-aux-parent-context/)
  expect(chat).not.toMatch(/parentContextOpen/)
  expect(chat).not.toMatch(/chat\.parentContext/)
  // 展示正文也来自解析器（与读回同源）。
  expect(chat).toMatch(/parseComposerPromptContexts\(props\.entry\.contextText \?\? props\.entry\.text\)/)
})

test("editing rewrites only the question and keeps the block bytes intact", async () => {
  const { promptPreservingParentContextBlock } = await import("@/composables/usePromptEdit")
  const entry = {
    kind: "user",
    id: 1,
    text: "本轮的提问",
    parentContext: "【用户】父会话第一轮\n【助手】父会话第一轮回答",
    parentContextBlock: "<aux_parent_context>\n【用户】父会话第一轮\n【助手】父会话第一轮回答\n</aux_parent_context>",
    contextText: persistedPrompt,
  }
  const rebuilt = promptPreservingParentContextBlock(entry, "改过的提问")
  // 块字节不变，只换提问正文。
  expect(rebuilt).toBe(persistedPrompt.replace("本轮的提问", "改过的提问"))
  expect(rebuilt.startsWith(entry.parentContextBlock)).toBe(true)
  // 实时消息（解析后 `entry.text` 已不含块）：从 `contextText` 里剥出原文再拼回去。
  const live = { kind: "user", id: 2, text: "第二轮", contextText: persistedPrompt.replace("本轮的提问", "第二轮") }
  expect(promptPreservingParentContextBlock(live, "再改一次")).toBe(persistedPrompt.replace("本轮的提问", "再改一次"))
  // 没有块：原样返回（主会话行为不变）。
  expect(promptPreservingParentContextBlock({ kind: "user", id: 3, text: "普通提问" }, "改过")).toBe("改过")
})

test("the edit textarea starts from the visible question, not the persisted prompt", () => {
  const edit = source("../src/composables/usePromptEdit.ts")
  // 编辑框初值来自解析后的可见正文；重发时把块原样拼回去。
  expect(edit).toMatch(/editedText\.value = parseComposerPromptContexts\(entry\.text\)\.visibleContent/)
  expect(edit).toMatch(/promptPreservingParentContextBlock\(entry, withSessionReferences\(text, knownSessions\(\)\)\)/)
})

test("aux panels never re-send edits (no rewind_prompt path)", () => {
  const pane = source("../src/components/aux-chat/AuxChatPane.vue")
  // aux 的编辑态是恒不可用的桩：`rewind_prompt` 被 M0 拒绝、也没有 session 文件。
  expect(pane).toMatch(/editBlocked: true/)
  expect(pane).not.toMatch(/resendPrompt/)
})
