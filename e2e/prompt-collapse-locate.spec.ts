import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-138 P2（第三轮）：虚拟行卸载后的**首次点击**必须就能定位。
 *
 * 复现自 QA 的 `qa-fixed-recheck.spec.ts`：真实 `ChatTurnList` + `VirtualMessage` 长会话，
 * 引用第 11 行并收起，滚到足够远让目标行整行卸载（`data-virtual-mounted="false"`，
 * 正文元素消失），再点引用摘要。旧实现在没有徽标时 `scrollToMessage` 重挂后只重算锚点，
 * 没有"重查正文 → 判断裁剪 → 展开"，于是第一次点击只把正文重挂出来、仍是收起态、无徽标，
 * 要再点一次才生效。
 *
 * 断言只用**单次** `evaluate` 取几何（正文与徽标同一时刻、同一坐标系）：QA 脚本里分两次
 * `boundingBox()` 取值，平滑滚动动画（WebKit 更慢）在两次调用之间还在推进，会把两次测量
 * 混到不同滚动位置，产生与产品行为无关的偶发失败。这里先等滚动停稳，再原子测量。
 */
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><div id="app"></div><script type="module">
import { createApp, h, reactive, ref } from 'vue'
import { createI18n } from 'vue-i18n'
import { createPinia } from 'pinia'
import zh from '/src/i18n/locales/zh-CN.ts'
import ChatTurnList from '/src/components/chat/ChatTurnList.vue'
import Summary from '/src/components/chat/ConversationSelectionSummary.vue'
import { usePromptEdit } from '/src/composables/usePromptEdit.ts'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import { useConversationSelectionsStore } from '/src/stores/conversationSelections.ts'
import '/src/style.css'
const mode = new URLSearchParams(location.search).get('mode')
const lines = Array.from({ length: 12 }, (_, i) => 'Line-' + String(i + 1).padStart(2, '0') + ' readable words')
const visible = lines.join('\\n')
const parent = '<aux_parent_context>\\nImmutable context.\\n</aux_parent_context>\\n\\n'
const target = { kind: 'user', id: 1, text: visible, contextText: parent + visible }
// virtual：目标行后面塞 55 条，滚动后目标行会被 VirtualMessage 整行卸载。
const entries = mode === 'virtual'
  ? [target, ...Array.from({ length: 55 }, (_, i) => ({ kind: 'user', id: i + 2, text: 'Later entry ' + i }))]
  : [target]
const copies = [], resends = []
const session = reactive({
  entries, sessionFile: 'qa-a.jsonl', steering: [], followUp: [], timelineTurns: [],
  isStreaming: false, partialBlocks: null,
  resendPrompt: (...args) => { resends.push(args) },
})
const ui = reactive({ pendingUserMessage: null, pushToast: () => {} })
const list = ref(null)
window.qa = { session, ui, list, visible, parent, copies, resends }
// 跨入口竞态回归用：记录两条定位链各自的 promise，便于断言"谁获胜"。
window.qa.pending = []
window.qa.locate = id => {
  const promise = list.value?.locateSelection(id)
  window.qa.pending.push(promise)
  return promise
}
window.qa.jump = id => {
  list.value?.stopScroll()
  const promise = list.value?.scrollToMessage(id)
  window.qa.pending.push(promise)
  return promise
}
createApp({ setup() {
  const editTextarea = ref(null)
  const edit = reactive(usePromptEdit({
    session, ui, workspace: useWorkspaceStore(), editTextarea,
    project: () => '/qa', connecting: () => false, connected: () => true, knownSessions: () => [],
  }))
  const selections = useConversationSelectionsStore()
  window.qa.selections = selections
  return () => h('div', { style: 'width:700px;height:550px;display:flex;flex-direction:column' }, [
    // 时间线跳转按钮：与 useChatTurnList.navigateToQuestion 同一入口（stopScroll → scrollToMessage）。
    h('button', { id: 'qa-jump-52', onClick: () => window.qa.jump(52) }, 'Jump to message 52'),
    h(ChatTurnList, {
      ref: list, session, ui, project: '/qa', projectName: 'QA', connecting: false,
      renderedEntries: session.entries, edit,
      onCopyText: t => copies.push(t),
      onEditTextarea: t => { editTextarea.value = t },
    }),
    selections.items.length ? h(Summary, {
      items: selections.items,
      onLocate: id => window.qa.locate(id),
      onEdit: id => list.value?.editSelection(id),
    }) : null,
  ])
}}).use(createPinia()).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zh } })).mount('#app')
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "prompt-collapse-locate", port: 1523, html })
})
test.afterAll(async () => {
  await harness?.close()
})

const body = '[data-message-id="1"] [data-prompt-text]'
const toggle = '[data-message-id="1"] [data-prompt-toggle]'
const badge = '[data-message-id="1"] [data-selection-anchor]'
const shell = '[data-message-id="1"][data-virtual-mounted]'

/**
 * 把目标行**确定性地**挂载出来：派发 `virtual-reveal`（产品自己的入口），
 * 不依赖 `IntersectionObserver` 的时序（在慢/并行环境里回调可能迟迟不来）。
 */
