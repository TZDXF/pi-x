import { expect, test, vi } from "vitest"
import { reactive, ref } from "vue"
import { useChatTurnList, blocksText, hasSummary, isWaitingForReply } from "@/composables/useChatTurnList"
import { chatSource } from "./fixtures/chatSources"

test("waiting status hides during tool calls and returns after all tools settle", () => {
  const session = reactive({ isStreaming: true, partialBlocks: null, runs: {} })
  expect(isWaitingForReply(session)).toBe(true)
  session.runs.first = { state: "input-available" }
  session.runs.second = { state: "input-streaming" }
  expect(isWaitingForReply(session)).toBe(false)
  session.runs.first.state = "output-available"
  expect(isWaitingForReply(session)).toBe(false)
  session.runs.second.state = "output-error"
  expect(isWaitingForReply(session)).toBe(true)
  session.partialBlocks = [{ type: "text", text: "reply" }]
  expect(isWaitingForReply(session)).toBe(false)
  session.partialBlocks = null
  session.isStreaming = false
  expect(isWaitingForReply(session)).toBe(false)
})

function harness() {
  const session = reactive({
    entries: [],
    isStreaming: false,
    partialBlocks: null,
    streamingTurnId: null,
    sessionFile: "current",
    hasOlderHistory: true,
    historyLoading: false,
    olderHistoryLoading: false,
    loadOlderHistory: vi.fn(async () => {}),
    revealTimelineTurn: vi.fn(async () => 7),
  })
  const ui = { pushToast: vi.fn() }
  const viewport = { scrollTop: 500, scrollHeight: 2000, isConnected: true, scrollTo: vi.fn() }
  const handle = { stopScroll: vi.fn(), scrollToMessage: vi.fn(), historyViewport: () => viewport }
  const controls = useChatTurnList({ session, ui, connecting: () => false, conversation: ref(handle) })
  return { session, ui, viewport, handle, controls }
}

test("partial turns keep their reserved ID through completion, without crossing panes", () => {
  const left = harness()
  const right = harness()
  left.session.entries.push({ kind: "user", id: 1, text: "left" })
  left.session.isStreaming = true
  left.session.streamingTurnId = 2
  left.session.partialBlocks = [{ type: "text", text: "answer" }]
  expect(left.controls.lastAssistantTurn().id).toBe(2)
  expect(left.controls.lastAssistantTurn().complete).toBe(false)
  expect(right.controls.renderedEntries.value).toEqual([])
  left.session.entries.push({ kind: "assistant", id: 2, blocks: [{ type: "text", text: "answer" }] })
  left.session.partialBlocks = null
  left.session.isStreaming = false
  const done = left.controls.lastAssistantTurn()
  expect(done.id).toBe(2)
  expect(done.complete).toBe(true)
  expect(hasSummary(done)).toBe(true)
  expect(blocksText(done.summary)).toBe("answer")
})

test("partial deltas append without mutating committed blocks and context edits stay hidden", () => {
  const h = harness()
  h.session.entries.push(
    { kind: "user", id: 1, text: "q" },
    { kind: "context_edit", id: 3 },
    { kind: "assistant", id: 2, blocks: [{ type: "text", text: "committed" }] },
  )
  h.session.isStreaming = true
  h.session.partialBlocks = [{ type: "text", text: "delta" }]
  expect(h.controls.renderedEntries.value.map(e => e.kind)).toEqual(["user", "assistant"])
  expect(blocksText(h.controls.lastAssistantTurn().blocks)).toBe("committed\n\ndelta")
  expect(h.session.entries[2].blocks).toHaveLength(1)
})

test("streaming chunks reuse historical turns and do not accumulate in the cached tail", () => {
  const h = harness()
  h.session.entries.push(
    { kind: "user", id: 1, text: "old question" },
    { kind: "assistant", id: 2, blocks: [{ type: "text", text: "old answer" }] },
    { kind: "user", id: 3, text: "new question" },
    { kind: "assistant", id: 4, blocks: [{ type: "text", text: "committed" }] },
  )
  h.session.isStreaming = true
  const original = h.controls.renderedEntries.value
  for (const text of ["one", "one two", "one two three"]) {
    h.session.partialBlocks = [{ type: "text", text }]
    const next = h.controls.renderedEntries.value
    expect(next[1]).toBe(original[1])
    expect(next[3]).not.toBe(original[3])
    expect(blocksText(h.controls.lastAssistantTurn().blocks)).toBe(`committed\n\n${text}`)
  }
  h.session.partialBlocks = null
  expect(h.controls.renderedEntries.value).toBe(original)
  h.session.entries[3].blocks.push({ type: "text", text: "saved" })
  expect(blocksText(h.controls.lastAssistantTurn().blocks)).toBe("committed\n\nsaved")
  h.session.isStreaming = false
  expect(h.controls.lastAssistantTurn().complete).toBe(true)
})

