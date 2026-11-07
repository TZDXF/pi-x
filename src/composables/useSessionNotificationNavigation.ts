import { nextTick, type Ref } from "vue"
import type { SessionNotificationTarget } from "@/lib/notifications"
import type { WorkspaceLayout } from "@/composables/useWorkspaceLayout"
import type { useAppNavigation } from "@/composables/useAppNavigation"
import type { useKanbanWorkspace } from "@/composables/useKanbanWorkspace"
import { sessionRoute, type Route } from "@/lib/router"
import { sameSessionIdentity } from "@/lib/sessionIdentity"

type Board = ReturnType<typeof useKanbanWorkspace>

interface Context {
  workspaceLayout: Ref<WorkspaceLayout>
  board: {
    cards: Board["cards"]["value"]
    selection: Board["selection"]["value"]
    detailsOpen: boolean
    selectedProject: string
  }
  workspace: Pick<Parameters<typeof useKanbanWorkspace>[0], "projectRoot" | "isProjectless">
  peekConversation: typeof import("@/stores/conversations").peekConversation
  navigation: Pick<ReturnType<typeof useAppNavigation>, "requestConversationNavigation" | "followConversationRoute">
}

/** Use the same serialized, trust-aware navigation as sidebar and history clicks. */
export function useSessionNotificationNavigation(context: Context) {
  return (target: SessionNotificationTarget) => {
    // Prefer the saved identity: a runtime may have moved on to a different session since delivery.
    const owner = context.peekConversation(target.sessionFile || target.runtimeId, target.cwd)
    if (!target.sessionFile && !owner) return
    const cwd = target.cwd || owner?.cwd || ""
    const id = target.sessionFile || owner?.sessionFile || target.runtimeId
    const path = sessionRoute(id, cwd)
    const route: Route = { path, name: "session", params: { conversation: id, project: cwd } }
    context.navigation.requestConversationNavigation(path, async () => {
      await context.navigation.followConversationRoute(route)
      await nextTick()
      if (context.workspaceLayout.value !== "board") return
      const { board, workspace } = context
      board.selectedProject = workspace.isProjectless(cwd) ? cwd : workspace.projectRoot(cwd)
      board.selection =
        board.cards.find(card =>
          target.sessionFile
            ? sameSessionIdentity(card.file, card.cwd || card.project, target.sessionFile, cwd)
            : card.runtimeId === owner?.runtimeId || card.draftId === owner?.runtimeId,
        ) ?? null
      board.detailsOpen = true
    })
  }
}
