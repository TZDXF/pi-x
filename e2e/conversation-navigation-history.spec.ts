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
// ?long：100 行的长提问 —— 展开它带来的高度增量远超历史前插，用来验证补偿只算前插。
const lineCount = new URLSearchParams(location.search).has('long') ? 100 : 12
const lines = Array.from({ length: lineCount }, (_, i) => 'Line-' + String(i + 1).padStart(2, '0') + ' readable words')
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
  isStreaming: false, partialBlocks: null, streamingTurnId: null, runs: {},
  // 受控"历史分页"：点时间线后挂起，直到测试调用 releaseHistory。
  // qa.gaps：前插行里混入模型切换分隔行（会比普通行多出额外高度/间距）；
  // qa.older：前插条数。
  revealTimelineTurn: () => new Promise(resolve => {
    window.qa.releaseHistory = () => {
      const count = window.qa.older ?? 32
      const oldRows = Array.from({ length: count }, (_, i) =>
        window.qa.gaps && i % 2
          ? { kind: 'model_change', id: 100 + i, provider: 'fixture', modelId: 'model-' + i }
          : { kind: 'user', id: 100 + i, text: 'Previously unloaded row ' + i })
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
  const { navigateToQuestion, renderedEntries } = useChatTurnList({ session, ui, conversation: list, connecting: () => false })
  window.qa.selections = selections
  return () => h('div', { style: 'width:700px;height:550px;display:flex;flex-direction:column' }, [
    h(ChatTurnList, {
      ref: list, session, ui, project: '/qa', projectName: 'QA', connecting: false,
      renderedEntries: renderedEntries.value, edit,
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
  // 准备动作（不是被测行为）：长提问里"收起提问"按钮可能已被滚到视口外很远，pointer 点击
  // 会先触发自动滚动、命中目标容易漂移（WebKit 实测会点空）；摘要浮层也可能盖住它。
  // 这里直接派发一次 click 收起气泡，把状态准备成"收起 + 无徽标"。
  await page.locator(toggle).evaluate(element => (element as HTMLElement).click())
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

/**
 * 分页等待期间**展开折叠提问并完成引用定位**（TZD-138 第九轮）。
 *
 * QA 复现：展开带来的高度增量会被旧实现误当成"前插量"（旧实现跨这段异步等待比较列表总高），
 * 前插一落地就把刚定位的正文与徽标滚出视口（可见比例 100% → 0%）。
 * 修复后补偿只算**前插行的实际高度**，因此这两样在停稳后仍然完整可见。
 */
test("expanding and locating during paging keeps the quoted text visible after prepend", async ({ page }) => {
  await page.goto(`${harness!.url}?long`)
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
  await page.locator(shell).dispatchEvent("virtual-reveal")
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "true")
  // 收起态先保存第 11 行的引用。
  await quoteLineEleven(page)
  await expect(page.locator(badge)).toHaveCount(0)
  await instrumentScroll(page)

  // 1) 点尚未挂载的历史节点：进入分页等待。
  await page.locator("button.timeline-node").click()
  await page.waitForFunction(
    () => typeof (window as unknown as { qa: { releaseHistory?: unknown } }).qa.releaseHistory === "function",
  )
  // 2) 等待期间展开提问并完成引用定位（这正是旧实现把"展开高度"误算成前插的场景）。
  await locateFromSummary(page)
  await page.evaluate(async () => await (window as unknown as { qa: { earlier: Promise<unknown> } }).qa.earlier)
  await expect(page.locator(toggle)).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(badge)).toHaveCount(1)
  // 定位完成时，第 11 行与徽标都已完整可见。
  await expect(page.locator(badge)).toBeInViewport({ ratio: 0.95 })

  // 3) 释放分页：历史数据照常补上，旧点击已经过期不导航，而且**前插补偿只算前插**。
  await page.evaluate(async () => {
    const qa = window as unknown as {
      qaWrites: { phase: string }
      qa: { releaseHistory: () => void; historyNavigation: Promise<unknown> }
    }
    qa.qaWrites.phase = "history resolved after quote"
    qa.qa.releaseHistory()
    await qa.qa.historyNavigation
  })
  await expect(page.locator('[data-message-id="111"][data-virtual-mounted]')).toHaveCount(1)
  const writes = await page.evaluate(
    () => (window as unknown as { qaWrites: { writes: { phase: string }[] } }).qaWrites.writes,
  )
  expect(
    writes.filter(write => write.phase === "history resolved after quote"),
    "the stale timeline click must not scroll after its page resolves",
  ).toEqual([])
  // 停稳后（几何计算，避免像素级抖动）：刚定位的第 11 行与徽标都还在视口里。
  const settled = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const text = document.querySelector('[data-message-id="1"] [data-prompt-text]') as HTMLElement
    const badgeEl = document.querySelector('[data-message-id="1"] [data-selection-anchor]') as HTMLElement
    const logRect = log.getBoundingClientRect()
    const overlapRatio = (rect: DOMRect) =>
      rect.height
        ? Math.max(0, Math.min(rect.bottom, logRect.bottom) - Math.max(rect.top, logRect.top)) / rect.height
        : 0
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent?.includes("Line-11")) node = walker.nextNode()
    const range = document.createRange()
    if (node) {
      const index = node.textContent!.indexOf("Line-11")
      range.setStart(node, index)
      range.setEnd(node, index + 7)
    }
    return {
      lineRatio: node ? overlapRatio(range.getBoundingClientRect()) : 0,
      badgeRatio: overlapRatio(badgeEl.getBoundingClientRect()),
      rows: (window as unknown as { qa: { session: { entries: unknown[] } } }).qa.session.entries.length,
    }
  })
  expect(settled.rows, "history data is still committed").toBe(88)
  expect(settled.lineRatio, "the selected line stays visible after the prepend").toBeGreaterThan(0.95)
  expect(settled.badgeRatio, "the selection badge stays visible after the prepend").toBeGreaterThan(0.95)
})

/** 起一条流式回复（真实 `partialBlocks` 投影，位于阅读位置**下方**）。 */
async function startStreamingTail(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    const qa = (window as unknown as { qa: { session: Record<string, unknown> } }).qa
    qa.session.streamingTurnId = 9001
    qa.session.isStreaming = true
    qa.session.partialBlocks = [
      { type: "text", text: Array.from({ length: 36 }, (_, i) => "Streaming paragraph " + i).join("\n\n") },
    ]
  })
  await expect(page.locator('[data-message-id="9001"][data-virtual-mounted]')).toHaveCount(1)
}

