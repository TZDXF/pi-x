import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"
import vm from "node:vm"
const source = readFileSync(new URL("../src/lib/conversationTimeline.ts", import.meta.url), "utf8")
const tsCompile = code => ts.transpile(code, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 })
// conversationTimeline now shares contentText with the session store via
// '@/lib/content'; load the real module so its behavior is under test too.
const require = id => {
  if (id === "@/lib/content") {
    const content = { exports: {} }
    vm.runInNewContext(tsCompile(readFileSync(new URL("../src/lib/content.ts", import.meta.url), "utf8")), content)
    return content.exports
  }
  throw new Error(`unexpected module: ${id}`)
}
const context = { exports: {}, require }
vm.runInNewContext(tsCompile(source), context)
const turns = context.exports.conversationTurns
const buildTimelineTurns = context.exports.buildTimelineTurns
const user = (id, text = "") => ({ kind: "user", id, text })
const text = value => ({ type: "text", text: value })
const assistant = (...blocks) => ({ kind: "assistant", blocks })
test("groups each question with subsequent replies and excludes reasoning/tools", () => {
  const result = turns(
    [
      assistant(text("orphan")),
      user(1, "first"),
      assistant({ type: "thinking", text: "secret" }, text("answer")),
      assistant(text("continued")),
      user(2, "second"),
    ],
    [text("streaming")],
  )
  expect(result.length).toBe(2)
  expect(result[0].answer).toBe("answer continued")
  expect(result[1].answer).toBe("streaming")
})
test("answer keeps only text after the last tool call, dropping run commentary", () => {
  const tool = { type: "toolCall", callId: "c1", name: "bash", argsText: "ls" }
  const result = turns([
    user(1, "提交代码"),
    assistant(text("我先看一下工作区改动"), tool, text("已提交 17d0e8c，终端功能已提交。")),
  ])
  expect(result[0].answer).toBe("已提交 17d0e8c，终端功能已提交。")
  const trailing = turns([user(1, "q"), assistant(tool, text("done"), text(" all")), assistant(text("final"))])
  expect(trailing[0].answer).toBe("done all final")
  const toolOnly = turns([user(1, "q"), assistant(text("commentary"), tool)])
  expect(toolOnly[0].answer).toBe("")
})
test("handles empty/image questions, unanswered turns, and bounded excerpts", () => {
  expect(turns([]).length).toBe(0)
  expect(turns([user(1)])[0].answer).toBe("")
  expect(turns([user(1)])[0].question).toBe("")
  expect(turns([user(1, "x".repeat(300))])[0].question.length).toBe(181)
  expect(turns([user(1, " a\n b ")])[0].question).toBe("a b")
})
test("rendered entries have anchors and navigation stops automatic following", () => {
  const chat = readFileSync(new URL("../src/components/ChatView.vue", import.meta.url), "utf8")
  expect(chat).toMatch(/:data-message-id="entry.id"/)
  const conversation = readFileSync(
    new URL("../src/components/ai-elements/conversation/Conversation.vue", import.meta.url),
    "utf8",
  )
  expect(conversation).toMatch(/context.stopScroll\(\)[\s\S]*viewport.scrollTo/)
  expect(conversation).toMatch(/prefers-reduced-motion/)
})

// ---- buildTimelineTurns: full-session timeline over paginated history ----
const build = context.exports.buildTimelineTurns
const rawUser = (text, images = []) => ({
  role: "user",
  content: images.length ? [{ type: "text", text }, ...images] : text,
})
const rawAssistant = (...parts) => ({ role: "assistant", content: parts })
const rawToolCall = { type: "toolCall", id: "c1", name: "bash", arguments: "ls" }
const liveUser = (id, text) => ({ kind: "user", id, text, live: true })

test("unmaterialized turns show with synthetic ids; materialized ones map to entries in order", () => {
  const messages = [
    rawUser("q1"),
    rawAssistant({ type: "text", text: "a1" }),
    rawUser("q2"),
    rawAssistant(rawToolCall, { type: "text", text: "a2" }),
    rawUser("q3"),
    rawAssistant({ type: "text", text: "a3" }),
  ]
  // cursor=4: q3/a3 materialized as entries; q1/q2 only raw.
  const entries = [
    { kind: "user", id: 50, text: "q3" },
    { kind: "assistant", id: 51, blocks: [text("a3")] },
  ]
  const result = build(messages, 4, entries)
  expect(result.length).toBe(3)
  expect(result.map(t => t.question).join("|")).toBe("q1|q2|q3")
  expect(result[0].id).toBe(-1)
  expect(result[0].entryId).toBe(null)
  expect(result[1].id).toBe(-3)
  expect(result[1].entryId).toBe(null)
  expect(result[2].id).toBe(50)
  expect(result[2].entryId).toBe(50)
  expect(result[1].answer).toBe("a2")
  expect(result[0].answer).toBe("a1")
})

test("live entries appended after the snapshot extend the timeline", () => {
  const messages = [rawUser("q1"), rawAssistant({ type: "text", text: "a1" })]
  const entries = [
    { kind: "user", id: 10, text: "q1" },
    { kind: "assistant", id: 11, blocks: [text("a1")] },
    liveUser(12, "q2 live"),
    { kind: "assistant", id: 13, blocks: [text("a2 live")], live: true },
  ]
  const result = build(messages, 2, entries)
  expect(result.length).toBe(2)
  expect(result[1].id).toBe(12)
  expect(result[1].entryId).toBe(12)
  expect(result[1].answer).toBe("a2 live")
})

