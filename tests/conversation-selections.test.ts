import { expect, test } from "vitest"
import {
  appendConversationSelection,
  buildPromptWithConversationSelections,
  createConversationSelectionId,
  parsePromptConversationSelections,
  CONVERSATION_SELECTION_MAX_COUNT,
  CONVERSATION_SELECTION_MAX_TEXT_LENGTH,
  CONVERSATION_SELECTION_MAX_TOTAL_LENGTH,
} from "@/lib/conversationSelections"
import { parseComposerPromptContexts, serializeComposerPromptContexts } from "@/lib/promptContexts"

// ---- wire 格式（对齐 ZCode 的 "# userselect:" 约定） ----

test("buildPromptWithConversationSelections appends the userselect block", () => {
  expect(buildPromptWithConversationSelections("对比一下", [{ text: "第一段" }, { text: "第二段" }])).toBe(
    [
      "对比一下",
      "",
      "# userselect:",
      "```userselect",
      JSON.stringify([{ text: "第一段" }, { text: "第二段" }]),
      "```",
    ].join("\n"),
  )
})

test("buildPromptWithConversationSelections keeps path for file-backed references", () => {
  expect(buildPromptWithConversationSelections("", [{ path: "docs/a.md", text: "正文" }])).toBe(
    ["# userselect:", "```userselect", JSON.stringify([{ path: "docs/a.md", text: "正文" }]), "```"].join("\n"),
  )
})

test("buildPromptWithConversationSelections without selections only trims", () => {
  expect(buildPromptWithConversationSelections("  你好  ", [])).toBe("你好")
})

// ---- 可选批注（comment）：带批注的引用随 wire 发出并在历史解析还原 ----

test("buildPromptWithConversationSelections keeps a non-empty comment", () => {
  expect(buildPromptWithConversationSelections("", [{ text: "选中文本", comment: "这里看不懂" }])).toBe(
    ["# userselect:", "```userselect", JSON.stringify([{ text: "选中文本", comment: "这里看不懂" }]), "```"].join("\n"),
  )
  // 空白批注与无批注等价，不出现在 wire 里。
  expect(buildPromptWithConversationSelections("", [{ text: "选中文本", comment: "   " }])).toBe(
    ["# userselect:", "```userselect", JSON.stringify([{ text: "选中文本" }]), "```"].join("\n"),
  )
})

test("parsePromptConversationSelections restores the comment", () => {
  const prompt = buildPromptWithConversationSelections("看看", [{ text: "选中文本", comment: "这里看不懂" }])
  const parsed = parsePromptConversationSelections(prompt)
  expect(parsed.visibleContent).toBe("看看")
  expect(parsed.selections[0]).toMatchObject({ text: "选中文本", comment: "这里看不懂" })
})

// ---- 持久化消息解析回引用 ----

test("parsePromptConversationSelections round-trips the built block", () => {
  const prompt = buildPromptWithConversationSelections("看看这段", [{ text: "第一段" }])
  const parsed = parsePromptConversationSelections(prompt)
  expect(parsed.visibleContent).toBe("看看这段")
  expect(parsed.selections).toEqual([{ id: "parsed-conversation-selection-1", text: "第一段" }])
})

test("parsePromptConversationSelections keeps path on parsed references", () => {
  const prompt = buildPromptWithConversationSelections("看看", [{ path: "docs/a.md", text: "正文" }])
  const parsed = parsePromptConversationSelections(prompt)
  expect(parsed.selections[0]).toMatchObject({ path: "docs/a.md", text: "正文" })
})

test("parsePromptConversationSelections returns content untouched without a valid block", () => {
  expect(parsePromptConversationSelections("普通消息")).toEqual({ visibleContent: "普通消息", selections: [] })
  expect(parsePromptConversationSelections("# userselect:\n```userselect\nnot json\n```")).toEqual({
    visibleContent: "# userselect:\n```userselect\nnot json\n```",
    selections: [],
  })
  // 结构不合规（缺 text）整块判为无效，原文原样返回。
  const invalid = buildPromptWithConversationSelections("正文", [{ text: "a" }]).replace('{"text":"a"}', "{}")
  expect(parsePromptConversationSelections(invalid).visibleContent).toContain("# userselect:")
  // 正文里出现 "# userselect:" 字样但不是尾块时不能误伤。
  const inline = '正文\n\n# userselect:\n```userselect\n[{"text":"a"}]\n```\n\n后续内容'
  expect(parsePromptConversationSelections(inline).visibleContent).toBe(inline)
})

