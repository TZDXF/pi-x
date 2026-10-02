import { readonly, ref } from "vue"

/** How much of the assistant's run is shown in the chat: with thinking or without. */
export type ProcessDetail = "detailed" | "concise"
const STORAGE_KEY = "pix.processDetail"
const isProcessDetail = (value: unknown): value is ProcessDetail => value === "detailed" || value === "concise"

function initialProcessDetail(): ProcessDetail {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (isProcessDetail(value)) return value
  } catch {
    /* Storage is optional. */
  }
  return "detailed"
}

const preference = ref<ProcessDetail>(initialProcessDetail())
export const processDetail = readonly(preference)

export function setProcessDetail(value: ProcessDetail) {
  if (!isProcessDetail(value)) return
  preference.value = value
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* Storage is optional. */
  }
}

function syncProcessDetail(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  preference.value = initialProcessDetail()
}
window.addEventListener("storage", syncProcessDetail)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("storage", syncProcessDetail)
  })
}
