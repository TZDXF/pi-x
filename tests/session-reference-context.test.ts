import { expect, test } from "vitest"
import { sessionReference, stripSessionReferenceContext, withSessionReferences } from "@/lib/completion"
import { parseComposerPromptContexts, serializeComposerPromptContexts } from "@/lib/promptContexts"
import { composerParts } from "@/lib/composerTokens"

const sessions = [
  { file: "C:/Users/me/.pi/agent/sessions/研究/one.jsonl", title: "结合靶纸识别与环线识别方案的研究" },
  { file: "C:/Users/me/.pi/agent/sessions/two.jsonl", title: "另一个会话" },
]
const text = `${sessionReference(sessions[0].file)} 将g06 接入到 service的分数计算流程中`

test("reloaded session references hide agent instructions while preserving the conversation chip and user text", () => {
  const persisted = withSessionReferences(text, sessions)
  expect(persisted).toContain("Referenced conversations")
  const parsed = parseComposerPromptContexts(persisted)
  expect(parsed).toEqual({ visibleContent: text, comments: [], selections: [] })
  expect(composerParts(parsed.visibleContent, { [sessions[0].file]: sessions[0].title }, undefined, "message")).toEqual(
    [
      { kind: "session", raw: sessionReference(sessions[0].file), label: sessions[0].title },
      { kind: "text", raw: " 将g06 接入到 service的分数计算流程中", label: " 将g06 接入到 service的分数计算流程中" },
    ],
  )
  // Parsing uses the persisted references even when the referenced session is no longer in the workspace.
  expect(stripSessionReferenceContext(persisted)).toBe(text)
})

test("session references round-trip multiple, duplicate, unknown and escaped mentions", () => {
  const quoted = { file: 'C:/sessions/a "quoted" name.jsonl', title: "标题\n第二行" }
  const input = `${text}\n${sessionReference(sessions[1].file)} ${sessionReference(sessions[0].file)} ${sessionReference("unknown.jsonl")} ${sessionReference(quoted.file)}`
  expect(stripSessionReferenceContext(withSessionReferences(input, [...sessions, quoted]))).toBe(input)
  expect(stripSessionReferenceContext(withSessionReferences(text, []))).toBe(text)
})

test.each([
  { comments: false, selections: false },
  { comments: false, selections: true },
  { comments: true, selections: false },
  { comments: true, selections: true },
])("session reference tails compose with other prompt contexts: %j", flags => {
  const comments = flags.comments
    ? [{ path: "src/service.ts", startLine: 3, endLine: 4, selectedText: "code", comment: "接入计分" }]
    : []
  const selections = flags.selections ? [{ text: "引用回复", comment: "参考这里" }] : []
  const persisted = serializeComposerPromptContexts(withSessionReferences(text, sessions), { comments, selections })
  const parsed = parseComposerPromptContexts(persisted)
  expect(parsed.visibleContent).toBe(text)
  expect(parsed.comments).toHaveLength(comments.length)
  expect(parsed.selections).toHaveLength(selections.length)
  if (comments.length) expect(parsed.comments[0]).toMatchObject(comments[0])
  if (selections.length) expect(parsed.selections[0]).toMatchObject(selections[0])
})

test("plain user content and malformed or non-trailing reference blocks remain unchanged", () => {
  const persisted = withSessionReferences(text, sessions)
  const marker = persisted.slice(text.length, persisted.lastIndexOf("\n") + 1)
  const contents = [
    "",
    text,
    "讨论 Referenced conversations 的展示问题",
    `${persisted}\n后续正文`,
    `${text}${marker}not json`,
    `${text}${marker}[]`,
    `${text}${marker}{"title":"研究","file":"one.jsonl"}`,
    ...[null, {}, { file: sessions[0].file }, { title: "研究", file: 42 }, { title: "研究", file: "other.jsonl" }].map(
      row => `${text}${marker}${JSON.stringify([row])}`,
    ),
    `没有会话引用${marker}${JSON.stringify(sessions)}`,
  ]
  for (const content of contents) expect(stripSessionReferenceContext(content)).toBe(content)
})
