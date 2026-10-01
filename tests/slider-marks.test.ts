import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"

function harness(props: { modelValue?: number[]; marks?: string[] }) {
  const source = readFileSync(new URL("../src/components/ui/slider/Slider.vue", import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)[1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
  const emitted: Record<string, unknown[]> = {}
  const context = vm.createContext({
    computed: fn => ({
      get value() {
        return fn()
      },
    }),
    reactiveOmit: (props, ...keys) => Object.fromEntries(Object.entries(props).filter(([key]) => !keys.includes(key))),
    useForwardPropsEmits: () => () => ({}),
    // 组件宏由 vue 编译器展开，这里直接提供运行时等价物以便对逻辑求值。
    defineProps: () => ({ ...props }),
    defineEmits: () => (event: string, payload: unknown) => {
      emitted[event] ??= []
      emitted[event].push(payload)
    },
    // withDefaults 会调用工厂型默认值（如 marks），与 vue 运行时行为保持一致。
    withDefaults: (props, defaults) => {
      const base = typeof props === "function" ? props() : props
      const resolved = Object.fromEntries(
        Object.entries(defaults ?? {}).map(([key, value]) => [key, typeof value === "function" ? value() : value]),
      )
      return { ...resolved, ...base }
    },
  })
  vm.runInContext(
    ts.transpile(source + "\nglobalThis.api = { currentIndex, markLeft, onMarkClick };", {
      target: ts.ScriptTarget.ES2022,
    }),
    context,
  )
  return { api: context.api, emitted }
}

test("the current index follows the first slider value and defaults to the first stop", () => {
  expect(harness({ modelValue: [2], marks: ["a", "b", "c"] }).api.currentIndex.value).toBe(2)
  expect(harness({ marks: ["a", "b", "c"] }).api.currentIndex.value).toBe(0)
  expect(harness({ modelValue: [1.4] }).api.currentIndex.value).toBe(1)
})

test("mark positions match reka-ui thumb placement across the track", () => {
  const { api } = harness({ modelValue: [1], marks: ["a", "b", "c"] })
  expect(api.markLeft(0, 3)).toBe("calc(0% + 8px)")
  expect(api.markLeft(1, 3)).toBe("calc(50% + 0px)")
  expect(api.markLeft(2, 3)).toBe("calc(100% + -8px)")
})

test("clicking a mark emits that stop as the slider value", () => {
  const { api, emitted } = harness({ modelValue: [0], marks: ["a", "b", "c"] })
  api.onMarkClick(2)
  expect(emitted["update:modelValue"]).toEqual([[2]])
})
