import { test, expect } from "vitest"
import {
  estimateContextBreakdown,
  contextBreakdownParts,
  annotateCompactionEstimates,
  mcpContextRows,
} from "@/lib/contextBreakdown"
import { estimateMcpContextUsage } from "@/lib/mcpUsage"

const system = (sections, toolsAdded, extra = {}) => ({
  role: "system",
  content: "",
  sections,
  toolsAdded,
  ...extra,
})
const user = text => ({ role: "user", content: text })
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] })

test("splits prompt sections, tool definitions and message history", () => {
  const messages = [
    system({ preamble: "a".repeat(400), tools: "t".repeat(800) }, [
      { name: "read", description: "r".repeat(396), parameters: {} },
    ]),
    user("u".repeat(4000)),
    assistant("a".repeat(4000)),
  ]
  const est = estimateContextBreakdown(messages)
  // chars/4: sections 400 -> 100; tools section 800 + schema ~416 -> ~304
  expect(est.systemPrompt).toBe(100)
  expect(est.messageHistory).toBe(2000)
  expect(est.toolDefinitions > 200).toBeTruthy()
  expect(est.total).toBe(est.systemPrompt + est.toolDefinitions + est.messageHistory)
})

test("replays section patches and tool removals across system messages", () => {
  const messages = [
    system({ preamble: "a".repeat(400), skills: "s".repeat(400), tools: "t".repeat(400) }, [
      { name: "read" },
      { name: "bash" },
    ]),
    system({ skills: null }, undefined, { toolsRemoved: [{ name: "bash" }] }),
    user("u".repeat(400)),
  ]
  const est = estimateContextBreakdown(messages)
  // skills removed; prompt keeps preamble only
  expect(est.systemPrompt).toBe(100)
  expect(est.messageHistory).toBe(100)
  const toolNames = JSON.stringify([{ name: "read" }]).length
  expect(est.toolDefinitions).toBe(Math.ceil((400 + toolNames) / 4))
})

test("non-empty system content replaces the prompt estimate", () => {
  const messages = [{ role: "system", content: "x".repeat(800) }, user("u".repeat(400))]
  const est = estimateContextBreakdown(messages)
  expect(est.systemPrompt).toBe(200)
  expect(est.toolDefinitions).toBe(0)
})

test("assistant thinking and toolCall blocks count towards history", () => {
  const messages = [
    assistant("a".repeat(100)),
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "t".repeat(200) },
        { type: "toolCall", name: "read", arguments: { path: "p".repeat(100) } },
      ],
    },
    { role: "toolResult", content: "o".repeat(400) },
    { role: "bashExecution", command: "c".repeat(40), output: "o".repeat(360) },
  ]
  const est = estimateContextBreakdown(messages)
  expect(est.systemPrompt).toBe(0)
  expect(est.toolDefinitions).toBe(0)
  expect(est.messageHistory > 0).toBeTruthy()
  expect(est.total).toBe(est.messageHistory)
})

test("images use the same fixed estimate as pi", () => {
  const messages = [
    user([
      { type: "text", text: "hi" },
      { type: "image", data: "..." },
    ]),
  ]
  const est = estimateContextBreakdown(messages)
  expect(est.messageHistory).toBe(Math.ceil((2 + 4800) / 4))
})

test("parts share the total and scale to the usage-backed token count", () => {
  const messages = [
    system({ preamble: "a".repeat(400) }, [{ name: "read", description: "d".repeat(396) }]),
    user("u".repeat(3200)),
  ]
  const est = estimateContextBreakdown(messages)
  const parts = contextBreakdownParts(est, 10000)
  expect(JSON.stringify(parts.map(p => p.key))).toBe(
    JSON.stringify(["systemPrompt", "toolDefinitions", "messageHistory"]),
  )
  const percentSum = parts.reduce((sum, p) => sum + p.percent, 0)
  expect(Math.abs(percentSum - 1) < 1e-9).toBeTruthy()
  const tokenSum = parts.reduce((sum, p) => sum + p.tokens, 0)
  expect(Math.abs(tokenSum - 10000) <= parts.length).toBeTruthy()
  expect(
    parts.find(p => p.key === "messageHistory").tokens > parts.find(p => p.key === "systemPrompt").tokens,
  ).toBeTruthy()
})

