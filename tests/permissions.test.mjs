import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTsSource } from './lib/load-ts.mjs'

const source = readFileSync(new URL('../src/lib/permissions.ts', import.meta.url), 'utf8')

function harness(storage = {}) {
  const localStorage = {
    getItem: key => (key in storage ? storage[key] : null),
    setItem: (key, value) => { storage[key] = String(value) },
  }
  return loadTsSource(source, { localStorage })
}

test('permission modes are the approval tiers enforced by the bundled extension', () => {
  const { TOOL_PERMISSIONS } = harness()
  // vm-context arrays need a realm-local copy for deepStrictEqual.
  assert.deepEqual(Array.from(TOOL_PERMISSIONS), ['ask', 'highRisk', 'full'])
})

test('tool permission persists per project and falls back to full access', () => {
  const storage = {}
  const { toolPermission, setToolPermission } = harness(storage)
  assert.equal(toolPermission('C:/project'), 'full')
  setToolPermission('C:/project', 'ask')
  assert.equal(toolPermission('C:/project'), 'ask')
  assert.equal(toolPermission('D:/other'), 'full')
  // Corrupt or unknown values (e.g. from older builds) fall back to full access.
  storage['pix:toolPermission:C:/project'] = 'readonly'
  assert.equal(toolPermission('C:/project'), 'full')
})
