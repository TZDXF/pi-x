import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { parseModelAdvanced } from "@/lib/modelAdvanced"
import {
  ModelFieldError,
  emptyInputLimitsForm,
  fallbackModelsJson,
  inputLimitsForm,
  parseFallbackModels,
  promptCacheForm,
  withFallbackModels,
  withInputLimits,
  withPromptCache,
} from "@/lib/modelLimits"

const base = { headers: { "X-Route": "keep" }, compat: { supportsStore: false }, futureOption: { enabled: true } }

test("input limits round-trip between the form and models.json", () => {
  const entry = withInputLimits(base, {
    ...emptyInputLimitsForm(),
    maxRequestBytes: "33554432",
    maxWidth: "1568",
    maxHeight: "1568",
    maxBytes: "524288",
    jpegQuality: "75",
    maxPerRequest: "600",
  })
  expect(entry.inputLimits).toEqual({
    maxRequestBytes: 33554432,
    images: { maxPerRequest: 600, resize: { maxWidth: 1568, maxHeight: 1568, maxBytes: 524288, jpegQuality: 75 } },
  })
  expect(inputLimitsForm(entry)).toEqual({
    maxRequestBytes: "33554432",
    maxWidth: "1568",
    maxHeight: "1568",
    maxBytes: "524288",
    jpegQuality: "75",
    maxPerMessage: "",
    maxPerRequest: "600",
  })
})

test("cleared limits are removed and unknown pi fields survive", () => {
  const stored = {
    inputLimits: { maxRequestBytes: 1, images: { maxPerMessage: 2, resize: { jpegQuality: 80 } } },
  }
  const next = withInputLimits({ ...base, ...stored }, emptyInputLimitsForm())
  expect("inputLimits" in next).toBe(false)
  expect(next).toEqual(base)
})

test("blank fields keep the rest of the object and other fields", () => {
  const next = withInputLimits(
    { ...base, promptCache: { short: 300 } },
    { ...emptyInputLimitsForm(), jpegQuality: "80" },
  )
  expect(next.inputLimits).toEqual({ images: { resize: { jpegQuality: 80 } } })
  expect(next.promptCache).toEqual({ short: 300 })
  expect(next.futureOption).toEqual({ enabled: true })
})

test("input limits reject ranges pi cannot use", () => {
  const form = { ...emptyInputLimitsForm() }
  for (const [key, value] of [
    ["maxWidth", "0"],
    ["maxWidth", "-10"],
    ["maxHeight", "1.5"],
    ["maxBytes", "abc"],
    ["maxRequestBytes", "0"],
    ["maxPerMessage", "-1"],
    ["maxPerRequest", ""],
    ["jpegQuality", "0"],
    ["jpegQuality", "101"],
  ] as const) {
    // An empty field is always allowed: it means "keep Pi's default".
    if (value === "" && key === "maxPerRequest") {
      expect(withInputLimits({}, { ...form, [key]: value }).inputLimits).toBeUndefined()
      continue
    }
    expect(() => withInputLimits({}, { ...form, [key]: value })).toThrow(ModelFieldError)
  }
})

test("prompt cache lifetimes are positive seconds and drop when cleared", () => {
  const entry = withPromptCache(base, { short: "300", long: "3600" })
  expect(entry.promptCache).toEqual({ short: 300, long: 3600 })
  expect(promptCacheForm(entry)).toEqual({ short: "300", long: "3600" })
  expect(withPromptCache(entry, { short: "", long: "" })).toEqual(base)
  // pi's schema is exclusiveMinimum: 0, so only clearing a field disables a
  // tier; 0, negative and fractional seconds would invalidate the whole
  // models.json.
  expect(() => withPromptCache({}, { short: "0", long: "" })).toThrow(/promptCache.short/)
  expect(() => withPromptCache({}, { short: "-1", long: "" })).toThrow(/promptCache.short/)
  expect(() => withPromptCache({}, { short: "1.5", long: "" })).toThrow(ModelFieldError)
  expect(() => parseModelAdvanced('{"promptCache":{"short":0}}')).toThrow(/promptCache.short/)
})

test("server-side fallback models parse, normalize and clear", () => {
  const raw =
    '[{"provider":"anthropic","model":"claude-opus-5","cost":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25}}]'
  const entry = withFallbackModels(base, parseFallbackModels(raw))
  expect(entry.compat).toEqual({
    supportsStore: false,
    allowedFallbackModels: [
      {
        provider: "anthropic",
        model: "claude-opus-5",
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      },
    ],
  })
  expect(fallbackModelsJson(entry)).toBe(
    JSON.stringify(entry.compat && (entry.compat as { allowedFallbackModels: unknown }).allowedFallbackModels, null, 2),
  )
  expect(parseFallbackModels("  ")).toEqual([])
  // Clearing the list leaves the other compat flags untouched.
  expect(withFallbackModels(entry, [])).toEqual(base)
  expect(
    withFallbackModels({ compat: { allowedFallbackModels: [{ provider: "a", model: "b", cost: {} }] } }, []).compat,
  ).toBeUndefined()
})

