import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-138 历史分页入口的定位竞态（第七轮）。
 *
 * 时间线上尚未挂载的历史节点要先 `await session.revealTimelineTurn(...)` 拉一页历史；
 * 这个等待可能长达几秒，期间用户完全可能点了引用定位。旧实现在分页**结束之后**才领
 * 视口请求身份，于是"先点击、后恢复"的旧导航被当成最新，反把用户后来点的目标顶掉
 * （QA 三内核复现：旧请求写入 `top: 1980` → `1056`，新点击的引用消息整个落在视口外）。
 *
 * 修复：身份在**点击那一刻**取得，分页完成后先校验再 `stopScroll` / `scrollToMessage`，
 * 并把身份往后传；过期分页可以照常返回数据（历史已补上），但**不得再导航**。
 *
 * fixture 用真实 `ChatTurnList` + `useChatTurnList.navigateToQuestion`，历史分页由受控
 * 的 `revealTimelineTurn` 模拟（不访问任何外部服务）。
 */
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module">
import { createApp, h, reactive, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import zh from '/src/i18n/locales/zh-CN.ts'
import ChatTurnList from '/src/components/chat/ChatTurnList.vue'
import Summary from '/src/components/chat/ConversationSelectionSummary.vue'
import { usePromptEdit } from '/src/composables/usePromptEdit.ts'
import { useChatTurnList } from '/src/composables/useChatTurnList.ts'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import { useConversationSelectionsStore } from '/src/stores/conversationSelections.ts'
import '/src/style.css'
const lines = Array.from({ length: 12 }, (_, i) => 'Line-' + String(i + 1).padStart(2, '0') + ' readable words')
const visible = lines.join('\\n')
const parent = '<aux_parent_context>\\nImmutable context.\\n</aux_parent_context>\\n\\n'
const target = { kind: 'user', id: 1, text: visible, contextText: parent + visible }
// 目标行后面塞 55 条：滚动后目标行会被 VirtualMessage 整行卸载。
const entries = [target, ...Array.from({ length: 55 }, (_, i) => ({ kind: 'user', id: i + 2, text: 'Later entry ' + i }))]
const copies = [], resends = []
const session = reactive({
  entries,
  sessionFile: 'qa-a.jsonl',
  steering: [], followUp: [],
  timelineTurns: [{ id: -100, entryId: null, rank: 1, question: 'Older history target', answer: '' }],
  isStreaming: false, partialBlocks: null,
  // 受控"历史分页"：点时间线后挂起，直到测试调用 releaseHistory。
  revealTimelineTurn: () => new Promise(resolve => {
    window.qa.releaseHistory = () => {
      const oldRows = Array.from({ length: 32 }, (_, i) => ({ kind: 'user', id: 100 + i, text: 'Previously unloaded row ' + i }))
      session.entries.unshift(...oldRows)
      session.timelineTurns[0].entryId = 111
      resolve(111)
    }
  }),
  resendPrompt: (...args) => { resends.push(args) },
})
const ui = reactive({ pendingUserMessage: null, pushToast: () => {} })
const list = ref(null)
window.qa = { session, ui, list, visible, parent, copies, resends }
createApp({ setup() {
  const editTextarea = ref(null)
  const edit = reactive(usePromptEdit({
    session, ui, workspace: useWorkspaceStore(), editTextarea,
    project: () => '/qa', connecting: () => false, connected: () => true, knownSessions: () => [],
  }))
  const selections = useConversationSelectionsStore()
  const { navigateToQuestion } = useChatTurnList({ session, ui, conversation: list, connecting: () => false })
  window.qa.selections = selections
  return () => h('div', { style: 'width:700px;height:550px;display:flex;flex-direction:column' }, [
    h(ChatTurnList, {
      ref: list, session, ui, project: '/qa', projectName: 'QA', connecting: false,
      renderedEntries: session.entries, edit,
      onNavigate: turn => { window.qa.historyNavigation = navigateToQuestion(turn) },
      onCopyText: t => copies.push(t),
      onEditTextarea: t => { editTextarea.value = t },
    }),
    selections.items.length ? h(Summary, {
      items: selections.items,
      onLocate: id => { window.qa.earlier = list.value?.locateSelection(id) },
      onEdit: id => list.value?.editSelection(id),
    }) : null,
  ])
}}).use(createPinia()).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zh } })).mount('#app')
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "conversation-navigation-history", port: 1525, html })
})
test.afterAll(async () => {
  await harness?.close()
})

const body = '[data-message-id="1"] [data-prompt-text]'
const toggle = '[data-message-id="1"] [data-prompt-toggle]'
const badge = '[data-message-id="1"] [data-selection-anchor]'
const shell = '[data-message-id="1"][data-virtual-mounted]'

