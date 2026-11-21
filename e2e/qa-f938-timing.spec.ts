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
import { createApp, h, ref, nextTick } from 'vue'
import { Conversation, ConversationScrollButton } from '/src/components/ai-elements/conversation'
import VirtualMessage from '/src/components/VirtualMessage.vue'
import { pinToBottom } from '/src/lib/bottomPin'
import { ScrollArea } from '/src/components/ui/scroll-area'
import '/src/style.css'
const compensation = location.search.includes('compensation')
const above = ref(compensation ? 600 : 1200)
const tail = ref(compensation ? 650 : 300)
createApp({
  render: () => h('div', { style: { height: '400px', width: '700px', display: 'flex' } },
    h(Conversation, { ref: c => { window.__conversation = c }, initial: 'instant', resize: 'instant' }, {
      default: () => [
        ... (location.search.includes('nested') ? [h(ScrollArea, { type: 'always', style: 'position:absolute;height:100px;width:100px' }, { default: () => h('div', { style: 'height:300px' }, 'nested') })] : []),
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
window.__compensate = async () => {
  above.value += 260
  tail.value -= 220
  await nextTick()
  const v = document.querySelector('[role=log]')
  return { top: v.scrollTop, gap: v.scrollHeight - v.clientHeight - v.scrollTop }
}
window.__pinToBottom = () => {
  const viewport = document.querySelector('[role=log]')
  pinToBottom(viewport, true, false)
}
</script></body></html>`

let harness: VueHarness | null = null
test.beforeAll(async () => {
  harness = await startVueHarness({ name: "qa-f938-timing", port: 1559, html })
})
test.afterAll(async () => {
  await harness?.close()
})
test.use({ viewport: { width: 900, height: 460 } })

const viewportOf = (page: import("@playwright/test").Page) => page.getByRole("log", { name: "Conversation" })
const gap = (page: import("@playwright/test").Page) =>
  viewportOf(page).evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)
const readUp = async (page: import("@playwright/test").Page, scenario = "") => {
  await page.goto(harness!.url + scenario)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  await viewportOf(page).hover()
  await page.mouse.wheel(0, -200)
  await expect.poll(() => gap(page)).toBe(200)
}
const grow = async (page: import("@playwright/test").Page, label: string) => {
  const atArrival = await gap(page)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  await page.waitForTimeout(160)
  await page.evaluate(() => (window as any).__growTail(40))
  await page.waitForTimeout(250)
  const after = await gap(page)
  console.log(`${label}: arrival=${atArrival}, after +40=${after}`)
  return after
}
test("QA overlap: a non-scrolling Space keyboard event must not launder real compensation", async ({ page }) => {
  await readUp(page, "?compensation")
  await viewportOf(page).evaluate(v => {
    const button = document.createElement("button")
    button.innerText = "Inline action"
    button.style.cssText = "position:fixed;left:10px;top:10px;"
    v.append(button)
    button.focus({ preventScroll: true })
    const descriptor = Object.getOwnPropertyDescriptor(v, "scrollTop")!
    const trace: any[] = []
    ;(window as any).__trace = trace
    let started = 0
    Object.defineProperty(v, "scrollTop", {
      ...descriptor,
      set: (value: number) => {
        if (started)
          trace.push({
            ms: Math.round(performance.now() - started),
            value,
            fromMeasure: new Error().stack?.includes("at ResizeObserver.measure"),
          })
        descriptor.set!.call(v, value)
      },
    })
    button.addEventListener(
      "keydown",
      () => {
        started = performance.now()
        void (window as any).__compensate().then((before: any) => trace.push({ before }))
      },
      { once: true },
    )
  })
  await page.keyboard.press("Space")
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  console.log("fresh Space + real virtual row", await page.evaluate(() => (window as any).__trace))
  expect(await grow(page, "fresh Space + real virtual row")).toBeGreaterThanOrEqual(40)
})
test("QA control: actual smooth message navigation does not resume", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await page.evaluate(() => (window as any).__conversation.scrollToMessage(1))
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  expect(await grow(page, "smooth nav control")).toBe(40)
})

test("QA actual smooth nav survives a no-scroll Space interaction", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(v => {
    const button = document.createElement("button")
    button.innerText = "Inline action"
    button.style.cssText = "position:fixed;left:10px;top:10px;"
    button.onclick = () => {
      ;(window as any).__inlineActivated = true
    }
    v.append(button)
    button.focus({ preventScroll: true })
  })
  // Arm a trusted keyboard action before the smooth navigation starts, then
  // let its first intermediate frame notify the driver to issue the action.
  await viewportOf(page).evaluate(v => {
    v.addEventListener(
      "scroll",
      () => {
        ;(window as any).__navInterimGap = v.scrollHeight - v.clientHeight - v.scrollTop
      },
      { once: true },
    )
    void (window as any).__conversation.scrollToMessage(1)
  })
  await page.waitForFunction(() => (window as any).__navInterimGap > 1, undefined, { timeout: 2000 })
  await page.keyboard.press("Space")
  expect(await page.evaluate(() => (window as any).__inlineActivated)).toBe(true)
  console.log(
    "smooth navigation before Space, sampled active gap",
    await page.evaluate(() => (window as any).__navInterimGap),
  )
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  expect(await grow(page, "smooth nav + no-scroll Space")).toBe(40)
})

test("QA smooth app navigation under one 330ms busy frame does not resume", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(async v => {
    const frames: Array<{ ms: number; gap: number }> = []
    ;(window as any).__slowNavFrames = frames
    const start = performance.now()
    v.addEventListener("scroll", () =>
      frames.push({ ms: Math.round(performance.now() - start), gap: v.scrollHeight - v.clientHeight - v.scrollTop }),
    )
    await (window as any).__conversation.scrollToMessage(1)
    const until = performance.now() + 330
    while (performance.now() < until) {
      /* simulate synchronous layout/JS load */
    }
  })
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  console.log("slow navigation event samples", await page.evaluate(() => (window as any).__slowNavFrames))
  expect(await grow(page, "smooth nav + 330ms busy frame")).toBe(40)
})
