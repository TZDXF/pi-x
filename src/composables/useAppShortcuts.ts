import type { Ref } from "vue"
import type { Route } from "@/lib/router"
import type { WorkspacePhase } from "@/lib/workspaceRuntime"

type WorkspaceStore = ReturnType<typeof import("@/stores/workspace").useWorkspaceStore>
type UiStore = ReturnType<typeof import("@/stores/conversations").useUiStore>
type PiClient = typeof import("@/api/piClient")
type Shortcuts = typeof import("@/lib/shortcuts")

interface UseAppShortcutsContext {
  workspace: WorkspaceStore
  session: ReturnType<typeof import("@/stores/conversations").useSessionStore>
  phase: Ref<WorkspacePhase>
  connecting: Ref<boolean>
  navigating: Ref<boolean>
  sidebarOpen: Ref<boolean>
  project: Ref<string>
  route: Ref<Route>
  ui: UiStore
  t(key: string): string
  translateError(error: unknown): string
  navigate(path: string, replace?: boolean): void
  projectRoute(project: string): string
  sessionRoute(conversation: string, project?: string): string
  requestConversationNavigation(path: string, action: () => Promise<unknown>): void
  newProjectSession(path: string): Promise<unknown>
  resumeSession(file: string, targetProject?: string): Promise<unknown>
  developerModeEnabled: Ref<boolean>
  isDesktop: boolean
  toggleDevtools: PiClient["toggleDevtools"]
  focusComposer(): void
  shortcuts: Pick<Shortcuts, "dispatchShortcut" | "registerShortcutHandler">
}

/** Global keyboard shortcuts: the keydown dispatcher plus app-level actions. */
export function useAppShortcuts(context: UseAppShortcutsContext) {
  const {
    workspace,
    session,
    phase,
    connecting,
    navigating,
    sidebarOpen,
    project,
    route,
    ui,
    t,
    translateError: tBackendError,
    navigate,
    projectRoute,
    sessionRoute,
    requestConversationNavigation,
    newProjectSession,
    resumeSession,
    developerModeEnabled,
    isDesktop,
    toggleDevtools,
    focusComposer,
    shortcuts: { dispatchShortcut, registerShortcutHandler },
  } = context

  /** 开发者模式下的 devtools 快捷键：F12 或 Ctrl+Shift+I。 */
  function isDevtoolsShortcut(event: KeyboardEvent) {
    if (!isDesktop) return false
    if (event.key === "F12") return true
    return event.ctrlKey && event.shiftKey && !event.altKey && event.key.toLowerCase() === "i"
  }

  function onGlobalKeydown(event: KeyboardEvent) {
    // devtools 快捷键不受会话阶段限制，打包版本在开发者模式下同样可用。
    if (developerModeEnabled.value && isDevtoolsShortcut(event)) {
      event.preventDefault()
      void toggleDevtools()
      return
    }
    if (phase.value !== "chat") return
    if (ui.activeDialog) return // extension dialogs handle their own keys
    dispatchShortcut(event)
  }

  function focusComposerFromShortcut() {
    focusComposer()
  }

  /** cycle_model / cycle_thinking_level:返回 false 表示没有其他可选（pi data 为 null）。 */
  async function cycleModelShortcut() {
    try {
      if (!(await session.cycleModel())) ui.pushToast(t("chat.cycleNoOtherModel"), "info")
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
    }
  }

  async function cycleThinkingLevelShortcut() {
    try {
      if (!(await session.cycleThinkingLevel())) ui.pushToast(t("chat.cycleThinkingUnsupported"), "info")
    } catch (e) {
      ui.pushToast(tBackendError(e), "error")
    }
  }

  function switchSessionByOffset(offset: number) {
    if (
      (route.value.name !== "home" && route.value.name !== "session" && route.value.name !== "project") ||
      connecting.value ||
      navigating.value
    )
      return
    const rows = workspace.orderedSessions(project.value)
    if (rows.length < 2) return
    const index = rows.findIndex(row => row.file === session.sessionFile)
    // No saved session yet (pristine draft): next = newest, prev = oldest.
    const target = index < 0 ? rows[offset > 0 ? 0 : rows.length - 1] : rows[(index + offset + rows.length) % rows.length]
    if (target)
      requestConversationNavigation(sessionRoute(target.file, target.cwd), () => resumeSession(target.file, target.cwd))
  }

  const offShortcutHandlers = [
    registerShortcutHandler("app.newSession", () =>
      requestConversationNavigation(projectRoute(project.value), () => newProjectSession(project.value)),
    ),
    registerShortcutHandler("app.focusComposer", focusComposerFromShortcut),
    registerShortcutHandler("app.toggleSidebar", () => {
      if (route.value.name === "home") sidebarOpen.value = !sidebarOpen.value
    }),
    registerShortcutHandler("app.settings", () => navigate("/settings/general")),
    registerShortcutHandler("app.schedules", () => navigate("/schedules")),
    registerShortcutHandler("app.archives", () => navigate("/settings/archives")),
    registerShortcutHandler("app.prevSession", () => switchSessionByOffset(-1)),
    registerShortcutHandler("app.nextSession", () => switchSessionByOffset(1)),
    registerShortcutHandler("chat.cycleModel", cycleModelShortcut),
    registerShortcutHandler("chat.cycleThinkingLevel", cycleThinkingLevelShortcut),
  ]

  function disposeShortcuts() {
    offShortcutHandlers.forEach(off => off())
  }

  return { onGlobalKeydown, disposeShortcuts }
}
