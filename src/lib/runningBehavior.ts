import { createLocalPreference } from "@/lib/localPreference"

/** How a message sent while the agent is still streaming should be handled. */
export type RunningBehavior = "queue" | "steer"
const STORAGE_KEY = "pix.runningBehavior"
const isRunningBehavior = (value: unknown): value is RunningBehavior => value === "queue" || value === "steer"

const preference = createLocalPreference<RunningBehavior>({
  key: STORAGE_KEY,
  defaultValue: "queue",
  validate: isRunningBehavior,
})
export const runningBehavior = preference.value

export function setRunningBehavior(value: RunningBehavior) {
  if (!isRunningBehavior(value)) return
  preference.set(value)
}
