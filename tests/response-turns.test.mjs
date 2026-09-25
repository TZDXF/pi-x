import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'

const { responseTurns } = loadTsSource(readFileSync(new URL('../src/lib/responseTurns.ts', import.meta.url), 'utf8'))
const user = id => ({ kind: 'user', id, text: 'question' })
const text = text => ({ type: 'text', text })
const assistant = (id, ...blocks) => ({ kind: 'assistant', id, blocks })
const tool = { type: 'toolCall', callId: 'tool-1', name: 'bash', argsText: '{}' }
const thinking = { type: 'thinking', text: 'reasoning', streaming: false }
const plain = value => JSON.parse(JSON.stringify(value))

test('completed turn folds earlier replies, reasoning and tools, retaining final summary', () => {
  const entries = [user(1), assistant(2, text('checking'), tool), assistant(3, thinking, text('done'), text('details'))]
  const original = JSON.stringify(entries)
  const result = responseTurns(entries, false)
  assert.equal(result.length, 2)
  assert.equal(result[0], entries[0])
  assert.deepEqual(plain(result[1].process), [text('checking'), tool, thinking])
  assert.deepEqual(plain(result[1].summary), [text('done'), text('details')])
  assert.equal(result[1].lastIndex, 2)
  assert.equal(result[1].complete, true)
  assert.equal(JSON.stringify(entries), original)
})

test('streaming only keeps the latest turn expanded; completion collapses it', () => {
  const entries = [user(1), assistant(2, text('first')), user(3), assistant(4, tool), assistant(5, text('final'))]
  const active = responseTurns(entries, true)
  assert.equal(active[1].complete, true)
  assert.equal(active[3].complete, false)
  assert.equal(responseTurns(entries, false)[3].complete, true)
  assert.equal(active[3].lastIndex, 4)
})

test('commentary preceding a trailing tool call is not a final summary', () => {
  const turn = responseTurns([user(1), assistant(2, text('working'), tool)], false)[1]
  assert.equal(turn.summary.length, 0)
  assert.deepEqual(plain(turn.blocks), [text('working'), tool])
})

test('single-entry turn splits process from trailing text, but plain answers need no disclosure', () => {
  const turn = responseTurns([assistant(1, text('checking'), tool, thinking, text('done'))], false)[0]
  assert.deepEqual(plain(turn.summary), [text('done')])
  assert.deepEqual(plain(turn.process), [text('checking'), tool, thinking])
  assert.equal(responseTurns([assistant(1, text('answer'))], false)[0].process.length, 0)
})

test('empty history and pending questions are preserved', () => {
  assert.equal(responseTurns([], true).length, 0)
  assert.deepEqual(plain(responseTurns([user(1)], true)), [user(1)])
})

test('chat uses an initially closed process disclosure and original index for branching', () => {
  const chat = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  const blocks = readFileSync(new URL('../src/components/AssistantBlocks.vue', import.meta.url), 'utf8')
  assert.match(chat, /entry.complete && entry.process.length && blocksText\(entry.summary\).trim\(\)/)
  assert.match(chat, /<details[\s\S]*?class="response-process(?:\s[^"]*)?"/)
  assert.doesNotMatch(chat, /response-process[^>]*\bopen\b/)
  assert.match(chat, /forkFromAnswer\(entry.lastIndex\)/)
  assert.doesNotMatch(blocks, /<Agent|ai-elements\/agent/)
})

test('streaming and completed answers share one render path so markdown never remounts', () => {
  const chat = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  const blocks = readFileSync(new URL('../src/components/AssistantBlocks.vue', import.meta.url), 'utf8')
  const session = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  // In-flight deltas fold into the last turn instead of a separate Message.
  assert.doesNotMatch(chat, /<Message v-if="session.partialBlocks"/)
  assert.match(chat, /blocks: \[\.\.\.last\.blocks, \.\.\.partial\]/)
  // The turn keeps a stable v-for key across completion via the reserved id.
  assert.match(session, /streamingTurnId.value \?\?= nextId\(\)/)
  assert.match(session, /id: streamingTurnId.value \?\? nextId\(\)/)
  // The summary tail reuses the streaming block keys instead of remounting.
  assert.match(blocks, /keyOffset\??: number/)
  assert.match(blocks, /:key="props.keyOffset \+ i"/)
  assert.match(chat, /:key-offset="hasSummary\(entry\) \? entry.blocks.length - entry.summary.length : 0"/)
  // The collapsed process renders lazily, not on completion.
  assert.match(chat, /@toggle="onProcessToggle\(entry.id, \$event\)"/)
})

test('turn statistics use recorded elapsed time and unique tool call IDs', () => {
  const first = { ...assistant(2, tool), startedAt: 1000, completedAt: 2000 }
  const last = { ...assistant(3, { ...tool, callId: 'tool-2' }, text('done')), startedAt: 1000, completedAt: 4250 }
  const turn = responseTurns([user(1), first, last], false)[1]
  assert.equal(turn.durationMs, 3250)
  assert.equal(turn.toolCallCount, 2)
  const historical = responseTurns([assistant(1, tool, tool, text('done'))], false)[0]
  assert.equal(historical.durationMs, null)
  assert.equal(historical.toolCallCount, 1)
})

test('duration spans the question to the last historical response, independently per turn', () => {
  const result = responseTurns([
    { ...user(1), timestamp: 1000 },
    { ...assistant(2, tool), timestamp: 2500 },
    { ...assistant(3, text('done')), timestamp: 6500 },
    { ...user(4), timestamp: 10000 },
    { ...assistant(5, text('next')), timestamp: 12000 },
  ], false)
  assert.equal(result[1].durationMs, 5500)
  assert.equal(result[3].durationMs, 2000)
})

test('live timing includes wait before agent start and uses actual completion', () => {
  const result = responseTurns([
    { ...user(1), timestamp: 1000 },
    { ...assistant(2, text('done')), startedAt: 2000, timestamp: 2100, completedAt: 7000 },
  ], false)
  assert.equal(result[1].durationMs, 6000)
})

test('missing, invalid and reversed timestamps never produce misleading durations', () => {
  for (const timestamp of [undefined, NaN, Infinity, 500]) {
    const result = responseTurns([
      { ...user(1), timestamp: 1000 },
      { ...assistant(2, text('done')), timestamp },
    ], false)
    assert.equal(result[1].durationMs, null)
  }
})
