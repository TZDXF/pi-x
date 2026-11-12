import { expect, test } from "vitest"
import { resolveCodeCommentFile } from "@/lib/codeCommentNavigation"

test("relative references stay in the session root and Windows separators normalize", () => {
  expect(resolveCodeCommentFile("src\\main.ts", ["C:/demo", "C:/other"])).toEqual({
    project: "C:/demo",
    path: "src/main.ts",
  })
})

test.each([
  ["C:\\OTHER\\src\\a.ts", ["C:/demo", "C:/other"], "C:/other", "src/a.ts"],
  ["/demo/sub/a.ts", ["/demo", "/demo/sub"], "/demo/sub", "a.ts"],
  [
    "ssh://user@host/work/other/a.ts",
    ["ssh://user@host/work/demo", "ssh://user@host/work/other"],
    "ssh://user@host/work/other",
    "a.ts",
  ],
  ["wsl://Ubuntu/work/a.ts", ["wsl://Ubuntu/work"], "wsl://Ubuntu/work", "a.ts"],
])("resolves registered cross-folder reference %s", (path, roots, project, relative) => {
  expect(resolveCodeCommentFile(path, roots)).toEqual({ project, path: relative })
})

test.each(["", "../a.ts", "src/../a.ts", "src//a.ts", "/other/a.ts", "C:/demo-other/a.ts", "ssh://other/work/a.ts"])(
  "does not read outside registered roots: %s",
  path => {
    expect(resolveCodeCommentFile(path, ["C:/demo"])).toBeNull()
  },
)

test("POSIX paths retain case and references need a project", () => {
  expect(resolveCodeCommentFile("/Demo/a.ts", ["/demo"])).toBeNull()
  expect(resolveCodeCommentFile("a.ts", [])).toBeNull()
})
