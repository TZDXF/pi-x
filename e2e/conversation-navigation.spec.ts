import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-138 P2（第五轮）：同一视口里的定位必须**只有最后一次生效**。
 *
 * 时间线的"跳转到第 N 次提问"很容易连点：用户在第一个平滑滚动还没结束时点了另一个目标。
 * 定位是"滚 → 等停 → 复核 → 修正"的多轮过程，期间会**多次写** `scrollTop`；旧定位在那之后
 * 的一轮即时修正会把新目标顶掉（QA 实测：连点第 5 条与第 65 条，最终反跳到第 5 条，
 * 第 65 条在视口顶部下方 4824px）。这里用真实的 `Conversation` + `VirtualMessage` 复现，
 * 并断言"第二次点击获胜"。
 *
 * 同时保留常规行高补偿的验证：定位结束后（计数归零）位于视口上方且仍挂载的虚拟行变高，
 * `scrollTop` 要同步补上同样的差值，阅读锚点不动。
 *
 * fixture 走产品同一条入口：`stopScroll()` → `scrollToMessage(id)`（与 `useChatTurnList`
 * 的时间线导航一致）。
 */
const html = `<!doctype html><html><body style="margin:0"><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import Conversation from '/src/components/ai-elements/conversation/Conversation.vue'
import VirtualMessage from '/src/components/VirtualMessage.vue'
import '/src/style.css'
const params = new URLSearchParams(location.search)
const virtual = params.has('virtual')
const baseHeight = virtual ? 160 : 80
const conversation = ref(null)
const heights = ref(baseHeight)
// 与 useChatTurnList 的时间线导航同构：先释放底部跟随，再滚到目标。
const nav = id => {
  conversation.value.stopScroll()
  const promise = conversation.value.scrollToMessage(id)
  ;(window.completed ||= []).push(promise)
  return promise
}
window.nav = nav
window.grow = () => { heights.value += 40 }
createApp({ render: () => h('div', { style: 'display:flex;flex-direction:column' }, [
  h('div', { style: 'display:flex;gap:8px' }, [
    h('button', { id: 'jump-5', onClick: () => nav(5) }, 'Jump to 5'),
    h('button', { id: 'jump-65', onClick: () => nav(65) }, 'Jump to 65'),
    h('button', { id: 'grow-row', onClick: () => window.grow() }, 'Grow row'),
  ]),
  h('div', { style: 'height:400px;display:flex;flex-direction:column' }, [
    h(Conversation, { ref: conversation, initial: 'instant' }, { default: () =>
      Array.from({ length: 80 }, (_, index) => {
        const id = index + 1
        return h(VirtualMessage, { key: id, 'data-message-id': id, enabled: virtual }, { default: () =>
          h('div', { style: 'height:' + (id === 60 ? heights.value : baseHeight) + 'px' }, 'Row ' + id)
        })
      })
    }),
  ]),
]) }).mount('#app')
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "conversation-navigation", port: 1524, html })
})
test.afterAll(async () => {
  await harness?.close()
})

/** 单次 `evaluate` 原子测量：视口、目标与阅读锚点同一坐标系。 */
const layout = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const log = document.querySelector('[role="log"]') as HTMLElement
    const origin = log.getBoundingClientRect().top
    const topOf = (id: number) => {
      const row = document.querySelector(`[data-message-id="${id}"]`)
      return row ? row.getBoundingClientRect().top - origin : null
    }
    return { scrollTop: Math.round(log.scrollTop), first: topOf(5), last: topOf(65), anchor: topOf(66) }
  })

/** 等所有已发起的导航 promise 结束（产品里它们由点击链各自 await）。 */
const settled = (page: import("@playwright/test").Page) =>
  page.evaluate(async () => {
    await Promise.all((window as unknown as { completed?: Promise<unknown>[] }).completed ?? [])
  })

test("two rapid navigation clicks keep the second target at the top", async ({ page }) => {
  await page.goto(harness!.url)
  await expect.poll(async () => (await layout(page)).scrollTop).toBeGreaterThan(5500)
  await page.getByRole("button", { name: "Jump to 5" }).click()
  await page.getByRole("button", { name: "Jump to 65" }).click()
  await settled(page)
  // 平滑滚动结束后再看（不依赖动画时长，等位置稳定）。
  await expect.poll(async () => (await layout(page)).last, { timeout: 5000 }).toBeCloseTo(24, 0)
  const final = await layout(page)
  // 第二次点击获胜：第 65 条贴视口顶端 24px，第 5 条早已在上方。
  expect(final.last, "the last clicked target wins").toBeCloseTo(24, 0)
  expect(final.first, "the earlier target is not restored").toBeLessThan(-1000)
})

test("rapid navigation with virtualized rows virtualized or not both keep the later target", async ({ page }) => {
  // 关掉虚拟卸载（`enabled=false`）也能复现/验证：排除行高测量干扰。
  await page.goto(`${harness!.url}?virtual`)
  await expect.poll(async () => (await layout(page)).scrollTop).toBeGreaterThan(5500)
  await page.getByRole("button", { name: "Jump to 5" }).click()
  await page.getByRole("button", { name: "Jump to 65" }).click()
  await settled(page)
  await expect.poll(async () => (await layout(page)).last, { timeout: 5000 }).toBeCloseTo(24, 0)
})

test("height compensation still works after a navigation has settled", async ({ page }) => {
  await page.goto(`${harness!.url}?virtual`)
  await expect.poll(async () => (await layout(page)).scrollTop).toBeGreaterThan(5500)
  await page.getByRole("button", { name: "Jump to 65" }).click()
  await settled(page)
  const before = await layout(page)
  expect(before.last, "navigation landed").toBeCloseTo(24, 0)
  // 定位结束后锁定计数归零：视口上方仍挂载的虚拟行变高 40px → scrollTop 同步 +40，锚点不动。
  await expect(page.locator('[data-message-id="60"]')).toHaveAttribute("data-virtual-mounted", "true")
  await page.getByRole("button", { name: "Grow row" }).click()
  await expect.poll(async () => (await layout(page)).scrollTop - before.scrollTop).toBe(40)
  const after = await layout(page)
  expect(after.anchor, "reading anchor stays put").toBeCloseTo(before.anchor!, 0)
})
