import { watch, type Ref } from "vue"
import type { AuxTab } from "@/stores/auxChat"

/**
 * aux 面板的"等实例就绪"（TZD-155）。
 *
 * 为什么要等：实例一入表就建好了 session/ui store 与引用桶（`openAux` 先同步入表再
 * `await` spawn），因此**创建期间**划词引用已经能落进本实例的桶，面板也应该先渲染页面
 * 骨架与输入区，而不是整块"加载中"盖住页面。但真正发送要等进程握手完成（`session.started`
 * 才有意义），于是发送动作在这里**有界等待**，就绪后立刻发出，而不是让用户看到一句
 * "启动失败"再手动重发。
 *
 * 判据只有两个终态：`ready`（可以发）或 `error`（放回文本并给出原因）。关闭/实例被摘除
 * 时 `tab.status` 停在最后一个值，由超时兜底 —— 超时后 `ensureStarted` 返回 false，
 * `useChatSendControl` 已把文本填回输入框并提示 `completion.startFailed`。
 */
export const AUX_READY_TIMEOUT_MS = 30_000

/**
 * 等实例进入 `ready`；`error`、关闭或超时都返回 false。
 *
 * `timeoutMs` 只用于"一直没终态"的兜底（进程始终起不来），因此不放在热路径轮询上：
 * 判定只依赖 `tab.status` 的响应式变化。
 */
export function waitForAuxReady(tab: Ref<AuxTab> | AuxTab, timeoutMs = AUX_READY_TIMEOUT_MS): Promise<boolean> {
  const status = () => ("value" in tab ? tab.value.status : tab.status)
  if (status() === "ready") return Promise.resolve(true)
  if (status() === "error") return Promise.resolve(false)
  return new Promise<boolean>(resolve => {
    let settled = false
    const finish = (ready: boolean) => {
      if (settled) return
      settled = true
      stop()
      clearTimeout(timer)
      resolve(ready)
    }
    const stop = watch(status, next => {
      if (next === "ready") finish(true)
      else if (next === "error") finish(false)
    })
    const timer = setTimeout(() => finish(false), timeoutMs)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
}
