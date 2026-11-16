import { afterEach, expect, test, vi } from "vitest"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function routeFor(hash: string) {
  vi.stubGlobal("window", {
    location: { hash },
    history: { length: 1, state: null },
    addEventListener: vi.fn(),
  })
  vi.resetModules()
  const { useRoute } = await import("@/lib/router")
  return useRoute().value
}

test("malformed session escapes fall back to the raw route parameters", async () => {
  const route = await routeFor("#/session/%/bad%project")
  expect(route.name).toBe("session")
  expect(route.params).toEqual({ conversation: "%", project: "bad%project" })
})

test("malformed project escapes do not prevent initial route parsing", async () => {
  const route = await routeFor("#/project/%")
  expect(route.name).toBe("project")
  expect(route.params.project).toBe("%")
})
