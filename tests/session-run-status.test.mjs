import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { loadTsModule, pathsModule } from "./lib/load-ts.mjs"

function harness() {
  const statuses = new Map()
  const notifications = []
  const modules = {
    pinia: { defineStore: (_, setup) => setup },
    vue: {
      ref: value => ({ value }),
      shallowRef: value => ({ value }),
      computed: get => ({
        get value() {
          return get()
        },
      }),
      watch: (source, cb, options) => {
        if (options?.immediate) cb(typeof source === "function" ? source() : source)
        return () => {}
      },
    },
    "@/lib/checkpoints": {
      createCheckpoint: async () => ({ refName: "r", commitOid: "oid" }),
      diffCheckpoints: async () => [],
      loadCheckpointManifest: async () => null,
      saveCheckpointManifest: async () => {},
    },
    "@/i18n": { i18n: { global: { t: key => key } } },
    "@/api/piClient": { sessionHistory: async () => [], pixLog() {}, rpcRequest: () => new Promise(() => {}) },
    "@/stores/workspace": { useWorkspaceStore: () => ({ histories: {}, projectName: () => "project" }) },
    "@/lib/notifications": { notifyTurnComplete: (...args) => notifications.push(args) },
    "@/stores/sessionRunStatus": {
      setSessionRunStatus: (file, status) => {
        if (status) statuses.set(file, status)
        else statuses.delete(file)
      },
    },
  }
  const { createSessionStore } = loadTsModule(new URL("../src/stores/session.ts", import.meta.url), id => modules[id], {
    localStorage: { getItem: () => null },
  })
  function session(id, file) {
    const store = createSessionStore(id)()
    store.sessionFile.value = file
    return store
  }
  return { statuses, session, notifications }
}

test("concurrent sessions show independent running, completed and error statuses", () => {
  const { statuses, session } = harness()
  const first = session("first", "first.jsonl")
  const second = session("second", "second.jsonl")
  first.handleEvent({ type: "agent_start" })
  second.handleEvent({ type: "agent_start" })
  assert.equal(statuses.get("first.jsonl"), "running")
  assert.equal(statuses.get("second.jsonl"), "running")
  first.handleEvent({ type: "agent_end" })
  // agent_end alone never finishes a run; only agent_settled does.
  assert.equal(statuses.get("first.jsonl"), "running")
  first.handleEvent({ type: "agent_settled" })
  assert.equal(statuses.get("first.jsonl"), "completed")
  assert.equal(statuses.get("second.jsonl"), "running")
  second.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } })
  second.handleEvent({ type: "agent_end" })
  // A failed run may still be continued by pi (auto-retry / compaction);
  // agent_end alone must not finish it.
  assert.equal(statuses.get("second.jsonl"), "running")
  second.handleEvent({ type: "agent_settled" })
  assert.equal(statuses.get("second.jsonl"), "error")
  second.handleEvent({ type: "agent_start" })
  assert.equal(statuses.get("second.jsonl"), "running")
  second.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } })
  second.handleEvent({ type: "auto_retry_end", success: true })
  // auto_retry_end fires mid-run; pi continues and settles later.
  assert.equal(statuses.get("second.jsonl"), "running")
  second.handleEvent({ type: "agent_end" })
  assert.equal(statuses.get("second.jsonl"), "running")
  second.handleEvent({ type: "agent_settled" })
  assert.equal(statuses.get("second.jsonl"), "completed")
})

test("aborted turns clear status; unexpected process exit marks running turn as error", () => {
  const { statuses, session } = harness()
  const store = session("first", "first.jsonl")
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } })
  store.handleEvent({ type: "agent_end" })
  store.handleEvent({ type: "agent_settled" })
  assert.equal(statuses.has("first.jsonl"), false)
  store.handleEvent({ type: "agent_start" })
  store.markInterrupted()
  assert.equal(statuses.get("first.jsonl"), "error")
  // The interruption must be visible in the conversation, not just the badge.
  const note = store.entries.value.at(-1)
  assert.equal(note.kind, "assistant")
  assert.match(note.blocks[0].text, /processExited/)
  // An idle worker exiting silently is not an interruption; no noise added.
  const idle = session("idle", "idle.jsonl")
  idle.markInterrupted()
  assert.equal(idle.entries.value.length, 0)
})

