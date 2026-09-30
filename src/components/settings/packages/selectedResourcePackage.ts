/** Shared state for the package resource page: the package being inspected
 *  and its project scope path (empty for global packages). Set by the
 *  installed list before navigating to the resource tab. */
import { ref } from "vue"
import type { InstalledPackage } from "@/api/piClient"

export const selectedResourcePackage = ref<InstalledPackage | null>(null)
export const selectedResourceProject = ref("")

/** Retained across settings route remounts so returning from resources keeps the installed tab. */
export const packageSettingsTab = ref<"market" | "builtin" | "installed">("market")
