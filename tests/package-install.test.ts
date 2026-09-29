import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(currentProject = "C:/chat-project") {
  const source = readFileSync(new URL("../src/components/settings/packages/usePackages.ts", import.meta.url), "utf8")
  const ast = ts.createSourceFile("usePackages.ts", source, ts.ScriptTarget.Latest, true)
  let withoutImports = source
  for (const node of ast.statements.filter(ts.isImportDeclaration).reverse()) {
    withoutImports = withoutImports.slice(0, node.getFullStart()) + withoutImports.slice(node.end)
  }
  const calls = []
  let fail = false
  const context = vm.createContext({
    ref: value => ({ value }),
    computed: getter => ({
      get value() {
        return typeof getter === "function" ? getter() : getter.get()
      },
    }),
    watch: () => {},
    onScopeDispose: () => {},
    useI18n: () => ({ t: key => key }),
    useUiStore: () => ({ pushToast: () => {} }),
    useWorkspaceStore: () => ({ orderedProjects: () => ["C:/recent-project"] }),
    currentLocale: () => "en",
    getProject: () => currentProject,
    packageCatalog: async () => ({ packages: [], hasMore: false }),
    packageList: async project => (project ? [{ source: "npm:test", scope: "project" }] : []),
    packageInstall: async (...args) => {
      calls.push(args)
      if (fail) throw Error("install failed")
    },
    packageRemove: async () => {},
    packageUpdate: async () => {},
    packageNameOf: source => source.replace(/^npm:/, ""),
  })
  const code = ts.transpile(withoutImports.replace(/^export /gm, "") + "\nglobalThis.api = usePackages(getProject);", {
    target: ts.ScriptTarget.ES2022,
  })
  vm.runInContext(code, context)
  return {
    api: context.api,
    calls,
    fail: value => {
      fail = value
    },
  }
}

test("project install waits for an explicit target instead of using the chat project", async () => {
  const h = harness()
  h.api.chooseProjectForInstall("npm:pi-mcp-adapter")
  expect(h.api.pendingProjectSource.value).toBe("npm:pi-mcp-adapter")
  await h.api.confirmProjectInstall("")
  expect(h.calls.length).toBe(0)
  await h.api.confirmProjectInstall("C:/recent-project")
  expect(h.calls).toEqual([["npm:pi-mcp-adapter", "project", "C:/recent-project"]])
  expect(h.api.viewedProject.value).toBe("C:/recent-project")
  expect(h.api.pendingProjectSource.value).toBe("")
})

test("custom project install asks for a target and preserves it on failure", async () => {
  const h = harness()
  h.api.customScope.value = "project"
  h.api.customSource.value = "npm:other"
  await h.api.installCustom()
  expect(h.calls.length).toBe(0)
  expect(h.api.pendingProjectSource.value).toBe("npm:other")
  h.fail(true)
  await h.api.confirmProjectInstall("C:/other-project")
  expect(h.api.pendingProjectSource.value).toBe("npm:other")
  expect(h.api.customSource.value).toBe("npm:other")
  h.fail(false)
  await h.api.confirmProjectInstall("C:/other-project")
  expect(h.api.customSource.value).toBe("")
  expect(h.api.pendingProjectSource.value).toBe("")
})
