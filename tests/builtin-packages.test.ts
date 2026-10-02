import { test, expect } from "vitest"
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
  t.onTestFinished(() => scope.stop())
  return { api: scope.run(() => context.exports.usePackages(() => undefined)), saved }
}

test("built-in file tracking defaults to enabled and persists toggles", async t => {
  const { api, saved } = harness(t, { config: {} })
  await api.loadBuiltinPlugins()
  expect(api.builtinFileChanges.value).toBe(true)
  await api.setBuiltinFileChanges(false)
  expect(api.builtinFileChanges.value).toBe(false)
  expect(saved.at(-1).builtinFileChanges).toBe(false)
  // 关闭一个内置插件不应碰另一个的开关。
  expect(saved.at(-1).builtinDelayedSend).toBeUndefined()
})

test("built-in delayed send defaults to enabled and persists toggles", async t => {
  const { api, saved } = harness(t, { config: {} })
  await api.loadBuiltinPlugins()
  expect(api.builtinDelayedSend.value).toBe(true)
  await api.setBuiltinDelayedSend(false)
  expect(api.builtinDelayedSend.value).toBe(false)
  expect(saved.at(-1).builtinDelayedSend).toBe(false)
  await api.setBuiltinDelayedSend(true)
  expect(api.builtinDelayedSend.value).toBe(true)
  expect(saved.at(-1).builtinDelayedSend).toBe(true)
})

test("failed built-in toggle rolls back the switch", async t => {
  const { api } = harness(t, { config: { builtinFileChanges: true, builtinDelayedSend: true }, failSave: true })
  await api.loadBuiltinPlugins()
  await api.setBuiltinFileChanges(false)
  expect(api.builtinFileChanges.value).toBe(true)
  await api.setBuiltinDelayedSend(false)
  expect(api.builtinDelayedSend.value).toBe(true)
})
