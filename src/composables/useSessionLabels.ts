import { computed } from "vue"
import { useWorkspaceStore } from "@/stores/workspace"
import { normalizeSlashes } from "@/lib/paths"

/** Session reference labels shared by the composer chips and rendered messages. */
export function useSessionLabels() {
  const workspace = useWorkspaceStore()
  return computed(() => {
    const labels: Record<string, string> = {}
    for (const row of Object.values(workspace.histories).flat()) {
      const label = row.title || row.preview
      if (label) labels[normalizeSlashes(row.file)] = label
    }
    return labels
  })
}
