import { test, expect } from "vitest"
import { buildFileTree, flattenVisibleTree, flatFileRows } from "@/lib/reviewFileTree"
import { buildPaneRows, buildPaneRowOffsets } from "@/lib/reviewLayout"
import { toSideBySideRows } from "@/lib/reviewDiff"
test("review file tree sorts directories first and preserves selection data", () => {
  const files = [{ path: "z.ts" }, { path: "src/b.ts" }, { path: "src/a.ts" }]
  const tree = buildFileTree(files)
  const rows = flattenVisibleTree(tree, new Set())
  expect(rows.map(row => row.name).join(",")).toBe("src,a.ts,b.ts,z.ts")
  expect(rows[1].data).toBe(files[2])
  expect(flattenVisibleTree(tree, new Set(["src"])).length).toBe(2)
  expect(flatFileRows(files)[1].fullPath).toBe("src/b.ts")
})
test("split panes omit artificial blank rows for unequal replacements", () => {
  const rows = toSideBySideRows([
    { kind: "del", text: "-old1", oldLine: 1, newLine: null },
    { kind: "del", text: "-old2", oldLine: 2, newLine: null },
    { kind: "add", text: "+new", oldLine: null, newLine: 1 },
  ])
  expect(buildPaneRows(rows, "left").length).toBe(2)
  expect(buildPaneRows(rows, "right").length).toBe(1)
  const offsets = buildPaneRowOffsets(rows)
  expect(offsets.left.at(-1)).toBe(2)
  expect(offsets.right.at(-1)).toBe(1)
})
