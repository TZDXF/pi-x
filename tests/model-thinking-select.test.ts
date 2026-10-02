import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { groupModelsByProvider } from "@/lib/modelSelection"

const MODELS = [
  { provider: "anthropic", id: "claude", name: "Claude" },
  { provider: "openai", id: "gpt", name: "GPT" },
  { provider: "openai", id: "gpt-mini" },
]

function harness(props: {
  modelValue: string
  thinkingLevel: string
  availableThinking: string[]
  translated?: boolean
}) {
  const source = readFileSync(new URL("../src/components/ModelThinkingSelect.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
  const emitted: Record<string, unknown[]> = {}
  const context = vm.createContext({
    groupModelsByProvider,
    computed: fn => ({
      get value() {
        return fn()
      },
    }),
    useI18n: () => ({
      t: (key: string) => key,
      te: () => props.translated !== false,
    }),
    // 组件宏由 vue 编译器展开，这里直接提供运行时等价物以便对逻辑求值。
    defineProps: () => ({ ...props, models: MODELS }),
    defineEmits: () => (event: string, payload: unknown) => {
      emitted[event] ??= []
      emitted[event].push(payload)
    },
  })
  vm.runInContext(
    ts.transpile(
      source +
        "\nglobalThis.api = { selectedModel, groups, levels, sliderIndex, levelLabel, onModelChange, onSliderChange };",
      { target: ts.ScriptTarget.ES2022 },
    ),
    context,
  )
  return { api: context.api, emitted }
}

test("models are grouped by provider and the selected model is resolved", () => {
  const { api } = harness({
    modelValue: "openai/gpt",
    thinkingLevel: "medium",
    availableThinking: ["off", "low", "medium", "high"],
  })
  expect(api.groups.value.map(group => group.provider)).toEqual(["anthropic", "openai"])
  expect(api.groups.value[1].models.map(model => model.id)).toEqual(["gpt", "gpt-mini"])
  expect(api.selectedModel.value.name).toBe("GPT")
})

test("the slider position tracks the current level and falls back to the first stop", () => {
  const { api } = harness({
    modelValue: "openai/gpt",
    thinkingLevel: "medium",
    availableThinking: ["off", "low", "medium", "high"],
  })
  expect(api.sliderIndex.value).toBe(2)
  const clamped = harness({
    modelValue: "openai/gpt",
    thinkingLevel: "xhigh",
    availableThinking: ["off", "low", "medium", "high"],
  })
  expect(clamped.api.sliderIndex.value).toBe(0)
})

test("slider changes emit the level at the requested stop, clamped to the available range", () => {
  const { api, emitted } = harness({
    modelValue: "openai/gpt",
    thinkingLevel: "medium",
    availableThinking: ["off", "low", "medium", "high"],
  })
  api.onSliderChange([1])
  expect(emitted["update:thinkingLevel"]).toEqual(["low"])
  api.onSliderChange([99])
  expect(emitted["update:thinkingLevel"]).toEqual(["low", "high"])
  api.onSliderChange("nope")
  expect(emitted["update:thinkingLevel"]).toHaveLength(2)
})

test("model radio changes emit the model key and ignore non-string values", () => {
  const { api, emitted } = harness({ modelValue: "openai/gpt", thinkingLevel: "medium", availableThinking: ["off"] })
  api.onModelChange("openai/gpt-mini")
  expect(emitted["update:modelValue"]).toEqual(["openai/gpt-mini"])
  api.onModelChange(42)
  expect(emitted["update:modelValue"]).toHaveLength(1)
})

test("level labels fall back to the raw level when no translation exists", () => {
  const translated = harness({
    modelValue: "openai/gpt",
    thinkingLevel: "medium",
    availableThinking: ["off"],
    translated: true,
  })
  expect(translated.api.levelLabel("medium")).toBe("chat.thinkingLevels.medium")
  const untranslated = harness({
    modelValue: "openai/gpt",
    thinkingLevel: "medium",
    availableThinking: ["off"],
    translated: false,
  })
  expect(untranslated.api.levelLabel("medium")).toBe("medium")
})
