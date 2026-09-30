import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
// modelAdvanced.ts imports the structured-field validators from @/lib/modelLimits,
// so it is loaded through the alias instead of a transpiled data: URL.
const { modelAdvancedJson, parseModelAdvanced } = await import("@/lib/modelAdvanced")

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
  expect(form).toMatch(/<ModelAdvancedSettings\b/)
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
test("thinking levels render as a toggle group with double-click mapping", () => {
  const component = readFileSync(
    new URL("../src/components/settings/ModelAdvancedSettings.vue", import.meta.url),
    "utf8",
  )
  expect(component).toMatch(/ALL_THINKING_LEVELS/)
  expect(component).toMatch(/<ButtonGroup/)
  expect(component).toMatch(/@dblclick="onLevelDblClick\(level\)"/)
  expect(component).toMatch(/thinkingLevelMode/)
  expect(component).toMatch(/setThinkingMapping/)
  // A level without an override is selected: the button group defaults to all on.
  expect(component).not.toMatch(/THINKING_INHERIT/)
})

test("thinking level toggles and mappings keep the map minimal", async () => {
  const levels = await import("@/lib/thinkingLevels")
  const base: Record<string, unknown> = {}
  for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const)
    expect(levels.thinkingLevelMode(base, level)).toBe("inherit")

  const disabled = levels.toggleThinkingLevel(base, "high")
  expect(disabled).toEqual({ high: null })
  expect(levels.thinkingLevelMode(disabled, "high")).toBe("disabled")
  expect(levels.toggleThinkingLevel(disabled, "high")).toEqual({})

  const custom = levels.setThinkingMapping(base, "xhigh", "extended")
  expect(custom).toEqual({ xhigh: "extended" })
  expect(levels.thinkingLevelMode(custom, "xhigh")).toBe("custom")
  expect(levels.thinkingLevelValue(custom, "xhigh")).toBe("extended")
  expect(levels.thinkingLevelValue(base, "xhigh")).toBe("xhigh")
  // A same-name mapping is pi's default, except for the levels pi only enables explicitly.
  expect(levels.setThinkingMapping(base, "high", "high")).toEqual({})
  expect(levels.setThinkingMapping(base, "xhigh", "xhigh")).toEqual({ xhigh: "xhigh" })
  expect(levels.setThinkingMapping(custom, "xhigh", " ")).toEqual({})
  // Re-enabling a level pi enables explicitly must keep the mapping that enables it.
  expect(levels.toggleThinkingLevel({ xhigh: null }, "xhigh")).toEqual({ xhigh: "xhigh" })
  expect([
    ...levels.supportedThinkingLevels({
      reasoning: true,
      thinkingLevelMap: levels.toggleThinkingLevel({ xhigh: null }, "xhigh"),
    }),
  ]).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"])
})
