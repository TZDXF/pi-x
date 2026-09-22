import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(initial = {}, commands = [], component = "SkillSettings") {
  const source = readFileSync(new URL(`../src/components/${component}.vue`, import.meta.url), 'utf8')
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1].replace(/^import .*$/gm, '')
  let config = initial, mount, failRead = false, failWrite = false
  let promptFile = config.__promptFile ?? ''
  delete config.__promptFile
  const toasts = []
  const context = vm.createContext({
    ref: value => ({ value }), computed: fn => ({ get value() { return fn() } }),
    onMounted: fn => { mount = fn }, useI18n: () => ({ t: key => key }),
    useSessionStore: () => ({ commands }), useUiStore: () => ({ pushToast: (...args) => toasts.push(args) }),
    getConfig: async () => { if (failRead) throw Error('read failure'); return config },
    saveConfig: async value => { if (failWrite) throw Error('write failure'); config = value },
    getGlobalPrompt: async () => { if (failRead) throw Error('read failure'); return promptFile },
    saveGlobalPrompt: async value => { if (failWrite) throw Error('write failure'); promptFile = value },
    open: async () => null,
  })
  const fields = component === 'AgentSettings' ? 'prompt, error, dirty, saving, load, save' : 'managed, skills, loaded, error, dirty, saving, load, save, add, setManaged, chooseSkills'
  vm.runInContext(ts.transpile(source + `\nglobalThis.api = { ${fields} };`, { target: ts.ScriptTarget.ES2022 }), context)
  return { api: context.api, mount: () => mount(), config: () => config, prompt: () => promptFile, setPrompt: value => { promptFile = value }, toasts,
    failRead: value => { failRead = value }, failWrite: value => { failWrite = value } }
}

test('configuration retains automatic discovery and editing preserves unrelated settings', async () => {
  const h = harness({ piPath: 'custom-pi', defaultModel: { provider: 'p', modelId: 'm' } })
  await h.mount()
  assert.equal(h.api.managed.value, false)
  await h.api.save()
  assert.equal(h.config().piPath, 'custom-pi')
  assert.equal(h.config().defaultModel.modelId, 'm')
  assert.equal(h.config().managedSkills, null)
})

test('manual discovery imports skills only, deduplicates paths, and preserves disabled choices', async () => {
  const h = harness({}, [
    { source: 'skill', path: 'C:\\skills\\SKILL.md', name: 'skill' },
    { source: 'extension', path: 'C:/extension.ts', name: 'extension' },
  ])
  await h.mount()
  h.api.setManaged(true)
  h.api.add(['C:/skills/SKILL.md'])
  assert.equal(h.api.skills.value.length, 1)
  h.api.skills.value[0].enabled = false
  await h.api.save()
  assert.equal(h.config().managedSkills[0].enabled, false)
  await h.mount()
  assert.equal(h.api.skills.value[0].enabled, false)
})

test('empty manual list is distinct from automatic discovery', async () => {
  const h = harness({ managedSkills: [] })
  await h.mount()
  assert.equal(h.api.managed.value, true)
  await h.api.save()
  assert.equal(h.config().managedSkills.length, 0)
  h.api.setManaged(false)
  await h.api.save()
  assert.equal(h.config().managedSkills, null)
})

test('editing a skill does not mutate persisted data before save', async () => {
  const h = harness({ managedSkills: [{ path: 'C:/SKILL.md', enabled: true }] })
  await h.mount()
  h.api.skills.value[0].enabled = false
  assert.equal(h.config().managedSkills[0].enabled, true)
})

test('load failures support retry and failed saves keep unsaved changes', async () => {
  const h = harness()
  h.failRead(true)
  await h.mount()
  assert.match(h.api.error.value, /read failure/)
  h.failRead(false)
  await h.api.load()
  assert.equal(h.api.error.value, '')
  h.api.add(['C:/SKILL.md'])
  h.failWrite(true)
  await h.api.save()
  assert.equal(h.api.dirty.value, true)
  assert.equal(h.api.saving.value, false)
  assert.equal(h.toasts.at(-1)[1], 'error')
})

test('canceling file picker changes nothing', async () => {
  const h = harness()
  await h.mount()
  await h.api.chooseSkills()
  assert.equal(h.api.dirty.value, false)
})

test('prompt page saves and clears prompt without changing skills', async () => {
  const skills = [{ path: 'C:/SKILL.md', enabled: false }]
  const h = harness({ __promptFile: 'old', managedSkills: skills, piPath: 'pi' }, [], 'AgentSettings')
  await h.mount()
  assert.equal(h.api.prompt.value, 'old')
  h.api.prompt.value = '中文'
  await h.api.save()
  assert.equal(h.prompt(), '中文')
  assert.equal(h.config().managedSkills, skills)
  h.api.prompt.value = ''
  await h.api.save()
  assert.equal(h.prompt(), '')
  assert.equal(h.config().piPath, 'pi')
})

test('skills settings remain independent from the prompt file', async () => {
  const h = harness({ __promptFile: 'old' })
  await h.mount()
  h.setPrompt('updated elsewhere')
  h.api.setManaged(true)
  await h.api.save()
  assert.equal(h.prompt(), 'updated elsewhere')
})

test('settings exposes separate prompt and skills pages', () => {
  const settings = readFileSync(new URL('../src/components/SettingsDialog.vue', import.meta.url), 'utf8')
  assert.match(settings, /TabsTrigger[^>]*value="skills"/)
  assert.match(settings, /TabsContent[^>]*value="skills"[^>]*>\s*<SkillSettings/)
  const prompt = readFileSync(new URL('../src/components/AgentSettings.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(prompt, /managedSkills|manage-skills/)
})
