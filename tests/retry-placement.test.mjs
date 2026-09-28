import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

test("retry errors appear at the end of the conversation, not in the header", () => {
  const view = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const header = view.slice(view.indexOf("<header"), view.indexOf("</header>"))
  const conversation = view.slice(view.indexOf("<Conversation"), view.indexOf("</Conversation>"))
  assert.doesNotMatch(header, /session\.retryInfo/)
  assert.match(conversation, /<Message v-if="session\.retryInfo" from="assistant" role="status"[^>]*>/)
  assert.ok(conversation.indexOf("session.retryInfo") > conversation.indexOf('v-for="entry in renderedEntries"'))
  assert.match(conversation, /session\.retryInfo\.attempt/)
  assert.match(conversation, /session\.retryInfo\.maxAttempts/)
  assert.match(conversation, /session\.retryInfo\.errorMessage/)
  assert.match(conversation, /RefreshCw.+animate-spin/s)
  assert.match(conversation, /border-amber-500\/25/)
})
