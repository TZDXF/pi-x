import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"
import { createMarkmendParser } from "vue-stream-markdown"
import { markdownParserOptions } from "@/lib/markdownAutoLink"
import { markdownImageContextKey, previewImageUrl, resolveMarkdownImageSource } from "@/lib/markdownImages"

// 回归（TZD-132）：文件预览里的 Markdown 图片曾经整片失效——渲染器在没有
// `defaultOrigin` 时把 `assets/a.png` 这类相对地址判为不安全，图片直接变成错误占位；
// 即便放行，webview 也只会按应用自身的源去请求，读不到项目目录。
// 现在的契约：相对地址按 md 文件所在目录解析成项目内路径，再经预览后端读成 data URL。

const preview = readFileSync(new URL("../src/components/ProjectFilePreview.vue", import.meta.url), "utf8")
const image = readFileSync(new URL("../src/components/MarkdownImage.vue", import.meta.url), "utf8")

const scopes: vue.EffectScope[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

const flush = async () => {
  await Promise.resolve()
  await vue.nextTick()
  await Promise.resolve()
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => {
    resolve = yes
  })
  return { promise, resolve }
}

/** 与仓库既有脚本 harness 一致：剥掉 import，用真实 Vue 响应式执行 setup 体。 */
function setup(props: Record<string, unknown>, context: unknown) {
  const source = image
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
  const scope = vue.effectScope()
  scopes.push(scope)
  const vmContext = vm.createContext({
    ...vue,
    markdownImageContextKey,
    resolveMarkdownImageSource,
    defineOptions: () => {},
    defineProps: () => props,
    inject: () => context,
    onBeforeUnmount: (callback: () => void) => vue.onScopeDispose(callback),
    useI18n: () => ({ t: (key: string) => key }),
  })
  scope.run(() =>
    vm.runInContext(
      ts.transpile(source + `\nglobalThis.api = { url, failed, source };`, { target: ts.ScriptTarget.ES2022 }),
      vmContext,
    ),
  )
  return { api: vmContext.api as { url: vue.Ref<string>; failed: vue.Ref<boolean> }, scope }
}

test("relative image paths resolve against the Markdown file's own directory", () => {
  // 成员反馈的原样示例：中文名先被解析层百分号编码，解析时要还原。
  expect(
    resolveMarkdownImageSource(
      "assets/spec/02/02-01-%E8%A7%92%E8%89%B2%E5%8D%8F%E4%BD%9C.png",
      "docs/spec/02/02-01.md",
    ),
  ).toEqual({ kind: "project", path: "docs/spec/02/assets/spec/02/02-01-角色协作.png" })
  expect(resolveMarkdownImageSource("./images/a.png", "docs/spec/02/a.md")).toEqual({
    kind: "project",
    path: "docs/spec/02/images/a.png",
  })
  expect(resolveMarkdownImageSource("../img/a.png", "docs/spec/a.md")).toEqual({
    kind: "project",
    path: "docs/img/a.png",
  })
  // 根相对地址按项目根解析；查询串与锚点不属于文件路径。
  expect(resolveMarkdownImageSource("/assets/a.png", "docs/a.md")).toEqual({ kind: "project", path: "assets/a.png" })
  expect(resolveMarkdownImageSource("a.png?v=2#top", "a.md")).toEqual({ kind: "project", path: "a.png" })
  expect(resolveMarkdownImageSource("assets\\win\\a.png", "docs/a.md")).toEqual({
    kind: "project",
    path: "docs/assets/win/a.png",
  })
})

test("external links pass through untouched and anything unreadable is blocked", () => {
  expect(resolveMarkdownImageSource("https://example.com/a.png", "a.md")).toEqual({
    kind: "external",
    url: "https://example.com/a.png",
  })
  // 回归（TZD-132 P2）：外链里的百分号编码是远端资源名的一部分，解码会改写请求地址。
  expect(resolveMarkdownImageSource("https://images.example.test/encoded%2Fobject.png", "a.md")).toEqual({
    kind: "external",
    url: "https://images.example.test/encoded%2Fobject.png",
  })
  expect(resolveMarkdownImageSource("https://example.com/a%20b.png?v=%2F#x", "a.md")).toEqual({
    kind: "external",
    url: "https://example.com/a%20b.png?v=%2F#x",
  })
  expect(resolveMarkdownImageSource("data:image/png;base64,AAA", "a.md")).toEqual({
    kind: "external",
    url: "data:image/png;base64,AAA",
  })
  expect(resolveMarkdownImageSource("//cdn.example.com/a%2Fb.png", "a.md")).toEqual({
    kind: "external",
    url: "https://cdn.example.com/a%2Fb.png",
  })
  // 越出项目根、绝对文件系统路径、非图片协议、空地址都不可渲染；
  // 解码后才露出协议或绝对路径的同样拦住。
  for (const src of [
    "../../etc/a.png",
    "C:/Users/a.png",
    "C:\\Users\\a.png",
    "javascript:alert(1)",
    "javascript%3Aalert(1)",
    "%2F%2Fevil.example.com/a.png",
    "%43%3A/Users/a.png",
    "file:///a.png",
    "",
  ])
    expect(resolveMarkdownImageSource(src, "docs/a.md"), src).toEqual({ kind: "blocked" })
})