test("idle turns ignore stale tool and thinking deltas after the final answer", () => {
  const h = harness()
  h.session.entries.push(
    { kind: "user", id: 1, text: "q" },
    { kind: "assistant", id: 2, blocks: [{ type: "text", text: "final answer" }] },
  )
  h.session.partialBlocks = [
    { type: "toolCall", callId: "old-tool", name: "bash", argsText: "{}" },
    { type: "thinking", text: "", streaming: true },
  ]
  const turn = h.controls.lastAssistantTurn()
  expect(turn.complete).toBe(true)
  expect(turn.blocks).toEqual([{ type: "text", text: "final answer" }])
  expect(hasSummary(turn)).toBe(true)
  expect(turn.toolCallCount).toBe(0)
})

test("history paging ignores duplicate events and restores only the still-current connected viewport", async () => {
  const h = harness()
  let finish
  h.session.loadOlderHistory.mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve
      }),
  )
  const event = { target: h.viewport }
  const load = h.controls.onHistoryScroll(event)
  await h.controls.onHistoryScroll(event)
  expect(h.session.loadOlderHistory).toHaveBeenCalledOnce()
  h.viewport.scrollTop = 450
  h.viewport.scrollHeight = 3200
  finish()
  await load
  expect(h.viewport.scrollTop).toBe(1650)
  const changed = h.controls.onHistoryScroll(event)
  // Scroll back into the prefetch range first.
  await changed
  h.viewport.scrollTop = 100
  const stale = h.controls.onHistoryScroll(event)
  h.session.sessionFile = "other"
  h.viewport.scrollHeight = 5000
  finish()
  await stale
  expect(h.viewport.scrollTop).toBe(100)
  const detached = h.controls.onHistoryScroll(event)
  h.viewport.isConnected = false
  h.viewport.scrollHeight = 6000
  finish()
  await detached
  expect(h.viewport.scrollTop).toBe(100)
})

test("paging failures release the lock and report through the owning pane", async () => {
  const left = harness()
  const right = harness()
  left.session.loadOlderHistory.mockRejectedValueOnce(new Error("failed page"))
  await left.controls.onHistoryScroll({ target: left.viewport })
  expect(left.ui.pushToast).toHaveBeenCalledWith("Error: failed page", "error")
  expect(right.ui.pushToast).not.toHaveBeenCalled()
  await left.controls.onHistoryScroll({ target: left.viewport })
  expect(left.session.loadOlderHistory).toHaveBeenCalledTimes(2)
})

test("timeline reveals unmaterialized questions and shortcuts scroll only the owning viewport", async () => {
  const left = harness()
  const right = harness()
  await left.controls.navigateToQuestion({ id: "turn" })
  expect(left.session.revealTimelineTurn).toHaveBeenCalledWith("turn")
  // 时间线导航会把"点击时取得的视口请求身份"一并传给滚动（测试替身没有该入口时为 undefined）。
  expect(left.handle.scrollToMessage).toHaveBeenCalledWith(7, undefined)
  await left.controls.navigateToQuestion({ id: "known", entryId: 12 })
  expect(left.session.revealTimelineTurn).toHaveBeenCalledOnce()
  expect(left.handle.scrollToMessage).toHaveBeenLastCalledWith(12, undefined)
  left.controls.scrollHistory(1)
  expect(left.viewport.scrollTo).toHaveBeenCalledWith({ top: 2000 })
  left.controls.scrollHistory(-1)
  expect(left.viewport.scrollTo).toHaveBeenLastCalledWith({ top: 0 })
  expect(right.handle.stopScroll).not.toHaveBeenCalled()
  expect(right.viewport.scrollTo).not.toHaveBeenCalled()
})

