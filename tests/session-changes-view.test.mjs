import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'
const source = readFileSync(new URL('../src/components/SessionChanges.vue', import.meta.url), 'utf8')
function harness(changes) {
  const props = { changes }
  const module = loadTsSource(source.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1] + '\nexport { files, activeFile, selectedPath, fileName }', {
    defineProps: () => props,
    defineEmits: () => () => {},
    require: id => id === 'vue' ? {
      ref: value => ({ value }), computed: get => ({ get value() { return get() } }),
      onMounted() {}, onBeforeUnmount() {},
    } : id === 'vue-i18n' ? { useI18n: () => ({ t: key => key }) } : {},
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
  const h = harness([])
  assert.equal(h.fileName('src/lib/index.ts'), 'index.ts')
  assert.equal(h.fileName('src/components/index.ts'), 'index.ts')
  assert.equal(h.fileName('index.ts'), 'index.ts')
  assert.ok(!source.includes('directory(file.path)'))
  assert.ok(source.includes(':title="file.path"'))
})


test('review panes use themed scroll areas with horizontal diff support', () => {
  const diff = readFileSync(new URL('../src/components/SessionDiff.vue', import.meta.url), 'utf8')
  const scrollArea = readFileSync(new URL('../src/components/ui/scroll-area/ScrollArea.vue', import.meta.url), 'utf8')
  assert.equal((source.match(/<ScrollArea /g) ?? []).length, 2)
  assert.ok(source.includes('orientation="both"'))
  assert.ok(!/overflow-(?:x-|y-)?auto/.test(source + diff))
  assert.ok(scrollArea.includes("orientation: 'vertical'"))
  assert.ok(scrollArea.includes('<ScrollBar v-if="orientation !== \'vertical\'" orientation="horizontal" />'))
})
