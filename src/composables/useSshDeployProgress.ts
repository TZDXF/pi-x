import { onScopeDispose, ref } from "vue"
import { listen } from "@tauri-apps/api/event"

export interface SshDeployProgress {
  step: string
  message: string
  percent: number
}

/** Shared SSH deployment progress with cleanup for late listener registration. */
export function useSshDeployProgress() {
  const progress = ref<SshDeployProgress | null>(null)
  let disposed = false
  let unlisten: (() => void) | undefined

  void listen<SshDeployProgress>("ssh_deploy_progress", event => {
    if (!disposed) progress.value = event.payload
  })
    .then(fn => {
      if (disposed) fn()
      else unlisten = fn
    })
    .catch(() => {})

  onScopeDispose(() => {
    disposed = true
    unlisten?.()
  })

  return progress
}
