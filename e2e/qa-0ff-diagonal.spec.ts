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
  harness = await startVueHarness({ name: "qa-0ff-diagonal", port: 1571, html })
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

for(const kind of ['contained horizontal swipe', 'diagonal constrained horizontal swipe'] as const){
  test(`${kind}: no touch scroll of conversation must not re-arm following`,async({page})=>{
    await page.emulateMedia({reducedMotion:'no-preference'})
    await readUp(page)
    const viewport=viewportOf(page)
    await viewport.evaluate(async(v,kind)=>{
      const mod='/src/lib/scrollWrites.ts'
      const {hasAppScroll}=await import(mod)
      const trace:any[]=[]
      const w=window as any
      w.__touchTrace=trace
      {
        const pane=document.createElement('div')
        pane.id='qa-contained-pane'
        pane.style.cssText='position:fixed;left:340px;top:100px;width:320px;height:230px;overflow:auto;overscroll-behavior:contain;background:#abc;z-index:5'
        if(kind.includes('horizontal swipe')) {
          pane.style.touchAction='pan-x'
          pane.innerHTML='<div style="width:1100px;height:90px">Wide code block</div>'
        } else {
          pane.style.touchAction='pan-y'
          pane.innerHTML='<div style="width:95%;height:1000px">Tall content block</div>'
        }
        v.append(pane)
      }
      for(const type of ['pointerdown','pointermove','pointercancel','pointerup']){
        window.addEventListener(type,e=>{
          const p=e as PointerEvent
          if(p.pointerType==='touch')trace.push({type,x:p.clientX,y:p.clientY,movementY:p.movementY,id:p.pointerId,trusted:p.isTrusted,mark:hasAppScroll(v),target:(p.target as Element)?.closest('#qa-contained-pane')?.id||'-'})
        },true)
      }
      v.addEventListener('scroll',()=>{if(w.__firstGap===undefined)w.__firstGap=v.scrollHeight-v.clientHeight-v.scrollTop})
    },kind)
    const cdp=await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1})
    await viewport.evaluate(()=>{void (window as any).__conversation.scrollToMessage(1)})
    await page.waitForFunction(()=>(window as any).__firstGap>1)
    expect(await appMark(page)).toBe(true)
    const tiny=false
    const x=tiny?290:580
    const y=270
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]})
    if(tiny)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y-3}]})
    else for(const d of [34,68,103,137]){
      const horizontal=kind.includes('horizontal swipe')
      await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:horizontal?x-d:x,y:horizontal?(kind.startsWith('diagonal')?y-Math.round(d*0.36):y):y-d}]})
    }
    const markAfterMove=await appMark(page)
    const contained=page.locator('#qa-contained-pane')
    if(!tiny)await expect.poll(()=>contained.evaluate((el,horizontal)=>horizontal?el.scrollLeft:el.scrollTop,kind.includes('horizontal swipe'))).toBeGreaterThan(0)
    await expect.poll(()=>gap(page)).toBeLessThanOrEqual(1)
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]})
    const after=await grow(page,kind)
    const trace=await page.evaluate(()=>(window as any).__touchTrace)
    const pane=tiny?null:await contained.evaluate(el=>({top:el.scrollTop,left:el.scrollLeft}))
    console.log({kind,markAfterMove,pane,trace,after})
    expect(trace.find((e:any)=>e.type==='pointerdown')).toMatchObject({trusted:true,mark:true,target:tiny?'-':'qa-contained-pane'})
    if(tiny){
      expect(trace.find((e:any)=>e.type==='pointermove')).toMatchObject({trusted:true,x,y:y-3})
      expect(trace.some((e:any)=>e.type==='pointercancel')).toBe(false)
    }
    if(kind.includes('horizontal swipe'))expect(pane?.top).toBe(0)
    expect(after).toBe(40)
  })
}