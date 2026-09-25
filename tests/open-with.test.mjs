import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'
const source = readFileSync(new URL('../src/lib/openWith.ts', import.meta.url), 'utf8')
  .replace(/^if \(import\.meta\.hot\).*$/m, '')
function harness(saved = null, desktop = true) {
  let stored = saved
  let failStorage = false
  const calls = [], listeners = {}
  const api = loadTsSource(source, {
    require: id => id === 'vue' ? { ref: value => ({ value }), readonly: value => value } : {
      isDesktop: desktop, invoke: async (command, args) => { calls.push({ command, args }) },
    },
    localStorage: { getItem: () => stored, setItem: (_, value) => { if (failStorage) throw Error('blocked'); stored = value } },
    window: { addEventListener: (name, fn) => { listeners[name] = fn } },
  })
  return { ...api, calls, stored: () => stored, failStorage: () => { failStorage = true },
    storage: value => { stored = value; listeners.storage({ key: 'pix.openWith' }) } }
}
test('defaults safely and restores only valid editor preferences', () => {
  for (const value of [null, '{', '{"kind":"arbitrary-command"}']) assert.equal(harness(value).openWithPreference.value.kind, 'vscode')
  assert.equal(harness('{"kind":"cursor"}').openWithPreference.value.kind, 'cursor')
})
test('persists default and custom executable and synchronizes other windows', () => {
  const h = harness()
  h.setOpenWith('custom', ' C:/Program Files/My IDE/ide.exe ')
  assert.equal(JSON.parse(h.stored()).executable, 'C:/Program Files/My IDE/ide.exe')
  h.storage('{"kind":"system"}')
  assert.equal(h.openWithPreference.value.kind, 'system')
  h.failStorage()
  assert.throws(() => h.setOpenWith('cursor'), /blocked/)
  assert.equal(h.openWithPreference.value.kind, 'system')
})
test('passes the file and project separately without shell interpolation', async () => {
  const h = harness()
  h.setOpenWith('cursor')
  await h.openFileInEditor('src/file & 中文.ts', 'C:/my project')
  assert.equal(h.calls[0].command, 'open_in_editor')
  assert.equal(h.calls[0].args.path, 'src/file & 中文.ts')
  assert.equal(h.calls[0].args.project, 'C:/my project')
  assert.equal(h.calls[0].args.kind, 'cursor')
  assert.equal(h.calls[0].args.executable, null)
  h.setOpenWith('custom', 'C:/ide.exe')
  await h.openFileInEditor('a.ts', 'C:/project')
  assert.equal(h.calls[1].args.executable, 'C:/ide.exe')
})
test('does not launch an editor from remote web mode', async () => {
  const h = harness(null, false)
  await assert.rejects(h.openFileInEditor('a.ts', '/project'), /desktop/)
  assert.equal(h.calls.length, 0)
})
test('both split panes reuse the shared themed scrollbars', () => {
  const split = readFileSync(new URL('../src/components/ReviewSplitDiff.vue', import.meta.url), 'utf8')
  assert.equal((split.match(/<ScrollArea\s/g) ?? []).length, 2)
  assert.equal((split.match(/orientation="both"/g) ?? []).length, 2)
  assert.equal((split.match(/@viewport-scroll=/g) ?? []).length, 2)
})
