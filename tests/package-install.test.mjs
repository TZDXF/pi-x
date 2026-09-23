import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(currentProject = 'C:/chat-project') {
  const component = readFileSync(new URL('../src/components/PackageSettings.vue', import.meta.url), 'utf8')
  const script = component.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
  const ast = ts.createSourceFile('PackageSettings.ts', script, ts.ScriptTarget.Latest, true)
  let withoutImports = script
  for (const node of ast.statements.filter(ts.isImportDeclaration).reverse()) {
    withoutImports = withoutImports.slice(0, node.getFullStart()) + withoutImports.slice(node.end)
  }
  const calls = []
  let fail = false
  const context = vm.createContext({
    defineProps: () => ({ active: false, project: currentProject }),
    ref: value => ({ value }),
    computed: getter => ({ get value() { return getter() } }),
    watch: () => {},
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: () => {} }),
    useWorkspaceStore: () => ({ orderedProjects: () => ['C:/recent-project'] }),
    currentLocale: () => 'en',
    packageNameOf: source => source.replace(/^npm:/, ''),
    packageInstall: async (...args) => { calls.push(args); if (fail) throw Error('install failed') },
    packageList: async project => project ? [{ source: 'npm:test', scope: 'project' }] : [],
    isDesktop: false,
    window: { prompt: () => null },
  })
  const code = ts.transpile(withoutImports + `\nglobalThis.api = { chooseProjectForInstall, confirmProjectInstall, installCustom, installTarget, pendingProjectSource, customScope, customSource, viewedProject, installed, recentProjects };`, { target: ts.ScriptTarget.ES2022 })
  vm.runInContext(code, context)
  return { api: context.api, calls, fail: value => { fail = value } }
}

test('project install waits for an explicit target instead of using the chat project', async () => {
  const h = harness()
  h.api.chooseProjectForInstall('npm:pi-mcp-adapter')
  assert.equal(h.api.installTarget.value, '')
  await h.api.confirmProjectInstall()
  assert.equal(h.calls.length, 0)
  h.api.installTarget.value = 'C:/recent-project'
  await h.api.confirmProjectInstall()
  assert.deepEqual(h.calls, [['npm:pi-mcp-adapter', 'project', 'C:/recent-project']])
  assert.equal(h.api.viewedProject.value, 'C:/recent-project')
  assert.equal(h.api.pendingProjectSource.value, '')
})

test('custom project install asks for a target and preserves it on failure', async () => {
  const h = harness()
  h.api.customScope.value = 'project'
  h.api.customSource.value = 'npm:other'
  await h.api.installCustom()
  assert.equal(h.calls.length, 0)
  assert.equal(h.api.pendingProjectSource.value, 'npm:other')
  h.api.installTarget.value = 'C:/other-project'
  h.fail(true)
  await h.api.confirmProjectInstall()
  assert.equal(h.api.pendingProjectSource.value, 'npm:other')
  assert.equal(h.api.customSource.value, 'npm:other')
  h.fail(false)
  await h.api.confirmProjectInstall()
  assert.equal(h.api.customSource.value, '')
  assert.equal(h.api.pendingProjectSource.value, '')
})
