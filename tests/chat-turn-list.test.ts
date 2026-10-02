import { expect, test, vi } from "vitest"
import { reactive, ref } from "vue"
import { useChatTurnList, blocksText, hasSummary } from "@/composables/useChatTurnList"
import { chatSource } from "./fixtures/chatSources"

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
  h.session.partialBlocks = [{ type: "text", text: "delta" }]
  expect(h.controls.renderedEntries.value.map(e => e.kind)).toEqual(["user", "assistant"])
  expect(blocksText(h.controls.lastAssistantTurn().blocks)).toBe("committed\n\ndelta")
  expect(h.session.entries[2].blocks).toHaveLength(1)
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
  expect(left.handle.scrollToMessage).toHaveBeenCalledWith(7)
  await left.controls.navigateToQuestion({ id: "known", entryId: 12 })
  expect(left.session.revealTimelineTurn).toHaveBeenCalledOnce()
  expect(left.handle.scrollToMessage).toHaveBeenLastCalledWith(12)
  left.controls.scrollHistory(1)
  expect(left.viewport.scrollTo).toHaveBeenCalledWith({ top: 2000 })
  left.controls.scrollHistory(-1)
  expect(left.viewport.scrollTo).toHaveBeenLastCalledWith({ top: 0 })
  expect(right.handle.stopScroll).not.toHaveBeenCalled()
  expect(right.viewport.scrollTo).not.toHaveBeenCalled()
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
  expect(root.split("\n").length).toBeLessThan(500)
})
