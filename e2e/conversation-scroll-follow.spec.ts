import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-135 regression: only the reader's own downward input may re-enable bottom
 * following.
 *
 * The conversation viewport is moved by code too (bottom pinning, virtual-row
 * height compensation, history anchoring, the storage library's clamps). One such
 * write landing on the bottom used to be read as a downward reading gesture, so
 * following was re-armed and every later streaming chunk pinned the panel to the
 * bottom — the reader could never stay scrolled up.
 */
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { Conversation, ConversationScrollButton } from '/src/components/ai-elements/conversation'
import VirtualMessage from '/src/components/VirtualMessage.vue'
import '/src/style.css'
const above = ref(1200)
const tail = ref(300)
createApp({
  render: () => h('div', { style: { height: '400px', width: '700px', display: 'flex' } },
    h(Conversation, { initial: 'instant', resize: 'instant' }, {
      default: () => [
        h(VirtualMessage, { key: 0, enabled: true, pinned: true, live: false, 'data-message-id': 0 }, {
          default: () => h('div', { style: 'height:' + above.value + 'px;background:#eee' }, 'expanded process above the reader'),
        }),
        h(VirtualMessage, { key: 1, enabled: true, pinned: true, live: true, 'data-message-id': 1 }, {
          default: () => h('div', { style: 'height:' + tail.value + 'px;background:#ddd' }, 'streaming answer'),
        }),
      ],
      overlay: () => h(ConversationScrollButton),
    }))
}).mount('#app')
// What the app itself does while a reply streams.
window.__growAbove = by => { above.value += by }
window.__growTail = by => { tail.value += by }
window.__pinToBottom = () => {
  const viewport = document.querySelector('[role=log]')
  viewport.scrollTop = viewport.scrollHeight - viewport.clientHeight
}
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "conversation-scroll-follow", port: 1534, html })
})
test.afterAll(async () => {
  await harness?.close()
})
test.use({ viewport: { width: 900, height: 460 } })

test("a virtual-row compensation landing on the bottom does not re-arm following", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const state = () =>
    viewport.evaluate((element: HTMLElement) => ({
      top: Math.round(element.scrollTop),
      gap: Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
    }))
  await expect.poll(async () => (await state()).gap).toBeLessThanOrEqual(1)
  await viewport.hover()
  await page.mouse.wheel(0, -200)
  await page.waitForTimeout(200)
  const reading = await state()
  // A mounted row above the reader grows past the remaining distance, so the
  // compensation write is clamped onto the bottom.
  await page.evaluate(() => (window as any).__growAbove(260))
  await page.waitForTimeout(250)
  expect((await state()).gap).toBeGreaterThan(0)
  for (let chunk = 0; chunk < 4; chunk++) {
    await page.evaluate(() => (window as any).__growTail(40))
    await page.waitForTimeout(150)
    // Streaming must never pull the reader back down.
    expect((await state()).top).toBe(reading.top)
  }
})

test("an app-side pin to the bottom does not re-arm following", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () =>
    viewport.evaluate((element: HTMLElement) =>
      Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
    )
  await page.waitForTimeout(200)
  await viewport.hover()
  await page.mouse.wheel(0, -200)
  await page.waitForTimeout(200)
  expect(await gap()).toBeGreaterThan(100)
  await page.evaluate(() => (window as any).__pinToBottom())
  await page.waitForTimeout(200)
  await page.evaluate(() => (window as any).__growTail(40))
  await page.waitForTimeout(200)
  expect(await gap()).toBeGreaterThan(0)
})

test("a reader's own wheel back to the bottom still re-arms following", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () =>
    viewport.evaluate((element: HTMLElement) =>
      Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
    )
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await viewport.hover()
  await page.mouse.wheel(0, -200)
  await expect.poll(gap).toBeGreaterThan(100)
  await page.mouse.wheel(0, 400)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await page.waitForTimeout(100)
  await page.evaluate(() => (window as any).__growTail(40))
  await expect.poll(gap).toBeLessThanOrEqual(1)
})

test("a scrollbar drag back to the bottom still re-arms following", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () =>
    viewport.evaluate((element: HTMLElement) =>
      Math.round(element.scrollHeight - element.clientHeight - element.scrollTop),
    )
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await viewport.hover()
  await page.mouse.wheel(0, -300)
  await expect.poll(gap).toBeGreaterThan(200)
  const thumb = page.locator('[data-slot="scroll-area-thumb"]')
  await expect(thumb).toBeVisible()
  const box = (await thumb.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + 400, { steps: 6 })
  await page.mouse.up()
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await page.waitForTimeout(100)
  await page.evaluate(() => (window as any).__growTail(40))
  await expect.poll(gap).toBeLessThanOrEqual(1)
})
