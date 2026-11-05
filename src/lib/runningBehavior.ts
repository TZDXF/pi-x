import { createConfigPreference } from "@/lib/configPreference"

/** How a message sent while the agent is still streaming should be handled. */
export type RunningBehavior = "queue" | "steer"
const LEGACY_STORAGE_KEY = "pix.runningBehavior"
const isRunningBehavior = (value: unknown): value is RunningBehavior => value === "queue" || value === "steer"

const preference = createConfigPreference<RunningBehavior>({
  key: "runningBehavior",
  legacyKey: LEGACY_STORAGE_KEY,
  defaultValue: "queue",
  validate: isRunningBehavior,
})
export const runningBehavior = preference.value

export function setRunningBehavior(value: RunningBehavior) {
  if (!isRunningBehavior(value)) return
  return preference.set(value)
}
