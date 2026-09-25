import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsSource } from './lib/load-ts.mjs'

const { pendingConversations } = loadTsSource(readFileSync(new URL('../src/lib/pendingConversations.ts', import.meta.url), 'utf8'))
const draft = (sessionFile, text = 'Send later', cwd = 'project') => ({ cwd, sessionFile, promptQueue: [{ text }] })

test('new queued conversations appear before a history file or row exists', () => {
  const items = [draft(null), draft('new.jsonl')]
  assert.equal(pendingConversations(items, ['project'], [], '').length, 2)
})

test('history rows deduplicate pending conversations, including Windows paths', () => {
  const items = [draft('sessions\\one.jsonl'), draft('sessions/two.jsonl')]
  const result = pendingConversations(items, ['project'], ['sessions/one.jsonl'], '')
  assert.equal(result.length, 1)
  assert.equal(result[0], items[1])
})

test('pending rows respect project folders, search and queue cancellation', () => {
  const items = [draft(null), draft(null, 'Other', 'other'), draft(null, 'Nested', 'project/sub')]
  assert.equal(pendingConversations(items, ['project', 'project/sub'], [], 'NESTED').length, 1)
  items[0].promptQueue = []
  assert.equal(pendingConversations(items, ['project'], [], '').length, 0)
})
