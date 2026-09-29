import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const previewUrl = loadTsSource(readFileSync(new URL("../src/lib/previewUrl.ts", import.meta.url), "utf8"), {
  URL,
  window: { location: { origin: "http://192.168.1.5:1421" } },
})
const { normalizeInputUrl, isHttpUrl, toProxyUrl, resolveProxyBase } = previewUrl

test("normalizes typed addresses into previewable URLs", () => {
  expect(normalizeInputUrl("  example.com  ")).toBe("https://example.com")
  expect(normalizeInputUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
  expect(normalizeInputUrl("http://example.com")).toBe("http://example.com")
  expect(normalizeInputUrl("")).toBe(null)
  expect(normalizeInputUrl("   ")).toBe(null)
  expect(normalizeInputUrl("file:///C:/x")).toBe(null)
  expect(normalizeInputUrl("javascript:alert(1)")).toBe(null)
})

test("dev-server style loopback input becomes http", () => {
  expect(normalizeInputUrl("localhost:5173")).toBe("http://localhost:5173")
  expect(normalizeInputUrl("localhost:5173/app/page")).toBe("http://localhost:5173/app/page")
  expect(normalizeInputUrl("localhost")).toBe("http://localhost")
  expect(normalizeInputUrl("127.0.0.1:3000/x?y=1")).toBe("http://127.0.0.1:3000/x?y=1")
})

test("isHttpUrl only accepts http(s)", () => {
  expect(isHttpUrl("https://example.com")).toBe(true)
  expect(isHttpUrl("http://localhost:5173")).toBe(true)
  expect(isHttpUrl("file:///a")).toBe(false)
  expect(isHttpUrl("example.com")).toBe(false)
})

test("toProxyUrl embeds scheme, host and path after the proxy prefix", () => {
  const base = "http://127.0.0.1:1234/p/secret"
  // Per-host token: fnv1a(secret + host[:port]) replaces the shared secret.
  const localhostToken = "45fff6de6864c280" // fnv1a("secret" + "localhost:5173")
  const exampleToken = "5c5f619405520e22" // fnv1a("secret" + "example.com")
  expect(toProxyUrl(base, "http://localhost:5173/app?x=1")).toBe(
    `http://127.0.0.1:1234/p/${localhostToken}/http/localhost:5173/app?x=1`,
  )
  expect(toProxyUrl(base, "https://example.com")).toBe(`http://127.0.0.1:1234/p/${exampleToken}/https/example.com/`)
  // Default ports are omitted by the URL parser.
  expect(toProxyUrl(base, "https://example.com:443/a")).toBe(
    `http://127.0.0.1:1234/p/${exampleToken}/https/example.com/a`,
  )
  expect(toProxyUrl(base + "/", "https://example.com")).toBe(
    `http://127.0.0.1:1234/p/${exampleToken}/https/example.com/`,
  )
})

test("resolveProxyBase supports remote-relative and absolute bases", () => {
  expect(resolveProxyBase("/api/preview/secret")).toBe("http://192.168.1.5:1421/api/preview/secret")
  expect(resolveProxyBase("http://127.0.0.1:9/p/secret/")).toBe("http://127.0.0.1:9/p/secret")
})
