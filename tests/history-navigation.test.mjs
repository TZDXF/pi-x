import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")
const run = (code, context) =>
  vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), vm.createContext(context))

test("navigation stays serialized and the latest pending selection wins", async () => {
  const app = source("../src/App.vue")
  const code = app.slice(app.indexOf("let queuedNavigation:"), app.indexOf("watch([connecting, navigating]"))
  const context = {
    ref: value => ({ value }),
    session: {},
    workspace: {},
    phase: { value: "chat" },
    connecting: { value: false },
    navigating: { value: false },
    pendingResume: { value: null },
    disposed: false,
  }
  run(code + "\nglobalThis.navigate = requestNavigation", context)
  const calls = []
  let finish
  context.navigate(() => {
    calls.push("first")
    return new Promise(resolve => {
      finish = resolve
    })
  })
  context.navigate(async () => {
    calls.push("skipped")
  })
  context.navigate(async () => {
    calls.push("latest")
  })
  assert.deepEqual(calls, ["first"])
  finish()
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, ["first", "latest"])
})

test("history prefetches near the top, suppresses duplicates and preserves the reading position", async () => {
  const chat = source("../src/components/ChatView.vue")
  const code = chat.slice(chat.indexOf("let restoringHistory ="), chat.indexOf("const completion ="))
  const viewport = { scrollTop: 601, scrollHeight: 2000, isConnected: true }
  let finish
  let requests = 0
  const context = {
    session: {
      sessionFile: "current",
      hasOlderHistory: true,
      loadOlderHistory: () => {
        requests++
        return new Promise(resolve => {
          finish = resolve
        })
      },
    },
    props: {},
    conversation: { value: { stopScroll() {} } },
    nextTick: async () => {},
    ui: { pushToast() {} },
  }
  run(code + "\nglobalThis.scroll = onHistoryScroll", context)
  await context.scroll({ target: viewport })
  assert.equal(requests, 0)
  viewport.scrollTop = 500
  const pending = context.scroll({ target: viewport })
  await context.scroll({ target: viewport })
  assert.equal(requests, 1)
  viewport.scrollTop = 450 // Reader continues scrolling while the page is loaded.
  viewport.scrollHeight = 3200
  finish()
  await pending
  assert.equal(viewport.scrollTop, 1650)
})

test("conversation mounts immediately with instant initial positioning; loading stays silent", () => {
  const chat = source("../src/components/ChatView.vue")
  assert.match(chat, /<Conversation[^>]*ref="conversation"[^>]+initial="instant"/)
  assert.match(
    chat,
    /v-if="session.entries.length === 0 && !session.historyLoading && \(!connecting \|\| selectingProject\)"/,
  )
  assert.doesNotMatch(chat, /v-if="connecting \|\| session.historyLoading"/)
  assert.doesNotMatch(chat, /@click="loadOlderHistory"/)
})

test("streaming navigation switches without aborting the running generation", async () => {
  const app = source("../src/App.vue")
  const code = app.slice(app.indexOf("let queuedNavigation:"), app.indexOf("watch([connecting, navigating]"))
  const calls = []
  const context = {
    ref: value => ({ value }),
    session: {
      isStreaming: true,
      abortAndRestore: () => {
        calls.push("abort")
        return Promise.resolve()
      },
    },
    workspace: {},
    phase: { value: "chat" },
    connecting: { value: false },
    navigating: { value: false },
    pendingResume: { value: null },
    disposed: false,
  }
  run(code + "\nglobalThis.navigate = requestNavigation", context)
  context.navigate(async () => calls.push("switch"))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(calls, ["switch"])
})

test("streaming composer shows send for text or attachments and stop only when empty", () => {
  const chat = source("../src/components/ChatView.vue")
  const declaration = chat.match(/^const showStopButton = .*$/m)?.[0]
  assert.ok(declaration)
  const session = { isStreaming: true }
  const delayedSend = { value: false }
  const bridge = { value: { textInput: "", files: [] } }
  const attachments = {
    get value() {
      return bridge.value.files
    },
  }
  const context = {
    session,
    delayedSend,
    bridge,
    attachments,
    computed: getter => ({
      get value() {
        return getter()
      },
    }),
  }
  run(`${declaration}\nglobalThis.shouldStop = () => showStopButton.value`, context)
  assert.equal(context.shouldStop(), true)
  bridge.value.textInput = "hello"
  assert.equal(context.shouldStop(), false)
  bridge.value.textInput = "   "
  assert.equal(context.shouldStop(), true)
  bridge.value.files.push({ id: "image" })
  assert.equal(context.shouldStop(), false)
  bridge.value.files.length = 0
  delayedSend.value = true
  assert.equal(context.shouldStop(), false)
  delayedSend.value = false
  session.isStreaming = false
  assert.equal(context.shouldStop(), false)
  assert.match(
    chat,
    /:aria-label="\s*showStopButton \? t\('chat\.stop'\) : delayedSend \? t\('chat\.delayedSend'\) : t\('chat\.sendMessage'\)"/,
  )
})

test("streaming input reaches command dispatch; the submit button doubles as stop while streaming", () => {
  const chat = source("../src/components/ChatView.vue")
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  assert.doesNotMatch(submit, /if \(session.isStreaming\)\s*\{\s*await abort\(\)\s*return/)
  assert.match(chat, /<PromptInputSubmit[\s\S]*?:status="showStopButton \? 'streaming' : undefined"/)
  assert.match(chat, /<PromptInputSubmit[\s\S]*?:type="showStopButton \? 'button' : 'submit'"/)
  assert.match(chat, /<PromptInputSubmit[\s\S]*?@click="showStopButton && abort\(\)"/)
  // /compact queues behind the active run; the store executes it from the queue.
  assert.doesNotMatch(submit, /await abort\(\)/)
  assert.match(
    submit,
    /else if \(commandName === 'compact'\) await session\.send\(text, undefined, undefined, runningBehavior\.value\)/,
  )
  assert.match(submit, /if \(commandName === 'new'\) emit\('newSession'\)/)
  const sidebar = source("../src/components/WorkspaceSidebar.vue")
  assert.doesNotMatch(sidebar, /const navigationDisabled = .*session.isStreaming/)
})
