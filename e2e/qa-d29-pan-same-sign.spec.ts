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
  harness = await startVueHarness({ name: "qa-d29-pan-same-sign", port: 1584, html })
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
test("native ancestor pan with small vertical component does not claim the conversation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  const viewport = viewportOf(page)
  await viewport.evaluate(async v => {
    const mod = "/src/lib/scrollWrites.ts"
    const { hasAppScroll, appScrollHasMoved } = await import(mod)
    const w = window as any
    const app = document.getElementById("app")!
    const pane = document.createElement("div")
    pane.id = "qa-ancestor-pane"
    pane.style.cssText =
      "position:fixed;inset:0 auto auto 0;width:700px;height:410px;overflow-x:auto;overflow-y:hidden;touch-action:pan-x;overscroll-behavior:contain"
    const strip = document.createElement("div")
    strip.style.width = "1200px"
    document.body.append(pane)
    pane.append(strip)
    strip.append(app)
    w.__trace = []
    for (const type of ["pointerdown", "pointermove", "pointercancel", "scroll"])
      v.addEventListener(type, e => {
        const p = e as PointerEvent
        w.__trace.push({
          type,
          trusted: e.isTrusted,
          x: p.clientX,
          y: p.clientY,
          movementY: p.movementY,
          mark: hasAppScroll(v),
          moved: appScrollHasMoved(v),
          gap: v.scrollHeight - v.clientHeight - v.scrollTop,
        })
      })
    v.addEventListener(
      "scroll",
      () => {
        w.__firstGap = v.scrollHeight - v.clientHeight - v.scrollTop
      },
      { once: true },
    )
  })
  const cdp = await page.context().newCDPSession(page)
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  await viewport.evaluate(() => {
    void (window as any).__conversation.scrollToMessage(1)
  })
  await page.waitForFunction(() => (window as any).__firstGap > 1)
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 430, y: 230 }] })
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 423, y: 224 }] })
  for (const x of [390, 350, 310, 270])
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: 224 }] })
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  const trace = await page.evaluate(() => (window as any).__trace as any[])
  const left = await page.locator("#qa-ancestor-pane").evaluate(v => v.scrollLeft)
  const after = await grow(page, "native ancestor horizontal pan")
  console.log({ left, after, trace: trace.slice(0, 14) })
  // The ancestor pans horizontally; the conversation must never be claimed, so
  // following stays released (40px, not 0). Whether the app mark is still pending
  // when the browser cancels depends on whether the cancelled animation already
  // reported `scrollend` — both are legitimate, the outcome is what matters.
  expect(left).toBeGreaterThan(0)
  expect(trace.find(e => e.type === "pointermove")).toMatchObject({ trusted: true, movementY: -6 })
  expect(trace.find(e => e.type === "pointercancel")).toMatchObject({ trusted: true, mark: true })
  expect(after).toBe(40)
})
