import { afterEach, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import vm from "node:vm"
import ts from "typescript"
import * as vue from "vue"
import { isMarkdownExt } from "@/lib/fileKind"
import { normalizeSlashes } from "@/lib/paths"
import { useContentTranslation } from "@/composables/useContentTranslation"
import { usePointerDrag } from "@/composables/usePointerDrag"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const scopes: vue.EffectScope[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))

// Match the repository's script harness, but use real Vue watchers and disposal
// so promise races are exercised rather than replacing reactivity with mocks.
function setup(component: string, props: Record<string, unknown>, fields: string, custom = {}) {
  const source = readFileSync(new URL(`../src/components/${component}.vue`, import.meta.url), "utf8")
    .match(/<script setup lang="ts">([\s\S]*?)<\/script>/)![1]
    .replace(/^import[\s\S]*?from\s+["'][^"']+["']\n/gm, "")
    .replace(/^import\s+["'][^"']+["']\n/gm, "")
  const scope = vue.effectScope()
  scopes.push(scope)
  const errors = vi.fn()
  const context = vm.createContext({
    ...vue,
    isMarkdownExt,
    normalizeSlashes,
    useContentTranslation,
    usePointerDrag,
    defineProps: () => props,
    withDefaults: value => value,
    defineEmits: () => vi.fn(),
    useI18n: () => ({ t: key => key, locale: vue.ref("en") }),
    useUiStore: () => ({ pushToast: errors }),
    ...custom,
  })
  scope.run(() =>
    vm.runInContext(
      ts.transpile(source + `\nglobalThis.api = { ${fields} };`, { target: ts.ScriptTarget.ES2022 }),
      context,
    ),
  )
  return { api: context.api, errors, scope }
}
const flush = async () => {
  await Promise.resolve()
  await vue.nextTick()
  await Promise.resolve()
}
function browser(listFiles: () => Promise<string[]>) {
  const props = vue.reactive({ listFiles, readFile: async () => "", project: "" })
  return {
    props,
    ...setup("ResourceMarkdownBrowser", props, "files, loading, selected, filter, hasMatches, generation"),
  }
}

test("the shared browser only lists Markdown and filters normalized paths case-insensitively", async () => {
  const h = browser(async () => ["README.md", "docs\\Usage.MD", "guide.markdown", "src/index.ts", "logo.png"])
  await flush()
  expect(h.api.files.value).toEqual(["README.md", "docs/Usage.MD", "guide.markdown"])
  expect(h.api.loading.value).toBe(false)
  h.api.filter.value = " DOCS\\usage "
  expect(h.api.hasMatches.value).toBe(true)
  h.api.filter.value = "missing"
  expect(h.api.hasMatches.value).toBe(false)
})

for (const outcome of ["success", "failure"]) {
  test(`resource changes reset selection/filter and suppress stale list ${outcome}`, async () => {
    const old = deferred<string[]>()
    const current = deferred<string[]>()
    const h = browser(() => old.promise)
    h.api.selected.value = "old.md"
    h.api.filter.value = "old"
    const generation = h.api.generation.value
    h.props.listFiles = () => current.promise
    expect(h.api.generation.value).toBeGreaterThan(generation)
    expect(h.api.selected.value).toBeNull()
    expect(h.api.filter.value).toBe("")
    if (outcome === "success") old.resolve(["stale.md"])
    else old.reject(new Error("stale"))
    await flush()
    expect(h.api.files.value).toEqual([])
    expect(h.api.loading.value).toBe(true)
    expect(h.errors).not.toHaveBeenCalled()
    current.resolve(["current.md"])
    await flush()
    expect(h.api.files.value).toEqual(["current.md"])
    expect(h.api.loading.value).toBe(false)
  })
}

test("closing the resource resets loading and stale failures never create a toast", async () => {
  const old = deferred<string[]>()
  const h = browser(() => old.promise)
  h.props.listFiles = undefined
  expect(h.api.loading.value).toBe(false)
  old.reject(new Error("closed"))
  await flush()
  expect(h.errors).not.toHaveBeenCalled()
  expect(h.api.files.value).toEqual([])
})

test("active list failures clear loading and are reported once", async () => {
  const old = deferred<string[]>()
  const h = browser(() => old.promise)
  old.reject(new Error("active"))
  await flush()
  expect(h.api.loading.value).toBe(false)
  expect(h.errors).toHaveBeenCalledExactlyOnceWith("Error: active", "error")
})

for (const outcome of ["success", "failure"]) {
  test(`unmount invalidates pending file-list ${outcome}`, async () => {
    const old = deferred<string[]>()
    const h = browser(() => old.promise)
    h.scope.stop()
    if (outcome === "success") old.resolve(["stale.md"])
    else old.reject(new Error("stale"))
    await flush()
    expect(h.api.files.value).toEqual([])
    expect(h.errors).not.toHaveBeenCalled()
  })
}

