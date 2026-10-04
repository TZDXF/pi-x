import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"
import * as modelLimits from "@/lib/modelLimits"
import * as thinkingLevels from "@/lib/thinkingLevels"
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
  expect(component).toMatch(/thinkingLevelEnabled/)
  expect(component).toMatch(/setThinkingMapping/)
  // The button group mirrors pi: xhigh/max stay off until the map names them.
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

test("the button group counts xhigh and max as off until pi is told to enable them", async () => {
  const levels = await import("@/lib/thinkingLevels")
  const base: Record<string, unknown> = {}
  expect(levels.thinkingLevelEnabled(base, "high")).toBe(true)
  expect(levels.thinkingLevelEnabled({ high: "think" }, "high")).toBe(true)
  expect(levels.thinkingLevelEnabled({ high: null }, "high")).toBe(false)
  // A missing entry keeps pi's default, which does not offer the two extra levels.
  expect(levels.thinkingLevelEnabled(base, "xhigh")).toBe(false)
  expect(levels.thinkingLevelEnabled(base, "max")).toBe(false)
  expect(levels.thinkingLevelEnabled({ xhigh: "xhigh" }, "xhigh")).toBe(true)
  expect(levels.thinkingLevelEnabled({ xhigh: "extended" }, "xhigh")).toBe(true)
  expect(levels.thinkingLevelEnabled({ xhigh: null }, "xhigh")).toBe(false)

  // Toggling an unmapped extra level enables it instead of writing a disabling null.
  expect(levels.toggleThinkingLevel(base, "xhigh")).toEqual({ xhigh: "xhigh" })
  expect(levels.toggleThinkingLevel(base, "high")).toEqual({ high: null })
  expect(levels.toggleThinkingLevel({ xhigh: "extended" }, "xhigh")).toEqual({ xhigh: null })
})

test("shared textareas preserve fallback draft/change events and advanced JSON validation", async () => {
  const source = readFileSync(new URL("../src/components/settings/ModelAdvancedSettings.vue", import.meta.url), "utf8")
  expect(source.match(/<Textarea\b/g)).toHaveLength(2)
  expect(source).not.toMatch(/<textarea\b/)
  expect(source).toMatch(/:model-value="fallbackModels"/)
  expect(source).toMatch(/@input="onFallbackInput"/)
  expect(source).toMatch(/@change="setFallbackModels"/)
  expect(source).toMatch(/@focus="focused = 'fallbackModels'"/)
  expect(source).toMatch(/@blur="focused = ''"/)
  expect(source).toMatch(/<Textarea\s+v-model="model"/)
  const script = source
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
  const model = vue.ref('{"futureOption":"keep"}')
  const emitted: boolean[] = []
  const context = vm.createContext({
    ...vue,
    ...modelLimits,
    ...thinkingLevels,
    parseModelAdvanced,
    defineModel: () => model,
    defineProps: () => ({ api: "anthropic-messages" }),
    defineEmits: () => (_event: string, value: boolean) => emitted.push(value),
    useI18n: () => ({ t: key => key }),
    useId: () => "advanced-test",
  })
  const scope = vue.effectScope()
  try {
    scope.run(() =>
      vm.runInContext(
        ts.transpile(
          script +
            "\nglobalThis.api = { onFallbackInput, setFallbackModels, focused, fallbackModels, fallbackError, parsed };",
          { target: ts.ScriptTarget.ES2022 },
        ),
        context,
      ),
    )
    const api = context.api
    expect(emitted.at(-1)).toBe(false)
    api.focused.value = "fallbackModels"
    api.onFallbackInput({ target: { value: "{" } })
    expect(api.fallbackModels.value).toBe("{")
    expect(JSON.parse(model.value)).toEqual({ futureOption: "keep" })
    api.setFallbackModels()
    await vue.nextTick()
    expect(api.fallbackError.value).not.toBeNull()
    expect(emitted.at(-1)).toBe(true)
    const fallback = {
      provider: "anthropic",
      model: "claude",
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }
    api.onFallbackInput({ target: { value: JSON.stringify([fallback]) } })
    api.setFallbackModels()
    await vue.nextTick()
    expect(emitted.at(-1)).toBe(false)
    expect(JSON.parse(model.value)).toEqual({
      futureOption: "keep",
      compat: { allowedFallbackModels: [fallback] },
    })
    model.value = "{"
    await vue.nextTick()
    expect(api.parsed.value.error).not.toBe("")
    expect(emitted.at(-1)).toBe(true)
    model.value = "{}"
    api.focused.value = ""
    await vue.nextTick()
    expect(emitted.at(-1)).toBe(false)
    expect(api.fallbackModels.value).toBe("[]")
  } finally {
    scope.stop()
  }
})
