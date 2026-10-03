import { test, expect } from "vitest"
import { parseComposerPromptContexts, serializeComposerPromptContexts } from "@/lib/promptContexts"
import {
  selectionLineRange,
  formatCodeComment,
  buildCodeCommentsBlock,
  buildPromptWithCodeComments,
  parsePromptCodeComments,
  commentFilePath,
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
  // 行范围非法（start > end）时保留原文，块整体视为未解析。
  const invalid = raw.replace("Lines: L4 - L9", "Lines: 9-4")
  expect(parsePromptCodeComments(`\n\n# Code comments:\n\n${invalid}`).comments).toEqual([])
})

test("commentFilePath keeps in-session paths relative and prefixes cross-folder roots", () => {
  expect(commentFilePath({ path: "src/a.ts" })).toBe("src/a.ts")
  expect(commentFilePath({ path: "src/a.ts", root: undefined })).toBe("src/a.ts")
  // Windows 反斜杠与尾部分隔符统一成正斜杠前缀，对齐 @ 提及的跨目录路径约定。
  expect(commentFilePath({ path: "src/a.ts", root: "C:\\code\\repo-b\\" })).toBe("C:/code/repo-b/src/a.ts")
  expect(commentFilePath({ path: "src/a.ts", root: "C:/code/repo-b" })).toBe("C:/code/repo-b/src/a.ts")
})

// ---- 围栏、结构边界与 composer 的回归契约 ----

const roundTripDraft = {
  path: "docs/example.md",
  startLine: 4,
  endLine: 9,
  selectedText: "code",
  comment: "说明",
}

function expectCommentDrafts(parsed, drafts) {
  expect(parsed.comments.map(({ id: _id, ...draft }) => draft)).toEqual(drafts)
}

test.each([3, 4, 8])("code comments round-trip a %i-backtick selection fence", length => {
  const innerFence = "`".repeat(length - 1)
  const selectedText = length === 3 ? "plain code" : [innerFence + "ts", "const x = 1", innerFence].join("\n")
  const draft = { ...roundTripDraft, selectedText }
  const prompt = buildPromptWithCodeComments("正文", [draft])
  expect(prompt).toContain(["Selected text:", "`".repeat(length), selectedText, "`".repeat(length)].join("\n"))
  const parsed = parsePromptCodeComments(prompt)
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, [draft])
})

test.each([3, 4, 8])("parsePromptCodeComments accepts a %i-backtick fence with a language tag", length => {
  const fence = "`".repeat(length)
  const prompt = buildPromptWithCodeComments("正文", [roundTripDraft])
    .replace("```\ncode\n```", [fence + "typescript", "code", fence].join("\n"))
    .replace("Side: R\n", "")
    .replace("Lines: 4-9", "Lines: L4 - L9")
    .replace("Comment:\n说明", "Comment: 说明")
  const parsed = parsePromptCodeComments(prompt)
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, [roundTripDraft])
})

test("selected text keeps shorter/longer fences and field-like lines inside its outer fence", () => {
  const selectedText = [
    "```ts",
    "code",
    "```",
    "``````",
    "Comment:",
    "## Comment 99",
    "File: fake.ts",
    "Side: L",
    "Lines: L1-L2",
    "Selected text:",
    "# Code comments:",
    "tail",
  ].join("\n")
  const draft = { ...roundTripDraft, selectedText }
  const parsed = parsePromptCodeComments(buildPromptWithCodeComments("正文", [draft, roundTripDraft]))
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, [draft, roundTripDraft])
})

test("comments containing headings and even complete serialized entries round-trip as text", () => {
  const fakeEntry = formatCodeComment({ ...roundTripDraft, path: "fake.ts", comment: "不是附件" }, 98)
  const comment = [
    "说明",
    "## Comment",
    "File: literal.ts",
    "Lines: L1-L2",
    "Selected text:",
    "Comment:",
    "```markdown",
    fakeEntry,
    "```",
    "# Code comments:",
    "结束",
  ].join("\n")
  const drafts = [{ ...roundTripDraft, comment }, roundTripDraft]
  const parsed = parsePromptCodeComments(buildPromptWithCodeComments("正文", drafts))
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, drafts)
})

test("a literal protected-comment fence is not mistaken for the serialization wrapper", () => {
  const comment = ["```code-comment", "literal", "```"].join("\n")
  const draft = { ...roundTripDraft, comment }
  const parsed = parsePromptCodeComments(buildPromptWithCodeComments("正文", [draft, roundTripDraft]))
  expectCommentDrafts(parsed, [draft, roundTripDraft])
})

test("legacy plain comments keep heading-only lines and unrelated field labels", () => {
  const comment = [
    "说明",
    "## Comment 42",
    "不是新条目",
    "## Comment",
    "Lines: L1-L2",
    "Comment:",
    "File: literal.ts",
  ].join("\n")
  const raw = formatCodeComment(roundTripDraft, 0).replace("Comment:\n说明", "Comment:\n" + comment)
  const parsed = parsePromptCodeComments(
    "正文\n\n# Code comments:\n\n" + raw + "\n\n" + formatCodeComment(roundTripDraft, 1),
  )
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, [{ ...roundTripDraft, comment }, roundTripDraft])
})

test("mixed valid entries preserve order, ids, empty fields, and normalization", () => {
  const drafts = [
    roundTripDraft,
    { ...roundTripDraft, selectedText: "", comment: "" },
    { ...roundTripDraft, selectedText: "  ```md\nx\n```  ", comment: "  ## Comment 7\n文字  " },
  ]
  const parsed = parsePromptCodeComments(buildPromptWithCodeComments("正文", drafts))
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(
    parsed,
    drafts.map(draft => ({ ...draft, selectedText: draft.selectedText.trim(), comment: draft.comment.trim() })),
  )
  expect(parsed.comments.map(comment => comment.id)).toEqual([
    "parsed-code-comment-1-4-9",
    "parsed-code-comment-2-4-9",
    "parsed-code-comment-3-4-9",
  ])
})

