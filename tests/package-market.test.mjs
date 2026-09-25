import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import { computed, effectScope, onScopeDispose, ref, watch } from 'vue'

function harness(t, packageCatalog) {
  const source = readFileSync(new URL('../src/components/settings/packages/usePackages.ts', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('usePackages.ts', source, ts.ScriptTarget.Latest, true)
  let script = source
  for (const node of ast.statements.filter(ts.isImportDeclaration).reverse()) {
    script = script.slice(0, node.getFullStart()) + script.slice(node.end)
  }
  const context = vm.createContext({
    exports: {}, computed, onScopeDispose, ref, watch, setTimeout, clearTimeout,
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: () => {} }),
    useWorkspaceStore: () => ({ orderedProjects: () => [] }),
    packageCatalog,
  })
  vm.runInContext(ts.transpile(script, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  const scope = effectScope()
  t.after(() => scope.stop())
  const api = scope.run(() => context.exports.usePackages(() => undefined))
  return { api, scope }
}

const pkg = name => ({ name, description: 'excerpt', author: 'author', types: ['extension'] })
const result = (names, hasMore = false) => ({ packages: names.map(pkg), hasMore })
const names = api => Array.from(api.catalog.value, p => p.name)
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('catalog searches the server, preserves server-only matches, and maps filters', async t => {
  const calls = []
  const { api } = harness(t, async (...args) => { calls.push(args); return result(['doompi-web-contracts']) })
  api.query.value = '  init  '
  api.sortBy.value = 'updated'
  api.typeFilter.value = 'skill'
  await api.loadCatalog()
  assert.deepEqual(calls, [['init', 'recent', 'skill', 1]])
  assert.deepEqual(names(api), ['doompi-web-contracts'])
})

test('pagination retains results on failure, retries the same page, and deduplicates', async t => {
  const calls = []
  let fail = true
  const { api } = harness(t, async (...args) => {
    calls.push(args)
    if (args[3] === 1) return result(['first'], true)
    if (fail) { fail = false; throw Error('offline') }
    return result(['first', 'second'])
  })
  await api.loadCatalog()
  await api.loadMoreCatalog()
  assert.deepEqual(names(api), ['first'])
  assert.match(api.catalogError.value, /offline/)
  assert.equal(api.catalogHasMore.value, true)
  await api.loadMoreCatalog()
  assert.deepEqual(names(api), ['first', 'second'])
  assert.deepEqual(calls.map(args => args[3]), [1, 2, 2])
  assert.equal(api.catalogHasMore.value, false)
  assert.equal(api.catalogError.value, '')
})

for (const fails of [false, true]) {
  test(`stale ${fails ? 'error' : 'response'} cannot overwrite a newer query`, async t => {
    const old = deferred()
    const { api } = harness(t, query => query === '' ? old.promise : Promise.resolve(result(['new'])))
    const initial = api.loadCatalog()
    api.query.value = 'new'
    await api.loadCatalog()
    if (fails) old.reject(Error('stale error'))
    else old.resolve(result(['old'], true))
    await initial
    assert.deepEqual(names(api), ['new'])
    assert.equal(api.catalogError.value, '')
    assert.equal(api.catalogHasMore.value, false)
    assert.equal(api.catalogLoading.value, false)
  })
}

test('query changes invalidate in-flight responses before the debounce fires', async t => {
  const old = deferred()
  const { api } = harness(t, () => old.promise)
  const initial = api.loadCatalog()
  api.query.value = 'init'
  old.resolve(result(['old'], true))
  await initial
  assert.deepEqual(names(api), [])
  assert.equal(api.catalogLoading.value, true)
  assert.equal(api.catalogHasMore.value, false)
})

test('disposing the scope ignores pending catalog results', async t => {
  const pending = deferred()
  const { api, scope } = harness(t, () => pending.promise)
  const initial = api.loadCatalog()
  scope.stop()
  pending.resolve(result(['old']))
  await initial
  assert.deepEqual(names(api), [])
})
