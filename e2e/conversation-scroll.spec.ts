import { test, expect } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref } from 'vue'
import { Conversation, ConversationScrollButton } from '/src/components/ai-elements/conversation'
import '/src/style.css'
const tailHeight = ref(240)
const messages = ref(0)
const viewportHeight = ref(400)
const conversation = ref(null)
const initial = new URLSearchParams(location.search).has('no-initial') ? false : 'instant'
window.addEventListener('reveal-message', () => { conversation.value.scrollToMessage(1) })
window.addEventListener('grow-viewport', () => { viewportHeight.value += 80 })
window.addEventListener('append-message', () => { messages.value += 1 })
window.addEventListener('shrink-tail', () => { tailHeight.value = 200 })
window.addEventListener('grow-tail', () => { tailHeight.value += 50 })
window.addEventListener('set-tail-height', event => { tailHeight.value = event.detail })
createApp({
  render: () => h('div', { style: { width: '600px', height: viewportHeight.value + 'px', display: 'flex' } }, [
    h(Conversation, { ref: conversation, initial, resize: 'instant' }, {
      default: () => [
        h('div', { 'data-message-id': 1, style: 'height:960px;background:linear-gradient(#eee,#999)' }, 'Earlier conversation'),
        h('div', { style: { height: tailHeight.value + 'px', background: '#ddd' } }, 'Streaming response'),
        ...Array.from({ length: messages.value }, (_, index) => h('div', { key: index, style: 'height:120px' }, 'Message ' + index)),
      ],
      overlay: () => h(ConversationScrollButton),
    }),
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
  await page.evaluate(() => window.dispatchEvent(new Event("grow-tail")))
  await page.waitForTimeout(100)
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(readingPosition)

  // Shrinking can leave the reader exactly at the new bottom without moving.
  // A duplicate scroll event must not mistake that resize for downward intent.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("set-tail-height", { detail: 190 })))
  await page.waitForTimeout(100)
  // The library uses max - 1 as its target and may settle one pixel upward.
  const settledPosition = await viewport.evaluate(element => element.scrollTop)
  await viewport.evaluate(element => element.dispatchEvent(new Event("scroll")))
  await page.waitForTimeout(50)
  await viewport.evaluate(element => element.dispatchEvent(new Event("scroll")))
  // One more stationary shrink lets the library relock if the duplicate event
  // incorrectly cleared readingHistory; the following growth must not follow.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("set-tail-height", { detail: 189 })))
  await page.waitForTimeout(100)
  const finalReadingPosition = await viewport.evaluate(element => element.scrollTop)
  expect(finalReadingPosition).toBeGreaterThanOrEqual(settledPosition - 1)
  expect(finalReadingPosition).toBeLessThanOrEqual(settledPosition)
  await page.evaluate(() => window.dispatchEvent(new Event("grow-tail")))
  await page.waitForTimeout(100)
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(finalReadingPosition)

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

test("successive messages and streaming chunks keep following the bottom", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  for (const event of ["append-message", "grow-tail", "grow-tail", "append-message", "grow-tail"]) {
    await page.evaluate(name => window.dispatchEvent(new Event(name)), event)
    await expect.poll(gap).toBeLessThanOrEqual(1)
    // Let the library's resize/scroll notifications settle before the next chunk.
    await page.waitForTimeout(100)
  }
})

test("content shrink and viewport expansion keep following subsequent growth", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  for (const resize of ["shrink-tail", "grow-viewport"]) {
    await page.evaluate(name => window.dispatchEvent(new Event(name)), resize)
    await page.waitForTimeout(100)
    await expect.poll(gap).toBeLessThanOrEqual(1)
    for (const event of ["append-message", "grow-tail", "grow-tail"]) {
      await page.evaluate(name => window.dispatchEvent(new Event(name)), event)
      await expect.poll(gap).toBeLessThanOrEqual(1)
      await page.waitForTimeout(100)
    }
  }
})

test("scroll-to-bottom button restores following for later messages and streaming", async ({ page }, testInfo) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await viewport.hover()
  await page.mouse.wheel(0, -300)
  await expect.poll(gap).toBeGreaterThan(200)
  const readingPosition = await viewport.evaluate(element => element.scrollTop)
  await page.evaluate(() => window.dispatchEvent(new Event("append-message")))
  await page.waitForTimeout(100)
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(readingPosition)
  await testInfo.attach("reading-history-before-scroll-to-bottom", {
    body: await viewport.locator("..").screenshot({ path: "temp/conversation-reading-history.png" }),
    contentType: "image/png",
  })
  await page.getByRole("button", { name: "Scroll to bottom" }).click()
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await page.waitForTimeout(100)
  await page.evaluate(() => window.dispatchEvent(new Event("shrink-tail")))
  await page.waitForTimeout(100)
  for (const event of ["append-message", "grow-tail", "grow-tail"]) {
    await page.evaluate(name => window.dispatchEvent(new Event(name)), event)
    await expect.poll(gap).toBeLessThanOrEqual(1)
    await page.waitForTimeout(100)
  }
  await testInfo.attach("following-after-scroll-to-bottom", {
    body: await viewport.locator("..").screenshot({ path: "temp/conversation-following.png" }),
    contentType: "image/png",
  })
})

test("keyboard reading releases following and End restores it", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await viewport.focus()
  await page.keyboard.press("PageUp")
  await expect.poll(gap).toBeGreaterThan(200)
  // Wait for the browser's smooth keyboard scroll to finish.
  await page.waitForTimeout(300)
  const readingPosition = await viewport.evaluate(element => element.scrollTop)
  await page.evaluate(() => window.dispatchEvent(new Event("grow-tail")))
  await page.waitForTimeout(100)
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(readingPosition)
  await page.keyboard.press("End")
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await page.waitForTimeout(100)
  await page.evaluate(() => window.dispatchEvent(new Event("append-message")))
  await expect.poll(gap).toBeLessThanOrEqual(1)
})