test("history paging only compensates the prepended rows (TZD-138)", async () => {
  // 历史分页会**前插一整页更早的消息**：即便 `scrollTop` 不动，眼前的内容也会整体下移。
  // 补偿量必须只算**前插行**的实际高度：等待期间用户可能展开了折叠提问、或做完一次引用
  // 定位，那些高度变化都不是前插（按总高差补会把人刚定位的正文滚出视口，QA 三内核复现）。
  const rows = [{ id: 1, height: 240 }]
  const scrollTop = { value: 500 }
  const viewport = {
    get scrollTop() {
      return scrollTop.value
    },
    set scrollTop(next: number) {
      scrollTop.value = next
    },
    get scrollHeight() {
      return 2000 + rows.reduce((sum, row) => sum + row.height, 0)
    },
    clientHeight: 550,
    isConnected: true,
    getBoundingClientRect: () => ({ top: 0, bottom: 550 }),
    querySelector: () => null,
    querySelectorAll: () =>
      rows.map(row => ({
        getAttribute: (name: string) => (name === "data-message-id" ? String(row.id) : null),
        getBoundingClientRect: () => ({ top: 0, bottom: row.height, height: row.height }),
      })),
  }
  const session = reactive({
    entries: [{ kind: "user", id: 1, text: "q" }],
    isStreaming: false,
    partialBlocks: null,
    streamingTurnId: null,
    sessionFile: "current",
    hasOlderHistory: true,
    historyLoading: false,
    olderHistoryLoading: false,
    loadOlderHistory: vi.fn(async () => {}),
    revealTimelineTurn: vi.fn(async () => {
      // 前插 32 行（合计 1600px）—— 同时**已有行的展开**把高度从 240 变成 420（不是前插）。
      rows[0]!.height = 420
      for (let index = 0; index < 32; index += 1) rows.push({ id: 100 + index, height: 50 })
      return 111
    }),
  })
  const ui = { pushToast: vi.fn() }
  const handle = {
    stopScroll: vi.fn(),
    scrollToMessage: vi.fn(),
    historyViewport: () => viewport,
    beginRevealRequest: () => ({ isCurrent: () => true }),
    withAnchorLock: async <T>(run: () => Promise<T>) => run(),
    isRevealActive: () => false,
  }
  const controls = useChatTurnList({ session, ui, connecting: () => false, conversation: ref(handle) })
  await controls.navigateToQuestion({ id: "older", entryId: null })
  // 只补前插行（32 × 50 = 1600），不含既有行展开带来的 180。
  expect(viewport.scrollTop).toBe(2100)
  // 已挂载的节点（entryId 已知）不触发前插补偿。
  rows.push({ id: 200, height: 50 })
  await controls.navigateToQuestion({ id: "known", entryId: 12 })
  expect(viewport.scrollTop).toBe(2100)
})

test("a stale timeline click returns its loaded page but never navigates (TZD-138)", async () => {
  // 未挂载的时间线节点要先 `await revealTimelineTurn`（拉历史分页），期间用户可能点了引用定位。
  // 旧实现等到分页结束才领请求身份，于是"先点击、后恢复"的旧导航被当成最新，反把新目标顶掉。
  // 现在身份在点击时取得：分页照常返回数据，但过期点击不得再 stopScroll / scrollToMessage。
  // 用一个可切换的"当前身份"替身模拟视口请求序号。
  let seq = 0
  const requests: { isCurrent: () => boolean }[] = []
  const beginRevealRequest = () => {
    seq += 1
    const token = seq
    const request = { isCurrent: () => seq === token }
    requests.push(request)
    return request
  }
  let release!: (id: number) => void
  const session = reactive({
    entries: [],
    isStreaming: false,
    partialBlocks: null,
    streamingTurnId: null,
    sessionFile: "current",
    hasOlderHistory: false,
    historyLoading: false,
    olderHistoryLoading: false,
    loadOlderHistory: vi.fn(async () => {}),
    revealTimelineTurn: vi.fn(() => new Promise<number>(resolve => (release = resolve))),
  })
  const ui = { pushToast: vi.fn() }
  const viewport = { scrollTop: 0, scrollHeight: 1000, isConnected: true, scrollTo: vi.fn() }
  const handle = { stopScroll: vi.fn(), scrollToMessage: vi.fn(), historyViewport: () => viewport, beginRevealRequest }
  const controls = useChatTurnList({ session, ui, connecting: () => false, conversation: ref(handle) })

  // 第一次点击：未挂载的旧节点 → 开始拉分页（挂起）。
  const oldClick = controls.navigateToQuestion({ id: "old", entryId: null })
  await Promise.resolve()
  expect(session.revealTimelineTurn).toHaveBeenCalledWith("old")
  // 等待期间用户又点了一次（更新的定位就此取得身份）。
  beginRevealRequest()
  // 分页结束：数据照常返回，但这次点击已过期，不得再导航。
  release(111)
  await oldClick
  expect(handle.stopScroll).not.toHaveBeenCalled()
  expect(handle.scrollToMessage).not.toHaveBeenCalled()

  // 对照：没有更新的请求时，分页结束后正常导航，并把身份往后传。
  const freshClick = controls.navigateToQuestion({ id: "fresh", entryId: null })
  await Promise.resolve()
  release(222)
  await freshClick
  expect(handle.stopScroll).toHaveBeenCalledTimes(1)
  expect(handle.scrollToMessage).toHaveBeenCalledWith(222, requests[requests.length - 1])
})