test("viewing a session acknowledges terminal badges without clearing running or other sessions", () => {
  const source = readFileSync(new URL("../src/stores/sessionRunStatus.ts", import.meta.url), "utf8")
  const context = vm.createContext({
    exports: {},
    require: name => (name === "vue" ? { reactive: value => value } : pathsModule()),
  })
  vm.runInContext(ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  const { setSessionRunStatus: set, sessionRunStatus: get, acknowledgeSessionRunStatus: acknowledge } = context.exports
  for (const terminal of ["completed", "error"]) {
    set("project/first.jsonl", terminal)
    set("second.jsonl", terminal)
    acknowledge("project\\first.jsonl")
    assert.equal(get("project/first.jsonl"), undefined)
    assert.equal(get("second.jsonl"), terminal)
  }
  set("project/first.jsonl", "running")
  acknowledge("project/first.jsonl")
  assert.equal(get("project/first.jsonl"), "running")
  acknowledge(null)
  acknowledge("missing.jsonl")
  set("project/first.jsonl", "completed")
  assert.equal(get("project/first.jsonl"), "completed")
})

for (const success of [true, false]) {
  test(`retry backoff stays running until retry finishes (success=${success})`, () => {
    const { statuses, session } = harness()
    const store = session("retry", "retry.jsonl")
    store.handleEvent({ type: "agent_start" })
    store.handleEvent({ type: "agent_end" })
    for (let attempt = 1; attempt <= 3; attempt++) {
      store.handleEvent({ type: "auto_retry_start", attempt, maxAttempts: 3, errorMessage: "503" })
      assert.equal(store.isStreaming.value, true)
      assert.equal(statuses.get("retry.jsonl"), "running")
      assert.match(store.retryInfo.value.errorMessage, /503/)
      store.handleEvent({ type: "agent_start" })
      store.handleEvent({ type: "agent_end" })
      assert.equal(store.isStreaming.value, true)
      assert.equal(statuses.get("retry.jsonl"), "running")
    }
    store.handleEvent({ type: "auto_retry_end", success })
    if (success) assert.equal(store.retryInfo.value, null)
    else assert.match(store.retryInfo.value.errorMessage, /503/)
    // auto_retry_end is not the end of the run; pi settles explicitly.
    assert.equal(store.isStreaming.value, true)
    assert.equal(statuses.get("retry.jsonl"), "running")
    store.handleEvent({ type: "agent_settled" })
    assert.equal(store.isStreaming.value, false)
    assert.equal(store.retryInfo.value, null)
    assert.equal(statuses.get("retry.jsonl"), success ? "completed" : "error")
  })
}

test("failed attempt notifies only after the auto-retry finishes, exactly once", () => {
  const { statuses, session, notifications } = harness()
  const store = session("retry", "retry.jsonl")
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } })
  // pi emits agent_end BEFORE auto_retry_start; the request is still alive.
  store.handleEvent({ type: "agent_end" })
  assert.equal(statuses.get("retry.jsonl"), "running")
  assert.equal(notifications.length, 0)
  store.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "503" })
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })
  assert.equal(store.retryInfo.value, null)
  store.handleEvent({ type: "agent_end" })
  assert.equal(notifications.length, 0)
  store.handleEvent({ type: "auto_retry_end", success: true })
  // auto_retry_end(success) arrives mid-run; nothing finishes yet.
  assert.equal(statuses.get("retry.jsonl"), "running")
  assert.equal(notifications.length, 0)
  store.handleEvent({ type: "agent_settled" })
  assert.equal(statuses.get("retry.jsonl"), "completed")
  assert.equal(notifications.length, 1)
  // A duplicate settled must not notify again.
  store.handleEvent({ type: "agent_settled" })
  assert.equal(notifications.length, 1)
})

test("normal run notifies exactly once across agent_end and agent_settled", () => {
  const { session, notifications } = harness()
  const store = session("normal", "normal.jsonl")
  store.handleEvent({ type: "agent_start" })
  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })
  store.handleEvent({ type: "agent_end" })
  assert.equal(notifications.length, 0)
  store.handleEvent({ type: "agent_settled" })
  assert.equal(notifications.length, 1)
})

test("finally-failed run surfaces the provider error in the conversation", () => {
  const { statuses, session } = harness()
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
  assert.equal(
    store.entries.value.some(e => e.blocks?.some(b => b.text?.includes("503"))),
    false,
  )
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
  assert.equal(statuses.get("fail.jsonl"), "error")
  const note = store.entries.value.at(-1)
  assert.match(note.blocks[0].text, /chat\.errorLabel/)
  // The JSON payload is humanized: status code + inner message, no raw body.
  assert.match(note.blocks[0].text, /503 · provider overloaded/)
  assert.doesNotMatch(note.blocks[0].text, /http_error/)
})

test("settled request clears retry loading even without retry_end", () => {
  const { statuses, session } = harness()
  const store = session("retry", "retry.jsonl")
  store.handleEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 })
  store.handleEvent({ type: "agent_settled" })
  assert.equal(store.retryInfo.value, null)
  assert.equal(store.isStreaming.value, false)
  assert.notEqual(statuses.get("retry.jsonl"), "running")
})

test("retry status is structured and clears as soon as the retried response succeeds", () => {
  const { session } = harness()
  const store = session("retry", "retry.jsonl")
  const errorMessage = '503: {"type":"http_error","message":"已尝试所有本地执行候选提供商，但没有任何候选成功完成请求"}'
  store.handleEvent({ type: "auto_retry_start", attempt: 2, maxAttempts: 3, errorMessage })
  assert.equal(store.retryInfo.value.attempt, 2)
  assert.equal(store.retryInfo.value.maxAttempts, 3)
  assert.equal(store.retryInfo.value.errorMessage, "503 · 已尝试所有本地执行候选提供商，但没有任何候选成功完成请求")

  store.handleEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", content: [] } })
  assert.equal(store.retryInfo.value, null)
})