test.each([0, 1, 2])("mixed entries retain the entire prompt when entry %i has an invalid range", index => {
  const entries = [0, 1, 2].map(i => formatCodeComment(roundTripDraft, i))
  entries[index] = entries[index].replace("Lines: 4-9", "Lines: 9-4")
  const prompt = "正文\n\n# Code comments:\n\n" + entries.join("\n\n")
  expect(parsePromptCodeComments(prompt)).toEqual({ visibleContent: prompt, comments: [] })
})

test.each(["```", "`````"])("mismatched closing fence %s does not hide a malformed entry", closingFence => {
  const raw = formatCodeComment(roundTripDraft, 0).replace("```\ncode\n```", ["````", "code", closingFence].join("\n"))
  const prompt = "正文\n\n# Code comments:\n\n" + formatCodeComment(roundTripDraft, 0) + "\n\n" + raw
  expect(parsePromptCodeComments(prompt)).toEqual({ visibleContent: prompt, comments: [] })
})

test("unrecognized block preamble is not discarded alongside valid entries", () => {
  const prompt = "正文\n\n# Code comments:\n\nunknown text\n\n" + formatCodeComment(roundTripDraft, 0)
  expect(parsePromptCodeComments(prompt)).toEqual({ visibleContent: prompt, comments: [] })
})

test("composer round-trips selections and complex code comments in reverse serialization order", () => {
  const comments = [
    {
      ...roundTripDraft,
      selectedText: "```md\n## Comment 2\nFile: literal.md\n```",
      comment: "建议\n## Comment 9\nFile: not-an-entry.ts",
    },
    roundTripDraft,
  ]
  const selections = [{ text: "引用\n## Comment 1\n```", comment: "引用批注" }]
  const prompt = serializeComposerPromptContexts("正文", { comments, selections })
  expect(prompt.indexOf("# userselect:")).toBeLessThan(prompt.indexOf("# Code comments:"))
  const parsed = parseComposerPromptContexts(prompt)
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, comments)
  expect(parsed.selections).toEqual([{ id: "parsed-conversation-selection-1", ...selections[0] }])
})

test("composer retains both context blocks if mixed code comments cannot be parsed", () => {
  const prompt = serializeComposerPromptContexts("正文", {
    comments: [roundTripDraft, roundTripDraft],
    selections: [{ text: "引用" }],
  }).replace("Lines: 4-9", "Lines: 9-4")
  expect(parseComposerPromptContexts(prompt)).toEqual({ visibleContent: prompt, comments: [], selections: [] })
})

test.each([3, 4, 8])("protected comments round-trip with a %i-backtick fence", length => {
  const comment = ["## Comment 99", "File: literal.ts", "`".repeat(length - 1), "Comment:", "tail"].join("\n")
  const draft = { ...roundTripDraft, comment }
  const prompt = buildPromptWithCodeComments("正文", [draft, roundTripDraft])
  expect(prompt).toContain("Comment:\n" + "`".repeat(length) + "code-comment\n")
  const parsed = parsePromptCodeComments(prompt)
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, [draft, roundTripDraft])
})

test("selected text matches the exact outer fence rather than a shorter or longer closing line", () => {
  const selectedText = ["```", "Comment:", "shorter", "`````", "Comment:", "longer", "end"].join("\n")
  const raw = formatCodeComment(roundTripDraft, 0).replace("```\ncode\n```", ["````", selectedText, "````"].join("\n"))
  const parsed = parsePromptCodeComments("正文\n\n# Code comments:\n\n" + raw)
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, [{ ...roundTripDraft, selectedText }])
})

test.each(["missing close", "trailing content"])(
  "a protected comment with %s preserves the original prompt",
  problem => {
    const draft = { ...roundTripDraft, comment: "## Comment 9\n说明" }
    let prompt = buildPromptWithCodeComments("正文", [roundTripDraft, draft])
    prompt = problem === "missing close" ? prompt.slice(0, -3) : prompt + "\nunknown text"
    expect(parsePromptCodeComments(prompt)).toEqual({ visibleContent: prompt, comments: [] })
  },
)

test("legacy first entries without a heading, unnumbered headings, and single L-prefixed lines still parse", () => {
  const raw = formatCodeComment({ ...roundTripDraft, endLine: 4 }, 0)
    .replace("## Comment 1\n", "")
    .replace("Side: R\n", "")
    .replace("Lines: 4", "Lines: L4")
  const second = formatCodeComment(roundTripDraft, 1).replace("## Comment 2", "## Comment")
  const parsed = parsePromptCodeComments("正文\n\n# Code comments:\n\n" + raw + "\n\n" + second)
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, [{ ...roundTripDraft, endLine: 4 }, roundTripDraft])
})

test("serialized selections and comments preserve internal CRLF line endings", () => {
  const drafts = [
    {
      ...roundTripDraft,
      selectedText: "```md\r\n## Comment 1\r\n```",
      comment: "建议\r\n## Comment 9\r\nFile: literal.ts",
    },
    { ...roundTripDraft, selectedText: "one\r\ntwo", comment: "one\r\ntwo" },
  ]
  const parsed = parsePromptCodeComments(buildPromptWithCodeComments("正文", drafts))
  expect(parsed.visibleContent).toBe("正文")
  expectCommentDrafts(parsed, drafts)
})
