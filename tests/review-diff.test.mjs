import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import { codeToTokens } from "shiki"
import { loadTsSource, pathsModule } from "./lib/load-ts.mjs"
const load = (name, context) =>
  loadTsSource(readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), "utf8"), context)
const paths = pathsModule()
const { parseDiff, intralineRanges, toSideBySideRows, foldContextLines } = load("reviewDiff")
const { changedLines } = load("sessionChanges", { require: () => paths })
const { tokensToLineHtml, highlightDiffLines, diffLangOf } = load("reviewHighlight", {
  require: name => (name === "shiki" ? { codeToTokens } : paths),
})
const plain = value => JSON.parse(JSON.stringify(value))
test("reference diff parser retains independent before and after line numbers", () => {
  const lines = parseDiff("@@ -10,2 +10,3 @@\n-const x = 1\n+const x = 20\n+extra\n tail")
  expect(plain(lines.slice(1).map(l => [l.oldLine, l.newLine]))).toEqual([
    [10, null],
    [null, 10],
    [null, 11],
    [11, 12],
  ])
})
test("intraline emphasis isolates changed text and split mode pairs unequal blocks", () => {
  const lines = parseDiff("@@ -1 +1,2 @@\n-const x = 1;\n+const x = 20;\n+extra").slice(1)
  const ranges = intralineRanges(lines)
  expect(plain(ranges.get(lines[0]))).toEqual([10, 11])
  expect(plain(ranges.get(lines[1]))).toEqual([10, 12])
  const rows = toSideBySideRows(lines)
  expect(rows.length).toBe(2)
  expect(rows[0].left).toBe(lines[0])
  expect(rows[0].right).toBe(lines[1])
  expect(rows[1].left).toBe(null)
  expect(rows[1].right).toBe(lines[2])
})
test("unchanged context folds and expands without losing source line numbers", () => {
  const lines = Array.from({ length: 30 }, (_, i) => ({
    kind: "ctx",
    text: ` line${i}`,
    oldLine: i + 1,
    newLine: i + 1,
  }))
  const folded = foldContextLines(lines, new Set())
  expect(folded.length).toBe(7)
  expect(folded[3].count).toBe(24)
  expect(folded[4].newLine).toBe(28)
  const expanded = foldContextLines(lines, new Set([folded[3].key]))
  expect(expanded.length).toBe(30)
  expect(toSideBySideRows(folded)[3].kind).toBe("fold")
})
test("tool snippets retain full context and relative line numbering", () => {
  const prefix = Array.from({ length: 20 }, (_, i) => `same ${i}`).join("\n")
  const lines = changedLines(`${prefix}\nold\ntail`, `${prefix}\nnew\nextra\ntail`)
  expect(lines[0].oldLine).toBe(1)
  expect(lines.find(l => l.kind === "remove").oldLine).toBe(21)
  expect(lines.find(l => l.kind === "add").newLine).toBe(21)
  expect(lines.at(-1).oldLine).toBe(22)
  expect(lines.at(-1).newLine).toBe(23)
})
test("large writes do not exceed the JavaScript argument stack limit", () => {
  const lines = changedLines("", "line\n".repeat(150_000))
  expect(lines.length).toBe(150_000)
  expect(lines.at(-1).newLine).toBe(150_000)
})
test("highlighting escapes source HTML and preserves theme colors", () => {
  const html = tokensToLineHtml(
    [{ content: "<script>&", htmlStyle: { "--shiki-light": "#000", "--shiki-dark": "#fff" } }],
    [1, 7],
    "diff-word-add",
  )
  expect(html.includes("&lt;")).toBeTruthy()
  expect(html.includes("&amp;")).toBeTruthy()
  expect(html.includes("--shiki-light:#000")).toBeTruthy()
  expect(html.includes("diff-word-add")).toBeTruthy()
  expect(!html.includes("<script>")).toBeTruthy()
  expect(diffLangOf("C:\\src\\test.ts")).toBe("typescript")
  expect(diffLangOf("unknown.xyz123")).toBe("text")
})
test("real syntax highlighting supports deletion-only diffs and inline ranges", async () => {
  const deleted = parseDiff("@@ -1 +0,0 @@\n-const n = 1;").slice(1)
  const deletionHtml = await highlightDiffLines(deleted, "test.ts")
  expect(deletionHtml.get(deleted[0]).includes("--shiki-light")).toBeTruthy()
  const lines = parseDiff("@@ -1 +1 @@\n-const n = 1;\n+const n = 2;").slice(1)
  const result = await highlightDiffLines(lines, "test.ts", intralineRanges(lines))
  expect(result.get(lines[0]).includes("diff-word-del")).toBeTruthy()
  expect(result.get(lines[1]).includes("diff-word-add")).toBeTruthy()
})
test("very large diffs skip grammar processing", async () => {
  const lines = Array.from({ length: 5001 }, () => ({ kind: "add", text: "+x", oldLine: null, newLine: 1 }))
  expect(await highlightDiffLines(lines, "test.ts")).toBe(null)
})
