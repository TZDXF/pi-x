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
  harness = await startVueHarness({ name: "qa-a81-boundaries", port: 1563, html })
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

for (const kind of ["2px horizontal", "3px horizontal", "outside vertical pan"] as const) {
  test(`touch ${kind} must not take over the conversation`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "no-preference" })
    await readUp(page)
    const viewport = viewportOf(page)
    await viewport.evaluate(async v => {
      const path = "/src/lib/scrollWrites.ts"
      const { hasAppScroll } = await import(path)
      const w = window as any
      const sibling = document.createElement("div")
      sibling.id = "qa-independent-touch-pane"
      sibling.style.cssText =
        "position:fixed;left:740px;top:25px;width:140px;height:365px;overflow:auto;overscroll-behavior:contain;background:#bbb"
      sibling.innerHTML = '<div style="height:1000px">Independent pane</div>'
      document.body.append(sibling)
      const trace: any[] = []
      w.__boundaryTrace = trace
      w.__mark = () => hasAppScroll(v)
      for (const type of ["pointerdown", "pointermove", "pointercancel", "pointerup"])
        window.addEventListener(
          type,
          e => {
            const p = e as PointerEvent
            if (p.pointerType !== "touch") return
            trace.push({
              type,
              x: p.clientX,
              y: p.clientY,
              inConversation: v.contains(p.target as Node),
              trusted: p.isTrusted,
              mark: hasAppScroll(v),
            })
          },
          true,
        )
      v.addEventListener("scroll", () => {
        if (w.__firstGap === undefined) w.__firstGap = v.scrollHeight - v.clientHeight - v.scrollTop
      })
    })
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 })
    await viewport.evaluate(() => {
      void (window as any).__conversation.scrollToMessage(1)
    })
    await page.waitForFunction(() => (window as any).__firstGap > 1)
    expect(await appMark(page)).toBe(true)
    const outside = kind === "outside vertical pan"
    const x = outside ? 790 : 300
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: 340 }] })
    if (outside) {
      for (const y of [306, 270, 235, 200])
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] })
    } else {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x + (kind === "2px horizontal" ? 2 : 3), y: 340 }],
      })
    }
    const markAfterMove = await appMark(page)
    // Dragging only the independent pane must have no effect on the ownership here.
    if (outside)
      await expect
        .poll(() => page.locator("#qa-independent-touch-pane").evaluate(el => el.scrollTop))
        .toBeGreaterThan(0)
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    const after = await grow(page, kind)
    const trace = await page.evaluate(() => (window as any).__boundaryTrace)
    const outsideTop = await page.locator("#qa-independent-touch-pane").evaluate(el => el.scrollTop)
    console.log({ kind, markAfterMove, outsideTop, trace, after })
    expect(trace.find((event: any) => event.type === "pointerdown")).toMatchObject({
      mark: true,
      inConversation: !outside,
      trusted: true,
    })
    if (outside)
      expect(trace.find((event: any) => event.type === "pointercancel")).toMatchObject({
        inConversation: false,
        trusted: true,
      })
    else {
      expect(trace.find((event: any) => event.type === "pointermove")).toMatchObject({
        x: x + (kind === "2px horizontal" ? 2 : 3),
        y: 340,
        trusted: true,
      })
      expect(trace.some((event: any) => event.type === "pointercancel")).toBe(false)
    }
    expect(after).toBe(40)
  })
}

