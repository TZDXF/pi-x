import { expect, test } from "vitest"
import { ref } from "vue"
import { AUX_READY_TIMEOUT_MS, waitForAuxReady } from "@/lib/auxReady"
import type { AuxTab } from "@/stores/auxChat"

/**
 * 面板"等实例就绪"（TZD-155）。
 *
 * 创建期间输入区已经渲染、引用也已经能落桶，因此发送动作需要**有界等待**而不是直接
 * 判失败：`ready` 放行、`error` 立刻失败、握手期间就绪就放行、始终没有终态则超时失败
 * （超时后 `useChatSendControl` 会把文本填回输入框）。
 */
function tabOf(status: AuxTab["status"]): AuxTab {
  return {
    tabId: 1,
    runtimeId: "aux:test",
    parentRuntimeId: "runtime:parent",
    clientId: "c",
    title: "aux 1",
    ordinal: 1,
    status,
  }
}

test("a ready or failed instance answers immediately", async () => {
  const ready = ref(tabOf("ready"))
  expect(await waitForAuxReady(ready)).toBe(true)
  const failed = ref(tabOf("error"))
  expect(await waitForAuxReady(failed)).toBe(false)
})

test("a creating instance resolves true once the handshake finishes, without polling", async () => {
  const tab = ref(tabOf("creating"))
  const waiting = waitForAuxReady(tab)
  // 创建期间的判断不阻塞事件循环（watch 依赖的是 tab.status 的响应式变化）。
  expect(tab.value.status).toBe("creating")
  tab.value.status = "ready"
  expect(await waiting).toBe(true)
})

test("a spawn failure during the wait reports false instead of hanging", async () => {
  const tab = ref(tabOf("creating"))
  const waiting = waitForAuxReady(tab)
  tab.value.status = "error"
  expect(await waiting).toBe(false)
})

test("an instance that never reaches a terminal state times out", async () => {
  const tab = ref(tabOf("creating"))
  // 进程一直没给终态：超时兜底必须自己回答 false，否则发送会一直挂着。
  expect(await waitForAuxReady(tab, 0)).toBe(false)
  // 默认超时足够长（远程启动可达数秒），但必须有界。
  expect(AUX_READY_TIMEOUT_MS).toBeGreaterThan(5_000)
})
