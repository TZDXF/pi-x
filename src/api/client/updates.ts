import { invoke } from "../transport"

export interface PiUpdateStatus {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseNotes?: string | null
  releaseUrl?: string | null
}
export const checkPiUpdate = () => invoke<PiUpdateStatus>("pi_update_check")
export const executePiUpdate = () => invoke<string>("pi_update_execute")

// ---- PiX 应用自身的更新（app_update.rs）----

export type UpdateChannel = "stable" | "preview"

export interface AppUpdateStatus {
  channel: UpdateChannel
  currentVersion: string
  updateAvailable: boolean
  /** 预览版退回正式通道：不回退旧正式版，等待下一次正式版发布 */
  waitingStable: boolean
  version: string | null
  releaseNotes: string | null
  releaseUrl: string | null
}

/** Rust 端下载/安装进度事件，stage: download | install | installed */
export const APP_UPDATE_PROGRESS_EVENT = "pix://app-update"

export const checkAppUpdate = (channel: UpdateChannel) => invoke<AppUpdateStatus>("app_update_check", { channel })
export const installAppUpdate = (channel: UpdateChannel) => invoke<void>("app_update_install", { channel })
export const restartApp = () => invoke<void>("app_update_restart")
