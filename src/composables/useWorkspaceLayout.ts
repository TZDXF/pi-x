import { ref, watch } from "vue"

export type WorkspaceLayout = "chat" | "board"
const STORAGE_KEY = "pix.workspace-layout"

export function useWorkspaceLayout() {
  let saved: WorkspaceLayout = "chat"
  try {
    if (localStorage.getItem(STORAGE_KEY) === "board") saved = "board"
  } catch {
    // Restricted browsers can still switch layouts for this visit.
  }
  const workspaceLayout = ref<WorkspaceLayout>(saved)
  watch(
    workspaceLayout,
    value => {
      try {
        localStorage.setItem(STORAGE_KEY, value)
      } catch {
        // Layout persistence is optional; shared task state uses the backend.
      }
    },
    { flush: "sync" },
  )
  return { workspaceLayout }
}