/** 划选第 11 行 → 引用到输入框 → 保存 → 收起提问（与用户真实操作顺序一致）。 */
async function quoteLineEleven(page: import("@playwright/test").Page) {
  await page.locator(toggle).click()
  await expect(page.locator(toggle)).toHaveAttribute("aria-expanded", "true")
  const points = await page.locator(body).evaluate(root => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent?.includes("Line-11")) node = walker.nextNode()
    if (!node) throw new Error("Line-11 missing")
    const start = node.textContent!.indexOf("Line-11")
    const range = document.createRange()
    range.setStart(node, start)
    range.setEnd(node, start + 7)
    const rect = range.getBoundingClientRect()
    return { left: rect.left + 0.5, right: rect.right - 0.5, y: (rect.top + rect.bottom) / 2 }
  })
  await page.mouse.move(points.left, points.y)
  await page.mouse.down()
  await page.mouse.move(points.right, points.y, { steps: 8 })
  await page.mouse.up()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("Line-11")
  await page.getByRole("button", { name: "引用到输入框" }).click()
  await page.getByRole("button", { name: "保存", exact: true }).click()
  await expect(page.locator(badge)).toHaveCount(1)
  await page.locator(toggle).click()
  await expect(page.locator(toggle)).toHaveAttribute("aria-expanded", "false")
  await expect(page.locator(badge)).toHaveCount(0)
}

async function locateFromSummary(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /1 条注释/ }).hover()
  await page.locator("button[title=Line-11]").click()
}

/** 记录 `scrollTo` 写入及其所处的"阶段"，用于判定"过期点击是否还在滚"。 */
async function instrumentScroll(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const viewport = document.querySelector('[role="log"]') as HTMLElement
    const native = viewport.scrollTo.bind(viewport)
    const state: { writes: { phase: string; from: number; top?: number; behavior?: string }[]; phase: string } = {
      writes: [],
      phase: "quote",
    }
    ;(window as unknown as { qaWrites: typeof state }).qaWrites = state
    viewport.scrollTo = ((...args: unknown[]) => {
      const options = args[0] as ScrollToOptions | undefined
      state.writes.push({
        phase: state.phase,
        from: viewport.scrollTop,
        top: options?.top,
        behavior: options?.behavior,
      })
      return (native as unknown as (...inner: unknown[]) => void)(...args)
    }) as typeof viewport.scrollTo
  })
}

