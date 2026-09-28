import { readonly, ref } from "vue"

/** How a message sent while the agent is still streaming should be handled. */
export type RunningBehavior = "queue" | "steer"
const STORAGE_KEY = "pix.runningBehavior"
const isRunningBehavior = (value: unknown): value is RunningBehavior => value === "queue" || value === "steer"

function initialRunningBehavior(): RunningBehavior {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    if (isRunningBehavior(value)) return value
  } catch {
    /* Storage is optional. */
  }
  return "queue"
}

const preference = ref<RunningBehavior>(initialRunningBehavior())
export const runningBehavior = readonly(preference)

export function setRunningBehavior(value: RunningBehavior) {
  if (!isRunningBehavior(value)) return
  preference.value = value
  try {
    localStorage.setItem(STORAGE_KEY, value)
  } catch {
    /* Storage is optional. */
  }
}

function syncRunningBehavior(event: StorageEvent) {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  preference.value = initialRunningBehavior()
}
window.addEventListener("storage", syncRunningBehavior)

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    window.removeEventListener("storage", syncRunningBehavior)
  })
}
