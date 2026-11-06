import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import { useForwardPropsEmits } from "reka-ui"
import ts from "typescript"

const filename = fileURLToPath(new URL("../src/components/ai-elements/canvas/Canvas.vue", import.meta.url))
const { descriptor } = parse(readFileSync(filename, "utf8"), { filename })
const compiled = compileScript(descriptor, { id: "canvas-forwarding-test", inlineTemplate: true })
const code = ts.transpileModule(compiled.content, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText

test("Canvas preserves default props, reactivity and every declared event when forwarding to VueFlow", async () => {
  let forwarded: Record<string, any> = {}
  const modules = {
    vue,
    "reka-ui": { useForwardPropsEmits },
    "@vue-flow/core": {
      VueFlow: vue.defineComponent({
        inheritAttrs: false,
        setup(_, { attrs }) {
          forwarded = attrs
          return () => null
        },
      }),
    },
    "@vue-flow/background": { Background: () => null },
  }
  const exports = {} as any
  new Function("exports", "require", code)(exports, id => modules[id] ?? {})
  const Canvas = exports.default
  const listeners = Object.fromEntries(
    Canvas.emits.map((event: string) => [vue.toHandlerKey(vue.camelize(event)), vi.fn()]),
  )
  const props = vue.reactive({ panOnDrag: false })
  const renderer = vue.createRenderer({
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    insert() {},
    remove() {},
    parentNode: () => null,
    nextSibling: () => null,
    setText() {},
    setElementText() {},
    patchProp() {},
  })
  const app = renderer.createApp({ setup: () => () => vue.h(Canvas, { ...props, ...listeners }) })
  app.mount({})
  try {
    expect(forwarded.deleteKeyCode).toEqual(["Backspace", "Delete"])
    expect(forwarded.fitViewOnInit).toBe(true)
    expect(forwarded.panOnDrag).toBe(false)
    expect(forwarded.panOnScroll).toBe(true)
    expect(forwarded.zoomOnDoubleClick).toBe(false)
    for (const [handler, listener] of Object.entries(listeners)) {
      const payload = { handler }
      forwarded[handler](payload)
      expect(listener).toHaveBeenCalledExactlyOnceWith(payload)
    }
    props.panOnDrag = true
    await vue.nextTick()
    expect(forwarded.panOnDrag).toBe(true)
  } finally {
    app.unmount()
  }
})
