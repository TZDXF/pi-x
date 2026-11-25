import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { createPinia, setActivePinia } from "pinia"
import { watch } from "vue"

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
vi.mock("@/lib/fileRewind", () => ({
  fileRewindState: async () => [],
}))
vi.mock("@/lib/notifications", () => ({ notifyTurnComplete() {} }))
vi.mock("@/stores/sessionRunStatus", () => ({ setSessionRunStatus() {} }))
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => controls.workspace }))

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function harness() {
  const requests = []
  Object.assign(controls.state, {
    sessionHistory: async () => [],
    pixLog() {},
    sessionLastError: async () => null,
    sessionMtime: async () => 0,
    rpcRequest: () =>
      new Promise(resolve => {
        requests.push(resolve)
      }),
  })
  controls.workspace = { histories: {}, projectName: () => "project" }
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem() {},
  })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  return { store: createSessionStore("default")(), requests }
}
const messages = count => Array.from({ length: count }, (_, i) => ({ role: "user", content: `message ${i}` }))

test("restoring history retains response billing metadata and recorded tool duration", async () => {
  const { store } = await harness()
  const usage = {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 0.2, totalFromProvider: true },
  }
  controls.state.sessionHistory = async () => [
    { role: "user", content: "question", timestamp: 100 },
    {
      role: "assistant",
      model: "auto",
      responseModel: "actual",
      usage,
      stopReason: "stop",
      content: [{ type: "text", text: "answer" }],
      timestamp: 200,
    },
    { role: "toolResult", toolCallId: "recorded", durationMs: 1250, content: [{ type: "text", text: "output" }] },
  ]
  store.sessionFile = "history.jsonl"
  await store.loadHistory()
  expect(store.entries.find(entry => entry.kind === "assistant")).toMatchObject({
    model: "auto",
    responseModel: "actual",
    usage,
  })
  expect(store.runs.recorded.durationMs).toBe(1250)
})

test("first page is asynchronous and limited to 30 entries; pages preserve ordering and ids", async () => {
  const { store } = await harness()
  const loading = store.loadMessages(messages(75))
  expect(store.entries.length).toBe(0)
  await loading
  expect(store.entries.length).toBe(30)
  expect(store.entries[0].text).toBe("message 45")
  const id = store.entries[0].id
  await Promise.all([store.loadOlderHistory(), store.loadOlderHistory()])
  expect(store.entries.length).toBe(60)
  expect(store.entries[30].id).toBe(id)
  await store.loadOlderHistory()
  expect(store.entries.length).toBe(75)
  expect(store.entries[0].text).toBe("message 0")
  expect(store.hasOlderHistory).toBe(false)
})

test("a long tool run and empty failure retries do not hide its question on the first page", async () => {
  const { store } = await harness()
  const longTurn = Array.from({ length: 55 }, (_, i) => [
    {
      role: "assistant",
      content: [{ type: "toolCall", id: `call-${i}`, name: "read", arguments: {} }],
      timestamp: 2000 + i,
    },
    { role: "toolResult", toolCallId: `call-${i}`, content: "ok" },
  ]).flat()
  await store.loadMessages([
    { role: "user", content: "older question", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 200 },
    { role: "user", content: "long question", timestamp: 1000 },
    ...longTurn,
    ...Array.from({ length: 11 }, () => ({ role: "assistant", content: [], stopReason: "error" })),
  ])
  expect(store.entries[0].kind).toBe("user")
  expect(store.entries[0].text).toBe("long question")
  expect(store.entries.length).toBe(56)
  expect(store.entries.filter(entry => entry.kind === "assistant").length).toBe(55)
  expect(store.hasOlderHistory).toBe(true)
  await store.loadOlderHistory()
  expect(store.entries[0].text).toBe("older question")
  expect(store.hasOlderHistory).toBe(false)
})

test("tool results survive page boundaries and image-only user messages are retained", async () => {
  const { store } = await harness()
  await store.loadMessages([
    { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "call", content: "result" },
    ...messages(29),
    { role: "user", content: [{ type: "image", mimeType: "image/png", data: "abc" }] },
  ])
  expect(store.entries.length).toBe(30)
  expect(store.entries[29].images[0].url).toBe("data:image/png;base64,abc")
  await store.loadOlderHistory()
  expect(store.runs.call.outputText).toBe("result")
  expect(store.entries[0].blocks[0].callId).toBe("call")
})