async function mountTarget(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    document.querySelector('[data-message-id="1"]')?.dispatchEvent(new Event("virtual-reveal"))
  })
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "true")
}

/** 划选第 11 行 → 引用到输入框 → 保存 → 收起提问。 */
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
  // 收起态：裁剪区里的引用没有可见锚点，徽标必须消失（而不是落在气泡下方空白处）。
  await expect(page.locator(badge)).toHaveCount(0)
}

/** 从摘要列表点该引用（一次点击）。 */
async function locateFromSummary(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: /1 条注释/ }).hover()
  await page.locator("button[title=Line-11]").click()
}

/** 等平滑滚动停稳：连续 3 次采样 `scrollTop` 不变（最多等约 2.4s）。 */
async function settleScroll(page: import("@playwright/test").Page) {
  await page.evaluate(async () => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
    let last = log.scrollTop
    let stable = 0
    for (let i = 0; i < 40 && stable < 3; i++) {
      await sleep(60)
      const now = log.scrollTop
      stable = now === last ? stable + 1 : 0
      last = now
    }
  })
}

/**
 * 原子测量（单次 `evaluate`，同一坐标系）：徽标必须落在可见正文里、位于第 11 行附近。
 */
async function geometry(page: import("@playwright/test").Page) {
  await settleScroll(page)
  return page.evaluate(() => {
    const bodyEl = document.querySelector('[data-message-id="1"] [data-prompt-text]') as HTMLElement
    const badgeEl = document.querySelector('[data-message-id="1"] [data-selection-anchor]') as HTMLElement
    const toggleEl = document.querySelector('[data-message-id="1"] [data-prompt-toggle]') as HTMLElement
    const bodyRect = bodyEl.getBoundingClientRect()
    const badgeRect = badgeEl.getBoundingClientRect()
    return {
      expanded: bodyEl.dataset.promptCollapsed,
      ariaExpanded: toggleEl.getAttribute("aria-expanded"),
      badgeTop: badgeRect.top - bodyRect.top,
      badgeBottom: badgeRect.bottom - bodyRect.top,
      bodyHeight: bodyRect.height,
      bodyLines: Number(bodyEl.dataset.promptLines),
    }
  })
}

test("first click locates a clipped reference while the target row is still mounted", async ({ page }) => {
  await page.goto(`${harness!.url}?mode=single`)
  await quoteLineEleven(page)
  await locateFromSummary(page)
  // 一次点击后徽标必须**真的进入视口**（不只是完成展开）：`toBeInViewport` 是 QA 最小脚本
  // 给的断言，针对"最终滚动被 VirtualMessage 的行高补偿打断"这一缺陷形态。
  await expect(page.locator(badge)).toBeInViewport({ ratio: 0.75, timeout: 3000 })
  const geo = await geometry(page)
  expect(geo.expanded, "one click expands the prompt").toBe("false")
  expect(geo.ariaExpanded).toBe("true")
  expect(geo.badgeTop).toBeGreaterThan(100)
  expect(geo.badgeBottom).toBeLessThanOrEqual(geo.bodyHeight)
})

