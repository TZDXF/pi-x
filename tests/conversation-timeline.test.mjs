import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'
const source = readFileSync(new URL('../src/lib/conversationTimeline.ts', import.meta.url), 'utf8')
const context = { exports: {} }
vm.runInNewContext(ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }), context)
const turns = context.exports.conversationTurns
const user = (id, text = '') => ({ kind: 'user', id, text })
const text = value => ({ type: 'text', text: value })
const assistant = (...blocks) => ({ kind: 'assistant', blocks })
test('groups each question with subsequent replies and excludes reasoning/tools', () => {
  const result = turns([assistant(text('orphan')), user(1, 'first'), assistant({ type: 'thinking', text: 'secret' }, text('answer')), assistant(text('continued')), user(2, 'second')], [text('streaming')])
  assert.equal(result.length, 2)
  assert.equal(result[0].answer, 'answer continued')
  assert.equal(result[1].answer, 'streaming')
})
test('answer keeps only text after the last tool call, dropping run commentary', () => {
  const tool = { type: 'toolCall', callId: 'c1', name: 'bash', argsText: 'ls' }
  const result = turns([user(1, '提交代码'), assistant(text('我先看一下工作区改动'), tool, text('已提交 17d0e8c，终端功能已提交。'))])
  assert.equal(result[0].answer, '已提交 17d0e8c，终端功能已提交。')
  const trailing = turns([user(1, 'q'), assistant(tool, text('done'), text(' all')), assistant(text('final'))])
  assert.equal(trailing[0].answer, 'done all final')
  const toolOnly = turns([user(1, 'q'), assistant(text('commentary'), tool)])
  assert.equal(toolOnly[0].answer, '')
})
test('handles empty/image questions, unanswered turns, and bounded excerpts', () => {
  assert.equal(turns([]).length, 0)
  assert.equal(turns([user(1)])[0].answer, '')
  assert.equal(turns([user(1)])[0].question, '')
  assert.equal(turns([user(1, 'x'.repeat(300))])[0].question.length, 181)
  assert.equal(turns([user(1, ' a\n b ')])[0].question, 'a b')
})
test('rendered entries have anchors and navigation stops automatic following', () => {
  const chat = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  assert.match(chat, /:data-message-id="entry.id"/)
  const conversation = readFileSync(new URL('../src/components/ai-elements/conversation/Conversation.vue', import.meta.url), 'utf8')
  assert.match(conversation, /context.stopScroll\(\)[\s\S]*viewport.scrollTo/)
  assert.match(conversation, /prefers-reduced-motion/)
})