test("clear cancels pending page processing", async () => {
  const { store } = await harness()
  const pending = store.loadMessages(messages(100))
  store.clear()
  await pending
  expect(store.entries.length).toBe(0)
  expect(store.olderHistoryLoading).toBe(false)
  expect(store.hasOlderHistory).toBe(false)
})

test("out-of-order history requests cannot overwrite a newer session", async () => {
  const { store, requests } = await harness()
  const old = store.loadHistory()
  store.clear()
  const current = store.loadHistory()
  requests[1]({ success: true, data: { messages: messages(1) } })
  await current
  requests[0]({ success: true, data: { messages: messages(99) } })
  await old
  expect(store.entries.length).toBe(1)
  expect(store.historyLoading).toBe(false)
})

test("failed history request resets loading and can be retried", async () => {
  const { store, requests } = await harness()
  const failed = store.loadHistory()
  requests[0]({ success: false, error: "offline" })
  await expect(failed).rejects.toThrow(/offline/)
  expect(store.historyLoading).toBe(false)
  const retry = store.loadHistory()
  requests[1]({ success: true, data: { messages: [] } })
  await retry
  expect(store.hasOlderHistory).toBe(false)
})

test("history retains question and answer timestamps across pagination", async () => {
  const { store } = await harness()
  await store.loadMessages([
    { role: "user", content: "older question", timestamp: 100 },
    { role: "assistant", content: [{ type: "text", text: "older answer" }], timestamp: 200 },
    { role: "user", content: "question", timestamp: 1000 },
    { role: "assistant", content: [{ type: "text", text: "answer" }], timestamp: 7500 },
    ...messages(29),
  ])
  expect(store.entries[0].timestamp).toBe(1000)
  expect(store.entries[1].timestamp).toBe(7500)
  await store.loadOlderHistory()
  expect(store.entries[0].timestamp).toBe(100)
  expect(store.entries[1].timestamp).toBe(200)
  expect(store.entries[2].timestamp).toBe(1000)
  expect(store.entries[3].timestamp).toBe(7500)
})

test("file change totals remain safe across idle, history loading, completion and clear", async () => {
  const { store } = await harness()
  expect(store.partialBlocks).toBe(null)
  expect(store.fileChanges.length).toBe(0)
  const loading = store.loadMessages([
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "a.ts", oldText: "old", newText: "new" } },
      ],
    },
    { role: "toolResult", toolCallId: "edit-1", content: "ok" },
  ])
  expect(() => store.fileChanges).not.toThrow()
  await loading
  expect(store.partialBlocks).toBe(null)
  expect(store.fileChanges[0].added).toBe(1)
  expect(store.fileChanges[0].removed).toBe(1)
  store.partialBlocks = []
  expect(store.fileChanges.length).toBe(1)
  store.partialBlocks = null
  expect(store.fileChanges.length).toBe(1)
  store.clear()
  expect(store.fileChanges.length).toBe(0)
})

test("compaction summaries materialize as in-position markers", async () => {
  const { store } = await harness()
  await store.loadMessages([
    { role: "user", content: "before" },
    { role: "compactionSummary", summary: "collapsed history", tokensBefore: 120000, timestamp: 42 },
    { role: "user", content: "after" },
  ])
  expect(store.entries.map(e => e.kind).join(",")).toBe("user,compaction,user")
  const marker = store.entries[1]
  expect(marker.summary).toBe("collapsed history")
  expect(marker.tokensBefore).toBe(120000)
  expect(marker.timestamp).toBe(42)
})

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test("attaching history preserves live thinking, turn identity and running tools across later deltas", async () => {
  const { store } = await harness()
  store.sessionFile = "running.jsonl"
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_start", message: { role: "assistant" } })
  const turnId = store.streamingTurnId
  store.handleEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "plan before switching" },
  })
  store.handleEvent({ type: "tool_execution_start", toolCallId: "active", toolName: "read", args: {} })
  const history = deferred()
  controls.state.sessionHistory = () => history.promise
  const loading = store.loadHistory()
  store.handleEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " while loading" },
  })
  history.resolve([{ role: "user", content: "question" }])
  await loading
  expect(store.entries[0].text).toBe("question")
  expect(store.streamingTurnId).toBe(turnId)
  expect(store.runs.active.state).toBe("input-available")
  expect(store.partialBlocks).toEqual([
    { type: "thinking", text: "plan before switching while loading", streaming: true },
  ])
  store.handleEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " after switching" },
  })
  expect(store.partialBlocks[0].text).toBe("plan before switching while loading after switching")
})

