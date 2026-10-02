import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

test("retry errors appear at the end of the conversation, not in the header", () => {
  const view = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const header = view.slice(view.indexOf("<header"), view.indexOf("</header>"))
  const list = readFileSync(new URL("../src/components/chat/ChatTurnList.vue", import.meta.url), "utf8")
  const conversation = list.slice(list.indexOf("<Conversation"), list.indexOf("</Conversation>"))
  expect(header).not.toMatch(/session\.retryInfo/)
  expect(conversation).toMatch(/<Message v-if="session\.retryInfo" from="assistant" role="status"[^>]*>/)
  expect(
    conversation.indexOf("session.retryInfo") > conversation.indexOf('v-for="(entry, entryIndex) in renderedEntries"'),
  ).toBeTruthy()
  expect(conversation).toMatch(/session\.retryInfo\.attempt/)
  expect(conversation).toMatch(/session\.retryInfo\.maxAttempts/)
  expect(conversation).toMatch(/session\.retryInfo\.errorMessage/)
  expect(conversation).toMatch(/RefreshCw.+animate-spin/s)
  expect(conversation).toMatch(/border-amber-500\/25/)
})
