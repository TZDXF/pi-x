import { expect, test } from "vitest"
import { defaultSearchResults } from "@/components/workspace/sidebar/useSidebarSessionOrdering"

const results = [2, 7, 1, 4, 6, 3, 5].map(mtimeMs => ({
  path: mtimeMs % 2 ? "project" : "tasks",
  session: { file: `${mtimeMs}.jsonl`, id: String(mtimeMs), cwd: "/project", mtimeMs },
}))

test("empty search shows the latest five across groups without changing source order", () => {
  for (const query of ["", "   "]) {
    expect(defaultSearchResults(results, query).map(row => row.session.mtimeMs)).toEqual([7, 6, 5, 4, 3])
  }
  expect(results.map(row => row.session.mtimeMs)).toEqual([2, 7, 1, 4, 6, 3, 5])
})

test("keyword search keeps all matches and small or empty lists remain valid", () => {
  expect(defaultSearchResults(results, "keyword")).toEqual(results)
  expect(defaultSearchResults([], "")).toEqual([])
  expect(defaultSearchResults(results.slice(0, 2), "").map(row => row.session.mtimeMs)).toEqual([7, 2])
})