test("first click locates a clipped reference after the row was virtually unmounted", async ({ page }) => {
  await page.goto(`${harness!.url}?mode=virtual`)
  const viewport = page.getByRole("log")
  // 目标行先在底部不可见 → 被 VirtualMessage 卸载（正文元素消失）。
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
  await mountTarget(page)
  await quoteLineEleven(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await viewport.evaluate(el => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
  await expect(page.locator(body)).toHaveCount(0)

  // 首次点击：必须一次就重挂 + 展开 + 出徽标 + 滚到位。
  await locateFromSummary(page)
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "true")
  await expect(page.locator(toggle)).toHaveAttribute("aria-expanded", "true")
  await expect(page.locator(badge)).toHaveCount(1)
  // 关键回归：目标行是靠"重挂 + 展开 + 重新校正滚动"一次进视口的，不能停在展开。
  await expect(page.locator(badge)).toBeInViewport({ ratio: 0.75, timeout: 3000 })
  const geo = await geometry(page)
  expect(geo.expanded).toBe("false")
  expect(geo.badgeTop).toBeGreaterThan(100)
  expect(geo.badgeBottom).toBeLessThanOrEqual(geo.bodyHeight)
  // 引用原文本身（第 11 行）也要在视口内，而不只是徽标。
  await expect(page.locator(body)).toBeInViewport({ ratio: 0.25 })
})

test("a second click on an already-revealed reference does not expand or scroll again", async ({ page }) => {
  // QA 的诊断用例改成断言：旧实现需要第二次点击；修复后第二次必须是无副作用的重复定位。
  await page.goto(`${harness!.url}?mode=virtual`)
  const viewport = page.getByRole("log")
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
  await mountTarget(page)
  await quoteLineEleven(page)
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await viewport.evaluate(el => {
    el.scrollTop = el.scrollHeight
  })
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
  await locateFromSummary(page)
  await expect(page.locator(toggle)).toHaveAttribute("aria-expanded", "true")
  const first = await geometry(page)
  await locateFromSummary(page)
  const second = await geometry(page)
  expect(second.ariaExpanded, "still expanded after the second click").toBe("true")
  expect(second.badgeTop).toBeCloseTo(first.badgeTop, 0)
  expect(second.badgeBottom).toBeCloseTo(first.badgeBottom, 0)
})

test("copy and inline edit still use the full visible question after expanding", async ({ page }) => {
  await page.goto(`${harness!.url}?mode=single`)
  await expect(page.locator(toggle)).toHaveAttribute("aria-expanded", "false")
  const visible: string = await page.evaluate(() => (window as unknown as { qa: { visible: string } }).qa.visible)
  await page.locator(body).hover()
  await page.getByRole("button", { name: "复制提问" }).click()
  expect(await page.evaluate(() => (window as unknown as { qa: { copies: string[] } }).qa.copies)).toEqual([visible])
  await page.getByRole("button", { name: "编辑提问" }).click()
  await expect(page.getByRole("textbox", { name: "编辑提问" })).toHaveValue(visible)
  await expect(page.locator(body)).toHaveCount(0)
  await page.getByRole("button", { name: "重新发送" }).click()
  const parent: string = await page.evaluate(() => (window as unknown as { qa: { parent: string } }).qa.parent)
  expect(await page.evaluate(() => (window as unknown as { qa: { resends: unknown[] } }).qa.resends)).toEqual([
    [visible, undefined, parent + visible],
  ])
})

/**
 * 跨入口竞态（TZD-138 第六轮）：引用定位进行中点时间线跳转。
 *
 * 旧的引用定位在 `await`（重挂/展开/重算）之后仍会再写一次 `scrollTop`，把用户后来点的
 * 时间线目标顶回去；更糟的是它把自己的"被取消"当成"徽标不存在"，接着走重挂回退，
 * 重新取得滚动权。修复后在**发起定位时就取得视口请求身份**，取消即终态。
 */
test("a later timeline jump is not overridden by a cancelled quote locate", async ({ page }) => {
  await page.goto(`${harness!.url}?mode=virtual`)
  const viewport = page.getByRole("log")
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "false")
  await page.locator(shell).dispatchEvent("virtual-reveal")
  await expect(page.locator(shell)).toHaveAttribute("data-virtual-mounted", "true")
  await quoteLineEleven(page)
  // 展开并保留徽标，把视口挪开一点，让引用定位真的要滚动。
  await page.locator(toggle).click()
  await expect(page.locator(badge)).toHaveCount(1)
  await viewport.evaluate(el => {
    ;(el as HTMLElement).scrollTop = 650
  })
  await expect(page.locator(badge)).not.toBeInViewport()

  // 记录滚动写入的先后顺序：第一条是引用定位，之后必须只有面向第 52 条的写入。
  await page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const native = log.scrollTo.bind(log)
    const state: { writes: { top: number | undefined; behavior?: string }[]; phase: number } = { writes: [], phase: 1 }
    ;(window as unknown as { qaWrites: typeof state }).qaWrites = state
    document.addEventListener(
      "click",
      event => {
        if ((event.target as Element).closest("#qa-jump-52")) state.phase = 2
      },
      true,
    )
    log.scrollTo = ((...args: unknown[]) => {
      state.writes.push({ top: (args[0] as ScrollToOptions | undefined)?.top, behavior: (args[0] as ScrollToOptions)?.behavior })
      return (native as unknown as (...inner: unknown[]) => void)(...args)
    }) as typeof log.scrollTo
  })
  // 引用定位先起步（等它真的发出了第一笔滚动写入），再点时间线。
  await page.getByRole("button", { name: /1 条注释/ }).hover()
  await page.locator("button[title=Line-11]").click()
  await page.waitForFunction(
    () => (window as unknown as { qaWrites: { writes: unknown[] } }).qaWrites.writes.length > 0,
  )
  await page.getByRole("button", { name: "Jump to message 52" }).click()

  const outcomes = await page.evaluate(async () => {
    const pending = (window as unknown as { qa: { pending: unknown[] } }).qa.pending
    return await Promise.all(pending.map(item => Promise.resolve(item)))
  })
  // 引用定位被取消（返回 `null` 表示它在展开/重挂阶段就终止，没有进入滚动阶段），时间线成功。
  expect(outcomes[outcomes.length - 1], "the timeline jump wins").toBe(true)
  const result = await page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const later = document.querySelector('[data-message-id="52"]') as HTMLElement
    return {
      writes: (window as unknown as { qaWrites: { writes: { phase: number; top?: number }[] } }).qaWrites.writes,
      laterTop: later.getBoundingClientRect().top - log.getBoundingClientRect().top,
    }
  })
  // 时间线点击之后不得再出现"回到旧引用附近"的写入（旧引用的字符位置在气泡顶部附近）。
  expect(
    result.writes.filter(write => write.phase === 2 && (write.top ?? Infinity) < 1000),
    "the cancelled quote must not scroll again after the timeline click",
  ).toEqual([])
  // 第 52 条贴视口顶端 24px（与产品原有顶距一致）。
  expect(result.laterTop).toBeCloseTo(24, 0)
})
