import type { UiStore } from "@/stores/ui"

/** Copy text to the clipboard and toast the outcome; the success message must already be translated. */
export async function copyWithToast(ui: UiStore, text: string, successMessage: string) {
  try {
    await navigator.clipboard.writeText(text)
    ui.pushToast(successMessage, "info")
  } catch (e) {
    ui.pushToast(String(e), "error")
  }
}
