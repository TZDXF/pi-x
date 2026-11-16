import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { ref } from "vue"
import { createPinia, setActivePinia } from "pinia"
import { useSessionNotificationNavigation } from "@/composables/useSessionNotificationNavigation"

const controls = vi.hoisted(() => ({
  desktop: false,
  invoke: vi.fn(async () => {}),
  listen: vi.fn(async (_event, _handler) => vi.fn()),
}))
vi.mock("@/api/transport", () => ({
  get isDesktop() {
    return controls.desktop
  },
  invoke: controls.invoke,
  listen: controls.listen,
}))
vi.mock("@/api/piClient", () => ({ pixLog() {} }))
vi.mock("@/i18n", () => ({ i18n: { global: { t: key => key } } }))
vi.mock("@/lib/configPreference", () => ({
  createConfigPreference: ({ defaultValue }) => ({ value: { value: defaultValue } }),
}))
vi.mock("@/lib/router", () => ({
  sessionRoute: (id, cwd) => `/session/${encodeURIComponent(id)}/${encodeURIComponent(cwd)}`,
}))

beforeEach(() => {
  vi.resetModules()
  controls.desktop = false
  vi.clearAllMocks()
  vi.stubGlobal("document", { visibilityState: "hidden", hasFocus: () => false })
})
afterEach(() => vi.unstubAllGlobals())

test("web notification clicks focus the window and open the captured session; cleanup removes the listener", async () => {
  const notifications: any[] = []
  class WebNotification {
    static permission = "granted"
    onclick: () => void
    close = vi.fn()
    constructor(..._args) {
      notifications.push(this)
    }
  }
  const focus = vi.fn()
  vi.stubGlobal("window", { Notification: WebNotification, focus })
  vi.stubGlobal("Notification", WebNotification)
  const { notifyTurnComplete, onSessionNotificationActivated } = await import("@/lib/notifications")
  const open = vi.fn()
  const unlisten = await onSessionNotificationActivated(open)
  const target = { runtimeId: "background", sessionFile: "first.jsonl", cwd: "/project" }
  notifyTurnComplete("Finished", false, target)
  target.sessionFile = "another.jsonl"
  await vi.waitFor(() => expect(notifications).toHaveLength(1))
  notifications[0].onclick()
  expect(focus).toHaveBeenCalledOnce()
  expect(notifications[0].close).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledWith({ ...target, sessionFile: "first.jsonl" })
  unlisten()
  notifications[0].onclick()
  expect(open).toHaveBeenCalledOnce()
})

test("desktop completion and question notifications carry their source session", async () => {
  controls.desktop = true
  vi.stubGlobal("window", { Notification: { permission: "granted" } })
  const { notifyTurnComplete, notifyQuestion, questionNotification, onSessionNotificationActivated } =
    await import("@/lib/notifications")
  expect(questionNotification.value).toBe(true)
  expect(document.visibilityState).toBe("hidden")
  const target = { runtimeId: "background", sessionFile: "first.jsonl", cwd: "/project" }
  const open = vi.fn()
  await onSessionNotificationActivated(open)
  notifyTurnComplete("Finished", true, target)
  notifyQuestion("Question", target)
  await vi.waitFor(() =>
    expect(controls.invoke.mock.calls).toEqual([
      ["send_notification", { title: "notify.turnFailedTitle", body: "Finished", target }],
      ["send_notification", { title: "notify.questionTitle", body: "Question", target }],
    ]),
  )
  const [event, handler] = controls.listen.mock.calls[0]
  expect(event).toBe("notification-activated")
  handler({ payload: target })
  expect(open).toHaveBeenCalledWith(target)
})

