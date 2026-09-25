import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('../src/lib/paths.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const { isWindowsPath, joinDisplayPath } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

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
