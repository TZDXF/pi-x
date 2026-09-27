// 无项目会话的界面回归：欢迎页入口、侧栏命名与设置项的保存/校验。
// PI_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
const { chromium } = await import(process.env.PI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PI_PLAYWRIGHT_MODULE).href : 'playwright')
const html = `<!doctype html><html><body><div id="app"></div><script type="module">
import { createApp, h } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import messages from '/src/i18n/locales/zh-CN.ts'
import WelcomeView from '/src/components/WelcomeView.vue'
import SettingsPage from '/src/components/SettingsPage.vue'
import WorkspaceSidebar from '/src/components/WorkspaceSidebar.vue'
import { useWorkspaceStore } from '/src/stores/workspace.ts'
import '/src/style.css'
const view = new URLSearchParams(location.search).get('view')
const pinia = createPinia()
const projectless = () => { window.projectlessOpened = true }
const app = createApp({ setup() {
  if (view === 'sidebar') return () => h('div', { class: 'flex h-screen' }, [
    h(WorkspaceSidebar, { project: window.projectlessDir, ready: true, busy: false, onProjectless: projectless })])
  if (view === 'settings') return () => h(SettingsPage, { project: 'C:/demo' })
  return () => h('div', { class: 'flex h-screen' }, [h(WelcomeView, { phase: 'pick', config: {}, onOpenProjectless: projectless })])
} })
app.use(pinia).use(createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': messages } }))
setActivePinia(pinia)
if (view === 'sidebar') {
  // 侧栏按解析结果命名项目；未解析时应退回目录名。
  useWorkspaceStore().projects = [window.projectlessDir, 'C:/demo']
  await useWorkspaceStore().ensureProjectless()
}
app.mount('#app')
</script></body></html>`
const server = await createServer({ server: { port: 1448, strictPort: true }, plugins: [{
  name: 'projectless-test', configureServer(server) {
    server.middlewares.use('/__projectless_test', async (req, res, next) => {
      try { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/__projectless_test', html)) } catch (e) { next(e) }
    })
  },
}] })
await server.listen()
const browser = await chromium.launch({ channel: process.env.PI_BROWSER_CHANNEL || 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 1050 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
const DEFAULT_DIR = 'C:/Users/you/.pix/workspace'
// 后端命令桩：目录由 projectless_dir_resolve 解析，配置写入记录在 window.config。
await page.addInitScript((defaultDir) => {
  window.isTauri = true
  window.defaultProjectlessDir = defaultDir
  window.projectlessDir = defaultDir
  window.config = {}
  window.calls = []
  window.__TAURI_INTERNALS__ = { invoke: async (command, args) => {
    window.calls.push({ command, args })
    if (command === 'app_config_get') return structuredClone(window.config)
    if (command === 'app_config_save') { window.config = structuredClone(args.config); return }
    if (command === 'projectless_dir_resolve') {
      return { dir: window.projectlessDir, defaultDir: window.defaultProjectlessDir, isDefault: window.projectlessDir === window.defaultProjectlessDir }
    }
    if (command === 'session_list') return []
    return {}
  } }
}, DEFAULT_DIR)
try {
  // 欢迎页：无项目会话入口可点击，且不触发目录选择器。
  await page.goto('http://localhost:1448/__projectless_test?view=welcome')
  const entry = page.getByRole('button', { name: '无项目会话', exact: true })
  await entry.waitFor()
  assert.equal(await page.getByRole('button', { name: '添加项目', exact: true }).count(), 1)
  await entry.click()
  assert.equal(await page.evaluate(() => window.projectlessOpened), true)
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command.startsWith('plugin:dialog'))), false)

  // 侧栏：无项目会话显示专用名称，普通项目仍显示目录名。
  await page.goto('http://localhost:1448/__projectless_test?view=sidebar')
  await page.getByText('无项目会话', { exact: true }).first().waitFor()
  assert.equal(await page.getByText('workspace', { exact: true }).count(), 0)
  assert.equal(await page.getByText('demo', { exact: true }).count(), 1)
  await page.locator('button[aria-label="无项目会话"]').click()
  assert.equal(await page.evaluate(() => window.projectlessOpened), true)

  // 设置项：展示默认目录、拒绝非法路径、保存绝对路径、与默认值一致时不写入配置。
  await page.goto('http://localhost:1448/__projectless_test?view=settings#/settings/general')
  const input = page.getByLabel('无项目会话目录')
  await input.waitFor()
  assert.equal(await input.getAttribute('placeholder'), DEFAULT_DIR)
  await input.fill('work')
  await input.press('Enter')
  assert.equal(await page.getByRole('alert').textContent(), '请输入完整路径，例如 C:\\work 或 ~/work')
  assert.equal(await page.evaluate(() => window.calls.some(call => call.command === 'app_config_save')), false)
  await input.fill('D:/pix/scratch')
  await input.press('Enter')
  await page.waitForFunction(() => window.config.projectlessDir === 'D:/pix/scratch')
  await input.fill(DEFAULT_DIR)
  await input.press('Enter')
  await page.waitForFunction(() => window.config.projectlessDir === undefined)
  assert.ok(await page.getByRole('button', { name: '恢复默认' }).isDisabled())
  assert.deepEqual(errors, [])
  console.log('projectless browser regression: ok')
} finally {
  await browser.close()
  await server.close()
}
