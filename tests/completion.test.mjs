import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
const source = readFileSync(new URL('../src/lib/completion.ts', import.meta.url), 'utf8')
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const { completionToken, insertCompletion, fileReference, withFileReferences } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('slash completion is start-only and supports skill, unicode and hyphenated names', () => {
  for (const text of ['/', '/skill:review', '/my-template', '/检查']) {
    assert.equal(completionToken(text, text.length)?.kind, 'command')
  }
  for (const text of ['explain /skill', '/review args', '//file']) assert.equal(completionToken(text, text.length), null)
})
test('file completion uses caret, excludes emails and selections', () => {
  const text = '检查 @src/in 然后继续'
  const caret = text.indexOf(' 然后')
  const token = completionToken(text, caret)
  assert.equal(token.query, 'src/in')
  assert.equal(insertCompletion(text, token, 'src/index.ts').text, '检查 @"src/index.ts" 然后继续')
  assert.equal(completionToken('mail@example.com', 16), null)
  assert.equal(completionToken('@src', 2, 4), null)
})
test('quoted paths, Windows separators, unicode and mid-token edits', () => {
  assert.equal(fileReference('src\\中文 name.ts'), '@"src/中文 name.ts"')
  const text = 'read @"my folder/old.ts" please'
  const caret = text.indexOf('old') + 2
  const result = insertCompletion(text, completionToken(text, caret), 'my folder/new.ts')
  assert.equal(result.text, 'read @"my folder/new.ts" please')
  assert.equal(result.caret, 'read @"my folder/new.ts"'.length)
  assert.equal(completionToken('@"my folder/a', 13)?.query, 'my folder/a')
})
test('command selection preserves following arguments and replaces token suffix', () => {
  const text = '/revie old args'
  assert.equal(insertCompletion(text, completionToken(text, 4), 'review').text, '/review old args')
})
test('references append explicit path-only context and retain slash dispatch prefix', () => {
  const text = '/review @"src/my file.ts" @src/index.ts @src/index.ts'
  const expanded = withFileReferences(text)
  assert.ok(expanded.startsWith(text))
  assert.deepEqual(JSON.parse(expanded.slice(expanded.lastIndexOf('\n') + 1)), ['src/my file.ts', 'src/index.ts'])
  assert.match(expanded, /contents have not been attached/)
})
test('external and traversal paths are not added as project references', () => {
  for (const text of ['plain text', 'user@example.com', '@../secret', '@C:\\secret', '@/etc/passwd', '@"a/../../secret"']) assert.equal(withFileReferences(text), text)
})
test('AI Elements command list forwards slot and editor intercepts keys before submit', () => {
  const list = readFileSync(new URL('../src/components/ai-elements/prompt-input/PromptInputCommandList.vue', import.meta.url), 'utf8')
  assert.match(list, /<slot\s*\/>/)
  const chat = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  assert.match(chat, /@keydown.capture="completion\?\.onKeydown\(\$event\)"/)
  assert.doesNotMatch(chat, /cmdOpen|fileOpen/)
})
