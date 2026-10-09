import { expect, test } from "vitest"
import { readFileSync } from "node:fs"
import { readToolTitle } from "@/lib/readToolTitle"

const path = "docs/开发进度.md"

test("read titles include the path and explicit offset regardless of argument order", () => {
  expect(readToolTitle(JSON.stringify({ offset: 425, path }))).toBe(`${path} · offset=425`)
  expect(readToolTitle(JSON.stringify({ path, offset: 425 }))).toBe(`${path} · offset=425`)
  expect(readToolTitle(JSON.stringify({ path, offset: 0 }))).toBe(`${path} · offset=0`)
})

test("reads without an offset keep their path-only title", () => {
  expect(readToolTitle(JSON.stringify({ path }))).toBe(path)
  expect(readToolTitle(JSON.stringify({ path, limit: 100 }))).toBe(path)
})

test("read titles support every existing file path alias and escaped paths", () => {
  for (const key of ["path", "file_path", "filePath"]) {
    expect(readToolTitle(JSON.stringify({ [key]: path, offset: 425 }))).toBe(`${path} · offset=425`)
  }
  const escaped = 'D:\\code\\a"b.md'
  expect(readToolTitle(JSON.stringify({ path: escaped, offset: 425 }))).toBe(`${escaped} · offset=425`)
})

test("invalid offsets are not exposed as read positions", () => {
  for (const offset of [null, "425", false, {}, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(readToolTitle(JSON.stringify({ path, offset }))).toBe(path)
  }
})

test("streaming arguments retain their path preview and gain an offset when complete", () => {
  expect(readToolTitle('{"path":"docs/开发')).toBe("docs/开发")
  expect(readToolTitle('{"offset":425,"path":"docs/开发进度.md"')).toBe(path)
  expect(readToolTitle('{"offset":425,"path":"docs/开发进度.md"}')).toBe(`${path} · offset=425`)
  expect(readToolTitle('{"file_path":"D:\\\\code\\\\file.md')).toBe("D:\\code\\file.md")
})

test("missing paths and invalid argument objects fall back to the tool name", () => {
  for (const input of ["", "{", "null", "[]", "42", '{"offset":425}', '{"path":"","offset":425}']) {
    expect(readToolTitle(input)).toBe("")
  }
})

test("read headers use the preview with persisted run arguments as a fallback", () => {
  const blocks = readFileSync(new URL("../src/components/AssistantBlocks.vue", import.meta.url), "utf8")
  expect(blocks).toMatch(/readToolTitle\(block\.argsText \|\| runFor\(block\)\?\.argsText \|\| ""\)/)
  expect(blocks).toMatch(/:title="isRead\(block\) \? readTitle\(block\) \|\| undefined : undefined"/)
})

test("read tools use a file icon while other tools keep their existing icons", () => {
  const blocks = readFileSync(new URL("../src/components/AssistantBlocks.vue", import.meta.url), "utf8")
  expect(blocks).toMatch(/import \{[^}]*\bFileText\b[^}]*\} from "@lucide\/vue"/)
  expect(blocks).toMatch(/:icon="isRead\(block\) \? FileText : undefined"/)
  expect(blocks).toMatch(/:icon="SquareTerminal"/)
})