test("extension questions capture their owning session before another session becomes active", async () => {
  const notifications: any[] = []
  class WebNotification {
    static permission = "granted"
    onclick: () => void
    close() {}
    constructor(..._args) {
      notifications.push(this)
    }
  }
  vi.stubGlobal("window", { Notification: WebNotification, focus() {} })
  vi.stubGlobal("Notification", WebNotification)
  setActivePinia(createPinia())
  const { createUiStore } = await import("@/stores/ui")
  const { onSessionNotificationActivated } = await import("@/lib/notifications")
  const target = { runtimeId: "question-owner", sessionFile: "question.jsonl", cwd: "/project" }
  const ui = createUiStore(target.runtimeId, () => target)()
  const open = vi.fn()
  const unlisten = await onSessionNotificationActivated(open)
  ui.handleRequest({ id: "question", method: "confirm", title: "Continue?" })
  target.sessionFile = "another.jsonl"
  await vi.waitFor(() => expect(notifications).toHaveLength(1))
  notifications[0].onclick()
  expect(open).toHaveBeenCalledWith({ ...target, sessionFile: "question.jsonl" })
  unlisten()
})

function navigationHarness(layout: "chat" | "board") {
  const saved = { id: "saved", file: "first.jsonl", cwd: "/project", project: "/project", runtimeId: "background" }
  const pending = { id: "draft:pending", draftId: "pending", project: "/project", runtimeId: "pending" }
  const board = { cards: [saved, pending], selection: null, detailsOpen: false, selectedProject: "/other" }
  const followConversationRoute = vi.fn(async () => {})
  const actions: (() => Promise<void>)[] = []
  const requestConversationNavigation = vi.fn((_path, action) => actions.push(action))
  const peekConversation = vi.fn((id: string) =>
    id === "evicted" || id === "archived.jsonl"
      ? undefined
      : {
          runtimeId: id === "pending" ? "pending" : "background",
          sessionFile: id === "pending" ? null : "first.jsonl",
          cwd: "/project",
        },
  )
  const context = {
    workspaceLayout: ref(layout),
    board,
    workspace: { isProjectless: () => false, projectRoot: () => "/project" },
    peekConversation,
    navigation: { requestConversationNavigation, followConversationRoute },
  }
  const open = useSessionNotificationNavigation(
    context as unknown as Parameters<typeof useSessionNotificationNavigation>[0],
  )
  return {
    open,
    board,
    actions,
    saved,
    pending,
    followConversationRoute,
    requestConversationNavigation,
    peekConversation,
  }
}

test.each(["chat", "board"] as const)(
  "%s mode opens the notified background session through queued navigation",
  async layout => {
    const h = navigationHarness(layout)
    h.open({ runtimeId: "background", sessionFile: "first.jsonl", cwd: "/project" })
    expect(h.followConversationRoute).not.toHaveBeenCalled()
    await h.actions[0]()
    expect(h.followConversationRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "session",
        params: { conversation: "first.jsonl", project: "/project" },
      }),
    )
    expect(h.board.detailsOpen).toBe(layout === "board")
    if (layout === "board") {
      expect(h.board.selection).toBe(h.saved)
      expect(h.board.selectedProject).toBe("/project")
      // Clicking again also reopens a closed details panel for the same route.
      h.board.detailsOpen = false
      h.open({ runtimeId: "background", sessionFile: "first.jsonl", cwd: "/project" })
      await h.actions[1]()
      expect(h.board.detailsOpen).toBe(true)
    }
  },
)

test("a fileless question opens its runtime and board draft", async () => {
  const h = navigationHarness("board")
  h.open({ runtimeId: "pending" })
  await h.actions[0]()
  expect(h.followConversationRoute).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { conversation: "pending", project: "/project" },
    }),
  )
  expect(h.board.selection).toBe(h.pending)
})

test("saved notifications reopen evicted sessions using the captured file and project", async () => {
  const h = navigationHarness("chat")
  h.open({ runtimeId: "evicted", sessionFile: "archived.jsonl", cwd: "ssh://host/project" })
  expect(h.peekConversation).toHaveBeenCalledWith("archived.jsonl", "ssh://host/project")
  await h.actions[0]()
  expect(h.followConversationRoute).toHaveBeenCalledWith(
    expect.objectContaining({
      params: { conversation: "archived.jsonl", project: "ssh://host/project" },
    }),
  )
  h.open({ runtimeId: "evicted" })
  expect(h.actions).toHaveLength(1)
})
