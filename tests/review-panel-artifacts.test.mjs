import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

const source = readFileSync(new URL("../src/components/ReviewPanel.vue", import.meta.url), "utf8")

test("artifact diffs take precedence over broader checkpoint spans", () => {
  assert.match(source, /const artifactBacked = computed/)
  assert.match(source, /if \(artifactBacked\.value\) return null/)
  assert.match(source, /v-for="\(change, operation\) in activeFile\.changes"/)
})
