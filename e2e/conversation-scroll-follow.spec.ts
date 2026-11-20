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
import { hasAppScroll } from '/src/lib/scrollWrites'
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
/** Whether an app-initiated navigation is still waiting for its arrival. */
window.__appMark = () => hasAppScroll(viewport)
/**
 * An independently scrollable, focusable block inside the conversation: a key
 * pressed inside it must not be read as the reader taking over the conversation.
 */
window.__mountNestedScroller = () => {
  const nested = document.createElement('div')
  nested.tabIndex = 0
  nested.id = 'inline-scroller'
  nested.style.cssText = 'position:fixed;top:10px;left:10px;width:100px;height:60px;overflow-y:scroll;overscroll-behavior:contain;'
  const child = document.createElement('div')
  child.style.height = '600px'
  nested.append(child)
  viewport.append(nested)
  nested.focus({ preventScroll: true })
  return nested
}
/** Block synchronously right after a handler started, to postpone the render step. */
window.__blockFor = ms => { const until = performance.now() + ms; while (performance.now() < until) { /* block */ } }
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
 * Stream one more chunk and report the gap afterwards. A gap of 0 means the panel
 * glued itself to the bottom again; anything growing means following stayed off.
 */
async function streamChunk(page: Page, by = 40) {
  await page.evaluate(size => (window as any).__growTail(size), by)
  await page.waitForTimeout(220)
  return gapOf(page)
}

test("virtual-row compensation really lands on the bottom, then must not re-arm following", async ({ page }) => {
  await readUp(page, "?compensation")
  // Arm the arrival listener *before* the Vue update, so the scroll event that
  // lands on the bottom cannot be missed by a late read.
  const before = await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>("[role=log]")!
    const w = window as unknown as { __arrival?: number | null }
    w.__arrival = null
    viewport.addEventListener("scroll", () => {
      const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      if (gap <= 1) w.__arrival = gap
    })
    return (window as any).__compensate()
  })
  // Reverse assertion: the remaining distance (240px) is smaller than the row
  // growth (260px), so the compensation write must be clamped onto the bottom.
  expect(before.gap).toBeGreaterThan(200)
  // Wait for the arrival event itself before streaming: pushing the next chunk
  // while the compensation is still settling would test a half-applied layout.
  await expect.poll(() => page.evaluate(() => (window as any).__arrival as number | null)).toBeLessThanOrEqual(1)
  // Everything below the reader streams on; none of it may pull the reader down.
  for (let chunk = 1; chunk <= 4; chunk++) {
    expect(await streamChunk(page)).toBeGreaterThanOrEqual(40 * chunk)
  }
})

test("virtual-row compensation landing on the bottom does not re-arm following", async ({ page }) => {
  await readUp(page, "?compensation")
  const readingTop = await viewportOf(page).evaluate(element => Math.round(element.scrollTop))
  await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>("[role=log]")!
    const w = window as unknown as { __arrival?: number | null }
    w.__arrival = null
    viewport.addEventListener("scroll", () => {
      const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      if (gap <= 1) w.__arrival = gap
    })
    await (window as any).__compensate()
  })
  await expect.poll(() => page.evaluate(() => (window as any).__arrival as number | null)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
  expect(await viewportOf(page).evaluate(element => Math.round(element.scrollTop))).toBeGreaterThanOrEqual(
    readingTop - 1,
  )
})

