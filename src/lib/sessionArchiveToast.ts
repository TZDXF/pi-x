import type { UiStore } from "@/stores/ui"

export function notifySessionArchived(
  ui: Pick<UiStore, "pushToast">,
  t: (key: string) => string,
  restore: () => Promise<unknown>,
) {
  ui.pushToast(t("workspace.sessionArchived"), "info", {
    label: t("workspace.undoArchive"),
    onClick: restore,
  })
}
