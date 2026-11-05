import { createConfigPreference } from "@/lib/configPreference"

/** How much of the assistant's run is shown in the chat: with thinking or without. */
export type ProcessDetail = "detailed" | "concise"
const LEGACY_STORAGE_KEY = "pix.processDetail"
const isProcessDetail = (value: unknown): value is ProcessDetail => value === "detailed" || value === "concise"

const preference = createConfigPreference<ProcessDetail>({
  key: "processDetail",
  legacyKey: LEGACY_STORAGE_KEY,
  defaultValue: "detailed",
  validate: isProcessDetail,
})
export const processDetail = preference.value

export function setProcessDetail(value: ProcessDetail) {
  if (!isProcessDetail(value)) return
  return preference.set(value)
}
