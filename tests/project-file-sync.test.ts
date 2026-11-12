import { expect, test } from "vitest"
import { directoriesToReload, interestPaths, parentDirectory, previewNeedsReload } from "@/lib/projectFileSync"

test("parentDirectory returns the project-relative folder of a changed path", () => {
  expect(parentDirectory("src/lib.ts")).toBe("src")
  expect(parentDirectory("src/stores/session.ts")).toBe("src/stores")
  expect(parentDirectory("README.md")).toBe("")
})

test("only loaded directories are re-listed, plus the project root", () => {
  const loaded = { "": [], src: [] }
  // 未展开目录下的变化不触发该目录的列表拉取，否则会把懒加载的树重新拉满。
  expect(directoriesToReload(["src/lib.ts"], loaded)).toEqual(["", "src"])
  expect(directoriesToReload(["src-tauri/target/debug/log"], loaded)).toEqual([""])
  // 根目录的增删总会刷新根列表。
  expect(directoriesToReload(["README.md"], loaded)).toEqual([""])
  expect(directoriesToReload(["a/b.ts", "a/b.ts"], loaded)).toEqual([""])
})

test("a loaded directory that disappeared is re-listed so stale children are replaced", () => {
  const loaded = { "": [], src: [], "src/stores": [] }
  // 目录自身被删除/重命名：它本身也要重拉，返回空列表即替换掉陈旧子项。
  expect(directoriesToReload(["src"], loaded)).toEqual(["", "src"])
  expect(directoriesToReload(["src/stores"], loaded)).toEqual(["", "src", "src/stores"])
  // 未加载目录被删除只需刷新其父目录。
  expect(directoriesToReload(["docs"], loaded)).toEqual([""])
})

test("the published interest is every expanded directory plus the previewed file", () => {
  expect(interestPaths([], null)).toEqual([""])
  expect(interestPaths(["src", "src/stores"], "src/lib.ts")).toEqual(["", "src", "src/stores", "src/lib.ts"])
  // 已打开文件同时是一个展开目录时不重复列出；缓存但仍收起的目录不参与。
  expect(interestPaths(["src", "src/lib.ts", ""], "src/lib.ts")).toEqual(["", "src", "src/lib.ts"])
})

test("the open preview reloads only when its own file changed", () => {
  expect(previewNeedsReload("src/lib.ts", ["src/lib.ts"])).toBe(true)
  expect(previewNeedsReload("src/lib.ts", ["src/other.ts"])).toBe(false)
  expect(previewNeedsReload(null, ["src/lib.ts"])).toBe(false)
  // 目录变更不重读文件内容。
  expect(previewNeedsReload("src/lib.ts", ["src"])).toBe(false)
})