test("empty snapshot falls back to entries-only turns (fully materialized session)", () => {
  const entries = [
    { kind: "user", id: 1, text: "q1" },
    { kind: "assistant", id: 2, blocks: [text("a1")] },
    liveUser(3, "q2"),
  ]
  const result = build([], 0, entries)
  expect(result.length).toBe(2)
  expect(result[0].entryId).toBe(1)
  expect(result[1].entryId).toBe(3)
  expect(result[1].answer).toBe("")
})

test("empty or image-only raw user messages are skipped, matching materialization", () => {
  const messages = [rawUser(""), rawUser("q1", [{ type: "image", data: "x", mimeType: "image/png" }])]
  const result = build(messages, 0, [])
  expect(result.length).toBe(1)
  expect(result[0].question).toBe("q1")
  expect(result[0].entryId).toBe(null)
  const imageOnly = build([rawUser("", [{ type: "image", data: "x", mimeType: "image/png" }])], 0, [])
  expect(imageOnly.length).toBe(1)
  expect(imageOnly[0].question).toBe("")
})

test("compaction markers are skipped without breaking turn grouping", () => {
  const compaction = { kind: "compaction", id: 9, summary: "collapsed" }
  const result = turns([
    user(1, "first"),
    assistant(text("one")),
    compaction,
    user(2, "second"),
    assistant(text("two")),
  ])
  expect(result.map(t => t.question).join(",")).toBe("first,second")
  expect(result[1].answer).toBe("two")
})

test("timeline includes compaction nodes with materialized entry ids", () => {
  const messages = [
    { role: "user", content: "first" },
    { role: "assistant", content: [{ type: "text", text: "one" }] },
    { role: "compactionSummary", summary: "collapsed", tokensBefore: 100000, estimatedTokensAfter: 30000 },
    { role: "user", content: "second" },
    { role: "assistant", content: [{ type: "text", text: "two" }] },
  ]
  // Nothing materialized yet: the node is positioned but has no entry id.
  let timeline = buildTimelineTurns(messages, 5, [])
  expect(timeline.length).toBe(3)
  expect(timeline[1].compaction.tokensBefore).toBe(100000)
  expect(timeline[1].compaction.tokensAfter).toBe(30000)
  expect(timeline[1].entryId).toBe(null)
  expect(timeline[1].id).toBe(-3)
  // Materialize the page: the compaction entry lines up with its message.
  const entries = [
    { kind: "user", id: 11, text: "first" },
    { kind: "assistant", id: 12, blocks: [{ type: "text", text: "one" }] },
    { kind: "compaction", id: 13, summary: "collapsed", tokensBefore: 100000, tokensAfter: 30000 },
    { kind: "user", id: 14, text: "second" },
    { kind: "assistant", id: 15, blocks: [{ type: "text", text: "two" }] },
  ]
  timeline = buildTimelineTurns(messages, 0, entries)
  expect(timeline.map(t => t.entryId).join(",")).toBe("11,13,14")
  expect(timeline[2].answer).toBe("two")
  // A live compaction appended after the snapshot appears at the end.
  timeline = buildTimelineTurns(messages, 0, [...entries, { kind: "compaction", id: 16, summary: "live", live: true }])
  expect(timeline.at(-1).entryId).toBe(16)
  expect(timeline.at(-1).compaction.tokensBefore).toBe(undefined)
})

test("timeline without a snapshot keeps compaction nodes from entries", () => {
  const timeline = buildTimelineTurns([], 0, [
    { kind: "user", id: 1, text: "q" },
    { kind: "compaction", id: 2, summary: "s", tokensBefore: 10 },
    { kind: "assistant", id: 3, blocks: [{ type: "text", text: "a" }] },
  ])
  expect(timeline.length).toBe(2)
  expect(timeline[1].compaction.tokensBefore).toBe(10)
  expect(timeline[1].entryId).toBe(2)
})

// NOTE: 源码正则断言，不验证运行时行为（项目未引入组件挂载依赖）。
test("timeline tracks the scroll position and reveals only the current number", () => {
  const component = readFileSync(new URL("../src/components/ConversationTimeline.vue", import.meta.url), "utf8")
  // 组件在 Conversation overlay 内自行定位 reka-ui 滚动视口并监听滚动。
  expect(component).toMatch(/parentElement\?\.querySelector<HTMLElement>\("\[data-reka-scroll-area-viewport\]"\)/)
  expect(component).toMatch(/addEventListener\("scroll", onViewportScroll/)
  // 当前轮次 = 视口顶部越过的最后一个问题，依据 data-message-id 锚点判定。
  expect(component).toMatch(/querySelector<HTMLElement>\(`\[data-message-id="\$\{turn\.entryId\}"\]`\)/)
  expect(component).toMatch(/'is-current': currentId === turn\.id/)
  // 当前位置只露出数字：不显示圆点，也不新增高亮样式。
  expect(component).toMatch(/\.timeline-node\.is-current \.timeline-number \{\n  opacity: 1;\n\}/)
  expect(component).toMatch(/\.timeline-node\.is-current \.timeline-dot \{\n  opacity: 0;\n\}/)
  // 仅检查 is-current 自己的规则块，确认没有附加 background/outline 高亮。
  const rules = component.match(/\.timeline-node\.is-current[^{]*\{[^}]*\}/g) ?? []
  expect(rules.length).toBeGreaterThan(0)
  for (const rule of rules) {
    expect(rule).not.toMatch(/background:/)
    expect(rule).not.toMatch(/outline:/)
  }
})
