import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness(currentProject = 'C:/chat-project') {
  const source = readFileSync(new URL('../src/components/settings/packages/usePackages.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('usePackages.ts', source, ts.ScriptTarget.Latest, true)
  let withoutImports = source
  for (const node of ast.statements.filter(ts.isImportDeclaration).reverse()) {
    withoutImports = withoutImports.slice(0, node.getFullStart()) + withoutImports.slice(node.end)
  }
  const calls = []
  let fail = false
  const context = vm.createContext({
    ref: value => ({ value }),
    computed: getter => ({ get value() { return typeof getter === 'function' ? getter() : getter.get() } }),
    watch: () => {},
    onScopeDispose: () => {},
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: () => {} }),
    useWorkspaceStore: () => ({ orderedProjects: () => ['C:/recent-project'] }),
    currentLocale: () => 'en',
    getProject: () => currentProject,
    packageCatalog: async () => ({ packages: [], hasMore: false }),
    packageList: async project => project ? [{ source: 'npm:test', scope: 'project' }] : [],
    packageInstall: async (...args) => { calls.push(args); if (fail) throw Error('install failed') },
    packageRemove: async () => {},
    packageUpdate: async () => {},
    packageNameOf: source => source.replace(/^npm:/, ''),
  })
  const code = ts.transpile(withoutImports.replace(/^export /gm, '') + '\nglobalThis.api = usePackages(getProject);', { target: ts.ScriptTarget.ES2022 })
  vm.runInContext(code, context)
  return { api: context.api, calls, fail: value => { fail = value } }
}

test('project install waits for an explicit target instead of using the chat project', async () => {
  const h = harness()
  h.api.chooseProjectForInstall('npm:pi-mcp-adapter')
  assert.equal(h.api.pendingProjectSource.value, 'npm:pi-mcp-adapter')
  await h.api.confirmProjectInstall('')
  assert.equal(h.calls.length, 0)
  await h.api.confirmProjectInstall('C:/recent-project')
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
  h.fail(true)
  await h.api.confirmProjectInstall('C:/other-project')
  assert.equal(h.api.pendingProjectSource.value, 'npm:other')
  assert.equal(h.api.customSource.value, 'npm:other')
  h.fail(false)
  await h.api.confirmProjectInstall('C:/other-project')
  assert.equal(h.api.customSource.value, '')
  assert.equal(h.api.pendingProjectSource.value, '')
})
