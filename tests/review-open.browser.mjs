// PI_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
const { chromium } = await import(process.env.PI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PI_PLAYWRIGHT_MODULE).href : 'playwright')
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/en.ts'
import ReviewPanel from '/src/components/ReviewPanel.vue'
import OpenWithSettings from '/src/components/settings/OpenWithSettings.vue'
import '/src/style.css'
const lines = Array.from({length: 100}, (_, i) => [
  {kind:'remove', text:'old '+i+' '+ 'long '.repeat(60), oldLine:i+1},
  {kind:'add', text:'new '+i+' '+ 'long '.repeat(60), newLine:i+1},
]).flat()
createApp({render:()=>h('div',{},[
  h('div',{style:'padding:24px'},[h(OpenWithSettings)]),
  h('div',{style:'display:flex;height:650px;width:1100px'},[h(ReviewPanel,{project:'C:/demo project',changes:[{id:'1',path:'src/demo & 中文.ts',tool:'edit',lines,added:100,removed:100,unknownBefore:false}]})])
])}).use(createI18n({legacy:false,locale:'en',messages:{en:messages}})).mount('#app')
</script></body></html>`
const server = await createServer({ server: { port: 1441, strictPort: true }, plugins: [{
  name: 'review-test-fixture', configureServer(server) {
    server.middlewares.use('/__review_test', async (req, res, next) => {
      try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__review_test', html)) } catch (e) { next(e) }
    })
  },
}] })
await server.listen()
const browser = await chromium.launch({ channel: process.env.PI_BROWSER_CHANNEL || 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(() => {
  window.isTauri = true
  window.calls = []
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    window.calls.push({ command, args })
    if (command === 'detect_editors') return { vscode: true, cursor: true }
    if (command === 'open_in_editor' && window.failOpen) throw Error('File does not exist')
  } }
})
try {
  await page.goto('http://localhost:1441/__review_test')
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  const panes = page.locator('.review-split-pane [data-slot="scroll-area-viewport"]')
  await panes.first().waitFor()
  assert.equal(await panes.count(), 2)
  // reka-ui 缺陷回归:动态切换 orientation 后外层视口 overflow-y 不得卡在 hidden
  const outerViewport = page.locator('.changes-file-view > [data-slot="scroll-area"] > [data-slot="scroll-area-viewport"]')
  assert.equal(await outerViewport.evaluate(el => getComputedStyle(el).overflowY), 'scroll')
  // 用真实鼠标滚轮验证:逐行 -> 并排切换后,垂直滚动必须立即生效
  // 切换瞬间异步组件/高亮落地会引发布局微调,允许滚轮重试几次,但最终必须生效
  let wheeled = false
  for (let i = 0; i < 5 && !wheeled; i++) {
    const box = await panes.last().boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.wheel(0, 300)
    await page.waitForTimeout(250)
    wheeled = await panes.last().evaluate(el => el.scrollTop > 0)
  }
  assert.ok(wheeled, 'wheel scrolling must work right after switching to split view')
  await panes.last().evaluate(el => { el.scrollTop = 600; el.scrollLeft = 120 })
  await page.waitForFunction(() => {
    const [left, right] = document.querySelectorAll('.review-split-pane [data-slot="scroll-area-viewport"]')
    return left?.scrollTop > 500 && Math.abs(left.scrollTop - right.scrollTop) < 2
  })
  for (const pane of [panes.first(), panes.last()]) {
    await pane.hover()
    await pane.locator('..').locator('[data-slot="scroll-area-scrollbar"]').first().waitFor()
    await pane.locator('..').locator('[data-slot="scroll-area-scrollbar"][data-orientation="horizontal"]').waitFor()
    await pane.locator('..').locator('[data-slot="scroll-area-scrollbar"][data-orientation="vertical"]').waitFor()
  }
  assert.equal(await panes.first().evaluate(el => getComputedStyle(el).scrollbarWidth), 'none')
  const select = page.getByRole('combobox', { name: 'Default open method' })
  await select.click()
  await page.getByRole('option', { name: 'Cursor', exact: true }).click()
  await page.getByRole('button', { name: 'Open file with default application' }).click()
  const call = await page.evaluate(() => window.calls.find(call => call.command === 'open_in_editor'))
  assert.equal(call.args.kind, 'cursor')
  assert.equal(call.args.path, 'src/demo & 中文.ts')
  assert.equal(call.args.project, 'C:/demo project')
  await page.reload()
  await page.waitForFunction(() => document.querySelector('[role="combobox"]')?.textContent.includes('Cursor'))
  await page.evaluate(() => { window.failOpen = true })
  await page.getByRole('button', { name: 'Open file with default application' }).click()
  await page.getByRole('alert').filter({ hasText: 'File does not exist' }).waitFor()
  assert.deepEqual(errors, [])
  console.log('PASS: themed split scrollbars, synchronized scrolling, default editor persistence, file opening, and error feedback')
} finally {
  await browser.close()
  await server.close()
}