test("thinking that starts during history materialization survives its publish", async () => {
  const { store } = await harness()
  store.sessionFile = "running.jsonl"
  controls.state.sessionHistory = async () => [{ role: "user", content: "question" }]
  const loading = store.loadHistory()
  // Allow history fetch and error lookup to reach the asynchronous page yield.
  await Promise.resolve()
  await Promise.resolve()
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_start", message: { role: "assistant" } })
  store.handleEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "new thinking" },
  })
  await loading
  expect(store.partialBlocks[0].text).toBe("new thinking")
  expect(store.streamingTurnId).not.toBeNull()
})

test.each([false, true])("history publish preserves an answer completed during loading (settled=%s)", async settled => {
  const { store } = await harness()
  store.sessionFile = "running.jsonl"
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_start", message: { role: "assistant" } })
  const history = deferred()
  controls.state.sessionHistory = () => history.promise
  const loading = store.loadHistory()
  store.handleEvent({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "live answer" }] },
  })
  if (settled) store.handleEvent({ type: "agent_settled" })
  history.resolve([{ role: "user", content: "question" }])
  await loading
  expect(store.entries.map(entry => entry.kind)).toEqual(["user", "assistant"])
  expect(store.entries[1]).toMatchObject({ blocks: [{ type: "text", text: "live answer" }] })
})

test("history publish deduplicates a live answer already present in the snapshot", async () => {
  const { store } = await harness()
  store.sessionFile = "running.jsonl"
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_start", message: { role: "assistant" } })
  const history = deferred()
  controls.state.sessionHistory = () => history.promise
  const loading = store.loadHistory()
  store.handleEvent({ type: "tool_execution_start", toolCallId: "live-tool", toolName: "read", args: {} })
  store.handleEvent({
    type: "tool_execution_end",
    toolCallId: "live-tool",
    result: { content: [{ type: "text", text: "tool output" }] },
    durationMs: 25,
  })
  store.handleEvent({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "live answer" }] },
  })
  store.handleEvent({ type: "agent_settled" })
  history.resolve([
    { role: "user", content: "question", timestamp: 100 },
    {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "live answer" }],
      timestamp: 200,
    },
  ])
  await loading
  expect(store.entries).toHaveLength(2)
  expect(store.entries.filter(entry => entry.kind === "assistant")).toHaveLength(1)
  expect(store.runs["live-tool"]).toMatchObject({
    state: "output-available",
    outputText: "tool output",
    durationMs: 25,
  })
})

test("worker rebuild reset preserves the visible transcript and identity; normal clear still drops them", async () => {
  const { store } = await harness()
  await store.loadMessages(messages(2))
  store.sessionFile = "saved.jsonl"
  const entries = store.entries
  const runs = store.runs
  store.clear({ preserveHistory: true })
  expect(store.entries).toBe(entries)
  expect(store.runs).toBe(runs)
  expect(store.sessionFile).toBe("saved.jsonl")
  store.clear()
  expect(store.entries).toEqual([])
  expect(store.sessionFile).toBeNull()
})

test("refresh keeps the transcript through error lookup and paging yields, then replaces without a blank frame", async () => {
  const { store } = await harness()
  await store.loadMessages(messages(2))
  store.sessionFile = "saved.jsonl"
  const previous = store.entries
  const error = deferred()
  const requested = deferred()
  controls.state.sessionHistory = async () => messages(75)
  controls.state.sessionLastError = () => {
    requested.resolve()
    return error.promise
  }
  const sizes = []
  const stop = watch(
    () => store.entries.length,
    size => sizes.push(size),
    { flush: "sync" },
  )
  try {
    const loading = store.loadHistory()
    await requested.promise
    expect(store.entries).toBe(previous)
    await store.loadOlderHistory()
    expect(store.entries).toBe(previous)
    error.resolve(null)
    await loading
    expect(sizes).toEqual([30])
    expect(store.entries[0].text).toBe("message 45")
    expect(store.historyLoading).toBe(false)
    await store.loadOlderHistory()
    expect(store.entries).toHaveLength(60)
  } finally {
    stop()
  }
})

