import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'

// Opt in with the dist directory of a real installed Pi. Never touch user data.
const dist = process.env.PI_TEST_SDK
const script = readFileSync(new URL('../src-tauri/src/pi_data.mjs', import.meta.url), 'utf8')
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pix-pi-data-test-'))
  t.after(() => {
    const target = realpathSync(root)
    assert.equal(dirname(target), realpathSync(tmpdir()))
    assert.ok(basename(target).startsWith('pix-pi-data-test-'))
    rmSync(target, { recursive: true, force: true })
  })
  const agent = join(root, 'agent'), project = join(root, 'project')
  mkdirSync(agent); mkdirSync(project)
  function call(request, success = true) {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, dist], {
      input: JSON.stringify(request), encoding: 'utf8', cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agent }, timeout: 15000,
    })
    if (!success) { assert.notEqual(child.status, 0); return child.stderr }
    assert.equal(child.status, 0, child.stderr || String(child.error))
    return JSON.parse(child.stdout)
  }
  return { root, agent, project, call }
}

test('installed Pi persists settings without a PiX copy and retains unrelated data', { skip: !dist }, t => {
  const { agent, root, call } = fixture(t)
  const path = join(agent, 'settings.json')
  writeFileSync(path, JSON.stringify({ theme: 'dark', retry: { enabled: false }, defaultThinkingLevel: 'high' }))
  call({ op: 'settings_save', settings: { defaultProvider: 'test', defaultModel: 'vendor/model' } })
  call({ op: 'settings_save', settings: { skills: ['C:/skill.md', '!**/excluded/**'] } })
  let saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.defaultProvider, 'test')
  assert.equal(saved.defaultModel, 'vendor/model')
  assert.equal(saved.theme, 'dark')
  assert.equal(saved.retry.enabled, false)
  assert.equal(call({ op: 'settings_get' }).defaultThinkingLevel, 'high')
  assert.deepEqual(saved.skills, ['C:/skill.md', '!**/excluded/**'])
  call({ op: 'settings_save', settings: { defaultProvider: null, defaultModel: null } })
  saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.defaultProvider, undefined)
  assert.equal(saved.defaultModel, undefined)
  assert.equal(existsSync(join(root, '.pix')), false)
})

test('Pi trust handles resources, parent inheritance, and explicit denial', { skip: !dist }, t => {
  const { agent, root, project, call } = fixture(t)
  mkdirSync(join(project, '.pi')); writeFileSync(join(project, '.pi', 'settings.json'), '{}')
  assert.equal(call({ op: 'trust_status', project }).needsDecision, true)
  call({ op: 'trust_save', project, trusted: true, trustParent: true })
  assert.equal(call({ op: 'trust_status', project }).decision, true)
  let stored = JSON.parse(readFileSync(join(agent, 'trust.json'), 'utf8'))
  assert.equal(stored[root], true)
  call({ op: 'trust_save', project, trusted: false, trustParent: false })
  assert.equal(call({ op: 'trust_status', project }).decision, false)
  stored = JSON.parse(readFileSync(join(agent, 'trust.json'), 'utf8'))
  assert.equal(stored[project], false)
})

test('Pi native session names roundtrip and automatic names preserve manual names', { skip: !dist }, t => {
  const { root, project, call } = fixture(t)
  const file = join(root, 'session.jsonl')
  writeFileSync(file, [
    { type: 'session', version: 3, id: 'test', timestamp: new Date().toISOString(), cwd: project },
    { type: 'message', id: 'm1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'hello', timestamp: Date.now() } },
    { type: 'message', id: 'm2', parentId: 'm1', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], timestamp: Date.now() } },
  ].map(v => JSON.stringify(v)).join('\n') + '\n')
  assert.equal(call({ op: 'session_name', file, title: 'Manual' }), 'Manual')
  assert.equal(call({ op: 'session_name', file, title: 'Auto', onlyIfEmpty: true }), 'Manual')
  assert.equal(call({ op: 'session_name', file }), 'Manual')
  const entries = readFileSync(file, 'utf8').trim().split('\n').map(v => JSON.parse(v))
  assert.equal(entries.at(-1).type, 'session_info')
  assert.equal(entries.at(-1).name, 'Manual')
  assert.equal(existsSync(file.replace('.jsonl', '.pix.json')), false)
})

test('Pi exports a saved session file directly without opening a runtime', { skip: !dist }, t => {
  const { root, project, call } = fixture(t)
  const file = join(root, 'conversation.jsonl'), outputPath = join(root, 'chosen.html')
  writeFileSync(file, [
    { type: 'session', version: 3, id: 'saved', timestamp: new Date().toISOString(), cwd: project },
    { type: 'message', id: 'm1', parentId: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'offline export marker', timestamp: Date.now() } },
  ].map(v => JSON.stringify(v)).join('\n') + '\n')
  assert.equal(call({ op: 'session_export_html', file, outputPath }), outputPath)
  assert.ok(readFileSync(outputPath, 'utf8').startsWith('<!DOCTYPE html>'))
})

test('retry count merges into the global file and invalid patches are rejected', { skip: !dist }, t => {
  const { agent, call } = fixture(t)
  const path = join(agent, 'settings.json')
  writeFileSync(path, '{}')
  assert.deepEqual(call({ op: 'settings_get' }).retry, { maxRetries: 3 }, 'the default comes from Pi')

  writeFileSync(path, JSON.stringify({ theme: 'dark', retry: { enabled: false, maxRetries: 9, baseDelayMs: 500, provider: { maxRetries: 2 } } }))
  call({ op: 'settings_save', settings: { retry: { maxRetries: 5 } } })
  let saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.retry.maxRetries, 5)
  assert.equal(saved.theme, 'dark')
  assert.equal(saved.retry.enabled, false, 'untouched retry keys survive the patch')
  assert.equal(saved.retry.baseDelayMs, 500)
  assert.deepEqual(saved.retry.provider, { maxRetries: 2 })
  assert.deepEqual(call({ op: 'settings_get' }).retry, { maxRetries: 5 })

  for (const retry of [{ maxRetries: -1 }, { maxRetries: 1.5 }, { maxRetries: '5' }, { enabled: false }, { baseDelayMs: 1 }, 3]) {
    call({ op: 'settings_save', settings: { retry } }, false)
  }
  saved = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(saved.retry.maxRetries, 5, 'invalid patches never reach the file')
  assert.equal(saved.retry.enabled, false)
})

test('malformed Pi settings and invalid patches fail without replacing the file', { skip: !dist }, t => {
  const { agent, call } = fixture(t)
  const file = join(agent, 'settings.json')
  writeFileSync(file, '{broken')
  call({ op: 'settings_get' }, false)
  call({ op: 'settings_save', settings: { skills: [] } }, false)
  assert.equal(readFileSync(file, 'utf8'), '{broken')
  writeFileSync(file, '{}')
  call({ op: 'settings_save', settings: { defaultProvider: 'p', defaultModel: 'm', skills: false } }, false)
  assert.equal(readFileSync(file, 'utf8'), '{}')
})
