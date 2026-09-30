import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"

// mcpConfig.ts is dependency-free; transpile like paths.test.ts so the module
// runs in plain node without the @/ alias.
const source = readFileSync(new URL("../src/lib/mcpConfig.ts", import.meta.url), "utf8")
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const { validateMcpJson, mcpConfigTemplate, mcpStateLabelKey, MCP_SERVER_STATES } = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
)

test("valid mcp.json documents pass validation", () => {
  const valid = validateMcpJson('{ "mcpServers": { "fs": { "command": "npx" } } }')
  expect(valid.ok).toBe(true)
  if (valid.ok) expect(valid.value.mcpServers.fs.command).toBe("npx")
})

test("unknown top-level fields survive validation", () => {
  const text = '{ "mcpServers": {}, "autoEnableCodemode": false, "future": { "a": 1 } }'
  const valid = validateMcpJson(text)
  expect(valid.ok).toBe(true)
  if (valid.ok) expect(valid.value.future).toEqual({ a: 1 })
})

test("empty content is rejected", () => {
  const invalid = validateMcpJson("   \n  ")
  expect(invalid.ok).toBe(false)
  if (!invalid.ok) expect(invalid.error.kind).toBe("empty")
})

test("syntax errors report kind parse with a message", () => {
  const invalid = validateMcpJson('{ "mcpServers": { }')
  expect(invalid.ok).toBe(false)
  if (!invalid.ok) {
    expect(invalid.error.kind).toBe("parse")
    expect(invalid.error.message).toBeTruthy()
  }
})

test("parse errors map the reported position to line and column", () => {
  // V8 reports the unexpected token "2" at position 11: one newline plus
  // nine characters before it -> line 2, column 10.
  const text = '{\n  "a": 1 2\n}'
  const invalid = validateMcpJson(text)
  expect(invalid.ok).toBe(false)
  if (!invalid.ok) {
    expect(invalid.error.kind).toBe("parse")
    expect(invalid.error.line).toBe(2)
    expect(invalid.error.column).toBe(10)
  }
})

test("non-object documents are rejected", () => {
  for (const text of ["[]", '"str"', "42", "null"]) {
    const invalid = validateMcpJson(text)
    expect(invalid.ok, text).toBe(false)
    if (!invalid.ok) expect(invalid.error.kind).toBe("topLevel")
  }
})

test("mcpServers must be an object when present", () => {
  const invalid = validateMcpJson('{ "mcpServers": ["broken"] }')
  expect(invalid.ok).toBe(false)
  if (!invalid.ok) expect(invalid.error.kind).toBe("mcpServers")
})

test("template is a valid minimal document", () => {
  const valid = validateMcpJson(mcpConfigTemplate())
  expect(valid.ok).toBe(true)
})

test("known server states map to i18n keys without raw value", () => {
  for (const state of MCP_SERVER_STATES) {
    expect(mcpStateLabelKey(state)).toEqual({ key: `mcpConfig.state.${state}` })
  }
})

test("unknown server states fall back to the raw value", () => {
  expect(mcpStateLabelKey("warp-drive")).toEqual({ key: "mcpConfig.stateUnknown", raw: "warp-drive" })
})
