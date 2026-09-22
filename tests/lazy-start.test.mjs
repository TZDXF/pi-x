import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function harness() {
  const calls = []
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
    .split('<script setup lang="ts">')[1].split('</script>')[0]
    .replace(/^import[\s\S]*?from ["'][^"']+["']\s*$/gm, '')
  const context = vm.createContext({
    watch: () => {}, ref: value => ({ value }), onMounted: fn => { context.mount = fn }, onUnmounted: () => {},
    useI18n: () => ({ t: x => x }), isDesktop: true,
    useSessionStore: () => ({ clear() {}, init: async () => calls.push('init'), loadHistory: async () => {}, newSession: async () => calls.push('new') }),
    useWorkspaceStore: () => ({}), useUiStore: () => ({ clear() {}, pushToast() {} }),
    getConfig: async () => ({ lastProject: 'project' }),
    onPiEvent: async () => () => {}, onPiExit: async () => () => {}, onPiStderr: async () => () => {},
    trustStatus: async () => ({ needsDecision: false }), saveConfig: async () => {},
    spawnPi: async () => calls.push('spawn'), killPi: async () => {},
  })
  vm.runInContext(ts.transpile(source + '\nglobalThis.actions = { start, selectProject, newProjectSession, resumeSession };', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
  return { context, calls }
}
test('opening the app, selecting projects and drafting a new chat do not start pi', async () => {
  const { context, calls } = harness()
  await context.mount()
  await context.actions.selectProject('other')
  await context.actions.newProjectSession('other')
  assert.deepEqual(calls, [])
})
test('first conversation starts pi and reuses the initialized process', async () => {
  const { context, calls } = harness()
  await context.mount()
  assert.equal(await context.actions.start(), true)
  assert.equal(await context.actions.start(), true)
  assert.deepEqual(calls, ['spawn', 'init'])
})
test('opening a saved conversation starts pi on demand', async () => {
  const { context, calls } = harness()
  await context.mount()
  await context.actions.resumeSession('session.jsonl')
  assert.deepEqual(calls, ['spawn', 'init'])
})
