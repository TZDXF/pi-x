import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function harness(group = null) {
  const calls = [], spawnArgs = []
  const workspace = { projectRoot: path => path, projectGroups: group ? { project: group } : {} }
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
    .split('<script setup lang="ts">')[1].split('</script>')[0]
    .replace(/^import[\s\S]*?from ["'][^"']+["']\s*$/gm, '')
  const stores = new Map()
  const activeRuntimeId = { value: 'default' }
  let seq = 0
  const sessionFor = id => {
    if (!stores.has(id)) stores.set(id, { runtimeId: id, started: false, cwd: '', entries: [], sessionFile: null,
      clear() {}, init: async () => calls.push('init'), loadHistory: async () => {}, loadOfflineModels: async () => {} })
    return stores.get(id)
  }
  const context = vm.createContext({
    watch: () => {}, ref: value => ({ value }), computed: def => ({ get value() { return (typeof def === 'function' ? def : def.get)() } }),
    onMounted: fn => { context.mount = fn }, onUnmounted: () => {},
    useI18n: () => ({ t: x => x }),
    useSessionStore: () => new Proxy({}, { get: (_, k) => sessionFor(activeRuntimeId.value)[k] }),
    useWorkspaceStore: () => workspace, useUiStore: () => ({ clear() {}, pushToast() {} }),
    sessionFor, uiFor: () => ({ pushToast() {}, handleRequest() {}, pushStderr() {} }),
    activeRuntimeId,
    activateSession: id => { sessionFor(id); activeRuntimeId.value = id },
    createConversation: project => { const id = 'rt' + (++seq); const s = sessionFor(id); s.cwd = project; activeRuntimeId.value = id; return s },
    findConversation: () => undefined,
    getConfig: async () => ({ lastProject: 'project' }),
    onPiEvent: async () => () => {}, onPiExit: async () => () => {}, onPiStderr: async () => () => {}, onReconnected: async () => () => {},
    trustStatus: async () => ({ needsDecision: false }), saveConfig: async () => {},
    spawnPi: async (...args) => { spawnArgs.push(args); calls.push('spawn') }, killPi: async () => {},
    listRunningSessions: async () => [], detectPi: async () => ({ found: true }),
    onSessionsChanged: async () => () => {}, sessionMtime: async () => 0,
    registerSessionMtimeSync: () => {}, useRoute: () => ({}), navigate: () => {},
  })
  vm.runInContext(ts.transpile(source + '\nglobalThis.actions = { start, selectProject, newProjectSession, resumeSession };', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
  return { context, calls, spawnArgs, workspace }
}
test('opening the app, selecting projects and drafting a new chat do not start pi', async () => {
  const { context, calls } = harness()
  await context.mount()
  await context.actions.selectProject('other')
  await context.actions.newProjectSession('other')
  assert.deepEqual(calls, [])
})
test('clicking new session reuses the pristine draft until a message is sent', async () => {
  const { context, calls } = harness()
  await context.mount()
  await context.actions.newProjectSession('project')
  assert.equal(context.activeRuntimeId.value, 'rt1')
  await context.actions.newProjectSession('project')
  assert.equal(context.activeRuntimeId.value, 'rt1')
  context.sessionFor('rt1').entries = [{ kind: 'user' }]
  await context.actions.newProjectSession('project')
  assert.equal(context.activeRuntimeId.value, 'rt2')
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

 test('only fresh process startup applies remembered selection', () => {
  const source = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8')
  assert.match(source, /await spawnWorkspacePi\(project.value, undefined, owner.runtimeId\)\s+await owner.init\(project.value, true\)/)
  assert.equal((source.match(/\.init\(project.value, true\)/g) || []).length, 1)
})

test('a grouped project passes every root to Pi and refreshes context on the next prompt after edits', async () => {
  const group = { name: 'Both', primary: 'project', folders: ['project', 'other'] }
  const { context, calls, spawnArgs } = harness(group)
  await context.mount()
  await context.actions.selectProject('project')
  assert.equal(await context.actions.start(), true)
  assert.ok(spawnArgs[0][3], JSON.stringify(spawnArgs))
  assert.deepEqual(Array.from(spawnArgs[0][3].roots), ['project', 'other'])
  assert.equal(spawnArgs[0][3].name, 'Both')
  context.sessionFor(context.activeRuntimeId.value).sessionFile = 'saved.jsonl'
  group.name = 'Renamed'
  assert.equal(await context.actions.start(), true)
  assert.equal(spawnArgs[1][3].name, 'Renamed')
  assert.deepEqual(calls, ['spawn', 'init', 'spawn', 'init'])
})
