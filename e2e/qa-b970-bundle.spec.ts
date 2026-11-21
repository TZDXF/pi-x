import { test, expect, type Page } from "@playwright/test"
import path from 'node:path'
import {mkdir, writeFile} from 'node:fs/promises'
import {build, preview} from 'vite'
import type { VueHarness } from './helpers/vue-harness'

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
    const root=process.cwd()
  const scratch='temp/playwright/b970-bundle-source'
  const input=path.resolve(root,scratch,'index.html')
  const outDir=path.resolve(root,'temp/playwright/b970-bundle-dist')
  const configFile=path.resolve(root,'vite.config.ts')
  await mkdir(path.dirname(input),{recursive:true})
  await writeFile(input,html,'utf8')
  const options={configFile,root,build:{outDir,rollupOptions:{input}}}
  // Default minification exactly as `vite build`; no keepNames override.
  await build(options)
  const server=await preview({...options,preview:{port:1567,strictPort:true}})
  harness={url:`http://localhost:1567/${scratch}/index.html`,close:()=>server.close()}
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


for(const type of ['native viewport wheel','rail wheel','thumb drag'] as const){
  test(`minified production build: ${type} back to bottom must restore following`, async ({page})=>{
    await readUp(page)
    await viewportOf(page).evaluate(v=>{
      const desc=Object.getOwnPropertyDescriptor(v,'scrollTop')!
      const rows:any[]=[]
      ;(window as any).__writes=rows
      Object.defineProperty(v,'scrollTop',{...desc,set(value:number){
        rows.push({value,stack:(new Error().stack||'').split('\n').slice(0,8)})
        desc.set!.call(v,value)
      }})
    })
    if(type==='native viewport wheel'){
      await viewportOf(page).hover()
      await page.mouse.wheel(0,400)
    }else{
      const p=await thumbCentre(page)
      await page.mouse.move(p.x,p.y)
      expect(await page.evaluate(({x,y})=>!!document.elementFromPoint(x,y)?.closest('[data-slot="scroll-area-scrollbar"]'),p)).toBe(true)
      if(type==='rail wheel') await page.mouse.wheel(0,400)
      else {
        await page.mouse.down()
        await page.mouse.move(p.x,p.y+400,{steps:6})
        await page.mouse.up()
      }
    }
    await expect.poll(()=>gapOf(page)).toBeLessThanOrEqual(1)
    const before=await page.evaluate(()=>(window as any).__writes)
    const after=await streamChunk(page)
    console.log(type,'gap after +40=', after, 'setter stacks=', before)
    expect(after).toBeLessThanOrEqual(1)
  })
}
for(const stackEnabled of [true,false]){
  test(`minified build: earlier app RAF with stopped wheel, stack enabled=${stackEnabled}`,async({page})=>{
    await page.addInitScript(()=>{
      window.addEventListener('wheel',()=>{
        const w=window as any
        if(w.__queueEarlyPin) requestAnimationFrame(w.__queueEarlyPin)
      },{capture:true,passive:true})
    })
    await readUp(page)
    await viewportOf(page).evaluate((v,stackEnabled)=>{
      const w=window as any
      const trace:any[]=[]
      w.__earlyPinTrace=trace
      w.__queueEarlyPin=()=>{
        const old=(Error as any).prepareStackTrace
        if(!stackEnabled)(Error as any).prepareStackTrace=()=>undefined
        try{
          trace.push({stage:'app RAF',stackAvailable:!!new Error().stack})
          w.__pinToBottom()
        }finally{(Error as any).prepareStackTrace=old}
      }
      v.addEventListener('wheel',e=>{
        e.stopPropagation()
        e.preventDefault()
        trace.push({stage:'stopped input',trusted:e.isTrusted})
        const until=performance.now()+34
        while(performance.now()<until){ /* rendering opportunity before timer */ }
      },{once:true,passive:false})
    },stackEnabled)
    await viewportOf(page).hover()
    await page.mouse.wheel(0,40)
    await expect.poll(()=>gapOf(page)).toBeLessThanOrEqual(1)
    const after=await streamChunk(page)
    const trace=await page.evaluate(()=>(window as any).__earlyPinTrace)
    console.log({stackEnabled,trace,after})
    expect(trace).toEqual([{stage:'stopped input',trusted:true},{stage:'app RAF',stackAvailable:stackEnabled}])
    expect(after).toBe(40)
  })
}