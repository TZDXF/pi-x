import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'
const source = readFileSync(new URL('../src/components/ReviewPanel.vue', import.meta.url), 'utf8')
function harness(changes) {
  const props = { changes, checkpoints: [] }
  const module = loadTsSource(source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1] + '\nexport { files, activeFile, selectedPath, fileRows, treeMode, selectRow }', {
    defineProps: () => props,
    defineEmits: () => () => {},
    require: id => id === 'vue' ? {
      ref: value => ({ value }), shallowRef: value => ({ value }), computed: get => ({ get value() { return get() } }),
      onMounted() {}, onBeforeUnmount() {}, watch() {},
    } : id === '@/lib/reviewFileTree' ? loadTsSource(readFileSync(new URL('../src/lib/reviewFileTree.ts', import.meta.url), 'utf8')) : id === 'vue-i18n' ? { useI18n: () => ({ t: key => key }) } : {},
  })
  return { props, ...module }
}
const change = (id, path, added = 1, removed = 0) => ({ id, path, added, removed, lines: [], tool: 'edit' })
test('review defaults to first file, groups operations, and switches selection', () => {
  const h = harness([change('a', 'src/a.ts'), change('b', 'src/b.ts'), change('c', 'src/a.ts', 2, 1)])
  assert.equal(h.files.value.length, 2)
  assert.equal(h.activeFile.value.path, 'src/a.ts')
  assert.equal(h.activeFile.value.changes.length, 2)
  assert.equal(h.activeFile.value.added, 3)
  assert.equal(h.activeFile.value.removed, 1)
  h.selectedPath.value = 'src/b.ts'
  assert.equal(h.activeFile.value.path, 'src/b.ts')
})
test('selection survives new operations and falls back on session switch or clear', () => {
  const h = harness([change('a', 'a.ts'), change('b', 'b.ts')])
  h.selectedPath.value = 'b.ts'
  h.props.changes.push(change('c', 'c.ts'), change('d', 'b.ts', 4))
  assert.equal(h.activeFile.value.path, 'b.ts')
  assert.equal(h.activeFile.value.added, 5)
  h.props.changes = [change('new', 'other.ts')]
  assert.equal(h.activeFile.value.path, 'other.ts')
  h.props.changes = []
  assert.equal(h.activeFile.value, null)
})
test('file list shows basenames while keeping full paths as identities', () => {
  const h = harness([change('a', 'src/lib/index.ts'), change('b', 'src/components/index.ts')])
  assert.equal(h.fileRows.value[0].name, 'index.ts')
  assert.equal(h.fileRows.value[1].name, 'index.ts')
  h.selectRow(h.fileRows.value[1])
  assert.equal(h.activeFile.value.path, 'src/components/index.ts')
  assert.ok(source.includes(':title="row.fullPath"'))
})


test('review panes use themed scroll areas; split mode scrolls horizontally per pane', () => {
  const diff = readFileSync(new URL('../src/components/SessionDiff.vue', import.meta.url), 'utf8')
  const scrollArea = readFileSync(new URL('../src/components/ui/scroll-area/ScrollArea.vue', import.meta.url), 'utf8')
  assert.equal((source.match(/<ScrollArea /g) ?? []).length, 2)
  assert.ok(source.includes(`:orientation="splitDiff ? 'vertical' : 'both'"`))
  assert.ok(!/overflow-(?:x-|y-)?auto/.test(source + diff))
  assert.ok(scrollArea.includes("orientation: 'vertical'"))
  assert.ok(scrollArea.includes('<ScrollBar v-if="orientation !== \'vertical\'" orientation="horizontal" />'))
})

test('tree navigation folds folders and selects Windows paths', () => {
  const h = harness([change('a', 'src\\lib\\a.ts')])
  h.treeMode.value = true
  assert.equal(h.fileRows.value.length, 3)
  h.selectRow(h.fileRows.value[2])
  assert.equal(h.activeFile.value.path, 'src\\lib\\a.ts')
  h.selectRow(h.fileRows.value[0])
  assert.equal(h.fileRows.value.length, 1)
})
