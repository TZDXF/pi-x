import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(initial = {}, commands = [], component = "SkillSettings") {
  const source = readFileSync(new URL(`../src/components/${component}.vue`, import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
  let config = initial, mount, failRead = false, failWrite = false, askResult = true
  let promptFile = config.__promptFile ?? ''
  delete config.__promptFile
  const toasts = []
  const hosted = config.__hosted ?? []
  delete config.__hosted
  let savedEnabled = null
  let importCalls = []
  let nextImportConflicts = []
  let deletedPaths = []
  const context = vm.createContext({
    ref: value => ({ value }), computed: fn => ({ get value() { return fn() } }),
    onMounted: fn => { mount = fn }, useI18n: () => ({ t: (key) => key }),
    useSessionStore: () => ({ commands }), useUiStore: () => ({ pushToast: (...args) => toasts.push(args) }),
    listHostedSkills: async () => { if (failRead) throw Error('read failure'); return hosted },
    setHostedSkillsEnabled: async paths => { if (failWrite) throw Error('write failure'); savedEnabled = paths },
    importHostedSkills: async (sources, overwrite) => {
      importCalls.push({ sources, overwrite })
      const conflicts = overwrite ? [] : nextImportConflicts
      nextImportConflicts = []
      return { imported: overwrite ? sources : sources.filter(s => !conflicts.includes(s)), conflicts }
    },
    deleteHostedSkill: async path => { if (failWrite) throw Error('write failure'); deletedPaths.push(path) },
    ask: async () => askResult,
    open: async () => null,
    getConfig: async () => { if (failRead) throw Error('read failure'); return config },
    saveConfig: async value => { if (failWrite) throw Error('write failure'); config = value },
    getGlobalPrompt: async () => { if (failRead) throw Error('read failure'); return promptFile },
    saveGlobalPrompt: async value => { if (failWrite) throw Error('write failure'); promptFile = value },
  })
  const fields = component === 'AgentSettings' ? 'prompt, error, dirty, saving, load, save' : 'skills, loaded, error, busy, load, toggle, remove, runImport, chooseSources, importLoaded'
  vm.runInContext(ts.transpile(source + `\nglobalThis.api = { ${fields} };`, { target: ts.ScriptTarget.ES2022 }), context)
  return {
    api: context.api, mount: () => mount(), config: () => config, prompt: () => promptFile, setPrompt: value => { promptFile = value }, toasts,
    failRead: value => { failRead = value }, failWrite: value => { failWrite = value },
    hosted, askResult: value => { askResult = value }, savedEnabled: () => savedEnabled,
    importCalls: () => importCalls, deletedPaths: () => deletedPaths,
    queueConflicts: names => { nextImportConflicts = names },
  }
}

test('hosted skills load from the .pix store and enabled paths come from Pi', async () => {
  const skill = { name: 'my-skill', description: 'd', path: 'C:/Users/u/.pix/skills/my-skill', kind: 'directory', enabled: true }
  const h = harness({ __hosted: [skill] })
  await h.mount()
  assert.equal(h.api.skills.value.length, 1)
  assert.equal(h.api.skills.value[0].enabled, true)
  assert.equal(h.api.error.value, '')
})

test('toggling enables by registering paths in Pi settings; failure reverts', async () => {
  const enabled = { name: 'on', description: '', path: 'C:/Users/u/.pix/skills/on', kind: 'file', enabled: true }
  const disabled = { name: 'off', description: '', path: 'C:/Users/u/.pix/skills/off', kind: 'directory', enabled: false }
  const h = harness({ __hosted: [enabled, disabled] })
  await h.mount()

  await h.api.toggle(disabled, true)
  assert.equal(disabled.enabled, true)
  assert.deepEqual(h.savedEnabled(), [enabled.path, disabled.path])

  h.failWrite(true)
  await h.api.toggle(disabled, false)
  assert.equal(disabled.enabled, true, 'optimistic change is reverted on failure')
  assert.equal(h.toasts.at(-1)[1], 'error')
})

test('importing reports conflicts and overwrite needs confirmation', async () => {
  const h = harness()
  h.askResult(false)
  await h.mount()
  h.queueConflicts(['dup'])
  await h.api.runImport(['C:/skills/dup'])
  assert.deepEqual(h.importCalls()[0], { sources: ['C:/skills/dup'], overwrite: false })
  assert.equal(h.importCalls().length, 1, 'no overwrite until confirmed')

  h.askResult(true)
  h.queueConflicts(['dup'])
  await h.api.runImport(['C:/skills/dup'])
  assert.equal(h.importCalls().length, 3)
  assert.deepEqual(h.importCalls()[2], { sources: ['C:/skills/dup'], overwrite: true })
  assert.match(h.toasts.at(-1)[0], /skillsConfig\.imported/)

  h.askResult(false)
  h.queueConflicts(['dup'])
  await h.api.runImport(['C:/skills/dup'])
  assert.equal(h.importCalls().length, 4, 'declining keeps the overwrite off')
  assert.equal(h.importCalls()[3].overwrite, false)
})

test('canceling the picker changes nothing and deleting requires confirmation', async () => {
  const skill = { name: 'gone', description: '', path: 'C:/Users/u/.pix/skills/gone', kind: 'file', enabled: false }
  const h = harness({ __hosted: [skill] })
  await h.mount()

  await h.api.chooseSources()
  assert.equal(h.importCalls().length, 0)

  h.askResult(false)
  await h.api.remove(skill)
  assert.deepEqual(h.deletedPaths(), [])

  h.askResult(true)
  await h.api.remove(skill)
  assert.deepEqual(h.deletedPaths(), [skill.path])
})

test('load failures support retry', async () => {
  const h = harness()
  h.failRead(true)
  await h.mount()
  assert.match(h.api.error.value, /read failure/)
  h.failRead(false)
  await h.api.load()
  assert.equal(h.api.error.value, '')
})

test('prompt page saves and clears prompt without touching hosted skills', async () => {
  const h = harness({ __promptFile: 'old', piPath: 'pi' }, [], 'AgentSettings')
  await h.mount()
  assert.equal(h.api.prompt.value, 'old')
  h.api.prompt.value = '中文'
  await h.api.save()
  assert.equal(h.prompt(), '中文')
  assert.equal(h.config().piPath, 'pi')
  h.api.prompt.value = ''
  await h.api.save()
  assert.equal(h.prompt(), '')
})

test('settings exposes separate prompt and skills pages', () => {
  const settings = readFileSync(new URL('../src/components/SettingsPage.vue', import.meta.url), 'utf8')
  assert.match(settings, /selectTab\('skills'\)/)
  assert.match(settings, /<SkillSettings v-else-if="isDesktop && tab === 'skills'"/)
  const prompt = readFileSync(new URL('../src/components/AgentSettings.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(prompt, /managedSkills|manage-skills/)
})
