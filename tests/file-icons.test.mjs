import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadTsModule } from './lib/load-ts.mjs'

// fileIcons.ts 依赖 vscode-icons-js（CJS），把真实包的命名空间注入 require
const vscodeIconsJs = await import('vscode-icons-js')
const fileIcons = loadTsModule(
  new URL('../src/lib/fileIcons.ts', import.meta.url),
  () => vscodeIconsJs,
)

test('fileIcon maps extensions and special filenames to vscode-icons iconify names', () => {
  assert.equal(fileIcons.fileIcon('foo.ts'), 'vscode-icons:file-type-typescript')
  assert.equal(fileIcons.fileIcon('src/components/ChatView.vue'), 'vscode-icons:file-type-vue')
  assert.equal(fileIcons.fileIcon('package.json'), 'vscode-icons:file-type-npm')
})

test('fileIcon matches on the basename of posix and windows paths', () => {
  assert.equal(fileIcons.fileIcon('src/lib/fileKind.ts'), 'vscode-icons:file-type-typescript')
  assert.equal(fileIcons.fileIcon('C:\\code\\pi-x\\src\\lib\\fileIcons.ts'), 'vscode-icons:file-type-typescript')
})

test('fileIcon falls back to the default file icon for unknown or empty names', () => {
  assert.equal(fileIcons.fileIcon('unknownxyz'), 'vscode-icons:default-file')
  assert.equal(fileIcons.fileIcon(''), 'vscode-icons:default-file')
})

test('folderIcon honors the open state and falls back to default folder icons', () => {
  assert.equal(fileIcons.folderIcon('src', false), 'vscode-icons:folder-type-src')
  assert.equal(fileIcons.folderIcon('src', true), 'vscode-icons:folder-type-src-opened')
  assert.equal(fileIcons.folderIcon('unknownxyz', false), 'vscode-icons:default-folder')
  assert.equal(fileIcons.folderIcon('unknownxyz', true), 'vscode-icons:default-folder-opened')
})
