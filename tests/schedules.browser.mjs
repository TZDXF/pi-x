// PI_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
const { chromium } = await import(process.env.PI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PI_PLAYWRIGHT_MODULE).href : 'playwright')
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/zh-CN.ts'
import WorkspaceSidebar from '/src/components/WorkspaceSidebar.vue'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import '/src/style.css'
const app = createApp({render:()=>h(WorkspaceSidebar,{project:'C:/demo',ready:true,busy:false})})
app.use(createPinia()).use(createI18n({legacy:false,locale:'zh-CN',messages:{'zh-CN':messages}}))
useWorkspaceStore().projects = ['C:/demo']
app.mount('#app')
</script></body></html>`
const server = await createServer({ server: { port: 1447, strictPort: true }, plugins: [{
  name: 'schedules-test', configureServer(server) {
    server.middlewares.use('/__schedules_test', async (req, res, next) => {
      try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__schedules_test', html)) } catch (e) { next(e) }
    })
  },
}] })
await server.listen()
const browser = await chromium.launch({ channel: process.env.PI_BROWSER_CHANNEL || 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.addInitScript(() => {
  window.isTauri = true
  window.calls = []
  window.tasks = []
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    window.calls.push({ command, args })
    if (command === 'schedule_list') return structuredClone(window.tasks)
    if (command === 'schedule_save') {
      const saved = { ...args.input, id: args.input.id || 'test-task', nextRun: Date.now() + 60000, lastRun: null, status: 'idle', error: null, sessionFile: null }
      window.tasks = [saved]
      return saved
    }
    if (command === 'schedule_delete') { window.tasks = []; return }
    if (command === 'models_config_get') return { providers: { test: { models: [{ id: 'test-model', name: 'Test model', reasoning: true }] } } }
    if (command === 'pi_settings_get') return { defaultProvider: 'test', defaultModel: 'test-model', skills: [] }
    if (command === 'session_list') return []
    return {}
  } }
})
try {
  await page.goto('http://localhost:1447/__schedules_test')
  const entry = page.getByRole('button', { name: '定时任务', exact: true })
  await entry.waitFor()
  assert.ok(await entry.evaluate(el => el.previousElementSibling.textContent.includes('新会话')))
  await entry.click()
  await page.getByRole('button', { name: '新建定时任务', exact: true }).click()
  await page.getByLabel('标题', { exact: true }).fill('每周项目巡检')
  await page.getByLabel('任务指令', { exact: true }).fill('检查项目测试与待办事项，汇总结果，不修改文件。')
  await page.getByRole('combobox', { name: '重复频率' }).click()
  for (const name of ['每小时', '每天', '工作日（周一至周五）', '每周', '每月', '自定义']) assert.equal(await page.getByRole('option', { name, exact: true }).count(), 1)
  await page.getByRole('option', { name: '每周', exact: true }).click()
  await page.getByRole('combobox', { name: '星期', exact: true }).click()
  await page.getByRole('option', { name: '周五', exact: true }).click()
  await page.getByLabel('执行时间', { exact: true }).fill('10:30')
  if (process.env.PI_SCHEDULE_SCREENSHOT) await page.screenshot({ path: process.env.PI_SCHEDULE_SCREENSHOT })
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('heading', { name: '每周项目巡检' }).waitFor()
  let saved = await page.evaluate(() => window.tasks[0])
  assert.equal(saved.expression, '30 10 * * FRI')
  assert.equal(saved.provider, 'test')
  assert.equal(saved.model, 'test-model')
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  assert.equal(await page.getByLabel('执行时间', { exact: true }).inputValue(), '10:30')
  await page.getByRole('combobox', { name: '重复频率' }).click()
  await page.getByRole('option', { name: '自定义', exact: true }).click()
  await page.getByLabel('Cron 表达式').fill('*/15 9-17 * * MON-FRI')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).click()
  await page.getByText('已暂停', { exact: true }).waitFor()
  saved = await page.evaluate(() => window.tasks[0])
  assert.equal(saved.enabled, false)
  assert.equal(saved.expression, '*/15 9-17 * * MON-FRI')
  await page.getByRole('button', { name: '恢复', exact: true }).click()
  await page.getByRole('button', { name: '暂停', exact: true }).waitFor()
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.getByText('确定删除此定时任务？').waitFor()
  await page.getByRole('button', { name: '删除', exact: true }).last().click()
  await page.getByText('暂无定时任务，创建一个自动执行重复工作。').waitFor()
  assert.deepEqual(errors, [])
  console.log('Scheduled task browser regression passed')
} finally { await browser.close(); await server.close() }