test("preview payloads become data URLs and non-images stay unrenderable", () => {
  expect(
    previewImageUrl({ kind: "image", text: null, truncated: false, mime: "image/png", data: "AAA" }, "a.png"),
  ).toBe("data:image/png;base64,AAA")
  expect(previewImageUrl({ kind: "text", text: "<svg/>", truncated: false, mime: null, data: null }, "a.svg")).toBe(
    "data:image/svg+xml;utf8,%3Csvg%2F%3E",
  )
  expect(previewImageUrl({ kind: "text", text: "<svg/>", truncated: true, mime: null, data: null }, "a.svg")).toBeNull()
  expect(previewImageUrl({ kind: "binary", text: null, truncated: false, mime: null, data: null }, "a.png")).toBeNull()
  expect(previewImageUrl(null, "a.png")).toBeNull()
})

test("the reported Markdown sample keeps its image source through parsing", async () => {
  const { document } = await createMarkmendParser({ parserOptions: markdownParserOptions }).parse(
    "![图 2-1 角色协作关系](assets/spec/02/02-01-角色协作.png)",
    "static",
  )
  const [paragraph] = document.nodes as [string, Record<string, unknown>, [string, Record<string, unknown>]][]
  expect(paragraph[2][0]).toBe("img")
  expect(resolveMarkdownImageSource(String(paragraph[2][1].src), "docs/spec/02/02-01-角色协作.md")).toEqual({
    kind: "project",
    path: "docs/spec/02/assets/spec/02/02-01-角色协作.png",
  })
})

test("the img component loads project images through the preview reader", async () => {
  const load = vi.fn(async (path: string) => `data:image/png;base64,${path}`)
  const props = vue.reactive({ src: "assets/a.png", alt: "图 2-1" })
  const h = setup(props, { docPath: "docs/spec/a.md", load })
  await flush()
  expect(load).toHaveBeenCalledExactlyOnceWith("docs/spec/a.md".replace("a.md", "") + "assets/a.png")
  expect(h.api.url.value).toBe("data:image/png;base64,docs/spec/assets/a.png")
  expect(h.api.failed.value).toBe(false)
})

test("switching the Markdown file re-resolves the same relative source", async () => {
  const load = vi.fn(async (path: string) => `data:image/png;base64,${path}`)
  const props = vue.reactive({ src: "assets/a.png" })
  const h = setup(props, { docPath: "docs/a.md", load })
  await flush()
  props.src = "assets/b.png"
  await flush()
  expect(h.api.url.value).toBe("data:image/png;base64,docs/assets/b.png")
})

test("unreadable or blocked images fall back instead of showing a broken picture", async () => {
  const missing = setup(vue.reactive({ src: "assets/missing.png" }), {
    docPath: "docs/a.md",
    load: async () => null,
  })
  await flush()
  expect(missing.api.url.value).toBe("")
  expect(missing.api.failed.value).toBe(true)

  const load = vi.fn(async () => "data:image/png;base64,AAA")
  const blocked = setup(vue.reactive({ src: "javascript:alert(1)" }), { docPath: "docs/a.md", load })
  await flush()
  expect(load).not.toHaveBeenCalled()
  expect(blocked.api.failed.value).toBe(true)
})

test("external images skip the project reader entirely", async () => {
  const load = vi.fn(async () => "data:image/png;base64,AAA")
  const h = setup(vue.reactive({ src: "https://example.com/a.png" }), { docPath: "docs/a.md", load })
  await flush()
  expect(load).not.toHaveBeenCalled()
  expect(h.api.url.value).toBe("https://example.com/a.png")
})

test("unmounting drops a pending image read", async () => {
  const pending = deferred<string | null>()
  const h = setup(vue.reactive({ src: "assets/a.png" }), { docPath: "docs/a.md", load: () => pending.promise })
  h.scope.stop()
  pending.resolve("data:image/png;base64,AAA")
  await flush()
  expect(h.api.url.value).toBe("")
})

test("the preview wires the img override and a per-session image cache", () => {
  expect(preview).toContain('import MarkdownImage from "@/components/MarkdownImage.vue"')
  expect(preview).toContain("const markdownComponents = { img: MarkdownImage }")
  expect(preview).toContain(':components="markdownComponents"')
  expect(preview).toContain("provide(markdownImageContextKey")
  expect(preview).toContain("markdownImageCache.clear()")
})
