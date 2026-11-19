import { test, expect, type Page } from "@playwright/test"
import { startVueHarness, type VueHarness } from "./helpers/vue-harness"

/**
 * TZD-135 regression: only the reader's own input may re-enable bottom following.
 *
 * The conversation viewport is moved by code too: bottom pinning while a reply
 * streams, virtual-row height compensation, `scrollToMessage` navigation and the
 * storage library's own clamps. Reading such a write as a downward gesture
 * re-armed following, so every later streaming chunk pinned the panel to the
 * bottom and the reader could never stay scrolled up.
 *
 * Each scenario is checked in both directions: app movement must never re-arm,
 * and the reader's own wheel/drag/key — including a wheel over the scrollbar
 * track, a drag with a nested scrollbar mounted, and a keystroke that does not
 * scroll the viewport — must keep the attribution honest.
 */
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h, ref, nextTick } from 'vue'
import { Conversation, ConversationScrollButton } from '/src/components/ai-elements/conversation'
import VirtualMessage from '/src/components/VirtualMessage.vue'
import { ScrollArea } from '/src/components/ui/scroll-area'
import { pinToBottom } from '/src/lib/bottomPin'
import '/src/style.css'
const query = location.search
// The compensation scenario stages a row above the reader (600px, its old end
// above the viewport top) and a tail that can shrink in the same Vue update.
const compensation = query.includes('compensation')
const above = ref(compensation ? 600 : 1200)
const tail = ref(compensation ? 650 : 300)
createApp({
  render: () => h('div', { style: { height: '400px', width: '700px', display: 'flex' } },
    h(Conversation, { ref: element => { window.__conversation = element }, initial: 'instant', resize: 'instant' }, {
      default: () => [
        ...(query.includes('nested')
          ? [h(ScrollArea, { type: 'always', style: 'position:absolute;height:100px;width:100px' }, {
              default: () => h('div', { style: 'height:300px' }, 'nested scroller'),
            })]
          : []),
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
const viewport = /** @type {HTMLElement} */ (document.querySelector('[role=log]'))
// Every scroll event the viewport dispatches, so a test can wait for the one a
// programmatic write causes instead of guessing with a timeout.
window.__scrollTicks = 0
viewport.addEventListener('scroll', () => { window.__scrollTicks += 1 })
window.__growTail = by => { tail.value += by }
// A streamed chunk that grows the row above the reader and shrinks the tail in
// one Vue update, so the compensation write is clamped onto the bottom.
window.__compensate = async () => {
  above.value += 260
  tail.value -= 220
  await nextTick()
  return { top: viewport.scrollTop, gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop }
}
// The production pin, called the way the streaming path calls it.
window.__pinToBottom = () => pinToBottom(viewport, true, false)
/** Append an inline control inside the panel for keystroke scenarios. */
window.__mountInlineButton = onActivate => {
  const button = document.createElement('button')
  button.textContent = 'Inline action'
  button.style.cssText = 'position:fixed;left:10px;top:10px;'
  button.onclick = onActivate
  viewport.append(button)
  button.focus({ preventScroll: true })
  return button
}
/** Run a synchronous busy loop to delay the next frame. */
window.__busy = ms => { const until = performance.now() + ms; while (performance.now() < until) { /* block */ } }
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "conversation-scroll-follow", port: 1534, html })
})
test.afterAll(async () => {
  await harness?.close()
})
test.use({ viewport: { width: 900, height: 460 } })

const viewportOf = (page: Page) => page.getByRole("log", { name: "Conversation" })
const gapOf = (page: Page) =>
  viewportOf(page).evaluate(element => element.scrollHeight - element.clientHeight - element.scrollTop)
const rail = (page: Page) => viewportOf(page).locator("..").locator(':scope > [data-slot="scroll-area-scrollbar"]')
const thumbCentre = async (page: Page) => {
  const thumb = rail(page).locator('[data-slot="scroll-area-thumb"]')
  await expect(thumb).toBeVisible()
  const box = (await thumb.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}
/** Open at the bottom, then read 200px up so following is released. */
async function readUp(page: Page, scenario = "") {
  await page.goto(harness!.url + scenario)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  await viewportOf(page).hover()
  await page.mouse.wheel(0, -200)
  await expect.poll(() => gapOf(page)).toBe(200)
}
/**
 * Wait until the viewport has dispatched another scroll event. A virtual-row
 * compensation landing on the bottom only stops mattering once its own scroll
 * event has been handled — pushing the next chunk before that would test a state
 * the browser has not reached yet.
 */
async function settleScroll(page: Page) {
  const ticks = await page.evaluate(() => (window as any).__scrollTicks)
  await page.waitForFunction(before => (window as any).__scrollTicks > before, ticks, { timeout: 2000 })
}
/**
 * Stream one more chunk and report the gap afterwards. A gap of 0 means the panel
 * glued itself to the bottom again; anything growing means following stayed off.
 */
async function streamChunk(page: Page, by = 40) {
  await settleScroll(page).catch(() => {})
  await page.evaluate(size => (window as any).__growTail(size), by)
  await page.waitForTimeout(220)
  return gapOf(page)
}

test("virtual-row compensation really lands on the bottom, then must not re-arm following", async ({ page }) => {
  await readUp(page, "?compensation")
  const before = await page.evaluate(() => (window as any).__compensate())
  // Reverse assertion: the remaining distance (240px) is smaller than the row
  // growth (260px), so the compensation write must be clamped onto the bottom.
  expect(before.gap).toBeGreaterThan(200)
  await settleScroll(page)
  expect(await gapOf(page)).toBeLessThanOrEqual(1)
  // Everything below the reader streams on; none of it may pull the reader down.
  for (let chunk = 1; chunk <= 4; chunk++) {
    expect(await streamChunk(page)).toBeGreaterThanOrEqual(40 * chunk)
  }
})

test("virtual-row compensation landing on the bottom does not re-arm following", async ({ page }) => {
  await readUp(page, "?compensation")
  const readingTop = await viewportOf(page).evaluate(element => Math.round(element.scrollTop))
  await page.evaluate(() => (window as any).__compensate())
  await settleScroll(page)
  expect(await gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
  expect(await viewportOf(page).evaluate(element => Math.round(element.scrollTop))).toBeGreaterThanOrEqual(
    readingTop - 1,
  )
})

test("an app-side pin to the bottom does not re-arm following", async ({ page }) => {
  await readUp(page)
  await page.evaluate(() => (window as any).__pinToBottom())
  await settleScroll(page).catch(() => {})
  expect(await gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("scrollToMessage clamped onto the bottom does not re-arm following", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await readUp(page)
  await page.evaluate(() => (window as any).__conversation.scrollToMessage(1))
  await settleScroll(page).catch(() => {})
  expect(await gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("compensation while the reader holds the thumb still does not re-arm following", async ({ page }) => {
  await readUp(page, "?compensation")
  const point = await thumbCentre(page)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.waitForTimeout(100)
  expect(await gapOf(page)).toBeGreaterThan(100)
  await page.evaluate(() => (window as any).__compensate())
  await settleScroll(page)
  expect(await gapOf(page)).toBeLessThanOrEqual(1)
  await page.waitForTimeout(120)
  await page.mouse.up()
  // The thumb never moved, so the compensation was still the app's movement.
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("a non-scrolling Space keystroke does not launder same-frame compensation", async ({ page }) => {
  await readUp(page, "?compensation")
  // Space activates the focused control instead of scrolling the viewport; it
  // must not open a reader exemption for the layout write that follows.
  await viewportOf(page).evaluate(() => {
    const button = (window as any).__mountInlineButton(() => {
      ;(window as any).__inlineActivated = true
    })
    button.addEventListener("keydown", () => void (window as any).__compensate(), { once: true })
  })
  await page.keyboard.press("Space")
  expect(await page.evaluate(() => (window as any).__inlineActivated)).toBe(true)
  await settleScroll(page)
  expect(await gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("a reader's own wheel back to the bottom still re-arms following", async ({ page }) => {
  await readUp(page)
  await viewportOf(page).hover()
  await page.mouse.wheel(0, 400)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})

test("a wheel over the scrollbar track still re-arms following", async ({ page }) => {
  await readUp(page)
  // Reka handles a wheel over the track with a document-level listener that
  // writes viewport.scrollTop; the viewport's own handler never sees it.
  const point = await thumbCentre(page)
  await page.mouse.move(point.x, point.y)
  expect(
    await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-slot="scroll-area-scrollbar"]'),
      point,
    ),
  ).toBe(true)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})

test("a scrollbar drag back to the bottom still re-arms following", async ({ page }) => {
  await readUp(page)
  const point = await thumbCentre(page)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x, point.y + 400, { steps: 6 })
  await page.mouse.up()
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})

test("an outer scrollbar drag still re-arms following with a nested scrollbar mounted", async ({ page }) => {
  await readUp(page, "?nested")
  await expect(page.locator('[data-slot="scroll-area-scrollbar"]')).toHaveCount(2)
  const point = await thumbCentre(page)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.mouse.move(point.x, point.y + 90, { steps: 5 })
  await page.mouse.up()
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})

test("a smooth scrollToMessage does not re-arm following", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await page.evaluate(() => (window as any).__conversation.scrollToMessage(1))
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a smooth scrollToMessage survives a non-scrolling Space keystroke", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(() => {
    ;(window as any).__mountInlineButton(() => {
      ;(window as any).__inlineActivated = true
    })
    // Trigger the keystroke from the animation's first intermediate frame, so the
    // interaction really overlaps the app's movement.
    document.querySelector<HTMLElement>("[role=log]")!.addEventListener(
      "scroll",
      event => {
        const viewport = event.currentTarget as HTMLElement
        ;(window as any).__navInterimGap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      },
      { once: true },
    )
    void (window as any).__conversation.scrollToMessage(1)
  })
  await page.waitForFunction(() => (window as any).__navInterimGap > 1, undefined, { timeout: 2000 })
  await page.keyboard.press("Space")
  expect(await page.evaluate(() => (window as any).__inlineActivated)).toBe(true)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a smooth scrollToMessage under one busy frame does not re-arm following", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  // A frame delayed by hundreds of milliseconds must not end the app
  // attribution: there is no timeout-based release any more.
  await viewportOf(page).evaluate(async () => {
    const started = performance.now()
    void (window as any).__conversation.scrollToMessage(1)
    ;(window as any).__busy(330)
    ;(window as any).__firstFrameDelay = Math.round(performance.now() - started)
  })
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})
