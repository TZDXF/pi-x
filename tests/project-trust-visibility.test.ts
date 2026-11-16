import { readFileSync } from "node:fs"
import { expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"

/**
 * 编辑项目里的信任标注只对未信任目录出现（TZD-115）：
 * 组件仍是行内小控件，不再渲染“项目信任”卡片，也不对已信任项目输出任何状态文案。
 */
const { descriptor } = parse(readFileSync("src/components/ProjectTrustControl.vue", "utf8"))

function renderComponent(trust: {
  trusted: boolean
  status: unknown
  saving?: boolean
  saved?: boolean
  error?: unknown
}) {
  const pushToast = vi.fn()
  const trust_ = vi.fn()
  const refresh = vi.fn()
  const state = vue.reactive({
    status: trust.status,
    saved: !!trust.saved,
    saving: !!trust.saving,
    error: trust.error ?? null,
    trusted: trust.trusted,
  })
  const compiled = compileScript(descriptor, { id: "project-trust-visibility", inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const modules = {
    vue: { ...vue, onScopeDispose() {} },
    "vue-i18n": { useI18n: () => ({ t: (key: string) => key }) },
    "@lucide/vue": { LoaderCircle: "svg", ShieldCheck: "svg" },
    "@/api/piClient": {},
    "@/components/ui/badge": { Badge: "span" },
    "@/components/ui/button": { Button: "button" },
    "@/composables/useProjectTrust": {
      useProjectTrust: () => ({
        status: vue.computed(() => state.status),
        saving: vue.computed(() => state.saving),
        saved: vue.computed(() => state.saved),
        error: vue.computed(() => state.error),
        trusted: vue.computed(() => state.trusted),
        refresh,
        trust: trust_,
      }),
    },
    "@/stores/conversations": { useUiStore: () => ({ pushToast }) },
    "@/i18n": { tBackendError: (error: unknown) => String(error) },
    "@/lib/ssh": {},
  }
  const exports = {} as { default: { setup: (props: unknown, ctx: unknown) => unknown } }
  new Function("exports", "require", code)(exports, (id: string) => modules[id as keyof typeof modules])
  const scope = vue.effectScope()
  const render = scope.run(() => exports.default.setup({ project: "D:/project", active: true, connections: [] }, {}))
  return {
    render: () => (render as (ctx: unknown, children: unknown[]) => unknown)({}, []),
    pushToast,
    state,
    stop: () => scope.stop(),
  }
}

/** 收集渲染树里的文本与 props，用于断言“没有状态文案”。 */
function collect(node: unknown): { text: string[]; props: Record<string, unknown>[] } {
  const text: string[] = []
  const props: Record<string, unknown>[] = []
  const walk = (value: unknown) => {
    if (value == null) return
    if (typeof value === "string" || typeof value === "number") {
      text.push(String(value))
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child)
      return
    }
    const vnode = value as { children?: unknown; props?: Record<string, unknown>; type?: unknown }
    // 编译器用注释节点标注 v-if/v-else 分支，它们不是渲染内容。
    if (vnode.type === vue.Comment) return
    if (vnode.type === vue.Text) {
      text.push(String(vnode.children ?? ""))
      return
    }
    if (vnode.props) props.push(vnode.props)
    const children = vnode.children as { default?: () => unknown } | unknown
    if (children && typeof children === "object" && typeof (children as { default?: unknown }).default === "function") {
      walk((children as { default: () => unknown }).default())
      return
    }
    walk(children)
  }
  walk(node)
  return { text, props }
}

test("trusted projects render no trust status at all", () => {
  const component = renderComponent({ trusted: true, status: { decision: true } })
  try {
    const { text, props } = collect(component.render())
    expect(text.join("")).toBe("")
    expect(props).toEqual([])
  } finally {
    component.stop()
  }
})

test("untrusted projects keep only the badge and the trust action", () => {
  const component = renderComponent({ trusted: false, status: { hasTrustRequiringResources: true } })
  try {
    const { text, props } = collect(component.render())
    expect(text.join(" ")).toContain("projectDialog.untrusted")
    expect(text.join(" ")).toContain("projectDialog.trustProject")
    // 卡片标题与加载态文案不再出现，信任说明改为徽标 title。
    expect(text.join(" ")).not.toContain("projectDialog.trustTitle")
    expect(text.join(" ")).not.toContain("projectDialog.trustLoading")
    expect(props.some(prop => prop.title === "trust.warning")).toBe(true)
  } finally {
    component.stop()
  }
})

test("saving a decision surfaces the saved notice as a toast, not a standing line", async () => {
  const component = renderComponent({ trusted: false, status: { decision: false } })
  try {
    const { text } = collect(component.render())
    expect(text.join(" ")).not.toContain("projectDialog.trustSaved")
    component.state.saved = true
    await vue.nextTick()
    expect(component.pushToast).toHaveBeenCalledWith("projectDialog.trustSaved", "info")
  } finally {
    component.stop()
  }
})

test("read failures stay retryable inline", () => {
  const component = renderComponent({ trusted: false, status: null, error: new Error("read failed") })
  try {
    const { text } = collect(component.render())
    expect(text.join(" ")).toContain("Error: read failed")
    expect(text.join(" ")).toContain("common.retry")
  } finally {
    component.stop()
  }
})

test("the editor only mounts trust controls for existing directories", () => {
  const dialog = readFileSync("src/components/CreateProjectDialog.vue", "utf8")
  expect(dialog).not.toContain("trustProjects")
  // 目录行内标注只在编辑已有项目时出现。
  expect(dialog).toMatch(/v-if="props\.editPath"\s*\n\s*:project="path"/)
  expect(dialog).toContain('v-if="remoteTrustProject"')
})
