import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import { computed, reactive } from "vue"
import { groupModelsByProvider } from "@/lib/modelSelection"

test("provider groups retain first-seen order, model order, and model metadata", () => {
  const models = Object.freeze([
    Object.freeze({ provider: "z", id: "one", name: "One", reasoning: true }),
    Object.freeze({ provider: "a", id: "two", reasoning: false }),
    Object.freeze({ provider: "z", id: "three", reasoning: false }),
  ])
  const groups = groupModelsByProvider(models)
  expect(groups.map(group => group.provider)).toEqual(["z", "a"])
  expect(groups[0].models).toEqual([models[0], models[2]])
  expect(groups[0].models[0]).toBe(models[0])
  expect(groups[0].models[0].reasoning).toBe(true)
  groups[0].models.pop()
  expect(models).toHaveLength(3)
})

test("empty lists and duplicate model IDs across providers are preserved", () => {
  expect(groupModelsByProvider([])).toEqual([])
  const models = [
    { provider: "__proto__", id: "same" },
    { provider: "constructor", id: "same" },
  ]
  expect(groupModelsByProvider(models)).toEqual([
    { provider: "__proto__", models: [models[0]] },
    { provider: "constructor", models: [models[1]] },
  ])
})

test("the conversation select keeps reactive grouping and provider/model key matching", () => {
  const props = reactive({
    modelValue: "one/nested/model",
    models: [
      { provider: "one", id: "nested/model", name: "Named" },
      { provider: "two", id: "other" },
    ],
  })
  const component = readFileSync(new URL("../src/components/ConversationModelSelect.vue", import.meta.url), "utf8")
  const source = component
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
  const context = vm.createContext({
    computed,
    groupModelsByProvider,
    defineProps: () => props,
    withDefaults: value => value,
    defineEmits: () => () => {},
    useI18n: () => ({ t: key => key }),
  })
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { groups, selectedModel };", {
      target: ts.ScriptTarget.ES2022,
    }),
    context,
  )
  expect(context.api.selectedModel.value.name).toBe("Named")
  expect(context.api.groups.value.map(group => group.provider)).toEqual(["one", "two"])
  props.models = [{ provider: "two", id: "other" }]
  expect(context.api.selectedModel.value).toBeUndefined()
  expect(context.api.groups.value.map(group => group.provider)).toEqual(["two"])
  // Shared options do not replace this select's positioning or display behavior.
  expect(component).toContain(`:side="openAbove ? 'top' : undefined"`)
  expect(component).toContain("showProvider")
  expect(component).toContain('<ModelSelectOptions :groups="groups" />')
})