test("an app-side pin to the bottom does not re-arm following", async ({ page }) => {
  await readUp(page)
  await page.evaluate(() => (window as any).__pinToBottom())
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("scrollToMessage clamped onto the bottom does not re-arm following", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await readUp(page)
  await page.evaluate(() => (window as any).__conversation.scrollToMessage(1))
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("compensation while the reader holds the thumb still does not re-arm following", async ({ page }) => {
  await readUp(page, "?compensation")
  const point = await thumbCentre(page)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await page.waitForTimeout(100)
  expect(await gapOf(page)).toBeGreaterThan(100)
  await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>("[role=log]")!
    const w = window as unknown as { __arrival?: number | null }
    w.__arrival = null
    viewport.addEventListener("scroll", () => {
      const gap = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop
      if (gap <= 1) w.__arrival = gap
    })
    await (window as any).__compensate()
  })
  await expect.poll(() => page.evaluate(() => (window as any).__arrival)).toBeLessThanOrEqual(1)
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
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
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
  // The official timing: start the browser animation (`await`), then block the
  // same task for 330ms so its first frame is delayed by that much. A frame
  // delayed by hundreds of milliseconds must not end the app attribution: there
  // is no timeout-based release any more.
  await page.evaluate(async () => {
    const started = performance.now()
    const frames: { ms: number; gap: number }[] = []
    ;(window as any).__slowNavFrames = frames
    const viewport = document.querySelector<HTMLElement>("[role=log]")!
    viewport.addEventListener("scroll", () => {
      frames.push({
        ms: Math.round(performance.now() - started),
        gap: viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop,
      })
    })
    await (window as any).__conversation.scrollToMessage(1)
    ;(window as any).__busy(330)
  })
  // The first animation frame arrives after the block ended, which is exactly the
  // sequence a timeout-based release would misattribute.
  await page.waitForFunction(() => ((window as any).__slowNavFrames as any[])?.length > 0, undefined, { timeout: 3000 })
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a render-phase compensation after a real thumb press stays app-owned", async ({ page }) => {
  await readUp(page, "?compensation")
  // Instrument the viewport's own setter and start a real VirtualMessage update
  // from the scrollbar's pointerdown handler, then keep that task busy for ~34ms
  // so the rendering step (ResizeObserver) lands in a later task.
  await viewportOf(page).evaluate(viewport => {
    const w = window as unknown as Record<string, any>
    const descriptor = Object.getOwnPropertyDescriptor(viewport, "scrollTop")!
    w.__setterTrace = []
    let started = 0
    Object.defineProperty(viewport, "scrollTop", {
      ...descriptor,
      set(value: number) {
        if (started) w.__setterTrace.push({ ms: Math.round(performance.now() - started), value })
        descriptor.set!.call(viewport, value)
      },
    })
    const scrollbar = viewport.parentElement!.querySelector('[data-slot="scroll-area-scrollbar"]')!
    scrollbar.addEventListener(
      "pointerdown",
      () => {
        started = performance.now()
        void (window as any).__compensate()
        w.__blockFor(34)
      },
      { once: true },
    )
  })
  const point = await thumbCentre(page)
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  await page.waitForTimeout(150)
  await page.mouse.up()
  // The compensation was the app's: following must stay released.
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("ArrowDown inside a nested scroller does not end an outer smooth navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(() => {
    ;(window as any).__mountNestedScroller()
    // Start the outer navigation; the keystroke is pressed once it is moving.
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
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  await page.keyboard.press("ArrowDown")
  // The nested region scrolled, the outer app navigation did not end.
  await expect.poll(() => page.locator("#inline-scroller").evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a navigation already at its target leaves no attribution behind", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  // Move to a position first, then ask the app to navigate exactly there: the
  // browser fires neither `scroll` nor `scrollend`, so no mark may be left.
  await readUp(page, "?compensation")
  await viewportOf(page).hover()
  await page.mouse.wheel(0, -74)
  await page.waitForTimeout(240)
  const atTarget = await viewportOf(page).evaluate(viewport => Math.round(viewport.scrollTop))
  const events = await viewportOf(page).evaluate(async (viewport, target) => {
    const state = { scroll: 0, end: 0 }
    viewport.addEventListener("scroll", () => (state.scroll += 1))
    viewport.addEventListener("scrollend", () => (state.end += 1))
    void target
    await (window as any).__conversation.scrollToMessage(1)
    return state
  }, atTarget)
  await page.waitForTimeout(1700)
  const finalEvents = await page.evaluate(() => (window as any).__noOpEvents ?? null)
  void finalEvents
  expect(await viewportOf(page).evaluate(viewport => Math.round(viewport.scrollTop))).toBe(atTarget)
  expect(events).toEqual({ scroll: 0, end: 0 })
  // No mark may survive a no-op navigation: the reader's next gesture must still
  // be recognized, i.e. a wheel back to the bottom re-arms following.
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(false)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})

test("a pending navigation does not swallow the reader's next gesture", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  // Navigate to the live tail: the app movement clamps onto the bottom, its mark
  // is consumed by the arrival, and nothing may linger afterwards.
  await page.evaluate(() => (window as any).__conversation.scrollToMessage(1))
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(false)
  // Whatever the reader does next — here a wheel back to the bottom — must be
  // recognized as the reader, not attributed to the finished navigation.
  await page.mouse.wheel(0, -200)
  await expect.poll(() => gapOf(page)).toBe(200)
  await page.mouse.wheel(0, 400)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})

test("a stationary touch does not claim a running app navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(() => {
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
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  // A press that never moves must leave the app's animation alone.
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  const box = (await viewportOf(page).boundingBox())!
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + 200 }],
  })
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(false)
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  expect(await streamChunk(page)).toBe(40)
})

test("a real touch takes over even when pointercancel precedes the first scroll", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).hover()
  // Simulate the platform that misses the cancellation's `scrollend`, so a mark is
  // still pending when the gesture arrives.
  await viewportOf(page).evaluate(async viewport => {
    const events = { scroll: 0, end: 0, hiddenEnd: 0 }
    ;(window as any).__cancellationEvents = events
    viewport.addEventListener("scroll", () => (events.scroll += 1))
    viewport.addEventListener("scrollend", () => (events.end += 1))
    window.addEventListener(
      "scrollend",
      event => {
        if (event.target !== viewport) return
        events.hiddenEnd += 1
        event.stopImmediatePropagation()
      },
      { capture: true, once: true },
    )
    const before = viewport.scrollTop
    await (window as any).__conversation.scrollToMessage(0)
    viewport.scrollTo({ top: before, behavior: "instant" })
    ;(window as any).__markPending = true
  })
  // The mark survives the cancelled navigation.
  expect(await page.evaluate(() => (window as any).__markPending)).toBe(true)
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  const box = (await viewportOf(page).boundingBox())!
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height - 60 }],
  })
  for (const step of [40, 80, 120, 160, 200, 240]) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height - 60 - step }],
    })
  }
  // Chromium takes the touch over for scrolling here and stops delivering moves.
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(false)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})

