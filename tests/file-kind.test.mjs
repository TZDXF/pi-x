import { test, expect } from "vitest"
import { loadTsModule } from "./lib/load-ts.mjs"

const fileKind = loadTsModule(new URL("../src/lib/fileKind.ts", import.meta.url))
const { extOf, isImageExt, isMarkdownExt, IMAGE_EXTS, MD_EXTS } = fileKind

test("extOf extracts the lowercased extension from posix and windows paths", () => {
  expect(extOf("src/stores/session.ts")).toBe("ts")
  expect(extOf("src\\stores\\Session.TS")).toBe("ts")
  expect(extOf("archive.tar.gz")).toBe("gz")
  expect(extOf("README")).toBe("")
})

test("extOf treats dotfiles as extension-less", () => {
  expect(extOf(".gitignore")).toBe("")
  expect(extOf("src/.env")).toBe("")
})

test("image extensions cover the renderable raster formats but not svg", () => {
  // svg 是文本，由预览面板按图片渲染并可切源码，不走后端 base64。
  for (const ext of ["png", "jpg", "jpeg", "jfif", "gif", "webp", "ico", "bmp", "avif"]) {
    expect(IMAGE_EXTS.has(ext), `missing image ext: ${ext}`).toBeTruthy()
  }
  expect(!IMAGE_EXTS.has("svg")).toBeTruthy()
  expect(isImageExt("assets/logo.PNG")).toBeTruthy()
  expect(!isImageExt("assets/logo.svg")).toBeTruthy()
  expect(!isImageExt("src/main.ts")).toBeTruthy()
})

test("markdown extensions detect md and markdown only", () => {
  expect(MD_EXTS.has("md") && MD_EXTS.has("markdown")).toBeTruthy()
  expect(isMarkdownExt("docs/README.md")).toBeTruthy()
  expect(isMarkdownExt("docs/NOTES.Markdown")).toBeTruthy()
  expect(!isMarkdownExt("src/fileKind.mts")).toBeTruthy()
  expect(!isMarkdownExt("README")).toBeTruthy()
})
