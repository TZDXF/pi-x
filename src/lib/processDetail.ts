import { createLocalPreference } from "@/lib/localPreference"

/** How much of the assistant's run is shown in the chat: with thinking or without. */
export type ProcessDetail = "detailed" | "concise"
const STORAGE_KEY = "pix.processDetail"
const isProcessDetail = (value: unknown): value is ProcessDetail => value === "detailed" || value === "concise"

const preference = createLocalPreference<ProcessDetail>({
  key: STORAGE_KEY,
  defaultValue: "detailed",
  validate: isProcessDetail,
})
export const processDetail = preference.value

export function setProcessDetail(value: ProcessDetail) {
  if (!isProcessDetail(value)) return
  preference.set(value)
}