// ---- 追加限制（对齐 ZCode 的 count/single/total 与去重） ----

test("appendConversationSelection dedupes identical text", () => {
  const first = appendConversationSelection([], { text: "同一段" })
  expect(first).toEqual({ ok: true, selections: [{ text: "同一段" }], duplicate: false })
  const second = appendConversationSelection(first.selections, { text: "同一段" })
  expect(second).toEqual({ ok: true, selections: [{ text: "同一段" }], duplicate: true })
  // 同一段文字配不同批注视为两条引用。
  const withComment = appendConversationSelection(first.selections, { text: "同一段", comment: "新的批注" })
  expect(withComment.ok).toBe(true)
  if (withComment.ok) expect(withComment.selections).toHaveLength(2)
})

test("appendConversationSelection rejects oversized text", () => {
  const result = appendConversationSelection([], { text: "x".repeat(CONVERSATION_SELECTION_MAX_TEXT_LENGTH + 1) })
  expect(result).toEqual({ ok: false, reason: "single" })
})

test("appendConversationSelection enforces count and total limits", () => {
  let selections: readonly { text: string }[] = []
  for (let i = 0; i < CONVERSATION_SELECTION_MAX_COUNT; i++) {
    const result = appendConversationSelection(selections, { text: `第${i}段` })
    expect(result.ok).toBe(true)
    if (result.ok) selections = result.selections
  }
  expect(appendConversationSelection(selections, { text: "再一条" })).toEqual({ ok: false, reason: "count" })
  // 两条各 7900 字（低于单条上限），再加一条即超总量上限。
  const first = appendConversationSelection([], { text: "x".repeat(CONVERSATION_SELECTION_MAX_TOTAL_LENGTH / 2 - 100) })
  expect(first.ok).toBe(true)
  if (first.ok) {
    const second = appendConversationSelection(first.selections, {
      text: "y".repeat(CONVERSATION_SELECTION_MAX_TOTAL_LENGTH / 2 - 100),
    })
    expect(second.ok).toBe(true)
    if (second.ok)
      expect(appendConversationSelection(second.selections, { text: "z".repeat(300) })).toEqual({
        ok: false,
        reason: "total",
      })
  }
})

test("createConversationSelectionId returns unique ids", () => {
  expect(createConversationSelectionId()).not.toBe(createConversationSelectionId())
})

// ---- 与代码批注的组合契约：序列化顺序与解析顺序严格相反 ----

test("serializeComposerPromptContexts and parseComposerPromptContexts round-trip both blocks", () => {
  const comments = [{ path: "src/a.ts", startLine: 3, endLine: 4, selectedText: "code", comment: "这里" }]
  const selections = [{ text: "引用的回复" }]
  const prompt = serializeComposerPromptContexts("帮我看看", { comments, selections })
  // userselect 块在前，Code comments 块在后。
  expect(prompt.indexOf("# userselect:")).toBeLessThan(prompt.indexOf("# Code comments:"))
  const parsed = parseComposerPromptContexts(prompt)
  expect(parsed.visibleContent).toBe("帮我看看")
  expect(parsed.selections).toEqual([{ id: "parsed-conversation-selection-1", text: "引用的回复" }])
  expect(parsed.comments).toEqual([
    {
      id: "parsed-code-comment-1-3-4",
      path: "src/a.ts",
      startLine: 3,
      endLine: 4,
      selectedText: "code",
      comment: "这里",
    },
  ])
})

test("parseComposerPromptContexts returns original content without any block", () => {
  expect(parseComposerPromptContexts("普通消息")).toEqual({
    visibleContent: "普通消息",
    comments: [],
    selections: [],
  })
})
