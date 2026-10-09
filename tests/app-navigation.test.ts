import { afterEach, expect, test, vi } from "vitest"
import { effectScope, nextTick, reactive, ref, type EffectScope } from "vue"
import { useAppNavigation } from "@/composables/useAppNavigation"
import type { Route } from "@/lib/router"
import type { WorkspacePhase } from "@/lib/workspaceRuntime"

const scopes: EffectScope[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
})

function navigationHarness() {
  const workspace = reactive({ gitBusy: true })
  const connecting = ref(true)
  const navigating = ref(false)
  const phase = ref<WorkspacePhase>("chat")
  const navigate = vi.fn()
  const scope = effectScope()
  scopes.push(scope)
  const navigation = scope.run(() =>
    useAppNavigation({
      workspace: workspace as Parameters<typeof useAppNavigation>[0]["workspace"],
      connecting,
      navigating,
      phase,
      pendingResume: ref(null),
      project: ref("project"),
      route: ref<Route>({ name: "home", params: {} }),
      ui: { pushToast: vi.fn() } as Parameters<typeof useAppNavigation>[0]["ui"],
      translateError: String,
      navigate,
      isDisposed: () => false,
      peekConversation: () => undefined,
      resumeSession: vi.fn(async () => {}),
      selectQueuedConversation: vi.fn(async () => {}),
      newProjectSession: vi.fn(async () => {}),
    }),
  )!
  return { ...navigation, workspace, connecting, navigating, phase, navigate }
}

test("sidebar selections during Git-backed startup queue the latest choice until startup finishes", async () => {
  const h = navigationHarness()
  const first = vi.fn(async () => {})
  const latest = vi.fn(async () => {})
  h.requestConversationNavigation("/first", first)
  h.requestConversationNavigation("/latest", latest)

  expect(h.navigate.mock.calls).toEqual([
    ["/first", true],
    ["/latest", true],
  ])
  expect(first).not.toHaveBeenCalled()
  expect(latest).not.toHaveBeenCalled()

  h.workspace.gitBusy = false
  h.connecting.value = false
  await nextTick()
  expect(first).not.toHaveBeenCalled()
  expect(latest).toHaveBeenCalledTimes(1)
})

test("route-free navigation requests also remain queueable during startup", async () => {
  const h = navigationHarness()
  const action = vi.fn(async () => {})
  h.requestNavigation(action)
  expect(action).not.toHaveBeenCalled()

  h.workspace.gitBusy = false
  h.connecting.value = false
  await nextTick()
  expect(action).toHaveBeenCalledTimes(1)
})

test.each(["git", "trust"])("%s protection still rejects navigation without mutating routes", async reason => {
  const h = navigationHarness()
  if (reason === "git") h.connecting.value = false
  else h.phase.value = "trust"
  const action = vi.fn(async () => {})
  h.requestConversationNavigation("/blocked", action)
  h.requestNavigation(action)

  expect(h.navigate).not.toHaveBeenCalled()
  expect(action).not.toHaveBeenCalled()
  h.workspace.gitBusy = false
  h.connecting.value = false
  h.phase.value = "chat"
  await nextTick()
  expect(action).not.toHaveBeenCalled()
})
