import { test, expect } from "vitest"
import { readFileSync } from "node:fs"
import ts from "typescript"

// mcpConfig.ts is dependency-free; transpile like paths.test.ts so the module
// runs in plain node without the @/ alias.
const source = readFileSync(new URL("../src/lib/mcpConfig.ts", import.meta.url), "utf8")
const js = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 })
const mcpConfig = await import(
  `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`
)
const { validateMcpJson, mcpConfigTemplate, mcpStateLabelKey, MCP_SERVER_STATES } = mcpConfig

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

const {
  mcpServerNameValid,
  mcpEntryTransport,
  mcpServerEntries,
  mcpFormFromDef,
  applyMcpForm,
  mcpFormError,
  upsertMcpServer,
  removeMcpServer,
  serializeMcpDoc,
  parseMcpEntryJson,
} = mcpConfig

test("server names follow pi's character rules", () => {
  expect(mcpServerNameValid("fs-server_1")).toBe(true)
  for (const bad of ["", "a b", "中文", "a.b"]) expect(mcpServerNameValid(bad)).toBe(false)
})

test("entry transport is inferred from shape and type field", () => {
  expect(mcpEntryTransport({ command: "npx" })).toBe("stdio")
  expect(mcpEntryTransport({ url: "https://x/mcp" })).toBe("http")
  expect(mcpEntryTransport({ type: "streamable-http", url: "https://x/mcp" })).toBe("http")
  expect(mcpEntryTransport({ type: "sse", url: "https://x/sse" })).toBe("unknown")
  expect(mcpEntryTransport({ type: "http", command: "npx" })).toBe("unknown")
  expect(mcpEntryTransport({ args: [] })).toBe("unknown")
  expect(mcpEntryTransport("text")).toBe("unknown")
})

test("form round trip preserves unknown def fields", () => {
  const def = { command: "npx", args: ["-y", "pkg"], env: { A: "1" }, timeout: 30, exposure: "direct" }
  const form = mcpFormFromDef(def)
  expect(form.transport).toBe("stdio")
  const next = applyMcpForm(def, { ...form, args: ["-y", "pkg2"] })
  expect(next.args).toEqual(["-y", "pkg2"])
  expect(next.timeout).toBe(30)
  expect(next.exposure).toBe("direct")
  expect(next.env).toEqual({ A: "1" })
})

test("applyMcpForm switches transports without leaving stale keys", () => {
  const def = { command: "npx", args: ["-y"], env: { A: "1" }, type: "stdio" }
  const form = { ...mcpFormFromDef(def), transport: "http", url: "https://x/mcp" }
  const next = applyMcpForm(def, form)
  expect(next.url).toBe("https://x/mcp")
  expect(next).not.toHaveProperty("command")
  expect(next).not.toHaveProperty("args")
  expect(next).not.toHaveProperty("env")
  expect(next).not.toHaveProperty("type")
})

test("applyMcpForm drops empty optional fields and honors enabled", () => {
  const def = { command: "npx", args: ["-y"], env: { A: "1" }, cwd: "." }
  const form = { ...mcpFormFromDef(def), args: [], env: {}, cwd: "", enabled: false }
  const next = applyMcpForm(def, form)
  for (const key of ["args", "env", "cwd"]) expect(next).not.toHaveProperty(key)
  expect(next.enabled).toBe(false)
  const back = applyMcpForm(next, { ...mcpFormFromDef(next), enabled: undefined })
  expect(back).not.toHaveProperty("enabled")
})

test("form validation requires command or a well-formed url", () => {
  const stdio = mcpFormFromDef({ command: "npx" })
  expect(mcpFormError({ ...stdio, command: "" })).toBe("commandRequired")
  expect(mcpFormError(stdio)).toBe(null)
  const http = mcpFormFromDef({ url: "https://x/mcp" })
  expect(mcpFormError({ ...http, url: "" })).toBe("urlRequired")
  expect(mcpFormError({ ...http, url: "ftp://x" })).toBe("urlInvalid")
  expect(mcpFormError(http)).toBe(null)
})

test("upsert and remove keep document shape and unknown fields", () => {
  const doc = { mcpServers: { fs: { command: "npx" } }, future: 1 }
  const added = upsertMcpServer(doc, "web", { url: "https://x/mcp" })
  expect(Object.keys(added.mcpServers)).toEqual(["fs", "web"])
  expect(added.future).toBe(1)
  // Replacing keeps the original key position.
  const replaced = upsertMcpServer(added, "fs", { command: "node" })
  expect(Object.keys(replaced.mcpServers)).toEqual(["fs", "web"])
  const removed = removeMcpServer(replaced, "fs")
  expect(Object.keys(removed.mcpServers)).toEqual(["web"])
  // Removing an absent server is a no-op.
  expect(removeMcpServer(doc, "nope")).toBe(doc)
  const valid = validateMcpJson(serializeMcpDoc(removed))
  expect(valid.ok).toBe(true)
})

test("parseMcpEntryJson accepts the supported paste shapes", () => {
  expect(parseMcpEntryJson('{"command":"npx"}', "fs")).toEqual({
    ok: true,
    name: "fs",
    def: { command: "npx" },
  })
  expect(parseMcpEntryJson('{"web":{"url":"https://x"}}', "fs")).toEqual({
    ok: true,
    name: "web",
    def: { url: "https://x" },
  })
  expect(
    parseMcpEntryJson('{"mcpServers":{"a":{"command":"npx"}}}', "fallback"),
  ).toEqual({ ok: true, name: "a", def: { command: "npx" } })
  // def.name fills in a blank name from the bare definition.
  expect(parseMcpEntryJson('{"name":"a","command":"npx"}', "")).toMatchObject({ name: "a" })
})

test("parseMcpEntryJson rejects ambiguous or broken input", () => {
  expect(parseMcpEntryJson("{", "fs").error).toBe("invalidJson")
  expect(parseMcpEntryJson("[]", "fs").error).toBe("notAnObject")
  expect(parseMcpEntryJson("{}", "fs").error).toBe("noEntry")
  expect(parseMcpEntryJson('{"a":{"command":"npx"},"b":{"command":"npx"}}', "fs").error).toBe(
    "noEntry",
  )
  expect(parseMcpEntryJson('{"mcpServers":{"a":{"command":"npx"},"b":{"url":"https://x"}}}', "").error).toBe(
    "noEntry",
  )
})

test("server entries are listed in document order", () => {
  const valid = validateMcpJson(
    '{"mcpServers":{"fs":{"command":"npx"},"web":{"url":"https://x/mcp"}}}',
  )
  expect(valid.ok).toBe(true)
  if (valid.ok) {
    const entries = mcpServerEntries(valid.value)
    expect(entries.map((e) => e.name)).toEqual(["fs", "web"])
  }
})
