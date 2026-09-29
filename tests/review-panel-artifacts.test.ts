import { test, expect } from "vitest"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../src/components/ReviewPanel.vue", import.meta.url), "utf8")

test("artifact diffs take precedence over broader checkpoint spans", () => {
  expect(source).toMatch(/const artifactBacked = computed/)
  expect(source).toMatch(/if \(artifactBacked\.value\) return null/)
  expect(source).toMatch(/v-for="\(change, operation\) in activeFile\.changes"/)
})