/** 停稳后的实际可见性：第 11 行原文与徽标的视口交集比例。 */
async function settledVisibility(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const text = document.querySelector('[data-message-id="1"] [data-prompt-text]') as HTMLElement
    const badgeEl = document.querySelector('[data-message-id="1"] [data-selection-anchor]') as HTMLElement
    const logRect = log.getBoundingClientRect()
    const ratio = (rect: DOMRect) =>
      rect.height
        ? Math.max(0, Math.min(rect.bottom, logRect.bottom) - Math.max(rect.top, logRect.top)) / rect.height
        : 0
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent?.includes("Line-11")) node = walker.nextNode()
    const range = document.createRange()
    if (node) {
      const index = node.textContent!.indexOf("Line-11")
      range.setStart(node, index)
      range.setEnd(node, index + 7)
    }
    return {
      lineRatio: node ? ratio(range.getBoundingClientRect()) : 0,
      badgeRatio: ratio(badgeEl.getBoundingClientRect()),
    }
  })
}

/**
 * 分页停稳后**目标正文与引用徽标仍在视口内**（TZD-138 第十轮，QA 的两个边界）。
 *
 * 1. `streaming-tail` / `existing-streaming-tail`：会话末尾有流式回复时，旧实现把这条
 *    （以及更下方）的高度也算成"前插"，补多了四倍左右，正文被推到上方 −1755px。
 * 2. `prepend-with-gaps`：前插行之间隔着列表 `gap-5`，旧实现只加行高、漏掉间距，补少了
 *    ≈520px，正文停在视口下沿之外。
 * 锚点改为"分页前就存在的最上面一行"，它的内容内位移恰好只等于前插行 + 行间距。
 */
for (const mode of ["only-prepend", "existing-streaming-tail", "streaming-tail", "prepend-with-gaps"]) {
  test(`prepend accounting keeps the quoted text visible: ${mode}`, async ({ page }) => {
    // 所有模式都用 100 行长提问：收起态下第 11 行在裁剪区外，定位必须真的滚动。
    await page.goto(`${harness!.url}?long`)
    // 100 行长提问：先收起，才能把引用点定位到裁剪区外。
    await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
    await page.locator(shell).dispatchEvent("virtual-reveal")
    await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "true")
    await quoteLineEleven(page)
    if (mode === "existing-streaming-tail") await startStreamingTail(page)
    if (mode === "prepend-with-gaps")
      await page.evaluate(() => {
        ;(window as unknown as { qa: { gaps?: boolean; older?: number } }).qa.gaps = true
        ;(window as unknown as { qa: { gaps?: boolean; older?: number } }).qa.older = 64
      })
    await instrumentScroll(page)

    // 1) 点尚未挂载的历史节点：进入分页等待；2) 期间展开并定位（真实交互），确认已可见。
    await page.locator("button.timeline-node").click()
    await page.waitForFunction(
      () => typeof (window as unknown as { qa: { releaseHistory?: unknown } }).qa.releaseHistory === "function",
    )
    await locateFromSummary(page)
    await page.evaluate(async () => await (window as unknown as { qa: { earlier: Promise<unknown> } }).qa.earlier)
    await expect(page.locator(badge)).toHaveCount(1)
    // 3) 分页**还没回来**时插入流式回复（`streaming-tail` 场景）。
    if (mode === "streaming-tail") await startStreamingTail(page)

    // 4) 释放分页：数据补上、旧点击零导航；停稳后正文与徽标仍必须看得见。
    await page.evaluate(async () => {
      const qa = window as unknown as {
        qaWrites: { phase: string }
        qa: { releaseHistory: () => void; historyNavigation: Promise<unknown> }
      }
      qa.qaWrites.phase = "history resolved after quote"
      qa.qa.releaseHistory()
      await qa.qa.historyNavigation
    })
    await expect(page.locator('[data-message-id="111"][data-virtual-mounted]')).toHaveCount(1)
    const writes = await page.evaluate(
      () => (window as unknown as { qaWrites: { writes: { phase: string }[] } }).qaWrites.writes,
    )
    expect(
      writes.filter(write => write.phase === "history resolved after quote"),
      "the stale timeline click must not scroll after its page resolves",
    ).toEqual([])
    const rows = await page.evaluate(
      () => (window as unknown as { qa: { session: { entries: unknown[] } } }).qa.session.entries.length,
    )
    expect(rows).toBe(mode === "prepend-with-gaps" ? 120 : 88)
    const seen = await settledVisibility(page)
    expect(seen.lineRatio, "the selected line stays visible after the prepend").toBeGreaterThan(0.95)
    expect(seen.badgeRatio, "the selection badge stays visible after the prepend").toBeGreaterThan(0.95)
  })
}

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
  // 定位是"发起 → 复核校正"两步：等它真正停稳再看几何（与用户看到的最终状态一致）。
  await page.evaluate(
    async () => await (window as unknown as { qa: { historyNavigation: Promise<unknown> } }).qa.historyNavigation,
  )
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
