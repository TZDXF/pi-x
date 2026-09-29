import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsSource, pathsModule } from "./lib/load-ts.mjs"
const source = readFileSync(new URL("../src/components/ReviewPanel.vue", import.meta.url), "utf8")
function harness(changes) {
  const props = { changes, checkpoints: [] }
  const module = loadTsSource(
    source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1] +
      "\nexport { files, activeFile, selectedPath, fileRows, treeMode, selectRow }",
    {
      defineProps: () => props,
      defineEmits: () => () => {},
      require: id =>
        id === "vue"
          ? {
              ref: value => ({ value }),
              shallowRef: value => ({ value }),
              computed: get => ({
                get value() {
                  return get()
                },
              }),
              onMounted() {},
              onBeforeUnmount() {},
              watch() {},
            }
          : id === "@/lib/reviewFileTree"
            ? loadTsSource(readFileSync(new URL("../src/lib/reviewFileTree.ts", import.meta.url), "utf8"))
            : id === "vue-i18n"
              ? { useI18n: () => ({ t: key => key }) }
              : id === "@/lib/paths"
                ? pathsModule()
                : {},
    },
  )
  return { props, ...module }
}
const change = (id, path, added = 1, removed = 0) => ({ id, path, added, removed, lines: [], tool: "edit" })
test("review defaults to first file, groups operations, and switches selection", () => {
  const h = harness([change("a", "src/a.ts"), change("b", "src/b.ts"), change("c", "src/a.ts", 2, 1)])
  expect(h.files.value.length).toBe(2)
  expect(h.activeFile.value.path).toBe("src/a.ts")
  expect(h.activeFile.value.changes.length).toBe(2)
  expect(h.activeFile.value.added).toBe(3)
  expect(h.activeFile.value.removed).toBe(1)
  h.selectedPath.value = "src/b.ts"
  expect(h.activeFile.value.path).toBe("src/b.ts")
})
test("selection survives new operations and falls back on session switch or clear", () => {
  const h = harness([change("a", "a.ts"), change("b", "b.ts")])
  h.selectedPath.value = "b.ts"
  h.props.changes.push(change("c", "c.ts"), change("d", "b.ts", 4))
  expect(h.activeFile.value.path).toBe("b.ts")
  expect(h.activeFile.value.added).toBe(5)
  h.props.changes = [change("new", "other.ts")]
  expect(h.activeFile.value.path).toBe("other.ts")
  h.props.changes = []
  expect(h.activeFile.value).toBe(null)
})
test("file list shows basenames while keeping full paths as identities", () => {
  const h = harness([change("a", "src/lib/index.ts"), change("b", "src/components/index.ts")])
  expect(h.fileRows.value[0].name).toBe("index.ts")
  expect(h.fileRows.value[1].name).toBe("index.ts")
  h.selectRow(h.fileRows.value[1])
  expect(h.activeFile.value.path).toBe("src/components/index.ts")
  expect(source.includes(':title="row.fullPath"')).toBeTruthy()
})

test("review panes use themed scroll areas; split mode scrolls horizontally per pane", () => {
  const diff = readFileSync(new URL("../src/components/SessionDiff.vue", import.meta.url), "utf8")
  const scrollArea = readFileSync(new URL("../src/components/ui/scroll-area/ScrollArea.vue", import.meta.url), "utf8")
  expect((source.match(/<ScrollArea[ >\n]/g) ?? []).length).toBe(2)
  expect(source.includes(`:orientation="splitDiff ? 'vertical' : 'both'"`)).toBeTruthy()
  expect(/overflow-(?:x-|y-)?auto/.test(source + diff)).toBeFalsy()
  expect(scrollArea.includes("orientation: 'vertical'")).toBeTruthy()
  expect(scrollArea.includes('<ScrollBar v-if="orientation !== \'vertical\'" orientation="horizontal" />')).toBeTruthy()
})

test("tree navigation folds folders and selects Windows paths", () => {
  const h = harness([change("a", "src\\lib\\a.ts")])
  h.treeMode.value = true
  expect(h.fileRows.value.length).toBe(3)
  h.selectRow(h.fileRows.value[2])
  expect(h.activeFile.value.path).toBe("src\\lib\\a.ts")
  h.selectRow(h.fileRows.value[0])
  expect(h.fileRows.value.length).toBe(1)
})
