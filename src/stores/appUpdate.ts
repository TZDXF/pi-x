import { defineStore } from "pinia"
import { ref } from "vue"
import { isDesktop, listen } from "@/api/transport"
import { getConfig } from "@/api/client/config"
import {
  APP_UPDATE_PROGRESS_EVENT,
  checkAppUpdate,
  installAppUpdate,
  type AppUpdateStatus,
  type UpdateChannel,
} from "@/api/client/updates"

interface AppUpdateProgress {
  stage: "download" | "install" | "installed"
  chunkLength?: number
  contentLength?: number | null
}

/** 应用自身更新的全局状态：启动时自动检查一次，结果供标题栏更新入口与关于页共用。 */
export const useAppUpdateStore = defineStore("appUpdate", () => {
  const status = ref<AppUpdateStatus | null>(null)
  const checked = ref(false)
  const installing = ref(false)
  const installed = ref(false)
  const progress = ref<number | null>(null)
  let autoCheckStarted = false
  let progressListenerStarted = false
  let downloaded = 0

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

  function onProgress(payload: AppUpdateProgress) {
    if (payload.stage === "download") {
      downloaded += payload.chunkLength ?? 0
      if (payload.contentLength) {
        progress.value = Math.min(99, Math.round((downloaded / payload.contentLength) * 100))
      }
    } else if (payload.stage === "install") {
      progress.value = 100
    } else if (payload.stage === "installed") {
      installed.value = true
    }
  }

  /** 监听跟随应用生命周期，避免离开关于页后丢失后续下载进度。 */
  async function startProgressListener() {
    if (progressListenerStarted) return
    progressListenerStarted = true
    try {
      await listen<AppUpdateProgress>(APP_UPDATE_PROGRESS_EVENT, event => onProgress(event.payload))
    } catch {
      // 下次进入更新流程时重试；监听失败不阻止后端安装。
      progressListenerStarted = false
    }
  }

  async function install(channel: UpdateChannel) {
    if (installing.value) return
    installing.value = true
    installed.value = false
    progress.value = 0
    downloaded = 0
    try {
      await startProgressListener()
      await installAppUpdate(channel)
      installed.value = true
    } finally {
      installing.value = false
      progress.value = null
    }
  }

  return { status, checked, installing, installed, progress, autoCheck, startProgressListener, install }
})
