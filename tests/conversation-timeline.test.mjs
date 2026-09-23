import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import vm from 'node:vm'
const source = readFileSync(new URL('../src/lib/conversationTimeline.ts', import.meta.url), 'utf8')
const tsCompile = code => ts.transpile(code, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
// conversationTimeline now shares contentText with the session store via
// '@/lib/content'; load the real module so its behavior is under test too.
const require = (id) => {
  if (id === '@/lib/content') {
    const content = { exports: {} }
    vm.runInNewContext(tsCompile(readFileSync(new URL('../src/lib/content.ts', import.meta.url), 'utf8')), content)
    return content.exports
  }
  throw new Error(`unexpected module: ${id}`)
}
const context = { exports: {}, require }
vm.runInNewContext(tsCompile(source), context)
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

// ---- buildTimelineTurns: full-session timeline over paginated history ----
const build = context.exports.buildTimelineTurns
const rawUser = (text, images = []) => ({ role: 'user', content: images.length ? [{ type: 'text', text }, ...images] : text })
const rawAssistant = (...parts) => ({ role: 'assistant', content: parts })
const rawToolCall = { type: 'toolCall', id: 'c1', name: 'bash', arguments: 'ls' }
const liveUser = (id, text) => ({ kind: 'user', id, text, live: true })

test('unmaterialized turns show with synthetic ids; materialized ones map to entries in order', () => {
  const messages = [
    rawUser('q1'), rawAssistant({ type: 'text', text: 'a1' }),
    rawUser('q2'), rawAssistant(rawToolCall, { type: 'text', text: 'a2' }),
    rawUser('q3'), rawAssistant({ type: 'text', text: 'a3' }),
  ]
  // cursor=4: q3/a3 materialized as entries; q1/q2 only raw.
  const entries = [
    { kind: 'user', id: 50, text: 'q3' },
    { kind: 'assistant', id: 51, blocks: [text('a3')] },
  ]
  const result = build(messages, 4, entries)
  assert.equal(result.length, 3)
  assert.equal(result.map(t => t.question).join('|'), 'q1|q2|q3')
  assert.equal(result[0].id, -1)
  assert.equal(result[0].entryId, null)
  assert.equal(result[1].id, -3)
  assert.equal(result[1].entryId, null)
  assert.equal(result[2].id, 50)
  assert.equal(result[2].entryId, 50)
  assert.equal(result[1].answer, 'a2')
  assert.equal(result[0].answer, 'a1')
})

test('live entries appended after the snapshot extend the timeline', () => {
  const messages = [rawUser('q1'), rawAssistant({ type: 'text', text: 'a1' })]
  const entries = [
    { kind: 'user', id: 10, text: 'q1' },
    { kind: 'assistant', id: 11, blocks: [text('a1')] },
    liveUser(12, 'q2 live'),
    { kind: 'assistant', id: 13, blocks: [text('a2 live')], live: true },
  ]
  const result = build(messages, 2, entries)
  assert.equal(result.length, 2)
  assert.equal(result[1].id, 12)
  assert.equal(result[1].entryId, 12)
  assert.equal(result[1].answer, 'a2 live')
})

test('empty snapshot falls back to entries-only turns (fully materialized session)', () => {
  const entries = [
    { kind: 'user', id: 1, text: 'q1' },
    { kind: 'assistant', id: 2, blocks: [text('a1')] },
    liveUser(3, 'q2'),
  ]
  const result = build([], 0, entries)
  assert.equal(result.length, 2)
  assert.equal(result[0].entryId, 1)
  assert.equal(result[1].entryId, 3)
  assert.equal(result[1].answer, '')
})

test('empty or image-only raw user messages are skipped, matching materialization', () => {
  const messages = [rawUser(''), rawUser('q1', [{ type: 'image', data: 'x', mimeType: 'image/png' }])]
  const result = build(messages, 0, [])
  assert.equal(result.length, 1)
  assert.equal(result[0].question, 'q1')
  assert.equal(result[0].entryId, null)
  const imageOnly = build([rawUser('', [{ type: 'image', data: 'x', mimeType: 'image/png' }])], 0, [])
  assert.equal(imageOnly.length, 1)
  assert.equal(imageOnly[0].question, '')
})
