import { test } from "node:test"
import assert from "node:assert/strict"
import { loadTsModule } from "./lib/load-ts.mjs"

const fileKind = loadTsModule(new URL("../src/lib/fileKind.ts", import.meta.url))
const { extOf, isImageExt, isMarkdownExt, IMAGE_EXTS, MD_EXTS } = fileKind

test("extOf extracts the lowercased extension from posix and windows paths", () => {
  assert.equal(extOf("src/stores/session.ts"), "ts")
  assert.equal(extOf("src\\stores\\Session.TS"), "ts")
  assert.equal(extOf("archive.tar.gz"), "gz")
  assert.equal(extOf("README"), "")
})

test("extOf treats dotfiles as extension-less", () => {
  assert.equal(extOf(".gitignore"), "")
  assert.equal(extOf("src/.env"), "")
})

test("image extensions cover the renderable raster formats but not svg", () => {
  // svg 是文本，由预览面板按图片渲染并可切源码，不走后端 base64。
  for (const ext of ["png", "jpg", "jpeg", "jfif", "gif", "webp", "ico", "bmp", "avif"]) {
    assert.ok(IMAGE_EXTS.has(ext), `missing image ext: ${ext}`)
  }
  assert.ok(!IMAGE_EXTS.has("svg"))
  assert.ok(isImageExt("assets/logo.PNG"))
  assert.ok(!isImageExt("assets/logo.svg"))
  assert.ok(!isImageExt("src/main.ts"))
})

test("markdown extensions detect md and markdown only", () => {
  assert.ok(MD_EXTS.has("md") && MD_EXTS.has("markdown"))
  assert.ok(isMarkdownExt("docs/README.md"))
  assert.ok(isMarkdownExt("docs/NOTES.Markdown"))
  assert.ok(!isMarkdownExt("src/fileKind.mts"))
  assert.ok(!isMarkdownExt("README"))
})