test("sidebar shows session statuses on the left with animated running and semantic result colors", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const light = readFileSync(new URL("../src/styles/theme/light.css", import.meta.url), "utf8")
  const dark = readFileSync(new URL("../src/styles/theme/dark.css", import.meta.url), "utf8")
  const row = sidebar.match(/<ContextMenu\s+v-for="s in rows\(path\)"[\s\S]*?<\/ContextMenuTrigger>/)?.[0]
  assert.ok(row, "session row is present")
  assert.ok(row.indexOf('class="session-status') < row.indexOf('variant="session-link"'), "status precedes the title")
  assert.match(row, /class="session-status absolute left-\[7px\] top-1\/2/)
  assert.doesNotMatch(row, /session-status group-hover\/session:invisible/)
  assert.match(sidebar, /animation: session-status-spin 1s linear infinite/)
  assert.match(sidebar, /@keyframes session-status-spin/)
  assert.match(sidebar, /\.session-status-completed \{\s*color: var\(--success\)/)
  assert.match(sidebar, /\.session-status-error \{\s*color: var\(--destructive\)/)
  for (const theme of [light, dark]) assert.match(theme, /--success: #[0-9a-f]{6}/)
})

test("session rows expose their actions through a right-click context menu", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  assert.doesNotMatch(sidebar, /class="session-actions/)
  for (const section of ["rows\\(path\\)", "rows\\(taskPath\\)"]) {
    const row = sidebar.match(new RegExp(`<ContextMenu\\s+v-for="s in ${section}"[\\s\\S]*?<\\/ContextMenu>`))?.[0]
    assert.ok(row, `context menu wraps ${section} rows`)
    assert.match(row, /<ContextMenuTrigger as-child :disabled="disabled">/)
    for (const action of ["rename(s)", "duplicateSession(s)", "copySessionLink(s)", "sessionAction', s.file, 'export'"])
      assert.ok(row.includes(action), `menu keeps ${action}`)
    // 归档是行内快捷按钮，hover 时显示，不进右键菜单。
    assert.match(row, /class="session-archive hover-action /)
    assert.ok(row.includes('@click="archive(s)"'), "row keeps the hover archive button")
    assert.doesNotMatch(row, /<ContextMenuItem @select="archive\(s\)"/)
  }
})

test("project heading exposes its actions through a right-click context menu", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const heading = sidebar.match(
    /<ContextMenu>\s*<ContextMenuTrigger as-child :disabled="disabled">\s*<div\s+class="project-heading[\s\S]*?<\/ContextMenu>/,
  )?.[0]
  assert.ok(heading, "project heading is wrapped in a context menu")
  // ⋯ 下拉菜单保留，右键菜单提供同样的操作。
  assert.match(heading, /class="project-more hover-action/)
  assert.match(heading, /<ContextMenuContent/)
  for (const action of [
    "workspace.togglePin(path)",
    "emit('editProject', path)",
    "openProjectFolder(path)",
    "emit('removeProject', path)",
  ])
    assert.equal(heading.split(action).length - 1, 2, `${action} appears in both menus`)
})

test("queued prompts show a left-hand clock without a count and hover for the live countdown", () => {
  const sidebar = readFileSync(new URL("../src/components/WorkspaceSidebar.vue", import.meta.url), "utf8")
  const pending = sidebar.match(/<div\s+v-for="pending in pendingRows\(path\)"[\s\S]*?<\/div>/)?.[0]
  const saved = sidebar.match(/<ContextMenu\s+v-for="s in rows\(path\)"[\s\S]*?<\/ContextMenuTrigger>/)?.[0]
  assert.ok(pending && saved)
  assert.match(pending, /session-queue-status absolute left-\[7px\]/)
  assert.match(saved, /session-queue-status absolute top-1\/2/)
  assert.match(saved, /sessionRunStatus\(s.file\) \? 'left-\[23px\]' : 'left-\[7px\]'/)
  assert.match(saved, /'pl-11': !!\(sessionRunStatus\(s.file\)/)
  for (const row of [pending, saved]) {
    assert.ok(row.indexOf("session-queue-status") < row.indexOf('variant="session-link"'))
    assert.doesNotMatch(row, /\{\{ (?:pending|findConversation\(s.file\)\?)\.promptQueue.length \}\}/)
    assert.match(row, /:title="queueTitle\(/)
  }
  assert.match(sidebar, /sendCountdown\(nextSendAt, queueNow.value\)/)
  assert.match(sidebar, /setInterval\(\(\) => \{[\s\S]*?queueNow\.value = Date\.now\(\)[\s\S]*?\}, 1000\)/)
})
