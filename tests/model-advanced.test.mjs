import { test } from "node:test"
import assert from "node:assert/strict"
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
  assert.deepEqual(
    parseModelAdvanced(modelAdvancedJson({ id: "test", api: "openai-completions", reasoning: true, ...extra })),
    extra,
  )
})
test("empty advanced settings remove overrides and inherit pi defaults", () => {
  assert.deepEqual(parseModelAdvanced(""), {})
  assert.deepEqual(parseModelAdvanced("{}"), {})
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
    assert.throws(() => parseModelAdvanced(raw), raw)
  }
})
test("advanced settings are available for both add and edit forms", () => {
  const panel = readFileSync(new URL("../src/components/settings/models/ModelSettings.vue", import.meta.url), "utf8")
  assert.equal((panel.match(/<ModelEditForm\b/g) ?? []).length, 2)
  const form = readFileSync(new URL("../src/components/settings/models/ModelEditForm.vue", import.meta.url), "utf8")
  assert.match(form, /<ModelAdvancedSettings /)
  const logic = readFileSync(new URL("../src/components/settings/models/modelForm.ts", import.meta.url), "utf8")
  assert.match(logic, /parseModelAdvanced\(f\.advanced\)/)
  assert.match(logic, /advanced: modelAdvancedJson\(m\)/)
})

test("thinking level maps reject non-string provider values", () => {
  assert.throws(() => parseModelAdvanced('{"thinkingLevelMap":{"high":1}}'), /thinkingLevelMap.high/)
  assert.deepEqual(parseModelAdvanced('{"thinkingLevelMap":{"low":null,"xhigh":"extended"}}'), {
    thinkingLevelMap: { low: null, xhigh: "extended" },
  })
})
test("advanced settings expose thinking modes and mappings", () => {
  const component = readFileSync(
    new URL("../src/components/settings/ModelAdvancedSettings.vue", import.meta.url),
    "utf8",
  )
  assert.match(component, /ALL_THINKING_LEVELS/)
  assert.match(component, /THINKING_DISABLED/)
  assert.match(component, /setThinkingMapping/)
})
