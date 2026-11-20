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
  harness = await startVueHarness({ name: "qa-d29-reversal-multiframe", port: 1591, html })
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
const appMark = (page: import("@playwright/test").Page) =>
  viewportOf(page).evaluate(async v => {
    const path = "/src/lib/scrollWrites.ts"
    return (await import(path)).hasAppScroll(v)
  })

async function startThenCancel(page: import("@playwright/test").Page, hideEnd: boolean) {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await page.waitForTimeout(220)
  const sameTop = await viewportOf(page).evaluate(async (v, simulatedMissingEnd) => {
    const events = { scroll: 0, end: 0, hiddenEnd: 0 }
    ;(window as any).__cancellationEvents = events
    v.addEventListener("scroll", () => events.scroll++)
    v.addEventListener("scrollend", () => events.end++)
    if (simulatedMissingEnd) {
      // Model the disclosed missing-scrollend platform only for cancellation.
      const intercept = (e: Event) => {
        if (e.target === v) {
          events.hiddenEnd++
          e.stopImmediatePropagation()
        }
      }
      ;(window as any).__removeEndInterceptor = () => window.removeEventListener("scrollend", intercept, true)
      window.addEventListener("scrollend", intercept, { capture: true, once: true })
    }
    const before = v.scrollTop
    await (window as any).__conversation.scrollToMessage(0)
    v.scrollTo({ top: before, behavior: "instant" })
    return v.scrollTop === before
  }, hideEnd)
  expect(sameTop).toBe(true)
  await page.waitForTimeout(1700)
  const events = await page.evaluate(() => (window as any).__cancellationEvents)
  const mark = await appMark(page)
  console.log("silent-cancellation simulation", { hideEnd, events, mark })
  expect(events).toMatchObject({ scroll: 0, end: 0 })
  await page.evaluate(() => (window as any).__removeEndInterceptor())
  expect(mark).toBe(hideEnd)
}

for (const pending of [true, false]) {
  test(`native touch reversal after pointercancel restores following, residual mark=${pending}`, async ({ page }) => {
    if (pending) await startThenCancel(page, true)
    else await readUp(page)
    const viewport = viewportOf(page)
    await viewport.evaluate(async v => {
      const path = "/src/lib/scrollWrites.ts"
      const { hasAppScroll, appScrollHasMoved } = await import(path)
      const w = window as any
      w.__trace = []
      for (const type of ["pointerdown", "pointermove", "pointercancel", "pointerup", "scroll", "scrollend"])
        v.addEventListener(type, e => {
          w.__trace.push({
            type,
            trusted: e.isTrusted,
            movementY: (e as PointerEvent).movementY,
            mark: hasAppScroll(v),
            moved: appScrollHasMoved(v),
            gap: v.scrollHeight - v.clientHeight - v.scrollTop,
          })
        })
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 300, y: 270 }] })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300, y: 281 }] })
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300, y: 286 }] })
    await expect.poll(() => gap(page)).toBe(201)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300, y: 130 }] })
    await expect.poll(() => gap(page)).toBe(45)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 300, y: 35 }] })
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    const trace = await page.evaluate(() => (window as any).__trace as any[])
    const after = await grow(page, "single native touch scroll with residual=" + pending)
    console.log({ pending, after, trace })
    const cancel = trace.findIndex(r => r.type === "pointercancel")
    expect(trace[cancel]).toMatchObject({ trusted: true, gap: 200, mark: pending })
    expect(
      trace
        .slice(0, cancel)
        .filter(r => r.type === "pointermove")
        .reverse()[0],
    ).toMatchObject({ trusted: true, movementY: 5 })
    expect(trace.slice(cancel + 1).filter(r => r.type === "pointermove")).toEqual([])
    expect(trace.filter(r => r.type === "scroll").map(r => r.gap)).toEqual([201, 45, 0])
    expect(after).toBeLessThanOrEqual(1)
  })
}
