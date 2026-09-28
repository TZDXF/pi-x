import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const previewUrl = loadTsSource(readFileSync(new URL("../src/lib/previewUrl.ts", import.meta.url), "utf8"), {
  URL,
  window: { location: { origin: "http://192.168.1.5:1421" } },
})
const { normalizeInputUrl, isHttpUrl, toProxyUrl, resolveProxyBase } = previewUrl

test("normalizes typed addresses into previewable URLs", () => {
  assert.equal(normalizeInputUrl("  example.com  "), "https://example.com")
  assert.equal(normalizeInputUrl("https://example.com/a?b=1"), "https://example.com/a?b=1")
  assert.equal(normalizeInputUrl("http://example.com"), "http://example.com")
  assert.equal(normalizeInputUrl(""), null)
  assert.equal(normalizeInputUrl("   "), null)
  assert.equal(normalizeInputUrl("file:///C:/x"), null)
  assert.equal(normalizeInputUrl("javascript:alert(1)"), null)
})

test("dev-server style loopback input becomes http", () => {
  assert.equal(normalizeInputUrl("localhost:5173"), "http://localhost:5173")
  assert.equal(normalizeInputUrl("localhost:5173/app/page"), "http://localhost:5173/app/page")
  assert.equal(normalizeInputUrl("localhost"), "http://localhost")
  assert.equal(normalizeInputUrl("127.0.0.1:3000/x?y=1"), "http://127.0.0.1:3000/x?y=1")
})

test("isHttpUrl only accepts http(s)", () => {
  assert.equal(isHttpUrl("https://example.com"), true)
  assert.equal(isHttpUrl("http://localhost:5173"), true)
  assert.equal(isHttpUrl("file:///a"), false)
  assert.equal(isHttpUrl("example.com"), false)
})

test("toProxyUrl embeds scheme, host and path after the proxy prefix", () => {
  const base = "http://127.0.0.1:1234/p/secret"
  // Per-host token: fnv1a(secret + hostname) replaces the shared secret.
  const localhostToken = "473873af1932c856" // fnv1a("secret" + "localhost")
  const exampleToken = "5c5f619405520e22" // fnv1a("secret" + "example.com")
  assert.equal(
    toProxyUrl(base, "http://localhost:5173/app?x=1"),
    `http://127.0.0.1:1234/p/${localhostToken}/http/localhost:5173/app?x=1`,
  )
  assert.equal(toProxyUrl(base, "https://example.com"), `http://127.0.0.1:1234/p/${exampleToken}/https/example.com/`)
  // Default ports are omitted by the URL parser.
  assert.equal(toProxyUrl(base, "https://example.com:443/a"), `http://127.0.0.1:1234/p/${exampleToken}/https/example.com/a`)
  assert.equal(toProxyUrl(base + "/", "https://example.com"), `http://127.0.0.1:1234/p/${exampleToken}/https/example.com/`)
})

test("resolveProxyBase supports remote-relative and absolute bases", () => {
  assert.equal(resolveProxyBase("/api/preview/secret"), "http://192.168.1.5:1421/api/preview/secret")
  assert.equal(resolveProxyBase("http://127.0.0.1:9/p/secret/"), "http://127.0.0.1:9/p/secret")
})
