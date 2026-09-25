import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTsSource } from './lib/load-ts.mjs'

const nodeRequire = createRequire(import.meta.url)
const template = readFileSync(new URL('../src-tauri/src/permission-extension.ts', import.meta.url), 'utf8')
const PLACEHOLDER = 'const PIX_CONFIG = { mode: "", locale: "" }'

/** Mirror the Rust permission::render substitution and load the extension. */
function load(mode, locale = 'zh-CN') {
  assert.ok(template.includes(PLACEHOLDER), 'template keeps its config placeholder')
  const source = template.replace(PLACEHOLDER, `const PIX_CONFIG = { mode: ${JSON.stringify(mode)}, locale: ${JSON.stringify(locale)} }`)
  return loadTsSource(source, { require: id => nodeRequire(id), process })
}

test('ask mode approves every non-read-only tool call', () => {
  const { pixShouldAsk } = load('ask')
  for (const tool of ['read', 'grep', 'find', 'ls'])
    assert.equal(pixShouldAsk('ask', tool, {}, '/proj'), false, tool)
  for (const tool of ['write', 'edit', 'bash', 'powershell', 'mcp_search'])
    assert.equal(pixShouldAsk('ask', tool, { command: 'ls', path: 'a.ts' }, '/proj'), true, tool)
})

test('highRisk mode only asks for dangerous operations', () => {
  const { pixShouldAsk } = load('highRisk')
  assert.equal(pixShouldAsk('highRisk', 'bash', { command: 'ls -la' }, '/proj'), false)
  assert.equal(pixShouldAsk('highRisk', 'bash', { command: 'npm test && git status' }, '/proj'), false)
  assert.equal(pixShouldAsk('highRisk', 'bash', { command: 'rm -rf /tmp/x' }, '/proj'), true)
  assert.equal(pixShouldAsk('highRisk', 'bash', { command: 'sudo apt install x' }, '/proj'), true)
  assert.equal(pixShouldAsk('highRisk', 'bash', { command: 'git push --force origin main' }, '/proj'), true)
  assert.equal(pixShouldAsk('highRisk', 'powershell', { command: 'Remove-Item -Recurse -Force C:/x' }, '/proj'), true)
  // Writes inside the project run free; outside writes ask.
  assert.equal(pixShouldAsk('highRisk', 'write', { path: 'src/a.ts' }, '/proj'), false)
  assert.equal(pixShouldAsk('highRisk', 'edit', { path: '/proj/src/a.ts' }, '/proj'), false)
  assert.equal(pixShouldAsk('highRisk', 'write', { path: '../outside.ts' }, '/proj'), true)
  assert.equal(pixShouldAsk('highRisk', 'write', { path: '/etc/hosts' }, '/proj'), true)
  // Unknown extension tools stay gated.
  assert.equal(pixShouldAsk('highRisk', 'mcp_delete', {}, '/proj'), true)
  assert.equal(pixShouldAsk('highRisk', 'read', {}, '/proj'), false)
})

test('full mode never gates tool calls', () => {
  const { pixShouldAsk, default: factory } = load('full')
  assert.equal(pixShouldAsk('full', 'bash', { command: 'rm -rf /' }, '/proj'), false)
  // The factory registers no handler in full mode.
  const pi = { on: () => { throw new Error('must not subscribe') } }
  factory(pi)
})

test('handler asks via UI confirm, blocks on denial and without UI', async () => {
  const { default: factory } = load('ask', 'zh-CN')
  let handler = null
  factory({ on: (name, fn) => { assert.equal(name, 'tool_call'); handler = fn } })
  const call = (hasUI, confirmed) => handler(
    { toolName: 'write', input: { path: 'a.ts' } },
    { cwd: '/proj', hasUI, ui: { confirm: async (title, message) => {
      assert.equal(title, '批准工具调用？')
      assert.ok(message.includes('write') && message.includes('a.ts'))
      return confirmed
    } } },
  )
  assert.equal(await call(true, true), undefined)
  const denied = await call(true, false)
  assert.equal(denied.block, true)
  assert.equal(denied.reason, '用户拒绝了该工具调用')
  const noUi = await call(false, true)
  assert.equal(noUi.block, true)
  assert.equal(noUi.reason, '没有可用的确认界面，已按权限设置阻止该操作')
  // A failing confirm dialog also fails closed.
  const failClosed = await handler({ toolName: 'bash', input: { command: 'ls' } },
    { cwd: '/proj', hasUI: true, ui: { confirm: () => Promise.reject(new Error('gone')) } })
  assert.equal(failClosed.block, true)
  // Read-only tools never reach the dialog.
  assert.equal(await handler({ toolName: 'read', input: {} }, { cwd: '/proj', hasUI: true, ui: {} }), undefined)
})

test('en locale variants use English dialog text', async () => {
  const { default: factory } = load('highRisk', 'en')
  let handler = null
  factory({ on: (_name, fn) => { handler = fn } })
  const result = await handler(
    { toolName: 'bash', input: { command: 'sudo rm -rf /' } },
    { cwd: '/proj', hasUI: true, ui: { confirm: async title => { assert.equal(title, 'High-risk operation, proceed?'); return false } } },
  )
  assert.equal(result.block, true)
  assert.equal(result.reason, 'Tool call denied by the user')
})
