import { expect, test } from "vitest"
import { fileDirectoryEntries } from "@/lib/projectFiles"

test("static file sources preserve nested directories, sort directories first, and normalize Windows paths", () => {
  const entries = fileDirectoryEntries(["README.md", "docs\\Usage.MD", "docs/api/reference.md", "README.md"])
  expect(entries[""]).toEqual([
    { name: "docs", path: "docs", is_dir: true },
    { name: "README.md", path: "README.md", is_dir: false },
  ])
  expect(entries.docs).toEqual([
    { name: "api", path: "docs/api", is_dir: true },
    { name: "Usage.MD", path: "docs/Usage.MD", is_dir: false },
  ])
  expect(entries["docs/api"]).toEqual([{ name: "reference.md", path: "docs/api/reference.md", is_dir: false }])
})

test("path filtering retains only matching files and their ancestor directories", () => {
  expect(fileDirectoryEntries(["README.md", "docs/guides/Usage.MD", "docs/reference.md"], " GUIDES\\usage ")).toEqual({
    "": [{ name: "docs", path: "docs", is_dir: true }],
    docs: [{ name: "guides", path: "docs/guides", is_dir: true }],
    "docs/guides": [{ name: "Usage.MD", path: "docs/guides/Usage.MD", is_dir: false }],
  })
  expect(fileDirectoryEntries(["README.md"], "missing")).toEqual({ "": [] })
  expect(fileDirectoryEntries([])).toEqual({ "": [] })
})

test("directory names do not collide with Object prototype properties", () => {
  const entries = fileDirectoryEntries(["__proto__/README.md", "constructor/README.md"])
  expect(Object.keys(entries)).toContain("__proto__")
  expect(entries["__proto__"]).toEqual([{ name: "README.md", path: "__proto__/README.md", is_dir: false }])
  expect(entries.constructor).toEqual([{ name: "README.md", path: "constructor/README.md", is_dir: false }])
})
