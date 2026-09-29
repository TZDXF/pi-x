import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { computed, effectScope, onScopeDispose, ref, watch } from "vue"

function harness(t, packageCatalog) {
  const source = readFileSync(new URL("../src/components/settings/packages/usePackages.ts", import.meta.url), "utf8")
  const ast = ts.createSourceFile("usePackages.ts", source, ts.ScriptTarget.Latest, true)
  let script = source
  for (const node of ast.statements.filter(ts.isImportDeclaration).reverse()) {
    script = script.slice(0, node.getFullStart()) + script.slice(node.end)
  }
  const context = vm.createContext({
    exports: {},
    computed,
    onScopeDispose,
    ref,
    watch,
    setTimeout,
    clearTimeout,
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: () => {} }),
    useWorkspaceStore: () => ({ orderedProjects: () => [] }),
    packageCatalog,
  })
  vm.runInContext(ts.transpile(script, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  const scope = effectScope()
  t.onTestFinished(() => scope.stop())
  const api = scope.run(() => context.exports.usePackages(() => undefined))
  return { api, scope }
}

const pkg = name => ({ name, description: "excerpt", author: "author", types: ["extension"] })
const result = (names, hasMore = false) => ({ packages: names.map(pkg), hasMore })
const names = api => Array.from(api.catalog.value, p => p.name)
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

test("catalog searches the server, preserves server-only matches, and maps filters", async t => {
  const calls = []
  const { api } = harness(t, async (...args) => {
    calls.push(args)
    return result(["doompi-web-contracts"])
  })
  api.query.value = "  init  "
  api.sortBy.value = "updated"
  api.typeFilter.value = "skill"
  await api.loadCatalog()
  expect(calls).toEqual([["init", "recent", "skill", 1]])
  expect(names(api)).toEqual(["doompi-web-contracts"])
})

test("pagination retains results on failure, retries the same page, and deduplicates", async t => {
  const calls = []
  let fail = true
  const { api } = harness(t, async (...args) => {
    calls.push(args)
    if (args[3] === 1) return result(["first"], true)
    if (fail) {
      fail = false
      throw Error("offline")
    }
    return result(["first", "second"])
  })
  await api.loadCatalog()
  await api.loadMoreCatalog()
  expect(names(api)).toEqual(["first"])
  expect(api.catalogError.value).toMatch(/offline/)
  expect(api.catalogHasMore.value).toBe(true)
  await api.loadMoreCatalog()
  expect(names(api)).toEqual(["first", "second"])
  expect(calls.map(args => args[3])).toEqual([1, 2, 2])
  expect(api.catalogHasMore.value).toBe(false)
  expect(api.catalogError.value).toBe("")
})

for (const fails of [false, true]) {
  test(`stale ${fails ? "error" : "response"} cannot overwrite a newer query`, async t => {
    const old = deferred()
    const { api } = harness(t, query => (query === "" ? old.promise : Promise.resolve(result(["new"]))))
    const initial = api.loadCatalog()
    api.query.value = "new"
    await api.loadCatalog()
    if (fails) old.reject(Error("stale error"))
    else old.resolve(result(["old"], true))
    await initial
    expect(names(api)).toEqual(["new"])
    expect(api.catalogError.value).toBe("")
    expect(api.catalogHasMore.value).toBe(false)
    expect(api.catalogLoading.value).toBe(false)
  })
}

test("query changes invalidate in-flight responses before the debounce fires", async t => {
  const old = deferred()
  const { api } = harness(t, () => old.promise)
  const initial = api.loadCatalog()
  api.query.value = "init"
  old.resolve(result(["old"], true))
  await initial
  expect(names(api)).toEqual([])
  expect(api.catalogLoading.value).toBe(true)
  expect(api.catalogHasMore.value).toBe(false)
})

test("disposing the scope ignores pending catalog results", async t => {
  const pending = deferred()
  const { api, scope } = harness(t, () => pending.promise)
  const initial = api.loadCatalog()
  scope.stop()
  pending.resolve(result(["old"]))
  await initial
  expect(names(api)).toEqual([])
})
