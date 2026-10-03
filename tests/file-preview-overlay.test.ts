import { expect, test } from "vitest"
import { readFileSync } from "node:fs"

const preview = readFileSync(new URL("../src/components/ProjectFilePreview.vue", import.meta.url), "utf8")

// 回归：代码视图的行号栏是 sticky left-0 z-10，若与右侧栏拖拽手柄（absolute z-2）处于同一
// 层叠上下文，带背景的 44px 行号栏会盖住手柄的 7px 命中区，导致打开文件后拖拽失效。
// 预览内容区必须自带 isolate，把内部 z-index 限制在本子树内。
test("预览内容区隔离内部层叠上下文，行号栏不再压过侧栏拖拽手柄", () => {
  expect(preview).toMatch(/<div class="isolate flex min-h-0 flex-1 flex-col overflow-hidden">/)
  // 内容区包裹层必须先于行号栏出现，保证 sticky 行号栏落在 isolate 子树内。
  const wrapper = preview.indexOf('<div class="isolate flex min-h-0 flex-1 flex-col overflow-hidden">')
  const gutter = preview.indexOf("sticky left-0 z-10")
  expect(wrapper).toBeGreaterThanOrEqual(0)
  expect(gutter).toBeGreaterThan(wrapper)
})
