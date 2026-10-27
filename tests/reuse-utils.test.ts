import { afterEach, expect, test, vi } from "vitest"
import { createLocalPreference } from "@/lib/localPreference"
import { modelKey, parseModelKey } from "@/lib/modelKey"
import { debounce } from "@/lib/timing"

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test("local preference validates reads and synchronizes storage events", () => {
  const values = new Map([["pix.test", "invalid"]])
  let sync: ((event: StorageEvent) => void) | undefined
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  vi.stubGlobal("window", {
    addEventListener: (_name: string, listener: (event: StorageEvent) => void) => (sync = listener),
    removeEventListener: vi.fn(),
  })
  const isMode = (value: unknown): value is "light" | "dark" => value === "light" || value === "dark"
  const preference = createLocalPreference({ key: "pix.test", defaultValue: "light" as const, validate: isMode })
  expect(preference.value.value).toBe("light")

  preference.set("dark")
  expect(values.get("pix.test")).toBe("dark")
  values.set("pix.test", "light")
  sync?.({ key: "pix.test" } as StorageEvent)
  expect(preference.value.value).toBe("light")
})

test("strict preference does not update its ref when persistence fails", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => "light",
    setItem: () => {
      throw new Error("denied")
    },
  })
  const preference = createLocalPreference({
    key: "pix.test",
    defaultValue: "light",
    throwOnWriteError: true,
  })
  expect(() => preference.set("dark")).toThrow("denied")
  expect(preference.value.value).toBe("light")
})

test("model keys round-trip model IDs containing slashes", () => {
  const model = { provider: "custom", id: "namespace/model" }
  expect(parseModelKey(modelKey(model))).toEqual(model)
  expect(parseModelKey("missing-separator")).toBeNull()
})

test("debounce keeps only the latest call and supports cancellation", () => {
  vi.useFakeTimers()
  const fn = vi.fn()
  const later = debounce(fn, 100)
  later("first")
  later("second")
  vi.advanceTimersByTime(100)
  expect(fn).toHaveBeenCalledExactlyOnceWith("second")

  later("cancelled")
  later.cancel()
  vi.advanceTimersByTime(100)
  expect(fn).toHaveBeenCalledTimes(1)
})
