import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { createPinia, setActivePinia } from "pinia"

const controls = vi.hoisted(() => {
  const state = {}
  return {
    state,
    statuses: new Map(),
    notifications: [],
    piClient: {
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
vi.mock("@/lib/checkpoints", () => ({
  createCheckpoint: async () => ({ commitOid: "oid" }),
  diffCheckpoints: async () => [],
  loadCheckpointManifest: async () => null,
  saveCheckpointManifest: async () => {},
}))
vi.mock("@/lib/fileRewind", () => ({
  fileRewindState: async () => [],
  markFileRewindState: async () => [],
}))
vi.mock("@/lib/notifications", () => ({
  notifyTurnComplete: (...args) => controls.notifications.push(args),
}))
vi.mock("@/stores/sessionRunStatus", () => ({
  setSessionRunStatus: (file, status) => {
    if (status) controls.statuses.set(file, status)
    else controls.statuses.delete(file)
  },
}))
vi.mock("@/stores/workspace", () => ({ useWorkspaceStore: () => controls.workspace }))

beforeEach(() => {
  setActivePinia(createPinia())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

async function harness() {
  Object.assign(controls.state, {
    sessionHistory: async () => [],
    pixLog() {},
    sessionLastError: async () => null,
    sessionMtime: async () => 0,
    rpcRequest: () => new Promise(() => {}),
  })
  controls.statuses.clear()
  controls.notifications.length = 0
  controls.workspace = { histories: {}, projectName: () => "project" }
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {} })
  setActivePinia(createPinia())
  vi.resetModules()
  const { createSessionStore } = await import("@/stores/session")
  function session(id, file) {
    const store = createSessionStore(id)()
    store.sessionFile = file
    return store
  }
  return { statuses: controls.statuses, session, notifications: controls.notifications }
}

test("concurrent sessions show independent running, completed and error statuses", async () => {
  const { statuses, session } = await harness()
  const first = session("first", "first.jsonl")
  const second = session("second", "second.jsonl")
  first.handleEvent({ type: "agent_start" })
  second.handleEvent({ type: "agent_start" })
  expect(statuses.get("first.jsonl")).toBe("running")
  expect(statuses.get("second.jsonl")).toBe("running")
  first.handleEvent({ type: "agent_end" })
  // agent_end alone never finishes a run; only agent_settled does.
  expect(statuses.get("first.jsonl")).toBe("running")
  first.handleEvent({ type: "agent_settled" })
  expect(statuses.get("first.jsonl")).toBe("completed")
  expect(statuses.get("second.jsonl")).toBe("running")
  second.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } })
  second.handleEvent({ type: "agent_end" })
  // A failed run may still be continued by pi (auto-retry / compaction);
  // agent_end alone must not finish it.
  expect(statuses.get("second.jsonl")).toBe("running")
  second.handleEvent({ type: "agent_settled" })
  expect(statuses.get("second.jsonl")).toBe("error")
  second.handleEvent({ type: "agent_start" })
  expect(statuses.get("second.jsonl")).toBe("running")
  second.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } })
  second.handleEvent({ type: "auto_retry_end", success: true })
  // auto_retry_end fires mid-run; pi continues and settles later.
  expect(statuses.get("second.jsonl")).toBe("running")
  second.handleEvent({ type: "agent_end" })
  expect(statuses.get("second.jsonl")).toBe("running")
  second.handleEvent({ type: "agent_settled" })
  expect(statuses.get("second.jsonl")).toBe("completed")
})

test("aborted turns clear status; unexpected process exit marks running turn as error", async () => {
  const { statuses, session } = await harness()
  const store = session("first", "first.jsonl")
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } })
  store.handleEvent({ type: "agent_end" })
  store.handleEvent({ type: "agent_settled" })
  expect(statuses.has("first.jsonl")).toBe(false)
  store.handleEvent({ type: "agent_start" })
  store.markInterrupted()
  expect(statuses.get("first.jsonl")).toBe("error")
  // The interruption must be visible in the conversation, not just the badge.
  const note = store.entries.at(-1)
  expect(note.kind).toBe("assistant")
  expect(note.blocks[0].text).toMatch(/processExited/)
  // An idle worker exiting silently is not an interruption; no noise added.
  const idle = session("idle", "idle.jsonl")
  idle.markInterrupted()
  expect(idle.entries.length).toBe(0)
})

