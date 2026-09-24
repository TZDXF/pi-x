import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

test('retry errors appear at the end of the conversation, not in the header', () => {
  const view = readFileSync(new URL('../src/components/ChatView.vue', import.meta.url), 'utf8')
  const header = view.slice(view.indexOf('<header'), view.indexOf('</header>'))
  const conversation = view.slice(view.indexOf('<Conversation ref='), view.indexOf('</Conversation>'))
  assert.doesNotMatch(header, /session\.retryInfo/)
  assert.match(conversation, /<Message v-if="session\.retryInfo" from="assistant" role="status"/)
  assert.ok(conversation.indexOf('session.retryInfo') > conversation.indexOf('v-for="entry in renderedEntries"'))
})