test("ArrowDown that only moves a caret does not claim the outer navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(() => {
    // A textarea mirrors the inline history-prompt editor inside the list.
    const editor = document.createElement("textarea")
    editor.id = "inline-prompt-editor"
    editor.style.cssText = "position:fixed;left:10px;top:10px;height:90px;width:160px"
    editor.value = "line one\nline two"
    document.querySelector<HTMLElement>("[role=log]")!.append(editor)
    editor.focus({ preventScroll: true })
    editor.setSelectionRange(0, 0)
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
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  await page.keyboard.press("ArrowDown")
  // The caret moved inside the editor; the outer navigation still owns the view.
  const caret = await page.locator("#inline-prompt-editor").evaluate(el => (el as HTMLTextAreaElement).selectionStart)
  expect(caret).toBeGreaterThan(0)
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a stopped input propagation still closes the reader exemption", async ({ page }) => {
  await readUp(page, "?compensation")
  // A listener that stops a real wheel's propagation: the bubble closer never
  // runs, and a leaked exemption would swallow the next app write.
  await viewportOf(page).evaluate(viewport => {
    viewport.addEventListener(
      "wheel",
      event => {
        event.preventDefault()
        event.stopPropagation()
      },
      { once: true, passive: false },
    )
  })
  await viewportOf(page).hover()
  await page.mouse.wheel(0, 50)
  await page.waitForTimeout(120)
  expect(await gapOf(page)).toBe(200)
  await page.mouse.wheel(0, 15)
  await expect.poll(() => gapOf(page)).toBe(185)
  await page.evaluate(async () => {
    const viewport = document.querySelector<HTMLElement>("[role=log]")!
    const w = window as unknown as { __arrival?: boolean }
    w.__arrival = false
    viewport.addEventListener("scroll", () => {
      if (viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop > 1) return
      w.__arrival = true
    })
    await (window as any).__compensate()
  })
  await page.waitForFunction(() => (window as any).__arrival === true, undefined, { timeout: 2000 })
  expect(await streamChunk(page)).toBeGreaterThanOrEqual(40)
})

test("a sideways touch swipe does not take over the app navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(() => {
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
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  const box = (await viewportOf(page).boundingBox())!
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
  })
  // Horizontal only: a sideways swipe is not scrolling the conversation.
  await client.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: box.x + box.width / 2 + 6, y: box.y + box.height / 2 }],
  })
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a cancellation from another pointer does not end the app navigation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(() => {
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
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  // Dragging a pane outside the conversation only scrolls that pane; its
  // cancellation belongs to that gesture, not to the conversation.
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  const box = (await viewportOf(page).boundingBox())!
  const outsideX = box.x + box.width + 40
  await client.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: outsideX, y: box.y + box.height - 80 }],
  })
  for (const step of [40, 80, 120]) {
    await client.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: outsideX, y: box.y + box.height - 80 - step }],
    })
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a touch pan inside a nested scroller does not claim the conversation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  await viewportOf(page).evaluate(() => {
    const pane = document.createElement("div")
    pane.id = "inline-pane"
    pane.style.cssText =
      "position:fixed;left:380px;top:150px;width:220px;height:180px;overflow-y:auto;overscroll-behavior:contain;background:#abc;z-index:5"
    pane.innerHTML = '<div style="height:700px">tall block</div>'
    document.querySelector<HTMLElement>("[role=log]")!.append(pane)
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
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(true)
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  const box = (await page.locator("#inline-pane").boundingBox())!
  const x = box.x + box.width / 2
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: box.y + 150 }] })
  for (const step of [30, 60, 90, 120]) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: box.y + 150 - step }] })
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  // Only the nested block panned; the conversation's app navigation still owns it.
  await expect.poll(() => page.locator("#inline-pane").evaluate(el => el.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await streamChunk(page)).toBe(40)
})

test("a genuine vertical touch drag still claims the conversation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await readUp(page)
  // A real downward drag on the conversation itself: it must reach the bottom and
  // restore following (the positive control for the touch attribution).
  const client = await page.context().newCDPSession(page)
  await client.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
  const box = (await viewportOf(page).boundingBox())!
  const x = box.x + box.width / 2
  // A finger moving up scrolls the content towards the bottom.
  await client.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: box.y + box.height - 60 }] })
  for (const step of [60, 120, 180, 240, 300, 340]) {
    await client.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: box.y + box.height - 60 - step }] })
  }
  await client.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  await expect.poll(() => gapOf(page)).toBeLessThanOrEqual(1)
  expect(await page.evaluate(() => (window as any).__appMark())).toBe(false)
  expect(await streamChunk(page)).toBeLessThanOrEqual(1)
})
