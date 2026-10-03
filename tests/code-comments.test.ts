import { test, expect } from "vitest"
import {
  selectionLineRange,
  formatCodeComment,
  buildCodeCommentsBlock,
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  MAX_SELECTED_TEXT_LENGTH,
} from "@/lib/codeComments"

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
  expect(selectionLineRange(root, selectionOf(nodeInRow(3, true), nodeInRow(7, true)))).toEqual({
    start: 3,
    end: 7,
  })
  // 反向选区（focus 在 anchor 之前）同样归一化为 start <= end。
  expect(selectionLineRange(root, selectionOf(nodeInRow(9, false), nodeInRow(4, true)))).toEqual({
    start: 4,
    end: 9,
  })
  // 单行内的普通文本选区。
  expect(selectionLineRange(root, selectionOf(nodeInRow(5, true), nodeInRow(5, false)))).toEqual({
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
      "Side: R",
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
    [
      "## Comment 3",
      "File: src/a.ts",
      "Side: R",
      "Lines: 2-5",
      "Selected text:",
      "```",
      "a\nb",
      "```",
      "Comment:",
      "x",
    ].join("\n"),
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
      [
        "## Comment 1",
        "File: src/a.ts",
        "Side: R",
        "Lines: 1-2",
        "Selected text:",
        "```",
        "a",
        "```",
        "Comment:",
        "one",
      ].join("\n"),
      "",
      [
        "## Comment 2",
        "File: src/b.ts",
        "Side: R",
        "Lines: 3",
        "Selected text:",
        "```",
        "",
        "```",
        "Comment:",
        "two",
      ].join("\n"),
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

// ---- 持久化消息解析回附件（对齐 ZCode 的 parsePromptCodeComments） ----

test("parsePromptCodeComments round-trips comments built by buildPromptWithCodeComments", () => {
  const drafts = [
    { path: "src/a.ts", startLine: 1, endLine: 2, selectedText: "a\nb", comment: "one" },
    { path: "src/b.ts", startLine: 7, endLine: 7, selectedText: "c", comment: "two" },
  ]
  const prompt = buildPromptWithCodeComments("帮我看看", drafts)
  const parsed = parsePromptCodeComments(prompt)
  expect(parsed.visibleContent).toBe("帮我看看")
  expect(parsed.comments).toEqual([
    {
      id: "parsed-code-comment-1-1-2",
      path: "src/a.ts",
      startLine: 1,
      endLine: 2,
      selectedText: "a\nb",
      comment: "one",
    },
    { id: "parsed-code-comment-2-7-7", path: "src/b.ts", startLine: 7, endLine: 7, selectedText: "c", comment: "two" },
  ])
})

test("parsePromptCodeComments keeps text without a comments block intact", () => {
  expect(parsePromptCodeComments("plain message")).toEqual({ visibleContent: "plain message", comments: [] })
  expect(parsePromptCodeComments("")).toEqual({ visibleContent: "", comments: [] })
  // 只有标题没有可解析条目时原样返回，避免吞掉用户正文。
  expect(parsePromptCodeComments("hi\n\n# Code comments:\n\ngarbage")).toEqual({
    visibleContent: "hi\n\n# Code comments:\n\ngarbage",
    comments: [],
  })
})

test("parsePromptCodeComments tolerates L-prefixed and padded line ranges", () => {
  const raw = [
    "## Comment 1",
    "File: a.ts",
    "Side: R",
    "Lines: L4 - L9",
    "Selected text:",
    "```",
    "x",
    "```",
    "Comment:",
    "y",
  ].join("\n")
  const parsed = parsePromptCodeComments(`\n\n# Code comments:\n\n${raw}`)
  expect(parsed.comments[0]).toMatchObject({ path: "a.ts", startLine: 4, endLine: 9 })
  // 行范围非法（start > end）的条目被丢弃，块整体视为未解析。
  const invalid = raw.replace("Lines: L4 - L9", "Lines: 9-4")
  expect(parsePromptCodeComments(`\n\n# Code comments:\n\n${invalid}`).comments).toEqual([])
})
