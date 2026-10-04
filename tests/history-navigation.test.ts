import { composerSources } from "./fixtures/chatSources"
import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

const source = path => readFileSync(new URL(path, import.meta.url), "utf8")
const run = (code, context) =>
  vm.runInContext(ts.transpile(code, { target: ts.ScriptTarget.ES2022 }), vm.createContext(context))

test("navigation stays serialized and the latest pending selection wins", async () => {
  // 导航队列逻辑已拆到 App 的导航 composable，按原文本切片执行。
  const app = source("../src/composables/useAppNavigation.ts")
  const code = app.slice(app.indexOf("let queuedNavigation:"), app.indexOf("watch([connecting, navigating]"))
  const context = {
    ref: value => ({ value }),
    session: {},
    workspace: {},
    phase: { value: "chat" },
    connecting: { value: false },
    navigating: { value: false },
    pendingResume: { value: null },
    isDisposed: () => false,
    route: { value: { name: "home", params: {} } },
    nextTick: async fn => fn?.(),
    watch: () => {},
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
  expect(calls).toEqual(["first"])
  finish()
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(calls).toEqual(["first", "latest"])
})

test("history prefetches near the top, suppresses duplicates and preserves the reading position", async () => {
  const chat = source("../src/composables/useChatTurnList.ts")
  const code = chat.slice(chat.indexOf("let restoringHistory ="), chat.indexOf("function lastAssistantTurn"))
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
    deps: { connecting: () => false },
    conversation: { value: { stopScroll() {} } },
    nextTick: async () => {},
    ui: { pushToast() {} },
  }
  run(code + "\nglobalThis.scroll = onHistoryScroll", context)
  await context.scroll({ target: viewport })
  expect(requests).toBe(0)
  viewport.scrollTop = 500
  const pending = context.scroll({ target: viewport })
  await context.scroll({ target: viewport })
  expect(requests).toBe(1)
  viewport.scrollTop = 450 // Reader continues scrolling while the page is loaded.
  viewport.scrollHeight = 3200
  finish()
  await pending
  expect(viewport.scrollTop).toBe(1650)
})

test("conversation mounts immediately with instant initial positioning; loading stays silent", () => {
  const chat = source("../src/components/chat/ChatTurnList.vue")
  expect(chat).toMatch(/<Conversation[^>]*ref="conversation"[^>]+initial="instant"/)
  expect(chat).toMatch(
    /v-if="session.entries.length === 0 && !session.historyLoading && \(!connecting \|\| selectingProject\)"/,
  )
  expect(chat).not.toMatch(/v-if="connecting \|\| session.historyLoading"/)
  expect(chat).not.toMatch(/@click="loadOlderHistory"/)
})

test("streaming navigation switches without aborting the running generation", async () => {
  const app = source("../src/composables/useAppNavigation.ts")
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
    isDisposed: () => false,
    route: { value: { name: "home", params: {} } },
    nextTick: async fn => fn?.(),
    watch: () => {},
  }
  run(code + "\nglobalThis.navigate = requestNavigation", context)
  context.navigate(async () => calls.push("switch"))
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(calls).toEqual(["switch"])
})

test("streaming composer shows send for text or attachments and stop only when empty", () => {
  const chat = composerSources()
  const declaration = chat.slice(chat.indexOf("const showStopButton"), chat.indexOf("const sendDelayMinutes")).trimEnd()
  expect(declaration).toBeTruthy()
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
  expect(context.shouldStop()).toBe(true)
  bridge.value.textInput = "hello"
  expect(context.shouldStop()).toBe(false)
  bridge.value.textInput = "   "
  expect(context.shouldStop()).toBe(true)
  bridge.value.files.push({ id: "image" })
  expect(context.shouldStop()).toBe(false)
  bridge.value.files.length = 0
  delayedSend.value = true
  expect(context.shouldStop()).toBe(false)
  delayedSend.value = false
  session.isStreaming = false
  expect(context.shouldStop()).toBe(false)
  const submitRegion = chat.slice(chat.indexOf("<PromptInputSubmit"), chat.indexOf("</PromptInputSubmit>"))
  const ariaLabel = submitRegion
    .match(/:aria-label="([\s\S]*?)"/)?.[1]
    .replace(/\s+/g, " ")
    .trim()
  expect(ariaLabel).toBe(
    "showStopButton ? t('chat.stop') : delayedSend ? t('chat.delayedSend') : t('chat.sendMessage')",
  )
})

test("streaming input reaches command dispatch; the submit button doubles as stop while streaming", () => {
  const chat = composerSources()
  const submit = chat.slice(chat.indexOf("async function onSubmit("), chat.indexOf("function thinkingLabel"))
  expect(submit).not.toMatch(/if \(session.isStreaming\)\s*\{\s*await abort\(\)\s*return/)
  expect(chat).toMatch(/<PromptInputSubmit[\s\S]*?:status="showStopButton \? 'streaming' : undefined"/)
  expect(chat).toMatch(/<PromptInputSubmit[\s\S]*?:type="showStopButton \? 'button' : 'submit'"/)
  expect(chat).toMatch(/<PromptInputSubmit[\s\S]*?@click="showStopButton && abort\(\)"/)
  // /compact queues behind the active run; the store executes it from the queue.
  expect(submit).not.toMatch(/await abort\(\)/)
  expect(submit).toMatch(
    /else if \(commandName === "compact"\) await session\.send\(text, undefined, undefined, runningBehavior\.value\)/,
  )
  expect(submit).toMatch(/if \(commandName === "new"\) deps\.newSession\(\)/)
  const sidebar = source("../src/components/WorkspaceSidebar.vue")
  expect(sidebar).not.toMatch(/const navigationDisabled = .*session.isStreaming/)
})