test("parts fall back to raw estimates without an actual total", () => {
  const est = estimateContextBreakdown([user("u".repeat(400))])
  const parts = contextBreakdownParts(est)
  const history = parts.find(p => p.key === "messageHistory")
  expect(parts.length).toBe(3)
  expect(history.tokens).toBe(100)
  expect(history.percent).toBe(1)
})

test("empty input yields no parts", () => {
  expect(estimateContextBreakdown([]).total).toBe(0)
  expect(contextBreakdownParts(estimateContextBreakdown([])).length).toBe(0)
  expect(contextBreakdownParts(estimateContextBreakdown(null)).length).toBe(0)
})

test("annotateCompactionEstimates estimates the size kept after each compaction", () => {
  const messages = [
    user("x".repeat(40000)),
    { role: "compactionSummary", summary: "s".repeat(400), tokensBefore: 10000 },
    user("y".repeat(3600)),
    assistant("z".repeat(4000)),
    { role: "compactionSummary", summary: "s".repeat(800), tokensBefore: 5000, estimatedTokensAfter: 999 },
    user("kept"),
  ]
  annotateCompactionEstimates(messages)
  // summary (400) + 3600 + 4000 chars -> 8000 / 4 = 2000 tokens
  expect(messages[1].estimatedTokensAfter).toBe(2000)
  // An existing estimate (e.g. live event data) is never overwritten.
  expect(messages[4].estimatedTokensAfter).toBe(999)
})

test("annotateCompactionEstimates uses firstKeptEntryId so later turns do not inflate the estimate", () => {
  const messages = [
    { ...user("dropped"), _entryId: "m1" },
    { ...user("k".repeat(3600)), _entryId: "m2" },
    {
      role: "compactionSummary",
      summary: "s".repeat(400),
      tokensBefore: 10000,
      firstKeptEntryId: "m2",
      _entryId: "c1",
    },
    { ...user("later turn ".repeat(40000)), _entryId: "m3" },
  ]
  annotateCompactionEstimates(messages)
  // summary (400) + kept m2 (3600) -> 4000 / 4 = 1000; the later m3 is excluded.
  expect(messages[2].estimatedTokensAfter).toBe(1000)
})

test("mcpContextRows sort by tokens and scale with the usage-backed total", () => {
  const usage = {
    "server-b": { server: "server-b", calls: 1, tokens: 100, tools: [{ tool: "t2", calls: 1, tokens: 100 }] },
    "server-a": { server: "server-a", calls: 3, tokens: 200, tools: [{ tool: "t1", calls: 3, tokens: 200 }] },
  }
  const est = { systemPrompt: 0, toolDefinitions: 0, messageHistory: 300, total: 300 }
  const rows = mcpContextRows(usage, est)
  expect(rows.map(row => row.server)).toEqual(["server-a", "server-b"])
  expect(rows[0].percent).toBeCloseTo(200 / 300)
  // Without an actual total the raw estimates pass through.
  expect(rows[0].tokens).toBe(200)
  const scaled = mcpContextRows(usage, est, 900)
  // Scale factor 3 applies to servers and their tools alike.
  expect(scaled[0].tokens).toBe(600)
  expect(scaled[0].tools[0].tokens).toBe(600)
})

test("mcpContextRows yield nothing without a context estimate", () => {
  const usage = { server: { server: "server", calls: 1, tokens: 100, tools: [] } }
  expect(mcpContextRows(usage, { systemPrompt: 0, toolDefinitions: 0, messageHistory: 0, total: 0 }, 100)).toEqual([])
})

test("MCP attribution from projected messages stays within the history share", () => {
  const messages = [
    user("u".repeat(4000)),
    {
      role: "assistant",
      content: [{ type: "toolCall", name: "mcp__github__search", arguments: { q: "p".repeat(200) }, callId: "c1" }],
    },
    { role: "toolResult", toolCallId: "c1", content: "o".repeat(2400) },
    assistant("a".repeat(4000)),
  ]
  const est = estimateContextBreakdown(messages)
  const rows = mcpContextRows(estimateMcpContextUsage(messages), est)
  expect(rows.length).toBe(1)
  expect(rows[0].server).toBe("github")
  expect(rows[0].calls).toBe(1)
  expect(rows[0].percent).toBeLessThanOrEqual(contextBreakdownParts(est).find(p => p.key === "messageHistory").percent)
})