test("viewing a session acknowledges terminal badges without clearing running or other sessions", async () => {
  vi.resetModules()
  const {
    setSessionRunStatus: set,
    sessionRunStatus: get,
    acknowledgeSessionRunStatus: acknowledge,
  } = await vi.importActual("@/stores/sessionRunStatus")
  for (const terminal of ["completed", "error"]) {
    set("project/first.jsonl", terminal)
    set("second.jsonl", terminal)
    acknowledge("project\\first.jsonl")
    expect(get("project/first.jsonl")).toBe(undefined)
    expect(get("second.jsonl")).toBe(terminal)
  }
  set("project/first.jsonl", "running")
  acknowledge("project/first.jsonl")
  expect(get("project/first.jsonl")).toBe("running")
  acknowledge(null)
  acknowledge("missing.jsonl")
  set("project/first.jsonl", "completed")
  expect(get("project/first.jsonl")).toBe("completed")
})
for (const success of [true, false]) {
  test(`retry backoff stays running until retry finishes (success=${success})`, async () => {
    const { statuses, session } = await harness()
    const store = session("retry", "retry.jsonl")
    store.handleEvent({ type: "agent_start" })
    store.handleEvent({ type: "agent_end" })
    for (let attempt = 1; attempt <= 3; attempt++) {
      store.handleEvent({ type: "auto_retry_start", attempt, maxAttempts: 3, errorMessage: "503" })
      expect(store.isStreaming).toBe(true)
      expect(statuses.get("retry.jsonl")).toBe("running")
      expect(store.retryInfo.errorMessage).toMatch(/503/)
      store.handleEvent({ type: "agent_start" })
      store.handleEvent({ type: "agent_end" })
      expect(store.isStreaming).toBe(true)
      expect(statuses.get("retry.jsonl")).toBe("running")
    }
    store.handleEvent({ type: "auto_retry_end", success })
    if (success) expect(store.retryInfo).toBe(null)
    else expect(store.retryInfo.errorMessage).toMatch(/503/)
    // auto_retry_end is not the end of the run; pi settles explicitly.
    expect(store.isStreaming).toBe(true)
    expect(statuses.get("retry.jsonl")).toBe("running")
    store.handleEvent({ type: "agent_settled" })
    expect(store.isStreaming).toBe(false)
    expect(store.retryInfo).toBe(null)
    expect(statuses.get("retry.jsonl")).toBe(success ? "completed" : "error")
  })
}

test("failed attempt notifies only after the auto-retry finishes, exactly once", async () => {
  const { statuses, session, notifications } = await harness()
  const store = session("retry", "retry.jsonl")
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } })
  // pi emits agent_end BEFORE auto_retry_start; the request is still alive.
  store.handleEvent({ type: "agent_end" })
  expect(statuses.get("retry.jsonl")).toBe("running")
  expect(notifications.length).toBe(0)
  store.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "503" })
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })
  expect(store.retryInfo).toBe(null)
  store.handleEvent({ type: "agent_end" })
  expect(notifications.length).toBe(0)
  store.handleEvent({ type: "auto_retry_end", success: true })
  // auto_retry_end(success) arrives mid-run; nothing finishes yet.
  expect(statuses.get("retry.jsonl")).toBe("running")
  expect(notifications.length).toBe(0)
  store.handleEvent({ type: "agent_settled" })
  expect(statuses.get("retry.jsonl")).toBe("completed")
  expect(notifications.length).toBe(1)
  // A duplicate settled must not notify again.
  store.handleEvent({ type: "agent_settled" })
  expect(notifications.length).toBe(1)
})

test("normal run notifies exactly once across agent_end and agent_settled", async () => {
  const { session, notifications } = await harness()
  const store = session("normal", "normal.jsonl")
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })
  store.handleEvent({ type: "agent_end" })
  expect(notifications.length).toBe(0)
  store.handleEvent({ type: "agent_settled" })
  expect(notifications.length).toBe(1)
})

test("finally-failed run surfaces the provider error in the conversation", async () => {
  const { statuses, session } = await harness()
  const store = session("fail", "fail.jsonl")
  for (let attempt = 1; attempt <= 3; attempt++) {
    store.handleEvent({ type: "agent_start" })
    store.handleEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: '503: {"type":"http_error","message":"provider overloaded"}',
        content: [],
      },
    })
    store.handleEvent({ type: "agent_end", willRetry: true })
    store.handleEvent({ type: "auto_retry_start", attempt, maxAttempts: 3, errorMessage: "503" })
  }
  // Transient failures must not leave error text behind.
  expect(store.entries.some(e => e.blocks?.some(b => b.text?.includes("503")))).toBe(false)
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "error",
      errorMessage: '503: {"type":"http_error","message":"provider overloaded"}',
      content: [],
    },
  })
  store.handleEvent({ type: "agent_end", willRetry: false })
  store.handleEvent({ type: "auto_retry_end", success: false })
  store.handleEvent({ type: "agent_settled" })
  expect(statuses.get("fail.jsonl")).toBe("error")
  const note = store.entries.at(-1)
  expect(note.blocks[0].text).toMatch(/chat\.errorLabel/)
  // The JSON payload is humanized: status code + inner message, no raw body.
  expect(note.blocks[0].text).toMatch(/503 · provider overloaded/)
  expect(note.blocks[0].text).not.toMatch(/http_error/)
})

test("settled request clears retry loading even without retry_end", async () => {
  const { statuses, session } = await harness()
  const store = session("retry", "retry.jsonl")
  store.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 })
  store.handleEvent({ type: "agent_settled" })
  expect(store.retryInfo).toBe(null)
  expect(store.isStreaming).toBe(false)
  expect(statuses.get("retry.jsonl")).not.toBe("running")
})

