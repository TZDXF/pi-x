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
  harness = await startVueHarness({ name: "qa-scroll-lifecycle", port: 1546, html })
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

test('QA smooth navigation should not lose attribution to ArrowDown inside a nested scroller', async ({page}) => {
  await page.emulateMedia({reducedMotion:'no-preference'})
  await readUp(page)
  await viewportOf(page).evaluate(v => {
    const nested=document.createElement('div')
    nested.tabIndex=0
    nested.id='qa-inner-scroll'
    nested.style.cssText='position:fixed;top:10px;left:10px;width:100px;height:60px;overflow-y:scroll;overscroll-behavior:contain;'
    const child=document.createElement('div')
    child.style.height='600px'
    nested.append(child)
    v.append(nested)
    nested.focus({preventScroll:true})
    v.addEventListener('scroll', () => { (window as any).__interim=v.scrollHeight-v.clientHeight-v.scrollTop },{once:true})
    void (window as any).__conversation.scrollToMessage(1)
  })
  await page.waitForFunction(() => (window as any).__interim > 1, undefined, {timeout:2000})
  expect(await appMark(page)).toBe(true)
  await page.keyboard.press('ArrowDown')
  const afterKey = await appMark(page)
  await expect.poll(() => page.locator('#qa-inner-scroll').evaluate(v=>v.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  console.log('mark right after ArrowDown inside independent nested scroller:', afterKey)
  expect(await grow(page, 'smooth navigation + nested ArrowDown')).toBe(40)
})

test('QA render-phase VirtualMessage write should stay app-owned after real pointerdown', async ({page}) => {
  await readUp(page, '?compensation')
  await viewportOf(page).evaluate(async v => {
    const path='/src/lib/scrollWrites.ts'
    const {isInputDispatch}=await import(path)
    const desc=Object.getOwnPropertyDescriptor(v,'scrollTop')!
    const trace:any[]=[]
    ;(window as any).__trace=trace
    let t=0
    Object.defineProperty(v,'scrollTop', {...desc,set(value:number){
      if(t) trace.push({ms:Math.round(performance.now()-t), value, input:isInputDispatch(v), measure:(new Error().stack||'').includes('ResizeObserver.measure')})
      desc.set!.call(v,value)
    }})
    v.parentElement!.querySelector(':scope > [data-slot="scroll-area-scrollbar"]')!.addEventListener('pointerdown', () => {
      t=performance.now()
      void (window as any).__compensate()
      // Let the next rendering opportunity become due before the handler ends.
      while(performance.now()-t<34) { /* simulate work already in the input task */ }
    },{once:true})
  })
  const thumb = viewportOf(page).locator('..').locator(':scope > [data-slot="scroll-area-scrollbar"] [data-slot="scroll-area-thumb"]')
  await expect(thumb).toBeVisible()
  const box = (await thumb.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(1)
  console.log('pointer compensation setter trace',await page.evaluate(()=>(window as any).__trace))
  await page.mouse.up()
  expect(await grow(page, 'pointerdown + same-frame real compensation')).toBeGreaterThanOrEqual(40)
})
// Arm a gap-specific listener before the Vue update, so no read-vs-scroll race.
test('QA compensation settles at the bottom event before the next chunk',async ({page})=>{
  await readUp(page,'?compensation')
  const before=await viewportOf(page).evaluate(async v=>{
    const w=window as any
    w.__arrival=null
    const onScroll=()=>{
      const gap=v.scrollHeight-v.clientHeight-v.scrollTop
      if(gap>1)return
      v.removeEventListener('scroll',onScroll)
      w.__arrival=gap
    }
    v.addEventListener('scroll',onScroll)
    return w.__compensate()
  })
  expect(before).toEqual({top:650,gap:240})
  await page.waitForFunction(()=>typeof (window as any).__arrival==='number')
  expect(await grow(page,'pre-armed compensation scroll event')).toBeGreaterThanOrEqual(40)
})