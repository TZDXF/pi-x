import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"
const source = readFileSync(new URL("../src/lib/modelAdvanced.ts", import.meta.url), "utf8")
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const { modelAdvancedJson, parseModelAdvanced } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
)

test("advanced fields round-trip without losing false or unknown pi options", () => {
  const extra = {
    compat: { supportsDeveloperRole: false, futureFlag: "keep" },
    headers: { "X-Route": "test" },
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    futureOption: { enabled: true },
  }
  expect(
    parseModelAdvanced(modelAdvancedJson({ id: "test", api: "openai-completions", reasoning: true, ...extra })),
  ).toEqual(extra)
})
test("empty advanced settings remove overrides and inherit pi defaults", () => {
  expect(parseModelAdvanced("")).toEqual({})
  expect(parseModelAdvanced("{}")).toEqual({})
})
test("reject malformed JSON, basic field overrides and invalid common types", () => {
  for (const raw of [
    "{",
    "null",
    "[]",
    "true",
    '{"id":"other"}',
    '{"compat":[]}',
    '{"compat":{"supportsDeveloperRole":"false"}}',
    '{"compat":{"maxTokensField":"other"}}',
    '{"headers":{"x":1}}',
    '{"cost":null}',
    '{"baseUrl":false}',
  ]) {
    expect(() => parseModelAdvanced(raw)).toThrow()
  }
})
test("advanced settings are available for both add and edit forms", () => {
  const panel = readFileSync(new URL("../src/components/settings/models/ModelSettings.vue", import.meta.url), "utf8")
  expect((panel.match(/<ModelEditForm\b/g) ?? []).length).toBe(2)
  const form = readFileSync(new URL("../src/components/settings/models/ModelEditForm.vue", import.meta.url), "utf8")
  expect(form).toMatch(/<ModelAdvancedSettings /)
  const logic = readFileSync(new URL("../src/components/settings/models/modelForm.ts", import.meta.url), "utf8")
  expect(logic).toMatch(/parseModelAdvanced\(f\.advanced\)/)
  expect(logic).toMatch(/advanced: modelAdvancedJson\(m\)/)
})

test("thinking level maps reject non-string provider values", () => {
  expect(() => parseModelAdvanced('{"thinkingLevelMap":{"high":1}}')).toThrow(/thinkingLevelMap.high/)
  expect(parseModelAdvanced('{"thinkingLevelMap":{"low":null,"xhigh":"extended"}}')).toEqual({
    thinkingLevelMap: { low: null, xhigh: "extended" },
  })
})
test("advanced settings expose thinking modes and mappings", () => {
  const component = readFileSync(
    new URL("../src/components/settings/ModelAdvancedSettings.vue", import.meta.url),
    "utf8",
  )
  expect(component).toMatch(/ALL_THINKING_LEVELS/)
  expect(component).toMatch(/THINKING_DISABLED/)
  expect(component).toMatch(/setThinkingMapping/)
})
