import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { Conversation } from '/src/components/ai-elements/conversation'
import '/src/style.css'
const tailHeight = ref(240)
window.addEventListener('shrink-tail', () => { tailHeight.value = 200 })
window.addEventListener('grow-tail', () => { tailHeight.value += 50 })
createApp({
  render: () => h('div', { style: 'width:600px;height:400px;display:flex' }, [
    h(Conversation, { initial: 'instant', resize: 'instant' }, () => [
      h('div', { style: 'height:960px;background:linear-gradient(#eee,#999)' }),
      h('div', { style: { height: tailHeight.value + 'px', background: '#ddd' } }),
    ]),
  ]),
}).mount('#app')
</script></body></html>`

let harness: VueHarness | null = null

test.beforeAll(async () => {
  harness = await startVueHarness({ name: "conversation-scroll", port: 1503, html })
})

test.afterAll(async () => {
  await harness?.close()
})

test("upward scrolling stays unlocked when nearby content shrinks", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(700)
  const initialPosition = await viewport.evaluate(element => element.scrollTop)
  await viewport.hover()
  await page.mouse.wheel(0, -50)
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeLessThan(initialPosition - 10)
  const readingPosition = await viewport.evaluate(element => element.scrollTop)
  await page.evaluate(() => window.dispatchEvent(new Event("shrink-tail")))
  await page.waitForTimeout(100)
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(readingPosition)

  await page.mouse.wheel(0, 100)
  await expect
    .poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
  await page.waitForTimeout(50)
  await page.evaluate(() => window.dispatchEvent(new Event("grow-tail")))
  await expect
    .poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
})

test("content growth still follows the bottom until the reader scrolls up", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(700)
  await page.evaluate(() => window.dispatchEvent(new Event("grow-tail")))
  await expect
    .poll(() => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop))
    .toBeLessThanOrEqual(1)
})