// The exemption is opened by the capture listener and closed three idempotent
// ways: the bubble listener of the same event, the next animation frame, and a
// zero-delay task. Here the input's propagation is stopped, so the bubble closer
// never runs. What matters is that a fallback closes it *before* the rendering
// step: otherwise the compensation that same task triggered would be recorded as
// the reader's.
for (const closer of ["both fallbacks", "animation frame only"] as const) {
  test(`stopped wheel: closer=${closer}`, async ({ page }) => {
    await readUp(page, "?compensation")
    const viewport = viewportOf(page)
    await viewport.evaluate(async (v, disableTimer) => {
      const path = "/src/lib/scrollWrites.ts"
      const { isInputDispatch } = await import(path)
      const w = window as any
      const desc = Object.getOwnPropertyDescriptor(v, "scrollTop")!
      const trace: any[] = []
      w.__fallbackTrace = trace
      const originalTimer = window.setTimeout
      const originalRAF = window.requestAnimationFrame
      const wrap = (kind: string, callback: any, schedule: (cb: any) => number) => {
        if (callback?.name !== "close" || !isInputDispatch(v)) return schedule(callback)
        trace.push({ schedule: kind, suppressed: kind === "timer" && disableTimer })
        if (kind === "timer" && disableTimer) return 0
        return schedule((time: number) => {
          trace.push({ run: kind })
          callback(time)
        })
      }
      window.requestAnimationFrame = (callback: FrameRequestCallback) =>
        wrap("raf", callback, cb => originalRAF.call(window, cb))
      window.setTimeout = ((callback: any, delay?: number, ...args: any[]) =>
        delay === 0
          ? wrap("timer", callback, (cb: any) => Number(originalTimer.call(window, cb, delay, ...args)))
          : Number(originalTimer.call(window, callback, delay, ...args))) as unknown as typeof setTimeout
      Object.defineProperty(v, "scrollTop", {
        ...desc,
        set(value: number) {
          trace.push({
            write: value,
            input: isInputDispatch(v),
            measure: (new Error().stack || "").includes("ResizeObserver.measure"),
          })
          desc.set!.call(v, value)
        },
      })
      v.addEventListener(
        "wheel",
        e => {
          e.preventDefault()
          e.stopPropagation()
          window.setTimeout = originalTimer
          window.requestAnimationFrame = originalRAF
          trace.push({ stopped: e.isTrusted, input: isInputDispatch(v) })
          void w.__compensate()
          const until = performance.now() + 34
          while (performance.now() < until) {
            /* simulate other input work before paint */
          }
        },
        { once: true, passive: false },
      )
    }, closer === "animation frame only")
    await viewport.hover()
    await page.mouse.wheel(0, 50)
    await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
    const trace = await page.evaluate(() => (window as any).__fallbackTrace)
    const after = await grow(page, "same-task compensation; closer=" + closer)
    console.log({ closer, trace, after })
    // The compensation performed inside the stopped input task is the app's.
    expect(trace.find((event: any) => event.measure)).toMatchObject({ input: false })
    if (closer === "animation frame only") {
      // With the timer fallback disabled the frame one still closes the scope
      // inside the rendering steps, ahead of the resize observers.
      expect(trace).toContainEqual({ schedule: "timer", suppressed: true })
      expect(trace).toContainEqual({ schedule: "raf", suppressed: false })
      expect(trace).toContainEqual({ run: "raf" })
    }
    expect(after).toBeGreaterThanOrEqual(40)
  })
}

test("a programmatic pin in an earlier RAF remains app owned after a stopped wheel", async ({ page }) => {
  // Register before Conversation mounts, so our app RAF precedes its fallback RAF.
  await page.addInitScript(() => {
    window.addEventListener(
      "wheel",
      () => {
        const w = window as any
        if (w.__queueEarlyPin) requestAnimationFrame(w.__queueEarlyPin)
      },
      { capture: true, passive: true },
    )
  })
  await readUp(page)
  const viewport = viewportOf(page)
  await viewport.evaluate(async v => {
    const path = "/src/lib/scrollWrites.ts"
    const { isInputDispatch } = await import(path)
    const w = window as any
    const trace: any[] = []
    w.__earlyPinTrace = trace
    w.__queueEarlyPin = () => {
      trace.push({ stage: "app RAF", input: isInputDispatch(v) })
      w.__pinToBottom()
    }
    const timer = window.setTimeout
    const raf = window.requestAnimationFrame
    window.requestAnimationFrame = ((cb: TimerHandler) =>
      raf.call(window, (time: number) => {
        if (typeof cb === "function" && cb.name === "close")
          trace.push({ stage: "close RAF", input: isInputDispatch(v) })
        if (typeof cb === "function") cb(time)
      })) as typeof requestAnimationFrame
    window.setTimeout = ((cb: any, delay?: number, ...args: any[]) =>
      timer.call(
        window,
        () => {
          if (typeof cb === "function" && cb.name === "close")
            trace.push({ stage: "close timer", input: isInputDispatch(v) })
          if (typeof cb === "function") cb(...args)
        },
        delay,
      )) as typeof setTimeout
    v.addEventListener(
      "wheel",
      e => {
        e.stopPropagation()
        e.preventDefault()
        window.requestAnimationFrame = raf
        window.setTimeout = timer
        trace.push({ stage: "stopped input", trusted: e.isTrusted, input: isInputDispatch(v) })
        const until = performance.now() + 34
        while (performance.now() < until) {
          /* an input task spanning the next frame */
        }
      },
      { once: true, passive: false },
    )
  })
  await viewport.hover()
  await page.mouse.wheel(0, 40)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  const after = await grow(page, "earlier app RAF and real stopped wheel")
  const trace = await page.evaluate(() => (window as any).__earlyPinTrace)
  console.log({ trace, after })
  expect(trace).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ stage: "close RAF" }),
      expect.objectContaining({ stage: "close timer" }),
    ]),
  )
  expect(after).toBe(40)
})
