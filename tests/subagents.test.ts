import { test, expect } from "vitest"
import {
  parseSubagentSnapshotLine,
  parseSubagentWidget,
  isSubagentTool,
  subagentToolTitle,
  subagentStateLabel,
  subagentStateView,
  SUBAGENT_WIDGET_PREFIX,
} from "@/lib/subagents"

const snapshot = {
  kind: "pi-subagents.async-status-snapshot",
  version: 1,
  generatedAt: 1790926729652,
  caps: { maxRuns: 20 },
  omitted: { runs: 0, children: 0, byteLimitExceeded: false },
  runs: [
    {
      id: "b975ff8f",
      kind: "subagent",
      label: "delegate",
      state: "running",
      startedAt: 1790926719649,
      updatedAt: 1790926719649,
      children: [{ id: "step:0", kind: "step", label: "delegate", state: "queued" }],
    },
    {
      id: "22d0d72d",
      kind: "subagent",
      label: "delegate",
      state: "completed",
      startedAt: 1790926719590,
      updatedAt: 1790926719590,
      children: [],
    },
  ],
}

const snapshotLine = SUBAGENT_WIDGET_PREFIX + JSON.stringify(snapshot)

test("parses a valid snapshot line", () => {
  const parsed = parseSubagentSnapshotLine(snapshotLine)
  expect(parsed).not.toBeNull()
  expect(parsed?.kind).toBe("pi-subagents.async-status-snapshot")
  expect(parsed?.runs).toHaveLength(2)
  expect(parsed?.runs[0]).toMatchObject({ label: "delegate", state: "running" })
  expect(parsed?.runs[0]?.children).toHaveLength(1)
})

test("rejects plain lines and invalid payloads", () => {
  expect(parseSubagentSnapshotLine("普通文本行")).toBeNull()
  expect(parseSubagentSnapshotLine(SUBAGENT_WIDGET_PREFIX + "{not json")).toBeNull()
  // Wrong kind or missing runs are not accepted.
  expect(parseSubagentSnapshotLine(SUBAGENT_WIDGET_PREFIX + JSON.stringify({ kind: "other", runs: [] }))).toBeNull()
  expect(
    parseSubagentSnapshotLine(SUBAGENT_WIDGET_PREFIX + JSON.stringify({ kind: "pi-subagents.async-status-snapshot" })),
  ).toBeNull()
  // Malformed run entries fail validation.
  const badRun = { ...snapshot, runs: [{ id: 1, label: "delegate", state: "running", startedAt: 1 }] }
  expect(parseSubagentSnapshotLine(SUBAGENT_WIDGET_PREFIX + JSON.stringify(badRun))).toBeNull()
})

test("splits widget lines into a snapshot and plain lines", () => {
  const content = parseSubagentWidget(["header line", snapshotLine, "footer line"])
  expect(content.snapshot?.runs).toHaveLength(2)
  expect(content.plainLines).toEqual(["header line", "footer line"])
})

test("keeps the last snapshot when several lines carry one", () => {
  const newer = { ...snapshot, runs: [{ ...snapshot.runs[0]!, state: "completed", children: [] }] }
  const content = parseSubagentWidget([snapshotLine, SUBAGENT_WIDGET_PREFIX + JSON.stringify(newer)])
  expect(content.snapshot?.runs[0]?.state).toBe("completed")
  expect(content.plainLines).toEqual([])
})

test("widget without snapshot lines renders as plain text", () => {
  const content = parseSubagentWidget(["some widget text"])
  expect(content.snapshot).toBeNull()
  expect(content.plainLines).toEqual(["some widget text"])
})

test("detects plugin delegation tools by their base name", () => {
  expect(isSubagentTool("subagent")).toBe(true)
  expect(isSubagentTool("subagents_enable")).toBe(true)
  // Prefixed spellings (e.g. server-qualified names) still match.
  expect(isSubagentTool("tool.subagent")).toBe(true)
  expect(isSubagentTool("bash")).toBe(false)
  expect(isSubagentTool("subagents_manager")).toBe(false)
})

test("derives delegation tool titles from arguments", () => {
  const workflowLabel = "子智能体工作流"
  expect(subagentToolTitle(JSON.stringify({ action: "list", capabilities: true }), workflowLabel)).toBe("list")
  expect(subagentToolTitle(JSON.stringify({ task: "只返回一个数字" }), workflowLabel)).toBe("只返回一个数字")
  // Multi-line tasks collapse to a single line, long ones are capped.
  const long = "x".repeat(150)
  expect(subagentToolTitle(JSON.stringify({ task: long }), workflowLabel)).toBe("x".repeat(120) + "…")
  expect(subagentToolTitle(JSON.stringify({ workflowScript: "const r = 1" }), workflowLabel)).toBe(workflowLabel)
  // No or invalid arguments fall back to the tool name (empty title).
  expect(subagentToolTitle(undefined, workflowLabel)).toBe("")
  expect(subagentToolTitle("{unterminated", workflowLabel)).toBe("")
  expect(subagentToolTitle(JSON.stringify({ capabilities: true }), workflowLabel)).toBe("")
})

test("state vocabulary normalizes snapshot and tool-run states", () => {
  expect(subagentStateView("running")).toBe("running")
  expect(subagentStateView("input-available")).toBe("running")
  expect(subagentStateView("input-streaming")).toBe("queued")
  expect(subagentStateView("complete")).toBe("completed")
  expect(subagentStateView("output-available")).toBe("completed")
  expect(subagentStateView("output-error")).toBe("failed")
  expect(subagentStateView("aborted")).toBe("canceled")
  expect(subagentStateView("mystery")).toBe("unknown")
  // Unknown states surface the raw value; known ones localize via the key.
  expect(subagentStateLabel("mystery", key => key)).toBe("mystery")
  expect(subagentStateLabel("running", key => key)).toBe("piSubagents.state.running")
})