test("retry status is structured and clears as soon as the retried response succeeds", async () => {
  const { session } = await harness()
  const store = session("retry", "retry.jsonl")
  const errorMessage = '503: {"type":"http_error","message":"已尝试所有本地执行候选提供商，但没有任何候选成功完成请求"}'
  store.handleEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage })
  expect(store.retryInfo.attempt).toBe(2)
  expect(store.retryInfo.maxAttempts).toBe(3)
  expect(store.retryInfo.errorMessage).toBe("503 · 已尝试所有本地执行候选提供商，但没有任何候选成功完成请求")

  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })
  expect(store.retryInfo).toBe(null)
})

test("sidebar shows session statuses on the left with animated running and semantic result colors", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const light = readFileSync(new URL("../src/styles/theme/light.css", import.meta.url), "utf8")
  const dark = readFileSync(new URL("../src/styles/theme/dark.css", import.meta.url), "utf8")
  const row = sidebar.match(/<ContextMenu\s+v-for="s in rows\(path\)"[\s\S]*?<\/ContextMenuTrigger>/)?.[0]
  expect(row, "session row is present").toBeTruthy()
  expect(
    row.indexOf('class="session-status') < row.indexOf('variant="session-link"'),
    "status precedes the title",
  ).toBeTruthy()
  expect(row).toMatch(/class="session-status absolute left-\[7px\] top-1\/2/)
  expect(row).not.toMatch(/session-status group-hover\/session:invisible/)
  expect(sidebar).toMatch(/animation: session-status-spin 1s linear infinite/)
  expect(sidebar).toMatch(/@keyframes session-status-spin/)
  expect(sidebar).toMatch(/\.session-status-completed \{\s*color: var\(--success\)/)
  expect(sidebar).toMatch(/\.session-status-error \{\s*color: var\(--destructive\)/)
  for (const theme of [light, dark]) expect(theme).toMatch(/--success: #[0-9a-f]{6}/)
})

test("session rows expose their actions through a right-click context menu", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  expect(sidebar).not.toMatch(/class="session-actions/)
  for (const section of ["rows\\(path\\)", "rows\\(taskPath\\)"]) {
    const row = sidebar.match(new RegExp(`<ContextMenu\\s+v-for="s in ${section}"[\\s\\S]*?<\\/ContextMenu>`))?.[0]
    expect(row, `context menu wraps ${section} rows`).toBeTruthy()
    expect(row).toMatch(/<ContextMenuTrigger as-child :disabled="disabled">/)
    for (const action of ["rename(s)", "duplicateSession(s)", "copySessionLink(s)", "sessionAction', s.file, 'export'"])
      expect(row.includes(action), `menu keeps ${action}`).toBeTruthy()
    // 归档是行内快捷按钮，hover 时显示，不进右键菜单。
    expect(row).toMatch(/class="session-archive hover-action /)
    expect(row.includes('@click="archive(s)"'), "row keeps the hover archive button").toBeTruthy()
    expect(row).not.toMatch(/<ContextMenuItem @select="archive\(s\)"/)
  }
})

test("project heading exposes its actions through a right-click context menu", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const heading = sidebar.match(
    /<ContextMenu>\s*<ContextMenuTrigger as-child :disabled="disabled">\s*<div\s+class="project-heading[\s\S]*?<\/ContextMenu>/,
  )?.[0]
  expect(heading, "project heading is wrapped in a context menu").toBeTruthy()
  // ⋯ 下拉菜单保留，右键菜单提供同样的操作。
  expect(heading).toMatch(/class="project-more hover-action/)
  expect(heading).toMatch(/<ContextMenuContent/)
  for (const action of [
    "workspace.togglePin(path)",
    "emit('editProject', path)",
    "openProjectFolder(path)",
    "emit('removeProject', path)",
  ])
    expect(heading.split(action).length - 1, `${action} appears in both menus`).toBe(2)
})

test("queued prompts show a left-hand clock without a count and hover for the live countdown", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const pending = sidebar.match(/<div\s+v-for="pending in pendingRows\(path\)"[\s\S]*?<\/div>/)?.[0]
  const saved = sidebar.match(/<ContextMenu\s+v-for="s in rows\(path\)"[\s\S]*?<\/ContextMenuTrigger>/)?.[0]
  expect(pending && saved).toBeTruthy()
  expect(pending).toMatch(/session-queue-status absolute left-\[7px\]/)
  expect(saved).toMatch(/session-queue-status absolute top-1\/2/)
  expect(saved).toMatch(/sessionRunStatus\(s.file\) \? 'left-\[23px\]' : 'left-\[7px\]'/)
  expect(saved).toMatch(/'pl-11': !!\(sessionRunStatus\(s.file\)/)
  for (const row of [pending, saved]) {
    expect(row.indexOf("session-queue-status") < row.indexOf('variant="session-link"')).toBeTruthy()
    expect(row).not.toMatch(/\{\{ (?:pending|findConversation\(s.file\)\?)\.promptQueue.length \}\}/)
    expect(row).toMatch(/:title="queueTitle\(/)
  }
  expect(sidebar).toMatch(/sendCountdown\(nextSendAt, queueNow.value\)/)
  expect(sidebar).toMatch(/queueNow = useCountdownNow\(/)
})
