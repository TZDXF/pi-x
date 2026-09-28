import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { webcrypto } from "node:crypto"
import { loadTsSource, pathsModule } from "./lib/load-ts.mjs"

const source = readFileSync(new URL("../src/lib/uuid.ts", import.meta.url), "utf8")

test("UUID generation uses the native method with its crypto receiver", () => {
  const crypto = {
    randomUUID() {
      assert.equal(this, crypto)
      return "native-uuid"
    },
  }
  assert.equal(loadTsSource(source, { crypto }).createUuid(), "native-uuid")
})

test("HTTP fallback sets UUID v4 version and variant bits", () => {
  for (const [fill, expected] of [
    [0, "00000000-0000-4000-8000-000000000000"],
    [255, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
  ]) {
    const crypto = {
      getRandomValues(bytes) {
        assert.equal(this, crypto)
        assert.equal(bytes.length, 16)
        return bytes.fill(fill)
      },
    }
    assert.equal(loadTsSource(source, { crypto }).createUuid(), expected)
  }
})

test("creating conversations works without randomUUID on LAN HTTP", () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
  const { createUuid } = loadTsSource(source, { crypto })
  const conversations = readFileSync(new URL("../src/stores/conversations.ts", import.meta.url), "utf8")
  const activeRuntimeId = { value: "" }
  const { createConversation } = loadTsSource(conversations, {
    require: name =>
      ({
        vue: { reactive: value => value },
        pinia: { getActivePinia: () => undefined },
        "../lib/uuid": { createUuid },
        "../lib/paths": pathsModule(),
        "./session": { createSessionStore: id => () => ({ runtimeId: id }) },
        "./ui": { createUiStore: () => () => ({}) },
        "./runtime": { activeRuntimeId },
      })[name],
  })
  const ids = new Set()
  for (let i = 0; i < 100; i++) {
    const store = createConversation("/project")
    assert.equal(store.cwd, "/project")
    assert.equal(activeRuntimeId.value, store.runtimeId)
    assert.match(store.runtimeId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    ids.add(store.runtimeId)
  }
  assert.equal(ids.size, 100)
})
