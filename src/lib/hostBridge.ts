import { isDesktop } from "@/api/transport"

export interface ConfirmOptions {
  title: string
  okLabel?: string
  cancelLabel?: string
}

/** 桌面端弹原生确认框，远程端退回浏览器 confirm，保证两侧都有确认流程。 */
export async function confirmDialog(message: string, options: ConfirmOptions): Promise<boolean> {
  if (isDesktop) {
    const { ask } = await import("@tauri-apps/plugin-dialog")
    return ask(message, {
      title: options.title,
      okLabel: options.okLabel,
      cancelLabel: options.cancelLabel,
      kind: "warning",
    })
  }
  return window.confirm(`${options.title}\n\n${message}`)
}

/** 桌面端交给系统浏览器打开外链，远程端开新标签页。 */
export function openExternal(url: string): void {
  if (isDesktop) {
    void import("@tauri-apps/plugin-opener").then(({ openUrl }) => openUrl(url)).catch(() => {})
    return
  }
  window.open(url, "_blank", "noopener")
}