test("dragging the scrollbar upward releases following", async ({ page }) => {
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  const gap = () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await viewport.hover()
  const thumb = page.locator('[data-slot="scroll-area-thumb"]')
  await expect(thumb).toBeVisible()
  const box = (await thumb.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 80, { steps: 5 })
  await page.mouse.up()
  await expect.poll(gap).toBeGreaterThan(100)
  const readingPosition = await viewport.evaluate(element => element.scrollTop)
  for (const event of ["append-message", "grow-tail"]) {
    await page.evaluate(name => window.dispatchEvent(new Event(name)), event)
    await page.waitForTimeout(100)
    expect(await viewport.evaluate(element => element.scrollTop)).toBe(readingPosition)
  }
})

test("message navigation releases following until the reader returns to the bottom", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto(harness!.url)
  const viewport = page.getByRole("log", { name: "Conversation" })
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBeGreaterThan(700)
  await page.evaluate(() => window.dispatchEvent(new Event("reveal-message")))
  await expect.poll(() => viewport.evaluate(element => element.scrollTop)).toBe(0)
  await page.evaluate(() => window.dispatchEvent(new Event("grow-tail")))
  await page.waitForTimeout(100)
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(0)
})

test("initial false waits for an explicit return to bottom before following", async ({ page }) => {
  await page.goto(harness!.url + "?no-initial")
  const viewport = page.getByRole("log", { name: "Conversation" })
  await expect(page.getByRole("button", { name: "Scroll to bottom" })).toBeVisible()
  await page.evaluate(() => window.dispatchEvent(new Event("grow-tail")))
  await page.waitForTimeout(100)
  expect(await viewport.evaluate(element => element.scrollTop)).toBe(0)
  await page.getByRole("button", { name: "Scroll to bottom" }).click()
  const gap = () => viewport.evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
  await expect.poll(gap).toBeLessThanOrEqual(1)
  await page.evaluate(() => window.dispatchEvent(new Event("append-message")))
  await expect.poll(gap).toBeLessThanOrEqual(1)
})
