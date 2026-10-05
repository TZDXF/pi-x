import { defineStore } from "pinia"
import { ref } from "vue"
import { isDesktop } from "@/api/transport"
import { getConfig } from "@/api/client/config"
import { checkAppUpdate, type AppUpdateStatus } from "@/api/client/updates"

/** 应用自身更新的全局状态：启动时自动检查一次，结果供标题栏更新入口与关于页共用。 */
export const useAppUpdateStore = defineStore("appUpdate", () => {
  const status = ref<AppUpdateStatus | null>(null)
  const checked = ref(false)
  let autoCheckStarted = false

  /** 启动时静默检查；非桌面端与开发模式不检查，失败也不打扰用户。 */
  async function autoCheck() {
    if (autoCheckStarted || !isDesktop || import.meta.env.DEV) return
    autoCheckStarted = true
    try {
      const channel = (await getConfig()).updateChannel ?? "stable"
      status.value = await checkAppUpdate(channel)
      checked.value = true
    } catch {
      /* 自动检查失败保持静默，用户可在关于页手动检查 */
    }
  }

  return { status, checked, autoCheck }
})
