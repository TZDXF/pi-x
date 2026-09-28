import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { computed, effectScope, onScopeDispose, ref, watch } from "vue"

function harness(t, options = {}) {
  const source = readFileSync(new URL("../src/components/settings/packages/usePackages.ts", import.meta.url), "utf8")
  const ast = ts.createSourceFile("usePackages.ts", source, ts.ScriptTarget.Latest, true)
  let script = source
  for (const node of ast.statements.filter(ts.isImportDeclaration).reverse())
    script = script.slice(0, node.getFullStart()) + script.slice(node.end)
  const saved = []
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
    packageCatalog: async () => ({ packages: [], hasMore: false }),
    packageList: async () => [],
    packageInstall: async () => "",
    packageRemove: async () => "",
    packageUpdate: async () => "",
    packageNameOf: value => value,
    getConfig: async () => options.config ?? {},
    saveConfig: async config => {
      if (options.failSave) throw Error("save failed")
      saved.push(config)
    },
    currentLocale: () => "en",
  })
  vm.runInContext(ts.transpile(script, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }), context)
  const scope = effectScope()
  t.after(() => scope.stop())
  return { api: scope.run(() => context.exports.usePackages(() => undefined)), saved }
}

test("built-in file tracking defaults to enabled and persists toggles", async t => {
  const { api, saved } = harness(t, { config: {} })
  await api.loadBuiltinPlugins()
  assert.equal(api.builtinFileChanges.value, true)
  await api.setBuiltinFileChanges(false)
  assert.equal(api.builtinFileChanges.value, false)
  assert.equal(saved.at(-1).builtinFileChanges, false)
})

test("failed built-in toggle rolls back the switch", async t => {
  const { api } = harness(t, { config: { builtinFileChanges: true }, failSave: true })
  await api.loadBuiltinPlugins()
  await api.setBuiltinFileChanges(false)
  assert.equal(api.builtinFileChanges.value, true)
})
