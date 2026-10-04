import { test, expect } from "vitest"
import {
  providerApiPathPrefix,
  resolveModelsListBaseUrl,
  resolveProviderBaseUrl,
  syncModelBaseUrls,
} from "@/lib/providerBaseUrl"

test("chat base URL resolution follows each API's own version-segment convention", () => {
  // OpenAI SDK appends /chat/completions|/responses, so it needs the /v1 suffix.
  expect(resolveProviderBaseUrl("http://192.168.3.3:8084", "openai-completions")).toBe("http://192.168.3.3:8084/v1")
  expect(resolveProviderBaseUrl("http://192.168.3.3:8084", "openai-responses")).toBe("http://192.168.3.3:8084/v1")
  // Anthropic SDK appends /v1/messages itself; a /v1 in the base URL doubles it (404 Route not found).
  expect(resolveProviderBaseUrl("http://192.168.3.3:8084", "anthropic-messages")).toBe("http://192.168.3.3:8084")
  // Google SDK owns /v1beta itself.
  expect(resolveProviderBaseUrl("http://192.168.3.3:8084", "google-generative-ai")).toBe(
    "http://192.168.3.3:8084/v1beta",
  )
})

test("resolution normalizes already-versioned base URLs instead of doubling them", () => {
  expect(resolveProviderBaseUrl("http://host:8084/v1/", "openai-completions")).toBe("http://host:8084/v1")
  expect(resolveProviderBaseUrl("http://host:8084/v1", "anthropic-messages")).toBe("http://host:8084")
  expect(resolveProviderBaseUrl("http://host:8084/v1beta/", "google-generative-ai")).toBe("http://host:8084/v1beta")
})

test("model listing endpoint always gets a version prefix", () => {
  expect(resolveModelsListBaseUrl("http://host:8084", "openai-completions")).toBe("http://host:8084/v1")
  expect(resolveModelsListBaseUrl("http://host:8084", "anthropic-messages")).toBe("http://host:8084/v1")
  expect(resolveModelsListBaseUrl("http://host:8084", "google-generative-ai")).toBe("http://host:8084/v1beta")
  expect(resolveModelsListBaseUrl("http://host:8084/v1", "anthropic-messages")).toBe("http://host:8084/v1")
})

test("path prefix helper covers the api styles", () => {
  expect(providerApiPathPrefix("openai-completions")).toBe("/v1")
  expect(providerApiPathPrefix("openai-responses")).toBe("/v1")
  expect(providerApiPathPrefix("anthropic-messages")).toBe("")
  expect(providerApiPathPrefix("google-generative-ai")).toBe("/v1beta")
})

test("sync writes the resolved URL into models without their own baseUrl", () => {
  const entry = {
    baseUrl: "http://192.168.3.3:8084",
    api: "openai-completions",
    models: [{ id: "deepseek-v4" }, { id: "MiniMax-M3", api: "anthropic-messages" }],
  }
  syncModelBaseUrls(entry)
  expect(entry.models?.[0].baseUrl).toBe("http://192.168.3.3:8084/v1")
  // Anthropic resolves to the provider URL itself, so no model-level entry is needed.
  expect(entry.models?.[1].baseUrl).toBeUndefined()
})

test("sync keeps custom model baseUrls but refreshes previously resolved ones", () => {
  const custom = { id: "custom", baseUrl: "https://other.example.com/api" }
  const stale = { id: "stale", baseUrl: "http://192.168.3.3:8084/v1" }
  const entry = { baseUrl: "http://192.168.3.3:9999", api: "openai-completions", models: [custom, stale] }
  syncModelBaseUrls(entry, "http://192.168.3.3:8084")
  expect(custom.baseUrl).toBe("https://other.example.com/api")
  expect(stale.baseUrl).toBe("http://192.168.3.3:9999/v1")
})

test("sync is a no-op without a provider baseUrl", () => {
  const entry = { models: [{ id: "m" }] }
  syncModelBaseUrls(entry)
  expect(entry.models?.[0].baseUrl).toBeUndefined()
})