test("failed refresh retains the visible transcript", async () => {
  const { store, requests } = await harness()
  await store.loadMessages(messages(2))
  const previous = store.entries
  const loading = store.loadHistory()
  requests[0]({ success: false, error: "unavailable" })
  await expect(loading).rejects.toThrow("unavailable")
  expect(store.entries).toBe(previous)
  expect(store.historyLoading).toBe(false)
})

test("a superseded error lookup cannot replace newer history or append its error", async () => {
  const { store } = await harness()
  store.sessionFile = "saved.jsonl"
  const error = deferred()
  const requested = deferred()
  controls.state.sessionHistory = async () => messages(40)
  controls.state.sessionLastError = () => {
    requested.resolve()
    return error.promise
  }
  const stale = store.loadHistory()
  await requested.promise
  await store.loadMessages([{ role: "user", content: "new snapshot" }])
  error.resolve({ timestamp: 100, errorMessage: "stale error" })
  await stale
  expect(store.entries).toHaveLength(1)
  expect(store.entries[0].text).toBe("new snapshot")
})

test("an empty replacement clears old content only when committed", async () => {
  const { store } = await harness()
  await store.loadMessages(messages(2))
  const previous = store.entries
  const loading = store.loadMessages([])
  expect(store.entries).toBe(previous)
  await loading
  expect(store.entries).toEqual([])
  expect(store.runs).toEqual({})
})

test("jumping to an older turn materializes only the pages it needs", async () => {
  // TZD-148：长会话里点时间轴上的旧轮次时，旧实现把 `while (historyCursor > 0)` 写成
  // "一直补到最老一页"，于是定位倒数第 100 轮也会把整段历史物化并渲染一遍（实测 1000 轮
  // 会话：2000 条 entry、79 次发布、12s）。用户点下去要等十几秒，期间每次前插的补偿还会
  // 把视口来回推。现在补到目标轮次物化就收手。
  const { store } = await harness()
  const turns = 1000
  await store.loadMessages(
    Array.from({ length: turns * 2 }, (_, i) =>
      i % 2 === 0
        ? { role: "user", content: `q${i / 2}` }
        : { role: "assistant", content: [{ type: "text", text: `a${(i - 1) / 2}` }] },
    ),
  )
  // 首屏只有最后一页（每页 30 条 entry = 15 轮）。
  expect(store.entries.length).toBe(30)
  expect(store.hasOlderHistory).toBe(true)
  // 倒数第 100 轮：只需要 6 页左右，绝不是整段历史。
  const near = store.timelineTurns[turns - 100]!
  expect(near.entryId).toBe(null)
  const id = await store.revealTimelineTurn(near.id)
  const entry = store.entries.find(candidate => candidate.id === id)!
  expect(entry.kind).toBe("user")
  expect(entry.text).toBe(near.question)
  expect(store.entries.length).toBe(210)
  // 更早的历史仍然留在边界上，没有被顺手全量物化。
  expect(store.hasOlderHistory).toBe(true)
  // 更早的轮次按需继续补页，且仍然解析到同一条提问。
  const far = { ...store.timelineTurns[3]! }
  const farId = await store.revealTimelineTurn(far.id)
  const farEntry = store.entries.find(candidate => candidate.id === farId)!
  expect(farEntry.text).toBe(far.question)
  expect(store.entries.length).toBe(turns * 2)
  expect(store.hasOlderHistory).toBe(false)
})

test("an already materialized turn is not paged at all", async () => {
  const { store } = await harness()
  await store.loadMessages(
    Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0
        ? { role: "user", content: `q${i / 2}` }
        : { role: "assistant", content: [{ type: "text", text: "a" }] },
    ),
  )
  const before = store.entries.length
  // 最后几轮在首屏里，已经是物化状态（真实 entry id）。
  const turn = store.timelineTurns.at(-1)!
  expect(turn.entryId).not.toBe(null)
  expect(await store.revealTimelineTurn(turn.id)).toBe(turn.entryId)
  expect(store.entries.length).toBe(before)
})

