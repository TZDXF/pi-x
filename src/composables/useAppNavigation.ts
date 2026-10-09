import { nextTick, ref, watch } from "vue"
import type { Ref } from "vue"
import type { Route } from "@/lib/router"
import type { WorkspacePhase } from "@/lib/workspaceRuntime"

type WorkspaceStore = ReturnType<typeof import("@/stores/workspace").useWorkspaceStore>
type UiStore = ReturnType<typeof import("@/stores/conversations").useUiStore>

interface AppNavigationContext {
  workspace: WorkspaceStore
  phase: Ref<WorkspacePhase>
  connecting: Ref<boolean>
  navigating: Ref<boolean>
  pendingResume: Ref<string | null>
  project: Ref<string>
  route: Ref<Route>
  ui: UiStore
  translateError(error: unknown): string
  navigate(path: string, replace?: boolean): void
  /** Application teardown flag shared with the runtime lifecycle. */
  isDisposed(): boolean
  peekConversation: typeof import("@/stores/conversations").peekConversation
  resumeSession(file: string, targetProject?: string): Promise<unknown>
  selectQueuedConversation(runtimeId: string): Promise<unknown>
  newProjectSession(path: string): Promise<unknown>
}

/** Queued conversation navigation: serializes backend switches, keeps the
 *  latest pending choice clickable and replays history route changes. */
export function useAppNavigation(context: AppNavigationContext) {
  const {
    workspace,
    phase,
    connecting,
    navigating,
    pendingResume,
    project,
    route,
    ui,
    translateError: tBackendError,
    navigate,
    isDisposed,
    peekConversation,
    resumeSession,
    selectQueuedConversation,
    newProjectSession,
  } = context

  // Serialize backend switches, but keep navigation clickable and retain the latest choice.
  // Startup owns both gitBusy and connecting; accept its clicks now and drain after startup.
  let queuedNavigation: (() => Promise<unknown>) | null = null
  const navigationRunning = ref(false)
  function requestNavigation(action: () => Promise<unknown>) {
    if ((workspace.gitBusy && !connecting.value) || phase.value === "trust") return
    queuedNavigation = action
    void drainNavigation()
  }

  /** Push the conversation route first so browser back/forward replays it. */
  let suppressRouteAction = false
  function requestConversationNavigation(path: string, action: () => Promise<unknown>) {
    // Guarded before any route mutation: navigating first and bailing afterwards
    // left a never-loaded conversation in the history stack, and
    // suppressRouteAction also silenced the route-watch fallback. The sidebar
    // already communicates the blocked state via its navigation-busy prop.
    if ((workspace.gitBusy && !connecting.value) || phase.value === "trust") return
    suppressRouteAction = true
    // The initial home entry is only a shell state; make the first project route replace it.
    navigate(path, route.value.name === "home")
    requestNavigation(action)
    void nextTick(() => {
      suppressRouteAction = false
    })
  }

  /** Route changes from sidebar clicks are handled by `action`; history changes replay here. */
  watch(route, next => {
    if (suppressRouteAction || (next.name !== "session" && next.name !== "project")) return
    requestNavigation(() => followConversationRoute(next))
  })

  async function followConversationRoute(next: Route) {
    if (next.name === "session" && next.params.conversation) {
      const id = next.params.conversation
      const targetProject = next.params.project || project.value
      // History entries carry a runtime id for live conversations and a session
      // file for saved ones. Resolve both to the in-memory store first: passing
      // a runtime id to resumeSession (or a file path to selectQueuedConversation)
      // would open a wrong, fresh conversation instead of replaying history.
      const owner = peekConversation(id)
      if (owner) {
        // Dormant stores with a saved file must go through resume so the worker
        // reattaches or respawns; live ones (and file-less pending ones) activate
        // directly, mirroring the sidebar's pending-conversation click.
        if (!owner.started && owner.sessionFile) return resumeSession(owner.sessionFile, targetProject)
        return selectQueuedConversation(owner.runtimeId)
      }
      return resumeSession(id, targetProject)
    }
    if (next.name === "project" && next.params.project) return newProjectSession(next.params.project)
  }

  async function drainNavigation() {
    if (navigationRunning.value || connecting.value || navigating.value || isDisposed()) return
    navigationRunning.value = true
    try {
      while (queuedNavigation && !isDisposed()) {
        const action = queuedNavigation
        queuedNavigation = null
        pendingResume.value = null
        try {
          await action()
        } catch (error) {
          ui.pushToast(tBackendError(error), "error")
        }
      }
    } finally {
      navigationRunning.value = false
    }
  }
  watch([connecting, navigating], () => {
    void drainNavigation()
  })

  return { requestNavigation, requestConversationNavigation, followConversationRoute }
}