test("fallback models reject entries pi would refuse", () => {
  for (const raw of [
    "{",
    "{}",
    '[{"provider":"","model":"b","cost":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1}}]',
    '[{"provider":"a","model":"b"}]',
    '[{"provider":"a","model":"b","cost":{"input":-1,"output":1,"cacheRead":1,"cacheWrite":1}}]',
    '[{"provider":"a","model":"b","cost":{"input":"1","output":1,"cacheRead":1,"cacheWrite":1}}]',
    // pi caps allowedFallbackModels at maxItems: 3 and would reject the whole
    // models.json beyond that.
    "[" +
      Array.from({ length: 4 }, () => '{"provider":"a","model":"b","cost":{"input":1,"output":1,"cacheRead":1,"cacheWrite":1}}').join(",") +
      "]",
  ]) {
    expect(() => parseFallbackModels(raw)).toThrow(ModelFieldError)
  }
})

test("fallback models keep unknown pi cost fields such as tiers", () => {
  const raw =
    '[{"provider":"anthropic","model":"m","cost":{"input":5,"output":25,"cacheRead":0.5,"cacheWrite":6.25,"tiers":[{"minTokens":200000,"input":6,"output":30}]}}]'
  const parsed = parseFallbackModels(raw)
  expect(parsed[0].cost.tiers).toEqual([{ minTokens: 200000, input: 6, output: 30 }])
  const entry = withFallbackModels({}, parsed)
  expect((entry.compat as { allowedFallbackModels: Array<{ cost: { tiers: unknown } }> }).allowedFallbackModels[0].cost.tiers).toEqual([
    { minTokens: 200000, input: 6, output: 30 },
  ])
})

test("editing a basic model field keeps the new fields and unknown ones", async () => {
  const { modelEntryFromForm, modelFormFromEntry } = await import("@/components/settings/models/modelForm")
  const stored = {
    id: "vision-model",
    api: "openai-completions",
    input: ["text", "image"],
    inputLimits: { images: { resize: { jpegQuality: 75 } } },
    promptCache: { short: 300, long: 3600 },
    compat: {
      allowedFallbackModels: [
        {
          provider: "anthropic",
          model: "claude-opus-5",
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        },
      ],
    },
    headers: { "X-Route": "keep" },
  }
  const form = modelFormFromEntry(stored)
  form.contextWindow = "200000"
  const entry = modelEntryFromForm(form, stored.id)
  expect(entry.inputLimits).toEqual(stored.inputLimits)
  expect(entry.promptCache).toEqual(stored.promptCache)
  expect(entry.compat).toEqual(stored.compat)
  expect(entry.headers).toEqual(stored.headers)
  expect(entry.contextWindow).toBe(200000)
  // An old config without the new fields round-trips unchanged.
  expect(modelEntryFromForm(modelFormFromEntry({ id: "plain", reasoning: false, input: ["text"] }), "plain")).toEqual({
    id: "plain",
    reasoning: false,
    input: ["text"],
  })
})

test("the advanced JSON editor validates the new fields too", () => {
  const valid = {
    inputLimits: { maxRequestBytes: 1024, images: { resize: { jpegQuality: 80 }, maxPerMessage: 4 } },
    promptCache: { short: 300, long: 3600 },
    compat: {
      allowedFallbackModels: [
        { provider: "anthropic", model: "m", cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } },
      ],
    },
  }
  expect(parseModelAdvanced(JSON.stringify(valid))).toEqual(valid)
  for (const raw of [
    '{"inputLimits":[]}',
    '{"inputLimits":{"maxRequestBytes":0}}',
    '{"inputLimits":{"images":{"resize":{"jpegQuality":101}}}}',
    '{"promptCache":[]}',
    '{"promptCache":{"short":-5}}',
    '{"compat":{"allowedFallbackModels":{}}}',
  ]) {
    expect(() => parseModelAdvanced(raw)).toThrow()
  }
})

test("the advanced panel exposes the new fields and blocks saving while invalid", () => {
  const panel = readFileSync(new URL("../src/components/settings/ModelAdvancedSettings.vue", import.meta.url), "utf8")
  expect(panel).toMatch(/settings\.modelInputLimits"/)
  expect(panel).toMatch(/settings\.modelPromptCache"/)
  expect(panel).toMatch(/api === 'anthropic-messages'/)
  expect(panel).toMatch(/emit\("update:invalid"/)
  const form = readFileSync(new URL("../src/components/settings/models/ModelEditForm.vue", import.meta.url), "utf8")
  expect(form).toMatch(/:disabled="props\.busy \|\| advancedInvalid"/)
})
