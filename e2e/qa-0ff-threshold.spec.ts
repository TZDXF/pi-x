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
  harness = await startVueHarness({ name: "qa-0ff-threshold", port: 1570, html })
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

for(const pending of [true,false]){
  test(`gradual native drag should resume bottom follow (pending app mark=${pending})`, async({page})=>{
    if(pending) await startThenCancel(page,true)
    else await readUp(page)
    const viewport=viewportOf(page)
    await viewport.evaluate(async v=>{
      const path='/src/lib/scrollWrites.ts'
      const {hasAppScroll}=await import(path)
      const trace:any[]=[]
      ;(window as any).__slowTouch=trace
      for(const type of ['pointerdown','pointermove','pointercancel','pointerup','scroll','scrollend']){
        v.addEventListener(type,e=>{
          const p=e as PointerEvent
          trace.push({type,trusted:e.isTrusted,y:p.clientY,movementY:p.movementY,mark:hasAppScroll(v),gap:v.scrollHeight-v.clientHeight-v.scrollTop})
        })
      }
    })
    const cdp=await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:300,y:365}]})
    for(let y=361;y>=29;y-=4) {
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:300,y}]})
      if(!await page.evaluate(()=>(window as any).__slowTouch.some((r:any)=>r.type==='pointercancel'))) await page.waitForTimeout(18)
      else break
    }
    const progress=await page.evaluate(()=> (window as any).__slowTouch as any[])
    const cancelIndex=progress.findIndex(r=>r.type==='pointercancel')
    const moves=progress.filter(r=>r.type==='pointermove')
    console.log('moves before actual pan',moves, 'cancel',progress[cancelIndex])
    expect(cancelIndex).toBeGreaterThan(0)
    expect(moves.length).toBeGreaterThan(1)
    expect(Math.max(...moves.map(r=>Math.abs(r.movementY)))).toBeLessThan(10)
    for(const y of [330,305,280,255,230,205,180,155,130,105,80,55,30]){
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:300,y}]})
    }
    await expect.poll(()=>gap(page)).toBeLessThanOrEqual(1)
    const markAtBottom=await appMark(page)
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    const after=await grow(page,`gradual native drag, pending=${pending}`)
    const trace=await page.evaluate(()=> (window as any).__slowTouch as any[])
    console.log({pending,markAtBottom,after,scrolls:trace.filter(r=>r.type==='scroll').slice(0,5)})
    expect(after).toBeLessThanOrEqual(1)
  })
}