test("a stale lazy-history timeline click never navigates after its page resolves", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log")
  // 准备：目标行先在视口外被卸载，再确定性挂载（走产品自己的 virtual-reveal 入口）。
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
  await page.locator(shell).dispatchEvent("virtual-reveal")
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "true")
  await quoteLineEleven(page)
  // 展开并保留徽标，然后把视口挪开，让引用定位真的要滚动。
  await page.locator(toggle).click()
  await expect(page.locator(badge)).toHaveCount(1)
  await viewport.evaluate(el => {
    ;(el as HTMLElement).scrollTop = 650
  })
  await expect(page.locator(badge)).not.toBeInViewport()
  await instrumentScroll(page)

  // 1) 点尚未挂载的历史节点：进入分页等待。
  await page.locator("button.timeline-node").click()
  await page.waitForFunction(
    () => typeof (window as unknown as { qa: { releaseHistory?: unknown } }).qa.releaseHistory === "function",
  )
  await expect(page.locator('[data-message-id="111"][data-virtual-mounted]')).toHaveCount(0)

  // 2) 分页还没回来，用户点了引用：这次定位取得更新的身份，且确实把徽标带进视口。
  await locateFromSummary(page)
  await page.evaluate(async () => await (window as unknown as { qa: { earlier: Promise<unknown> } }).qa.earlier)
  await expect(page.locator(badge)).toBeInViewport({ ratio: 0.75 })

  // 3) 释放分页：历史数据照常补上，但这次点击已经过期 —— 不得再导航。
  await page.evaluate(async () => {
    const qa = window as unknown as {
      qaWrites: { phase: string }
      qa: { releaseHistory: () => void; historyNavigation: Promise<unknown> }
    }
    qa.qaWrites.phase = "history resolved after quote"
    const list = (window as unknown as { qa: { list: { value: Record<string, unknown> } } }).qa.list.value
    const original = (list.scrollToMessage as (...inner: unknown[]) => unknown).bind(list)
    ;(window as unknown as { qaCalls: unknown[] }).qaCalls = []
    list.scrollToMessage = (id: number, request?: unknown) => {
      ;(window as unknown as { qaCalls: unknown[] }).qaCalls.push({ id, hasRequest: !!request })
      return original(id, request)
    }
    qa.qa.releaseHistory()
    await qa.qa.historyNavigation
  })
  await expect(page.locator('[data-message-id="111"][data-virtual-mounted]')).toHaveCount(1)
  const writes = await page.evaluate(
    () => (window as unknown as { qaWrites: { writes: { phase: string }[] } }).qaWrites.writes,
  )
  const navCalls = await page.evaluate(() => (window as unknown as { qaCalls?: unknown[] }).qaCalls ?? [])
  // 关键回归：分页恢复之后，旧点击一笔滚动都没发。
  expect(
    writes.filter(write => write.phase === "history resolved after quote"),
    "a stale timeline click must not scroll after its page resolves",
  ).toEqual([])
  // 决定性判据：分页恢复后**根本没有再触发导航**（旧实现会调用 `scrollToMessage(111)`）。
  // 这条断言不依赖滚动引擎的时序，三内核结果一致。
  expect(navCalls, "a stale timeline click must not navigate after its page resolves").toEqual([])
  // 最强判据是**停稳后真正看得见的内容**（不是写入次数、`scrollTop` 或 `top < 120`）：
  // 历史前插会把一整页更早的消息插到最前面，所以 `scrollTop` 允许变化（那是为了把内容
  // 钉在原处）；但用户此刻在读的引用正文与徽标必须仍然在视口里，旧点击的目标不能被
  // 带到视口顶端。
  // 徽标在历史前插前处于视口内；前插后仍必须**看得见**（允许因前插行高微调而轻微位移，
  // 但不允许整块跑到视口外）。用几何计算而不是 `toBeInViewport`，避免像素级抖动导致 flake。
  // 前插后引用行可能被虚拟化重新挂载，先确保它回到 DOM 里（产品自己的入口）。
  if (
    (await page.locator('[data-message-id="1"][data-virtual-mounted]').getAttribute("data-virtual-mounted")) === "false"
  ) {
    await page.locator('[data-message-id="1"][data-virtual-mounted]').dispatchEvent("virtual-reveal")
  }
  await expect(page.locator(body)).toHaveCount(1)
  const visibility = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const badgeEl = document.querySelector('[data-message-id="1"] [data-selection-anchor]') as HTMLElement
    const bodyEl = document.querySelector('[data-message-id="1"] [data-prompt-text]') as HTMLElement
    const logRect = log.getBoundingClientRect()
    const overlapOf = (rect: DOMRect) =>
      Math.max(0, Math.min(rect.bottom, logRect.bottom) - Math.max(rect.top, logRect.top))
    const badgeRect = badgeEl.getBoundingClientRect()
    const bodyRect = bodyEl.getBoundingClientRect()
    return {
      badgeRatio: badgeRect.height ? overlapOf(badgeRect) / badgeRect.height : 0,
      bodyRatio: bodyRect.height ? overlapOf(bodyRect) / bodyRect.height : 0,
    }
  })
  expect(visibility.badgeRatio, "the quoted line the user was reading stays visible").toBeGreaterThan(0.5)
  expect(visibility.bodyRatio, "the quoted prompt stays in view").toBeGreaterThan(0.2)
  const finalTop = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const row = document.querySelector('[data-message-id="111"][data-virtual-mounted]') as HTMLElement
    return { scrollTop: log.scrollTop, rowTop: row.getBoundingClientRect().top - log.getBoundingClientRect().top }
  })
  // 旧点击的目标**没有**被停到视口顶端（可能在上方也可能在下方，关键是没被"导航到位"）。
  expect(Math.abs(finalTop.rowTop - 24), "the stale target is not parked at the viewport top").toBeGreaterThan(100)
})

test("a current lazy-history timeline click still navigates and passes its request identity on", async ({ page }) => {
  await page.goto(harness!.url)
  await page.locator("button.timeline-node").click()
  await page.waitForFunction(
    () => typeof (window as unknown as { qa: { releaseHistory?: unknown } }).qa.releaseHistory === "function",
  )
  // 没有更新的定位介入：分页结束后应当正常导航（数据 + 跳转都发生）。
  await page.evaluate(async () => {
    const qa = window as unknown as { qa: { releaseHistory: () => void; historyNavigation: Promise<unknown> } }
    qa.qa.releaseHistory()
    await qa.qa.historyNavigation
  })
  await expect(page.locator('[data-message-id="111"][data-virtual-mounted]')).toHaveCount(1)
  const geometry = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const row = document.querySelector('[data-message-id="111"]') as HTMLElement
    return { top: row.getBoundingClientRect().top - log.getBoundingClientRect().top }
  })
  // 判据是**目标原文实际可见**（不是"调用过导航"或 `top < 120`）：冷跳时被重挂出来的
  // 虚拟行会连续测高，写入一次就收工会把目标留在视口外。
  await expect(page.locator('[data-message-id="111"] [data-prompt-text]')).toBeInViewport({ ratio: 0.5 })
  expect(geometry.top).toBeGreaterThan(-1)
})
