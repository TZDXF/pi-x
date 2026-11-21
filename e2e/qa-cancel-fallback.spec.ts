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
  harness = await startVueHarness({ name: "qa-cancel-fallback", port: 1547, html })
})
test.afterAll(async () => {
  await harness?.close()
})
test.use({ viewport: { width: 900, height: 460 } })

const viewportOf = (page: import('@playwright/test').Page) => page.getByRole('log', { name: 'Conversation' })
const gap = (page: import('@playwright/test').Page) => viewportOf(page).evaluate(e => e.scrollHeight - e.clientHeight - e.scrollTop)
const readUp = async (page: import('@playwright/test').Page, scenario = '') => {
  await page.goto(harness!.url + scenario)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  await viewportOf(page).hover()
  await page.mouse.wheel(0, -200)
  await expect.poll(() => gap(page)).toBe(200)
}
const grow = async (page: import('@playwright/test').Page, label: string) => {
  const atArrival = await gap(page)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  await page.waitForTimeout(160)
  await page.evaluate(() => (window as any).__growTail(40))
  await page.waitForTimeout(250)
  const after = await gap(page)
  console.log(`${label}: arrival=${atArrival}, after +40=${after}`)
  return after
}
const appMark = (page: import('@playwright/test').Page) => viewportOf(page).evaluate(async v => {
  const path = '/src/lib/scrollWrites.ts'
  return (await import(path)).hasAppScroll(v)
})


async function startThenCancel(page: import('@playwright/test').Page, hideEnd:boolean) {
  await page.emulateMedia({reducedMotion:'no-preference'})
  await readUp(page)
  await page.waitForTimeout(220)
  const sameTop=await viewportOf(page).evaluate(async (v, simulatedMissingEnd) => {
    const events={scroll:0,end:0,hiddenEnd:0}
    ;(window as any).__cancellationEvents=events
    v.addEventListener('scroll',()=>events.scroll++)
    v.addEventListener('scrollend',()=>events.end++)
    if(simulatedMissingEnd) {
      // Model the disclosed missing-scrollend platform only for cancellation.
      window.addEventListener('scrollend',e=>{
        if(e.target===v){ events.hiddenEnd++; e.stopImmediatePropagation() }
      },{capture:true,once:true})
    }
    const before=v.scrollTop
    await (window as any).__conversation.scrollToMessage(0)
    v.scrollTo({top:before,behavior:'instant'})
    return v.scrollTop===before
  },hideEnd)
  expect(sameTop).toBe(true)
  await page.waitForTimeout(1700)
  const events=await page.evaluate(()=>(window as any).__cancellationEvents)
  const mark=await appMark(page)
  console.log('silent-cancellation simulation', {hideEnd,events,mark})
  expect(events).toEqual({scroll:0,end:hideEnd?0:1,hiddenEnd:hideEnd?1:0})
  expect(mark).toBe(hideEnd)
}

test('QA native scrollend after cancelling clears app attribution',async ({page})=>{
  await startThenCancel(page,false)
})

test('QA simulated missing scrollend leaves a mark but ordinary wheel takes over',async ({page})=>{
  await startThenCancel(page,true)
  await viewportOf(page).hover()
  await page.mouse.wheel(0,500)
  await expect.poll(()=>gap(page)).toBeLessThanOrEqual(1)
  expect(await appMark(page)).toBe(false)
  expect(await grow(page,'wheel after simulated missing scrollend')).toBeLessThanOrEqual(1)
})

test('QA navigation already at its target leaves a native no-event mark',async ({page})=>{
  await page.emulateMedia({reducedMotion:'no-preference'})
  await readUp(page,'?compensation')
  await viewportOf(page).hover()
  await page.mouse.wheel(0,-74)
  await expect.poll(()=>viewportOf(page).evaluate(e=>e.scrollTop)).toBe(576)
  await page.waitForTimeout(220)
  const after=await viewportOf(page).evaluate(async v=>{
    const events={scroll:0,end:0}
    ;(window as any).__noOpEvents=events
    v.addEventListener('scroll',()=>events.scroll++)
    v.addEventListener('scrollend',()=>events.end++)
    await (window as any).__conversation.scrollToMessage(1)
    return v.scrollTop
  })
  expect(after).toBe(576)
  await page.waitForTimeout(1700)
  const events=await page.evaluate(()=>(window as any).__noOpEvents)
  console.log('native navigation already at target', {after,events,mark:await appMark(page)})
  expect(events).toEqual({scroll:0,end:0})
  expect(await appMark(page)).toBe(false)
  // Native touch content scroll does not go through wheel, key, or scrollbar handlers.
  const cdp=await page.context().newCDPSession(page)
  await cdp.send('Emulation.setTouchEmulationEnabled', {enabled:true, maxTouchPoints:1})
  await cdp.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[{x:300,y:365}]})
  for (const y of [345,325,300,275,250,225,200,175,150,125,100,75,50,25]) {
    await cdp.send('Input.dispatchTouchEvent', {type:'touchMove', touchPoints:[{x:300,y}]})
  }
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  console.log('native touch at bottom before lift', {mark:await appMark(page)})
  await cdp.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]})
  expect(await grow(page, 'touch after native no-op navigation')).toBeLessThanOrEqual(1)
})