test("process materialization survives virtual row unmounting and content/actions keep their layout boundary", () => {
  const list = chatSource("components/chat/ChatTurnList.vue")
  const assistant = chatSource("components/chat/ChatAssistantTurn.vue")
  const user = chatSource("components/chat/ChatUserPrompt.vue")
  expect(list).toMatch(/openedProcesses = reactive\(new Set<number>\(\)\)/)
  expect(list).toMatch(/:process-opened="openedProcesses.has\(entry.id\)"/)
  expect(list).toMatch(/@process-opened="openedProcesses.add\(entry.id\)"/)
  expect(assistant).toMatch(/v-if="processOpened"/)
  for (const source of [assistant, user]) expect(source).toMatch(/<\/MessageContent>\s*<MessageActions/)
  const root = chatSource("components/ChatView.vue")
  expect(root).toMatch(/<Teleport :to="sidebarTarget \|\| 'body'" :disabled="!sidebarTarget" defer>/)
  expect(root).toMatch(/v-model:bridge="bridge"/)
  expect(root).toMatch(/setShortcutsSuppressed\("chat-dialogs", active\)/)
  // ChatView 的规模护栏（防止把业务逻辑继续塞进这个视图）。TZD-101 的侧栏接线
  // （槽位 + aux 实例）整体搬进 `useChatViewSidebar`，视图只留装配与取返回值，
  // 因此恢复 500 上限，不放宽。
  expect(root.split("\n").length).toBeLessThan(500)
})

test("error records stay outside answer/process rendering and failed turns have no actions", () => {
  const assistant = chatSource("components/chat/ChatAssistantTurn.vue")
  const list = chatSource("components/chat/ChatTurnList.vue")
  expect(assistant).toMatch(/v-for="\(error, index\) in entry.errors"/)
  expect(assistant).toMatch(/<MessageActions\s+v-if="entry.complete && !entry.failed"/)
  expect(list).toMatch(/v-if="session.compactionError"/)
})

test.each([
  ["sent prompts", "components/chat/ChatUserPrompt.vue", "<template>", "entry.images"],
  [
    "pending prompts",
    "components/chat/ChatTurnList.vue",
    '<template v-if="ui.pendingUserMessage">',
    "ui.pendingUserMessage.images",
  ],
])("%s show a wrapping image row above and outside the text bubble", (_name, file, marker, images) => {
  const template = chatSource(file).split(marker)[1]!
  const aboveBubble = template.split("<MessageContent>")[0]!
  const bubble = template.match(/<MessageContent>([\s\S]*?)<\/MessageContent>/)![1]!
  expect(aboveBubble).toContain(`v-if="${images}${images === "entry.images" ? "?." : "."}length"`)
  expect(aboveBubble).toContain('class="mb-2 flex max-w-full flex-wrap justify-end gap-2"')
  expect(aboveBubble).toContain(`v-for="(im, i) in ${images}"`)
  expect(aboveBubble).toContain("size-16 shrink-0")
  expect(aboveBubble).toContain(`:aria-label="t('chat.previewImage')"`)
  expect(aboveBubble).toContain(`@click="emit('previewImage', im.url)"`)
  expect(aboveBubble).toMatch(/<img :src="im.url"/)
  expect(bubble).not.toContain("<img")
  // 正文由可折叠的只读正文承载（TZD-138）：首条回显与真实提问同一套折叠语义。
  expect(bubble).toContain("<CollapsiblePromptText")
})
