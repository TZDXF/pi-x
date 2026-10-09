import { readFileSync } from "node:fs"
import { expect, test } from "vitest"

const source = readFileSync(new URL("../src/components/ReviewPanel.vue", import.meta.url), "utf8")

test("review renders captured artifact changes without querying Git snapshots", () => {
  expect(source).not.toMatch(/checkpointFileContent|realDiff|startOid|endOid/)
  expect(source).toMatch(/v-for="\(change, operation\) in activeFile\.changes"/)
  expect(source).toContain('"changes.exactLines"')
})
