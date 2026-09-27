import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('../src/lib/paths.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const { isWindowsPath, joinDisplayPath, relativeDisplayPath, normalizeSlashes, baseName } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('windows paths use backslashes when joined', () => {
  assert.equal(joinDisplayPath('C:\\code\\pi-x', '.pi', 'settings.json'), 'C:\\code\\pi-x\\.pi\\settings.json')
  assert.equal(joinDisplayPath('C:\\code\\pi-x\\', '.pi/settings.json'), 'C:\\code\\pi-x\\.pi\\settings.json')
  assert.equal(joinDisplayPath('\\\\server\\share', '.pi'), '\\\\server\\share\\.pi')
})

test('posix paths keep forward slashes', () => {
  assert.equal(joinDisplayPath('/home/user/proj', '.pi', 'settings.json'), '/home/user/proj/.pi/settings.json')
  assert.equal(joinDisplayPath('/home/user/proj/', '/.pi/', 'settings.json'), '/home/user/proj/.pi/settings.json')
})

test('isWindowsPath detects separator styles', () => {
  assert.equal(isWindowsPath('C:\\code\\pi-x'), true)
  assert.equal(isWindowsPath('D:/code/pi-x'), true)
  assert.equal(isWindowsPath('/home/user'), false)
})

test('relativeDisplayPath shows project files relative to the root', () => {
  assert.equal(relativeDisplayPath('C:/code/pi-x/src/lib/a.ts', 'C:\\code\\pi-x'), 'src/lib/a.ts')
  assert.equal(relativeDisplayPath('C:\\code\\pi-x\\src\\a.ts', 'C:/code/pi-x'), 'src/a.ts')
  assert.equal(relativeDisplayPath('/home/u/proj/src/a.ts', '/home/u/proj'), 'src/a.ts')
  // 项目内相对路径（pi 传入相对路径时）保持原样。
  assert.equal(relativeDisplayPath('src/a.ts', 'C:/code/pi-x'), 'src/a.ts')
})

test('relativeDisplayPath keeps absolute paths for files outside the project', () => {
  assert.equal(relativeDisplayPath('D:/other/b.ts', 'C:/code/pi-x'), 'D:/other/b.ts')
  assert.equal(relativeDisplayPath('/home/u/other/b.ts', '/home/u/proj'), '/home/u/other/b.ts')
  // 前缀相似但不是同一目录时不能误判为项目内。
  assert.equal(relativeDisplayPath('/home/u/project/b.ts', '/home/u/proj'), '/home/u/project/b.ts')
})

test('relativeDisplayPath folds case only for windows drive paths', () => {
  assert.equal(relativeDisplayPath('c:/CODE/pi-x/src/a.ts', 'C:/code/pi-x'), 'src/a.ts')
  assert.equal(relativeDisplayPath('/Home/U/Proj/src/a.ts', '/home/u/proj'), '/Home/U/Proj/src/a.ts')
})

test('normalizeSlashes converts windows separators and keeps posix paths intact', () => {
  assert.equal(normalizeSlashes('C:\\code\\pi-x\\src\\App.vue'), 'C:/code/pi-x/src/App.vue')
  assert.equal(normalizeSlashes('\\\\server\\share\\a.jsonl'), '//server/share/a.jsonl')
  assert.equal(normalizeSlashes('/home/u/proj'), '/home/u/proj')
  assert.equal(normalizeSlashes(''), '')
})

test('baseName returns the final segment for both separator styles', () => {
  assert.equal(baseName('C:\\code\\pi-x\\src\\App.vue'), 'App.vue')
  assert.equal(baseName('/home/u/proj/src/App.vue'), 'App.vue')
  assert.equal(baseName('App.vue'), 'App.vue')
  assert.equal(baseName('src/App.vue/'), 'App.vue')
  assert.equal(baseName('C:'), 'C:')
  assert.equal(baseName(''), '')
  assert.equal(baseName('/'), '/')
})