test("project and reader changes invalidate the file list even when the loader is unchanged", async () => {
  const list = vi.fn(async () => ["README.md"])
  const h = browser(list)
  await flush()
  h.api.selected.value = "README.md"
  h.props.project = "C:/other"
  expect(h.api.selected.value).toBeNull()
  await flush()
  h.props.readFile = async () => "other resource"
  await flush()
  expect(list).toHaveBeenCalledTimes(3)
})

test("preview readers capture their resource and translation invalidates on file, reader, and language changes", async () => {
  const firstRead = deferred<string>()
  const firstTranslation = deferred<string>()
  const locale = vue.ref("zh-CN")
  const send = vi.fn(() => firstTranslation.promise)
  const props = vue.reactive({ path: "README.md", project: "", readFile: () => firstRead.promise })
  const h = setup(
    "ResourceMarkdownPreview",
    props,
    "readResourceFile, previewVersion, translating, translated, translate",
    {
      useI18n: () => ({ t: key => key, locale }),
      packageTranslate: send,
    },
  )
  const read = h.api.readResourceFile.value("README.md")
  const translated = h.api.translate("old")
  props.readFile = async () => "new resource"
  expect(h.api.previewVersion.value).toBe(1)
  firstRead.resolve("old resource")
  expect((await read).text).toBe("old resource")
  expect((await h.api.readResourceFile.value("README.md")).text).toBe("new resource")
  firstTranslation.resolve("old translation")
  await translated
  expect(h.api.translated.value).toBe("")
  props.path = "next.md"
  expect(h.api.previewVersion.value).toBe(2)
  await h.api.translate("English source")
  locale.value = "en"
  expect(h.api.translated.value).toBe("")
  await h.api.translate("English source")
  expect(send).toHaveBeenLastCalledWith("English source", "English")
  h.scope.stop()
  expect(h.api.translated.value).toBe("")
})

test("the preview adapter preserves text preview metadata and remounts the reader on identity changes", async () => {
  const props = vue.reactive({ path: "README.md", project: "", readFile: async () => "# Text" })
  const h = setup("ResourceMarkdownPreview", props, "readResourceFile, previewVersion", { packageTranslate: vi.fn() })
  expect(await h.api.readResourceFile.value(props.path)).toEqual({
    kind: "text",
    text: "# Text",
    truncated: false,
    mime: null,
    data: null,
  })
  props.project = "C:/next"
  expect(h.api.previewVersion.value).toBe(1)
  const browserSource = readFileSync(new URL("../src/components/ResourceMarkdownBrowser.vue", import.meta.url), "utf8")
  const previewSource = readFileSync(new URL("../src/components/ResourceMarkdownPreview.vue", import.meta.url), "utf8")
  expect(browserSource).toContain(':key="JSON.stringify([generation, selected])"')
  expect(previewSource).toContain(':key="previewVersion"')
  expect(browserSource).toMatch(/<Input\b/)
  expect(browserSource).not.toMatch(/<input\b/)
})

test("package adapters capture source/scope/project, including in-place resource changes", async () => {
  const pkg = vue.ref({ source: "npm:one", scope: "project" })
  const project = vue.ref("C:/one")
  const list = vi.fn(async () => [])
  const read = vi.fn(async () => "text")
  const h = setup("settings/packages/PackageResourcePage", {}, "listResourceFiles, readResourceFile, project", {
    selectedResourcePackage: pkg,
    selectedResourceProject: project,
    packageListFiles: list,
    packageReadFile: read,
    packageNameOf: value => value,
  })
  const oldList = h.api.listResourceFiles.value
  const oldRead = h.api.readResourceFile.value
  pkg.value.source = "npm:two"
  project.value = "C:/two"
  await oldList()
  await oldRead("README.md")
  expect(list).toHaveBeenLastCalledWith("npm:one", "project", "C:/one")
  expect(read).toHaveBeenLastCalledWith("npm:one", "project", "README.md", "C:/one")
  await h.api.listResourceFiles.value()
  expect(list).toHaveBeenLastCalledWith("npm:two", "project", "C:/two")
  pkg.value.scope = "global"
  await h.api.readResourceFile.value("README.md")
  expect(read).toHaveBeenLastCalledWith("npm:two", "global", "README.md", undefined)
  pkg.value = null
  expect(h.api.listResourceFiles.value).toBeUndefined()
  expect(h.api.readResourceFile.value).toBeUndefined()
})

