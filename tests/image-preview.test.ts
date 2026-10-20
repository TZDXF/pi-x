import { expect, test, vi } from "vitest"
import * as vue from "vue"
import { compileScript, parse } from "vue/compiler-sfc"
import ts from "typescript"
import { chatSource } from "./fixtures/chatSources"

test("image previews cover the chat below the title bar with a dark backdrop", () => {
  for (const file of ["ChatDialogs.vue", "ToolImageGallery.vue"]) {
    const source = chatSource(`components/chat/${file}`)
    expect(source).toContain(':modal="false"')
    expect(source).toContain("<ImagePreviewContent")
  }
  const preview = chatSource("components/chat/ImagePreviewContent.vue")
  expect(preview).toContain("inset-x-0 bottom-0 top-9")
  expect(preview).toContain("bg-black/60")
  expect(preview).not.toMatch(/max-w-|DialogOverlay/)
  expect(preview).toContain("@interact-outside.prevent")
  expect(preview).toContain("<DialogClose as-child>")
  expect(preview).toContain('@background-click="closePreview"')
  expect(chatSource("components/WindowTitleBar.vue")).toContain("h-9")
})

// 编译真实模板，验证空白点击与图片、工具栏事件冒泡的区别，无需浏览器或额外依赖。
function renderComponent(file: string, imports: Record<string, unknown>, emit = vi.fn()) {
  const { descriptor } = parse(chatSource(file))
  const compiled = compileScript(descriptor, { id: file, inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const modules = {
    vue: { ...vue, onMounted() {}, onBeforeUnmount() {} },
    "vue-i18n": { useI18n: () => ({ t: key => key }) },
    "@lucide/vue": { X: "svg", ImageOff: "svg", Maximize: "svg", ZoomIn: "svg", ZoomOut: "svg" },
    "@/components/ui/button": { Button: "button" },
    ...imports,
  }
  const exports = {} as any
  new Function("exports", "require", code)(exports, id => modules[id])
  const scope = vue.effectScope()
  const render = scope.run(() => exports.default.setup({ src: "test.png" }, { emit, expose() {} }))
  return { render: () => render({ $t: key => key }, []), stop: () => scope.stop() }
}

function click(...path: any[]) {
  const event = { target: path.at(-1), currentTarget: null }
  for (const currentTarget of [...path].reverse()) {
    event.currentTarget = currentTarget
    currentTarget.props?.onClick?.(event)
  }
}

test("viewer emits background clicks for padding and empty space, but not images or zoom controls", () => {
  const emit = vi.fn()
  const viewer = renderComponent("components/ImageViewer.vue", {}, emit)
  try {
    let root = viewer.render()
    let center = root.children[0]
    click(root)
    click(root, center)
    expect(emit.mock.calls).toEqual([["backgroundClick"], ["backgroundClick"]])
    emit.mockClear()
    const image = center.children[0]
    click(root, center, image)
    image.props.onLoad({ target: { naturalWidth: 800, naturalHeight: 600 } })
    root = viewer.render()
    center = root.children[0]
    const toolbar = root.children[1]
    click(root, toolbar)
    for (const control of toolbar.children) click(root, toolbar, control)
    click(root, center, center.children[0])
    expect(emit).not.toHaveBeenCalled()
  } finally {
    viewer.stop()
  }
})

test("preview closes on its backdrop, viewer background and Escape while ignoring content clicks", () => {
  const close = vi.fn()
  const preview = renderComponent("components/chat/ImagePreviewContent.vue", {
    "reka-ui": {
      DialogPortal: {},
      DialogContent: {},
      DialogTitle: {},
      DialogClose: {},
      injectDialogRootContext: () => ({ onOpenChange: close }),
    },
    "@/components/ImageViewer.vue": { default: {} },
  })
  try {
    const content = preview
      .render()
      .children.default()
      .find(node => node.props?.onClick)
    click(content)
    expect(close).toHaveBeenCalledExactlyOnceWith(false)
    close.mockClear()
    const viewer = content.children.default().find(node => node.props?.onBackgroundClick)
    click(content, viewer)
    expect(close).not.toHaveBeenCalled()
    viewer.props.onBackgroundClick()
    expect(close).toHaveBeenCalledExactlyOnceWith(false)
    close.mockClear()
    const escape = { key: "Escape", preventDefault: vi.fn(), stopPropagation: vi.fn() }
    content.props.onEscapeKeyDown(escape)
    expect(close).toHaveBeenCalledExactlyOnceWith(false)
    expect(escape.preventDefault).toHaveBeenCalledOnce()
    expect(escape.stopPropagation).toHaveBeenCalledOnce()
  } finally {
    preview.stop()
  }
})