/** 一棵"每轮 user + assistant"的 transcript，可给提问正文/时间戳。 */
const transcript = (turns: number, text: (turn: number) => string = turn => `q${turn}`) =>
  Array.from({ length: turns * 2 }, (_, i) =>
    i % 2 === 0
      ? { role: "user", content: text(i / 2), timestamp: (i / 2) * 1000 }
      : { role: "assistant", content: [{ type: "text", text: `a${(i - 1) / 2}` }], timestamp: (i / 2) * 1000 + 500 },
  )

/** 让出若干个宏任务，等分页真的把页插进来（每页开头/途中都有 `yieldHistory`）。 */
const settle = async (rounds = 3) => {
  for (let i = 0; i < rounds; i++) await new Promise(resolve => setTimeout(resolve, 0))
}

test("a live turn appended while paging does not shift the target (TZD-148)", async () => {
  // QA 复现：点在分页中发起了新提问的会话里的旧轮次，`fromEnd` 会被新轮次顶偏，
  // 于是最终解析返回相邻的那一条（q80 → q81）。目标身份必须与末尾是否增长无关。
  const { store } = await harness()
  await store.loadMessages(transcript(100))
  const target = store.timelineTurns[80]!
  expect(target.entryId).toBe(null)
  const pending = store.revealTimelineTurn(target.id)
  // 分页还在跑：用户发起新提问（live 轮次追加到末尾）。
  await settle(1)
  store.entries.push({ kind: "user", id: 9001, text: "brand new live question", live: true })
  const id = await pending
  const resolved = store.entries.find(entry => entry.id === id)!
  expect(resolved.kind).toBe("user")
  expect((resolved as { text: string }).text).toBe("q80")
  // 而按需分页的收益也保住了：没有把整段历史都物化。
  expect(store.hasOlderHistory).toBe(true)
  expect(store.entries.length).toBeLessThan(200)
})

test("identical question text resolves by position, not by text (TZD-148)", async () => {
  // 提问文本不是唯一键：同一句话可能出现多次。旧实现最终的兜底只用文本匹配，
  // 于是"第 20 轮"会被解析到第 80 轮（或反过来），QA 点名的另一半根因。
  const same = "identical question"
  const { store } = await harness()
  await store.loadMessages(transcript(100, turn => (turn === 20 || turn === 80 ? same : `q${turn}`)))
  const early = store.timelineTurns[20]!
  expect(early.question).toBe(same)
  expect(early.entryId).toBe(null)
  const pending = store.revealTimelineTurn(early.id)
  // 并发场景：分页中又有一条**同样文本**的新提问进来（文本兜底会被它抢走）。
  await settle(1)
  store.entries.push({ kind: "user", id: 9001, text: same, live: true })
  const earlyId = await pending
  const earlyEntry = store.entries.find(entry => entry.id === earlyId)!
  // 用时间戳区分两条同文本轮次：第 20 轮 = 20000，第 80 轮 = 80000。
  expect(earlyEntry.kind).toBe("user")
  expect((earlyEntry as { timestamp?: number }).timestamp).toBe(20_000)
  const late = store.timelineTurns[80]!
  expect(late.question).toBe(same)
  // 补第 20 轮时途经的页已把第 80 轮物化；即便如此它也必须解析到**自己**这一条。
  const lateId = await store.revealTimelineTurn(late.id)
  const lateEntry = store.entries.find(entry => entry.id === lateId)!
  expect((lateEntry as { timestamp?: number }).timestamp).toBe(80_000)
  expect(lateId).not.toBe(earlyId)
})

test("a live append before the click does not change later reveals (TZD-148)", async () => {
  // 对照：末尾已经有 live 轮次时（没有竞态），定位仍然精确。
  const { store } = await harness()
  await store.loadMessages(transcript(100))
  store.entries.push({ kind: "user", id: 9001, text: "live question", live: true })
  const target = store.timelineTurns[70]!
  expect(target.entryId).toBe(null)
  const id = await store.revealTimelineTurn(target.id)
  const resolved = store.entries.find(entry => entry.id === id)!
  expect((resolved as { text: string }).text).toBe("q70")
})
