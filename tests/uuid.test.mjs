import { afterEach, expect, test, vi } from "vitest"
import { webcrypto } from "node:crypto"

vi.mock("@/stores/session", () => ({
  createSessionStore: id => () => ({ runtimeId: id }),
}))
vi.mock("@/stores/ui", () => ({
  createUiStore: () => () => ({}),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function loadUuid(crypto) {
  vi.stubGlobal("crypto", crypto)
  vi.resetModules()
  return import("@/lib/uuid")
}

test("UUID generation uses the native method with its crypto receiver", async () => {
  const crypto = {
    randomUUID() {
      expect(this).toBe(crypto)
      return "native-uuid"
    },
  }
  const { createUuid } = await loadUuid(crypto)
  expect(createUuid()).toBe("native-uuid")
})

test("HTTP fallback sets UUID v4 version and variant bits", async () => {
  for (const [fill, expected] of [
    [0, "00000000-0000-4000-8000-000000000000"],
    [255, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
  ]) {
    const crypto = {
      getRandomValues(bytes) {
        expect(this).toBe(crypto)
        expect(bytes.length).toBe(16)
        return bytes.fill(fill)
      },
    }
    const { createUuid } = await loadUuid(crypto)
    expect(createUuid()).toBe(expected)
  }
})

test("creating conversations works without randomUUID on LAN HTTP", async () => {
  const crypto = { getRandomValues: bytes => webcrypto.getRandomValues(bytes) }
  vi.stubGlobal("crypto", crypto)
  vi.resetModules()
  const [{ createConversation }, { activeRuntimeId }] = await Promise.all([
    import("@/stores/conversations"),
    import("@/stores/runtime"),
  ])
  const ids = new Set()
  for (let i = 0; i < 100; i++) {
    const store = createConversation("/project")
    expect(store.cwd).toBe("/project")
    expect(activeRuntimeId.value).toBe(store.runtimeId)
    expect(store.runtimeId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    ids.add(store.runtimeId)
  }
  expect(ids.size).toBe(100)
})
