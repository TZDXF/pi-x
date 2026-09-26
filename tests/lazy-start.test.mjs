import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
function harness(group = null) {
  const calls = [], spawnArgs = []
  const workspace = { projectRoot: path => path, projectName: path => path, projectGroups: group ? { project: group } : {} }
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
    useI18n: () => ({ t: x => x, locale: { value: 'en' } }),
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
  vm.runInContext(ts.transpile(source + '\nglobalThis.actions = { start, selectProject, newProjectSession, resumeSession, selectQueuedConversation, connecting, selectingProject, phase };', { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }), context)
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
  assert.equal(spawnArgs[0].length, 4, 'worker startup has no tool-permission arguments')
  assert.deepEqual(Array.from(spawnArgs[0][3].roots), ['project', 'other'])
  assert.equal(spawnArgs[0][3].name, 'Both')
  context.sessionFor(context.activeRuntimeId.value).sessionFile = 'saved.jsonl'
  group.name = 'Renamed'
  assert.equal(await context.actions.start(), true)
  assert.equal(spawnArgs[1][3].name, 'Renamed')
  assert.deepEqual(calls, ['spawn', 'init', 'spawn', 'init'])
})

test('cross-project drafts stay visible during checks while sending remains blocked', async () => {
  const { context, calls } = harness()
  await context.mount()
  let resolveTrust
  context.trustStatus = () => new Promise(resolve => { resolveTrust = resolve })
  const pending = context.actions.newProjectSession('other')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(context.sessionFor(context.activeRuntimeId.value).cwd, 'other')
  assert.equal(context.actions.phase.value, 'chat')
  assert.equal(context.actions.selectingProject.value, true)
  assert.equal(context.actions.connecting.value, true)
  assert.equal(await context.actions.start(), false)
  assert.deepEqual(calls, [])
  resolveTrust({ needsDecision: true })
  await pending
  assert.equal(context.actions.phase.value, 'trust')
  assert.equal(await context.actions.start(), false)
  assert.equal(context.actions.selectingProject.value, false)
  assert.equal(context.actions.connecting.value, false)
  assert.deepEqual(calls, [])
  const view = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  assert.equal(view.split('(!connecting || selectingProject)').length - 1, 2)
  assert.match(view, /:disabled="editBusy \|\| workspace.gitBusy \|\| connecting"/)
})


test('project selection keeps the editor enabled without bypassing other edit guards', () => {
  const view = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  const editor = view.split('<ComposerRichEditor')[1].split('/>')[0]
  const expression = editor.match(/:disabled="([^"]+)"/)[1]
  const disabled = values => vm.runInNewContext(expression, values)
  const state = { editBusy: false, workspace: { gitBusy: false }, connecting: true, selectingProject: true, completion: null }
  assert.equal(disabled(state), false)
  assert.equal(disabled({ ...state, selectingProject: false }), true)
  assert.equal(disabled({ ...state, editBusy: true }), true)
  assert.equal(disabled({ ...state, workspace: { gitBusy: true } }), true)
})

test('disabled accessory buttons do not dim the entire composer', () => {
  const group = readFileSync(new URL('../src/components/ui/input-group/InputGroup.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(group, /has-disabled:/)
  for (const style of ['bg-input/50', 'bg-input/80', 'opacity-50']) {
    assert.ok(group.includes(`has-[[data-slot=input-group-control]:disabled]:${style}`))
  }
  const editor = readFileSync(new URL('../src/components/ComposerRichEditor.vue', import.meta.url), 'utf8')
  assert.ok(editor.includes('aria-disabled:opacity-50'))
})

test('resuming across projects selects the saved identity before startup and loads history in parallel', async () => {
  const { context } = harness()
  await context.mount()
  let releaseSpawn
  context.spawnPi = () => new Promise(resolve => { releaseSpawn = resolve })
  const pending = context.actions.resumeSession('saved.jsonl', 'other')
  const owner = context.sessionFor(context.activeRuntimeId.value)
  assert.equal(owner.sessionFile, 'saved.jsonl')
  assert.equal(owner.cwd, 'other')
  assert.equal(context.actions.selectingProject.value, false)
  // Wait for trust/config checks to reach worker startup.
  for (let i = 0; i < 20 && !releaseSpawn; i++) await Promise.resolve()
  assert.ok(releaseSpawn)
  let releaseInit
  let historyLoaded = false
  owner.clear = () => { owner.sessionFile = null }
  owner.init = () => new Promise(resolve => { releaseInit = resolve })
  owner.loadHistory = async () => { historyLoaded = true }
  releaseSpawn()
  for (let i = 0; i < 20 && !releaseInit; i++) await Promise.resolve()
  assert.equal(historyLoaded, true)
  assert.equal(owner.sessionFile, 'saved.jsonl')
  releaseInit()
  await pending
  assert.equal(owner.started, true)
})


test('selecting a queued new conversation reattaches its runtime without clearing or restarting', async () => {
  const { context, calls } = harness()
  await context.mount()
  const pending = context.sessionFor(context.activeRuntimeId.value)
  pending.started = true
  pending.promptQueue = [{ text: 'later', sendAt: Date.now() + 60000 }]
  const id = context.activeRuntimeId.value
  await context.actions.newProjectSession('project')
  assert.notEqual(context.activeRuntimeId.value, id)
  await context.actions.selectQueuedConversation(id)
  assert.equal(context.activeRuntimeId.value, id)
  assert.equal(pending.promptQueue.length, 1)
  assert.deepEqual(calls, [])
})
