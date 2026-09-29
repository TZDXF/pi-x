import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"
const source = readFileSync(new URL("../src/lib/paths.ts", import.meta.url), "utf8")
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const { isWindowsPath, joinDisplayPath, relativeDisplayPath, normalizeSlashes, normalizeProjectPath, baseName } =
  await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)

test("windows paths use backslashes when joined", () => {
  expect(joinDisplayPath("C:\\code\\pi-x", ".pi", "settings.json")).toBe("C:\\code\\pi-x\\.pi\\settings.json")
  expect(joinDisplayPath("C:\\code\\pi-x\\", ".pi/settings.json")).toBe("C:\\code\\pi-x\\.pi\\settings.json")
  expect(joinDisplayPath("\\\\server\\share", ".pi")).toBe("\\\\server\\share\\.pi")
})

test("posix paths keep forward slashes", () => {
  expect(joinDisplayPath("/home/user/proj", ".pi", "settings.json")).toBe("/home/user/proj/.pi/settings.json")
  expect(joinDisplayPath("/home/user/proj/", "/.pi/", "settings.json")).toBe("/home/user/proj/.pi/settings.json")
})

test("isWindowsPath detects separator styles", () => {
  expect(isWindowsPath("C:\\code\\pi-x")).toBe(true)
  expect(isWindowsPath("D:/code/pi-x")).toBe(true)
  expect(isWindowsPath("/home/user")).toBe(false)
})

test("relativeDisplayPath shows project files relative to the root", () => {
  expect(relativeDisplayPath("C:/code/pi-x/src/lib/a.ts", "C:\\code\\pi-x")).toBe("src/lib/a.ts")
  expect(relativeDisplayPath("C:\\code\\pi-x\\src\\a.ts", "C:/code/pi-x")).toBe("src/a.ts")
  expect(relativeDisplayPath("/home/u/proj/src/a.ts", "/home/u/proj")).toBe("src/a.ts")
  // 项目内相对路径（pi 传入相对路径时）保持原样。
  expect(relativeDisplayPath("src/a.ts", "C:/code/pi-x")).toBe("src/a.ts")
})

test("relativeDisplayPath keeps absolute paths for files outside the project", () => {
  expect(relativeDisplayPath("D:/other/b.ts", "C:/code/pi-x")).toBe("D:/other/b.ts")
  expect(relativeDisplayPath("/home/u/other/b.ts", "/home/u/proj")).toBe("/home/u/other/b.ts")
  // 前缀相似但不是同一目录时不能误判为项目内。
  expect(relativeDisplayPath("/home/u/project/b.ts", "/home/u/proj")).toBe("/home/u/project/b.ts")
})

test("relativeDisplayPath folds case only for windows drive paths", () => {
  expect(relativeDisplayPath("c:/CODE/pi-x/src/a.ts", "C:/code/pi-x")).toBe("src/a.ts")
  expect(relativeDisplayPath("/Home/U/Proj/src/a.ts", "/home/u/proj")).toBe("/Home/U/Proj/src/a.ts")
})

test("normalizeSlashes converts windows separators and keeps posix paths intact", () => {
  expect(normalizeSlashes("C:\\code\\pi-x\\src\\App.vue")).toBe("C:/code/pi-x/src/App.vue")
  expect(normalizeSlashes("\\\\server\\share\\a.jsonl")).toBe("//server/share/a.jsonl")
  expect(normalizeSlashes("/home/u/proj")).toBe("/home/u/proj")
  expect(normalizeSlashes("")).toBe("")
})

test("project paths use stable slash separators without losing filesystem roots", () => {
  expect(normalizeProjectPath("C:\\code\\pi-x\\")).toBe("C:/code/pi-x")
  expect(normalizeProjectPath("C:\\")).toBe("C:/")
  expect(normalizeProjectPath("\\\\server\\share\\")).toBe("//server/share")
  expect(normalizeProjectPath("/")).toBe("/")
})

test("baseName returns the final segment for both separator styles", () => {
  expect(baseName("C:\\code\\pi-x\\src\\App.vue")).toBe("App.vue")
  expect(baseName("/home/u/proj/src/App.vue")).toBe("App.vue")
  expect(baseName("App.vue")).toBe("App.vue")
  expect(baseName("src/App.vue/")).toBe("App.vue")
  expect(baseName("C:")).toBe("C:")
  expect(baseName("")).toBe("")
  expect(baseName("/")).toBe("/")
})
