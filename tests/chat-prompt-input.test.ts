import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

test("file picker and drag/drop input accept images only", () => {
  const source = readFileSync(new URL("../src/components/chat/ChatPromptInput.vue", import.meta.url), "utf8")
  const promptInput = source.match(/<PromptInput[\s\S]*?>/)?.[0]
  expect(promptInput).toContain('accept="image/*"')
})
