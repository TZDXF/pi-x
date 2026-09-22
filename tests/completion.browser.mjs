// Run: PI_PLAYWRIGHT_MODULE=<absolute path to playwright/index.mjs> node tests/completion.browser.mjs
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'
const { chromium } = await import(process.env.PI_PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PI_PLAYWRIGHT_MODULE).href : 'playwright')
const server = await createServer({ server: { port: 1439, strictPort: true } })
await server.listen()
const browser = await chromium.launch({ channel: process.env.PI_BROWSER_CHANNEL || 'msedge', headless: true })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(error.message))
const calls = []
let failedSearch = false
await page.routeWebSocket('**/api/events*', () => {})
await page.route('**/api/invoke', async route => {
  const { command, args } = route.request().postDataJSON()
  calls.push({ command, args })
  let data = {}
  if (command === 'app_config_get') data = { lastProject: 'C:/test-project' }
  else if (command === 'rpc_running') data = false
  else if (command === 'trust_status') data = { needsDecision: false }
  else if (/sessions|projects/.test(command)) data = []
  else if (command === 'search_files') {
    if (failedSearch) return route.fulfill({ status: 500, json: { error: 'Search unavailable' } })
    if (args.query === 'slow') await new Promise(r => setTimeout(r, 450))
    data = args.query === 'none' ? [] : [{ name: '中文 file.ts', path: 'src/中文 file.ts', dir: 'src' }, { name: 'index.ts', path: 'src/index.ts', dir: 'src' }]
  } else if (command === 'rpc_spawn') await new Promise(r => setTimeout(r, 100))
  else if (command === 'rpc_request') {
    const type = args.command.type
    const response = type === 'get_commands' ? { commands: [
      { name: 'review', description: 'Review code', source: 'prompt' },
      { name: 'skill:check', description: 'Check project', source: 'skill' },
      { name: 'extension', description: 'Extension test', source: 'extension' },
    ] } : type === 'get_available_models' ? { models: [] } : type === 'get_state' ? { sessionId: 'test', messageCount: 0 } : type === 'get_messages' ? { messages: [] } : {}
    data = { success: true, command: type, data: response }
  }
  await route.fulfill({ json: { data } })
})
try {
  await page.goto('http://localhost:1439')
  const editor = page.locator('textarea[name="message"]')
  await editor.waitFor()
  assert.equal(calls.filter(c => c.command === 'rpc_spawn').length, 0)
  await editor.fill('/')
  const rows = page.locator('[data-slot="command-item"]')
  await rows.filter({ hasText: '/review' }).waitFor()
  assert.equal(await editor.isEnabled(), true)
  assert.equal(calls.filter(c => c.command === 'rpc_spawn').length, 1)
  await editor.press('ArrowDown')
  await editor.press('Enter')
  assert.equal(await editor.inputValue(), '/skill:check ')
  assert.equal(calls.filter(c => c.args?.command?.type === 'prompt').length, 0)
  await editor.fill('/rev')
  await rows.filter({ hasText: '/review' }).waitFor()
  await editor.press('Tab')
  assert.equal(await editor.inputValue(), '/review ')
  await editor.fill('检查 @src')
  await rows.filter({ hasText: '中文 file.ts' }).waitFor()
  await editor.press('Enter')
  assert.equal(await editor.inputValue(), '检查 @"src/中文 file.ts" ')
  assert.equal(await editor.evaluate(el => el === document.activeElement), true)
  await editor.press('Enter')
  await page.waitForFunction(() => document.querySelector('textarea').value === '')
  const prompt = calls.find(c => c.args?.command?.type === 'prompt')
  assert.match(prompt.args.command.message, /contents have not been attached/)
  assert.match(prompt.args.command.message, /src\/中文 file.ts/)
  await editor.fill('before @sr after')
  await editor.evaluate(el => { el.setSelectionRange(10, 10); el.dispatchEvent(new Event('select', { bubbles: true })) })
  await rows.filter({ hasText: 'index.ts' }).waitFor()
  await rows.filter({ hasText: 'index.ts' }).click()
  assert.equal(await editor.inputValue(), 'before @"src/index.ts" after')
  await editor.fill('@src')
  await rows.first().waitFor()
  await editor.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  assert.equal(await editor.inputValue(), '@src')
  await editor.press('Escape')
  assert.equal(await rows.count(), 0)
  assert.equal(await editor.getAttribute('aria-expanded'), 'false')
  failedSearch = true
  await editor.fill('@error')
  await page.getByRole('alert').filter({ hasText: 'Search unavailable' }).waitFor()
  failedSearch = false
  await page.getByRole('button', { name: /^(重试|Retry)$/ }).click()
  await rows.first().waitFor()
  await editor.fill('@slow')
  await page.waitForTimeout(180)
  await editor.fill('plain text')
  await page.waitForTimeout(500)
  assert.equal(await rows.count(), 0)
  await editor.fill('/unsupported')
  await editor.press('Escape')
  await editor.press('Enter')
  await page.waitForTimeout(100)
  assert.equal(await editor.inputValue(), '/unsupported')
  assert.equal(calls.filter(c => c.args?.command?.type === 'prompt').length, 1)
  await editor.fill('/review explain')
  await editor.press('Enter')
  await page.waitForTimeout(100)
  assert.equal(calls.filter(c => c.args?.command?.type === 'prompt').at(-1).args.command.message, '/review explain')
  await editor.fill('/extension @"src/index.ts"')
  await editor.press('Enter')
  await page.waitForTimeout(100)
  assert.equal(calls.filter(c => c.args?.command?.type === 'prompt').at(-1).args.command.message, '/extension @"src/index.ts"')
  await editor.fill('@none')
  await page.getByRole('status').filter({ hasText: /没有匹配|无匹配|No matching/ }).waitFor()
  await editor.press('Shift+Enter')
  assert.equal(await editor.inputValue(), '@none\n')
  await editor.fill('/compact keep decisions')
  await editor.press('Enter')
  await page.waitForTimeout(100)
  assert.equal(calls.find(c => c.args?.command?.type === 'compact').args.command.customInstructions, 'keep decisions')
  await editor.fill('/new ')
  await editor.press('Escape')
  await editor.press('Enter')
  await page.waitForTimeout(100)
  assert.ok(calls.some(c => c.args?.command?.type === 'new_session'))
  assert.deepEqual(errors, [])
  console.log('PASS: lazy start, rendered AI Elements slots, keyboard/mouse completion, caret, IME, file RPC context, errors/retry, stale search, unsupported command restoration')
} finally {
  await browser.close()
  await server.close()
}

