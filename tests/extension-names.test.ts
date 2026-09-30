import { test, expect } from "vitest"
import {
  BUILTIN_PREFIX,
  builtinExtensionName,
  builtinExtensionPath,
  isBuiltinExtensionPath,
} from "@/lib/extensionNames"
import { isBuiltinCommand, sortCommands } from "@/lib/completion"

test("built-in names use the current builtin:<name> spelling", () => {
  for (const name of ["mcp", "read", "llama.cpp", "codemode", "tool-search"]) {
    const path = `${BUILTIN_PREFIX}${name}`
    expect(builtinExtensionName(path)).toBe(name)
    expect(isBuiltinExtensionPath(path)).toBe(true)
    expect(builtinExtensionPath(path)).toBe(path)
  }
})

test("legacy <builtin:name> and <inline:name> names parse as built-ins", () => {
  // pi before 0.99 named the same built-ins with angle brackets; cached data
  // and strings captured from older versions still use those spellings.
  expect(builtinExtensionName("<builtin:mcp>")).toBe("mcp")
  expect(builtinExtensionName("<inline:mcp>")).toBe("mcp")
  expect(builtinExtensionName("<builtin:llama.cpp>")).toBe("llama.cpp")
  expect(isBuiltinExtensionPath("<builtin:mcp>")).toBe(true)
  expect(builtinExtensionPath("<builtin:mcp>")).toBe("builtin:mcp")
  expect(builtinExtensionPath("<inline:tool-search>")).toBe("builtin:tool-search")
})

test("real file paths are never treated as built-in names", () => {
  const files = [
    "/home/u/.pi/agent/extensions/pi-mcp-adapter/index.js",
    "C:\\Users\\u\\.pi\\agent\\extensions\\builtin-helper.js",
    "~/.pix/extensions/pix-file-changes.js",
    "builtin.mjs",
    "",
  ]
  for (const file of files) {
    expect(builtinExtensionName(file)).toBe(null)
    expect(isBuiltinExtensionPath(file)).toBe(false)
    expect(builtinExtensionPath(file)).toBe(file)
  }
  expect(builtinExtensionName(undefined)).toBe(null)
  expect(builtinExtensionName("  ")).toBe(null)
  expect(builtinExtensionName("builtin:")).toBe(null)
})

test("commands from a built-in extension group with the built-in ones", () => {
  // pi reports built-in extension commands as source "extension"; the
  // canonical builtin:<name> path is what separates them from third-party ones.
  const commands = sortCommands([
    { name: "pi-mcp-adapter", source: "extension" },
    { name: "mcp", source: "extension", builtin: true, path: "builtin:mcp" },
    { name: "compact", source: "builtin" },
    { name: "review", source: "skill" },
  ])
  // Stable within a group, so `mcp` keeps its place ahead of `compact`.
  expect(commands.map(command => command.name)).toEqual(["review", "mcp", "compact", "pi-mcp-adapter"])
  expect(isBuiltinCommand({ source: "extension", builtin: true })).toBe(true)
  expect(isBuiltinCommand({ source: "builtin" })).toBe(true)
  expect(isBuiltinCommand({ source: "extension" })).toBe(false)
})