test("hosted and discovered previews reuse the browser and skill readers capture the selected path", async () => {
  const list = vi.fn(async () => [])
  const read = vi.fn(async () => "text")
  const h = setup("settings/SkillSettings", {}, "previewing, togglePreview, listPreviewFiles, readPreviewFile", {
    onMounted: () => {},
    skillListFiles: list,
    skillReadFile: read,
  })
  h.api.togglePreview({ path: "C:/hosted" })
  const oldRead = h.api.readPreviewFile.value
  h.api.togglePreview({ path: "C:/discovered" })
  await oldRead("SKILL.md")
  expect(read).toHaveBeenLastCalledWith("C:/hosted", "SKILL.md")
  await h.api.listPreviewFiles.value()
  await h.api.readPreviewFile.value("SKILL.md")
  expect(list).toHaveBeenLastCalledWith("C:/discovered")
  expect(read).toHaveBeenLastCalledWith("C:/discovered", "SKILL.md")
  h.api.togglePreview({ path: "C:/discovered" })
  expect(h.api.previewing.value).toBeNull()
  const source = readFileSync(new URL("../src/components/settings/SkillSettings.vue", import.meta.url), "utf8")
  expect(source.match(/<ResourceMarkdownBrowser\b/g)).toHaveLength(2)
})

for (const outcome of ["success", "failure"]) {
  test(`the underlying file preview suppresses pending read ${outcome} after unmount`, async () => {
    const old = deferred<unknown>()
    const props = vue.reactive({ path: "README.md", project: "", readFile: () => old.promise })
    const h = setup("ProjectFilePreview", props, "preview, loading, error", {
      useCodeCommentsStore: () => ({}),
      onBeforeUnmount: callback => vue.onScopeDispose(callback),
      document: { removeEventListener() {} },
      highlightFileLines: async () => [],
      formatCodedError: (_t, error) => String(error),
    })
    h.scope.stop()
    if (outcome === "success") old.resolve({ kind: "text", text: "stale" })
    else old.reject(new Error("stale"))
    await flush()
    expect(h.api.preview.value).toBeNull()
    expect(h.api.error.value).toBe("")
  })
}


test("file preview error text reacts to locale changes", async () => {
  const locale = vue.ref("en")
  const props = vue.reactive({ path: "a", project: "", readFile: async () => { throw "coded" } })
  const h = setup("ProjectFilePreview", props, "error", {
    useI18n: () => ({ t: key => `${locale.value}:${key}` }),
    useCodeCommentsStore: () => ({}),
    onBeforeUnmount: callback => vue.onScopeDispose(callback),
    document: { removeEventListener() {} },
    formatCodedError: t => t("backendErrors.example"),
  })
  await flush()
  expect(h.api.error.value).toBe("en:backendErrors.example")
  locale.value = "zh-CN"
  expect(h.api.error.value).toBe("zh-CN:backendErrors.example")
})


test("file preview imports its toast store from the conversations module", () => {
  const source = readFileSync(new URL("../src/components/ProjectFilePreview.vue", import.meta.url), "utf8")
  expect(source).toMatch(/import\s*\{\s*useUiStore\s*\}\s*from\s*["']@\/stores\/conversations["']/)
  expect(source).not.toMatch(/import\s*\{\s*useUiStore\s*\}\s*from\s*["']@\/stores\/ui["']/)
})

test("full code comment warning uses a localized toast and preserves the draft", async () => {
  const locale = vue.ref("en")
  const props = vue.reactive({ path: "a", project: "p", readFile: async () => ({ kind: "text", text: "a" }) })
  const h = setup("ProjectFilePreview", props, "commentRange, commentText, confirmComment", {
    useI18n: () => ({ t: key => `${locale.value}:${key}` }),
    useCodeCommentsStore: () => ({ add: () => false }),
    onBeforeUnmount: callback => vue.onScopeDispose(callback),
    document: { removeEventListener() {} },
    highlightFileLines: async () => [],
  })
  h.api.commentRange.value = { start: 1, end: 1 }
  h.api.commentText.value = "comment"
  h.api.confirmComment()
  locale.value = "zh-CN"
  h.api.confirmComment()
  expect(h.errors.mock.calls).toEqual([["en:projectFiles.annotateFull", "warning"], ["zh-CN:projectFiles.annotateFull", "warning"]])
  expect(h.api.commentText.value).toBe("comment")
  expect(h.api.commentRange.value).toEqual({ start: 1, end: 1 })
})


test("successfully adding a code comment closes the draft without a toast", () => {
  const props = vue.reactive({ path: "a", project: "p", readFile: async () => ({ kind: "text", text: "a" }) })
  const h = setup("ProjectFilePreview", props, "commentRange, commentText, confirmComment", {
    useCodeCommentsStore: () => ({ add: () => true }),
    onBeforeUnmount: callback => vue.onScopeDispose(callback),
    document: { removeEventListener() {} },
    highlightFileLines: async () => [],
  })
  h.api.commentRange.value = { start: 1, end: 1 }
  h.api.commentText.value = "comment"
  h.api.confirmComment()
  expect(h.errors).not.toHaveBeenCalled()
  expect(h.api.commentText.value).toBe("")
  expect(h.api.commentRange.value).toBeNull()
})
