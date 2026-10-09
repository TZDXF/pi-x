import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { parse, compileScript } from "vue/compiler-sfc"
import { transpileModule, ModuleKind, ScriptTarget } from "typescript"
import { reactive } from "vue"
import * as vueRuntime from "vue"
import reviewSource from "@/components/ReviewPanel.vue?raw"
import * as reviewFileTree from "@/lib/reviewFileTree"
import * as paths from "@/lib/paths"
import * as sessionChanges from "@/lib/sessionChanges"

async function loadVueSetup(source, props, require) {
  const { descriptor } = parse(source, { filename: "ReviewPanel.vue" })
  const compiled = compileScript(descriptor, { id: "review-panel-test" }).content
  const output = transpileModule(compiled, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  const requireModule = id => (id in require ? require[id] : {})
  new Function("exports", "require", "module", "__filename", "__dirname", output)(
    module.exports,
    requireModule,
    module,
    "ReviewPanel.vue",
    import.meta.dirname,
  )
  return module.exports.default.setup(props, { expose: () => {}, emit: () => {} })
}

async function harness(changes) {
  const props = reactive({ changes })
  const bindings = await loadVueSetup(reviewSource, props, {
    vue: { ...vueRuntime, onMounted: () => {}, onBeforeUnmount: () => {}, watch: () => {} },
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@/lib/reviewFileTree": reviewFileTree,
    "@/lib/paths": paths,
    "@/lib/sessionChanges": sessionChanges,
  })
  return { props, ...bindings }
}

const change = (id, path, added = 1, removed = 0) => ({ id, path, added, removed, lines: [], tool: "edit" })
test("review defaults to first file, groups operations, and switches selection", async () => {
  const h = await harness([change("a", "src/a.ts"), change("b", "src/b.ts"), change("c", "src/a.ts", 2, 1)])
  expect(h.files.value.length).toBe(2)
  expect(h.activeFile.value.path).toBe("src/a.ts")
  expect(h.activeFile.value.changes.length).toBe(2)
  expect(h.activeFile.value.added).toBe(3)
  expect(h.activeFile.value.removed).toBe(1)
  h.selectedPath.value = "src/b.ts"
  expect(h.activeFile.value.path).toBe("src/b.ts")
})
test("selection survives new operations and falls back on session switch or clear", async () => {
  const h = await harness([change("a", "a.ts"), change("b", "b.ts")])
  h.selectedPath.value = "b.ts"
  h.props.changes.push(change("c", "c.ts"), change("d", "b.ts", 4))
  expect(h.activeFile.value.path).toBe("b.ts")
  expect(h.activeFile.value.added).toBe(5)
  h.props.changes = [change("new", "other.ts")]
  expect(h.activeFile.value.path).toBe("other.ts")
  h.props.changes = []
  expect(h.activeFile.value).toBe(null)
})
test("file list shows basenames while keeping full paths as identities", async () => {
  const h = await harness([change("a", "src/lib/index.ts"), change("b", "src/components/index.ts")])
  expect(h.fileRows.value[0].name).toBe("index.ts")
  expect(h.fileRows.value[1].name).toBe("index.ts")
  h.selectRow(h.fileRows.value[1])
  expect(h.activeFile.value.path).toBe("src/components/index.ts")
  expect(reviewSource.includes(':title="row.fullPath"')).toBeTruthy()
})

test("review panes use themed scroll areas; split mode scrolls horizontally per pane", () => {
  const diff = readFileSync(new URL("../src/components/SessionDiff.vue", import.meta.url), "utf8")
  const scrollArea = readFileSync(new URL("../src/components/ui/scroll-area/ScrollArea.vue", import.meta.url), "utf8")
  expect((reviewSource.match(/<ScrollArea[ >\n]/g) ?? []).length).toBe(2)
  expect(reviewSource.includes(`:orientation="splitDiff ? 'vertical' : 'both'"`)).toBeTruthy()
  expect(/overflow-(?:x-|y-)?auto/.test(reviewSource + diff)).toBeFalsy()
  expect(scrollArea.includes("orientation: 'vertical'")).toBeTruthy()
  expect(scrollArea.includes('<ScrollBar v-if="orientation !== \'vertical\'" orientation="horizontal" />')).toBeTruthy()
})

test("tree navigation folds folders and selects Windows paths", async () => {
  const h = await harness([change("a", "src\\lib\\a.ts")])
  h.treeMode.value = true
  expect(h.fileRows.value.length).toBe(3)
  h.selectRow(h.fileRows.value[2])
  expect(h.activeFile.value.path).toBe("src\\lib\\a.ts")
  h.selectRow(h.fileRows.value[0])
  expect(h.fileRows.value.length).toBe(1)
})
