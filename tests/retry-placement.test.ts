import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

test("retry errors appear at the end of the conversation, not in the header", () => {
  const view = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  const header = view.slice(view.indexOf("<header"), view.indexOf("</header>"))
  const list = readFileSync(new URL("../src/components/chat/ChatTurnList.vue", import.meta.url), "utf8")
  const conversation = list.slice(list.indexOf("<Conversation"), list.indexOf("</Conversation>"))
  const banner = readFileSync(new URL("../src/components/chat/RetryBanner.vue", import.meta.url), "utf8")
  expect(header).not.toMatch(/session\.retryInfo/)
  // The banner component is mounted inside the conversation, after the
  // rendered entries (the retry banner moved into RetryBanner.vue).
  expect(conversation).toMatch(
    /<RetryBanner v-if="session\.retryInfo" :retry="session\.retryInfo" @stop="stopRetry" \/>/,
  )
  expect(
    conversation.indexOf("<RetryBanner") > conversation.indexOf('v-for="(entry, entryIndex) in renderedEntries"'),
  ).toBeTruthy()
  expect(banner).toMatch(/retry\.attempt/)
  expect(banner).toMatch(/retry\.maxAttempts/)
  expect(banner).toMatch(/retry\.errorMessage/)
  expect(banner).toMatch(/RefreshCw.+animate-spin/s)
  expect(banner).toMatch(/border-amber-500\/25/)
})
