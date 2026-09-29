import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { loadTsSource } from "./lib/load-ts.mjs"

const {
  selectionLineRange,
  formatCodeComment,
  buildCodeCommentsBlock,
  buildPromptWithCodeComments,
  MAX_SELECTED_TEXT_LENGTH,
} = loadTsSource(readFileSync(new URL("../src/lib/codeComments.ts", import.meta.url), "utf8"))

// VM 内创建的对象原型与测试环境不同，deepStrictEqual 会因原型差异而失败。
const plain = value => JSON.parse(JSON.stringify(value))

// ---- DOM 桩：最小化实现 anchorLine 依赖的 nodeType/closest/contains/dataset ----

function lineEl(line) {
  return { dataset: { line: String(line) } }
}
/** 行内节点：isText 为文本节点（经由 parentElement 上溯），否则是元素节点本身。 */
function nodeInRow(line, isText) {
  const host = { nodeType: 1, closest: selector => (selector === "[data-line]" ? lineEl(line) : null) }
  return isText ? { nodeType: 3, parentElement: host } : host
}
function selectionOf(anchor, focus, { collapsed = false, rangeCount = 1 } = {}) {
  return { isCollapsed: collapsed, rangeCount, anchorNode: anchor, focusNode: focus }
}

test("selectionLineRange returns null for collapsed or empty selections", () => {
  const root = { contains: () => true }
  expect(selectionLineRange(root, null)).toBe(null)
  expect(selectionLineRange(null, selectionOf(nodeInRow(1, true), nodeInRow(2, true)))).toBe(null)
  expect(selectionLineRange(root, selectionOf(nodeInRow(1, true), nodeInRow(1, true), { collapsed: true }))).toBe(null)
  expect(selectionLineRange(root, selectionOf(nodeInRow(1, true), nodeInRow(1, true), { rangeCount: 0 }))).toBe(null)
})

test("selectionLineRange maps anchors to the enclosing line range", () => {
  const root = { contains: () => true }
  expect(plain(selectionLineRange(root, selectionOf(nodeInRow(3, true), nodeInRow(7, true))))).toEqual({
    start: 3,
    end: 7,
  })
  // 反向选区（focus 在 anchor 之前）同样归一化为 start <= end。
  expect(plain(selectionLineRange(root, selectionOf(nodeInRow(9, false), nodeInRow(4, true))))).toEqual({
    start: 4,
    end: 9,
  })
  // 单行内的普通文本选区。
  expect(plain(selectionLineRange(root, selectionOf(nodeInRow(5, true), nodeInRow(5, false))))).toEqual({
    start: 5,
    end: 5,
  })
})

test("selectionLineRange rejects anchors outside the code root or with invalid line numbers", () => {
  const root = { contains: () => true }
  expect(selectionLineRange(root, selectionOf(nodeInRow(1, true), null))).toBe(null)
  expect(selectionLineRange({ contains: () => false }, selectionOf(nodeInRow(1, true), nodeInRow(2, true)))).toBe(null)
  // data-line 非数字或小于 1 时视为无效。
  const bad = { nodeType: 1, closest: () => ({ dataset: { line: "x" } }) }
  expect(selectionLineRange(root, selectionOf(bad, nodeInRow(2, true)))).toBe(null)
  const zero = { nodeType: 1, closest: () => ({ dataset: { line: "0" } }) }
  expect(selectionLineRange(root, selectionOf(zero, nodeInRow(2, true)))).toBe(null)
})

// ---- 批注格式化 ----

test("formatCodeComment renders file, lines and trimmed text", () => {
  expect(
    formatCodeComment(
      { path: "src/a.ts", startLine: 10, endLine: 10, selectedText: "  foo()  ", comment: " 这里不对 " },
      0,
    ),
  ).toBe(
    [
      "## Comment 1",
      "File: src/a.ts",
      "Lines: 10",
      "Selected text:",
      "```",
      "foo()",
      "```",
      "Comment:",
      "这里不对",
    ].join("\n"),
  )
  expect(formatCodeComment({ path: "src/a.ts", startLine: 2, endLine: 5, selectedText: "a\nb", comment: "x" }, 2)).toBe(
    ["## Comment 3", "File: src/a.ts", "Lines: 2-5", "Selected text:", "```", "a\nb", "```", "Comment:", "x"].join(
      "\n",
    ),
  )
})

test("formatCodeComment lengthens the fence when the selection contains backticks", () => {
  const text = formatCodeComment(
    { path: "a.md", startLine: 1, endLine: 1, selectedText: "```js\ncode\n```", comment: "c" },
    0,
  )
  expect(text.includes("````\n```js\ncode\n```\n````"), text).toBeTruthy()
})

test("formatCodeComment caps the quoted selection length", () => {
  const long = "x".repeat(MAX_SELECTED_TEXT_LENGTH + 100)
  const text = formatCodeComment({ path: "a.ts", startLine: 1, endLine: 1, selectedText: long, comment: "c" }, 0)
  expect(text.includes("x".repeat(MAX_SELECTED_TEXT_LENGTH))).toBeTruthy()
  expect(!text.includes("x".repeat(MAX_SELECTED_TEXT_LENGTH + 1))).toBeTruthy()
})

test("buildCodeCommentsBlock joins numbered comments under one header", () => {
  expect(buildCodeCommentsBlock([])).toBe("")
  const drafts = [
    { path: "src/a.ts", startLine: 1, endLine: 2, selectedText: "a", comment: "one" },
    { path: "src/b.ts", startLine: 3, endLine: 3, selectedText: "", comment: "two" },
  ]
  expect(buildCodeCommentsBlock(drafts)).toBe(
    [
      "# Code comments:",
      "",
      ["## Comment 1", "File: src/a.ts", "Lines: 1-2", "Selected text:", "```", "a", "```", "Comment:", "one"].join(
        "\n",
      ),
      "",
      ["## Comment 2", "File: src/b.ts", "Lines: 3", "Selected text:", "```", "", "```", "Comment:", "two"].join("\n"),
    ].join("\n"),
  )
})

test("buildPromptWithCodeComments appends the block or trims plain text", () => {
  expect(buildPromptWithCodeComments("  hello \n", [])).toBe("hello")
  const drafts = [{ path: "a.ts", startLine: 1, endLine: 1, selectedText: "a", comment: "c" }]
  expect(buildPromptWithCodeComments("帮我看看", drafts)).toBe("帮我看看\n\n" + buildCodeCommentsBlock(drafts))
  // 空消息只发批注块本身。
  expect(buildPromptWithCodeComments("  ", drafts)).toBe(buildCodeCommentsBlock(drafts))
})
