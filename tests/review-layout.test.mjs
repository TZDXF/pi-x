import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'
const load = name => loadTsSource(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8'))
const { buildFileTree, flattenVisibleTree, flatFileRows } = load('reviewFileTree')
const { buildPaneRows, buildPaneRowOffsets } = load('reviewLayout')
const { toSideBySideRows } = load('reviewDiff')
test('review file tree sorts directories first and preserves selection data', () => {
  const files = [{ path: 'z.ts' }, { path: 'src/b.ts' }, { path: 'src/a.ts' }]
  const tree = buildFileTree(files)
  const rows = flattenVisibleTree(tree, new Set())
  assert.equal(rows.map(row => row.name).join(','), 'src,a.ts,b.ts,z.ts')
  assert.equal(rows[1].data, files[2])
  assert.equal(flattenVisibleTree(tree, new Set(['src'])).length, 2)
  assert.equal(flatFileRows(files)[1].fullPath, 'src/b.ts')
})
test('split panes omit artificial blank rows for unequal replacements', () => {
  const rows = toSideBySideRows([
    { kind: 'del', text: '-old1', oldLine: 1, newLine: null },
    { kind: 'del', text: '-old2', oldLine: 2, newLine: null },
    { kind: 'add', text: '+new', oldLine: null, newLine: 1 },
  ])
  assert.equal(buildPaneRows(rows, 'left').length, 2)
  assert.equal(buildPaneRows(rows, 'right').length, 1)
  const offsets = buildPaneRowOffsets(rows)
  assert.equal(offsets.left.at(-1), 2)
  assert.equal(offsets.right.at(-1), 1)
})
