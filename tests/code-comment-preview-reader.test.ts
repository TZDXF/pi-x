import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"
import { parseCodedError, encodeCodedError } from "@/lib/backendError"
import { resolveCodeCommentFile } from "@/lib/codeCommentNavigation"

// 回归（TZD-132 P2）：代码批注弹窗的 Rendered view 必须能显示 Markdown 里的相对图片。
// 之前弹窗的读取回调忽略传入的项目相对路径，永远读批注目标 Markdown 本身，
// 图片既没发起读取也没渲染，只剩 alt 占位。

const source = readFileSync(new URL("../src/components/chat/CodeCommentPreview.vue", import.meta.url), "utf8")
  .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
  .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")

const scopes: vue.EffectScope[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

function setup(comment: Record<string, unknown> | null, roots: string[], read = vi.fn(async () => ({ kind: "text" }))) {
  const scope = vue.effectScope()
  scopes.push(scope)
  const context = vm.createContext({
    ...vue,
    defineProps: () => vue.reactive({ comment, roots }),
    defineEmits: () => vi.fn(),
    useI18n: () => ({ t: (key: string, params?: { path?: string }) => `${key}:${params?.path ?? ""}` }),
    invokeProjectFile: read,
    parseCodedError,
    resolveCodeCommentFile,
  })
  scope.run(() =>
    vm.runInContext(
      ts.transpile(source + `\nglobalThis.api = { readFile, target };`, { target: ts.ScriptTarget.ES2022 }),
      context,
    ),
  )
  return { api: context.api as { readFile: vue.ComputedRef<(path?: string) => Promise<unknown>> }, read, scope }
}

const comment = { path: "C:/demo/docs/guide.md", startLine: 3, endLine: 3, selectedText: "img", comment: "See diagram" }

test("the dialog reads the requested project-relative path under the comment's project root", async () => {
  const { api, read } = setup(
    comment,
    ["C:/demo"],
    vi.fn(async () => ({ kind: "image", data: "AAA" })),
  )
  await api.readFile.value("docs/guide.md")
  await api.readFile.value("docs/assets/spec/02/02-01-角色协作.png")
  expect(read.mock.calls).toEqual([
    ["read_file_preview", "C:/demo", "docs/guide.md"],
    ["read_file_preview", "C:/demo", "docs/assets/spec/02/02-01-角色协作.png"],
  ])
})

test("an empty request falls back to the comment's own file", async () => {
  const { api, read } = setup(comment, ["C:/demo"])
  await api.readFile.value()
  expect(read).toHaveBeenCalledExactlyOnceWith("read_file_preview", "C:/demo", "docs/guide.md")
})

test("coded path errors stay friendly and name the file that failed", async () => {
  const read = vi.fn(async () => {
    throw encodeCodedError("previewPathInvalid", "无效的文件路径")
  })
  const { api } = setup(comment, ["C:/demo"], read)
  // Markdown 本体失败时沿用批注里的原始路径（用户认得出的那个）。
  await expect(api.readFile.value("docs/guide.md")).rejects.toThrow(
    "projectFiles.commentFileUnavailable:C:/demo/docs/guide.md",
  )
  // 图片等派生路径失败时报出实际请求的项目内路径。
  await expect(api.readFile.value("docs/assets/missing.png")).rejects.toThrow(
    "projectFiles.commentFileUnavailable:docs/assets/missing.png",
  )
})

test("other failures propagate and unknown roots report an unavailable file", async () => {
  const boom = new Error("network down")
  const { api } = setup(
    comment,
    ["C:/demo"],
    vi.fn(async () => Promise.reject(boom)),
  )
  await expect(api.readFile.value("docs/guide.md")).rejects.toBe(boom)

  const orphan = setup({ ...comment, path: "missing.md" }, [])
  await expect(orphan.api.readFile.value("missing.md")).rejects.toThrow(
    "projectFiles.commentFileUnavailable:missing.md",
  )
})
