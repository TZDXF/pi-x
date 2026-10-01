import { describe, expect, test } from "vitest"
import { estimateMcpContextUsage, estimateMcpLoadUsage, parseMcpToolName, sanitizeMcpServerName } from "@/lib/mcpUsage"

describe("sanitizeMcpServerName", () => {
  test("keeps identifier characters, dashes and underscores", () => {
    expect(sanitizeMcpServerName("chrome-devtools")).toBe("chrome-devtools")
    expect(sanitizeMcpServerName("my_server1")).toBe("my_server1")
  })

  test("replaces other characters like pi's tool naming", () => {
    expect(sanitizeMcpServerName("a.b")).toBe("a_b")
    expect(sanitizeMcpServerName("c d/e")).toBe("c_d_e")
  })
})

describe("parseMcpToolName", () => {
  test("splits server and tool", () => {
    expect(parseMcpToolName("mcp__chrome-devtools__take_snapshot")).toEqual({
      server: "chrome-devtools",
      tool: "take_snapshot",
    })
  })

  test("rejects non-MCP names and malformed MCP names", () => {
    expect(parseMcpToolName("read")).toBeNull()
    expect(parseMcpToolName("mcp__noserver")).toBeNull()
    expect(parseMcpToolName("mcp____tool")).toBeNull()
  })

  test("keeps separators inside the tool part", () => {
    expect(parseMcpToolName("mcp__srv__a__b")).toEqual({ server: "srv", tool: "a__b" })
  })
})

describe("estimateMcpContextUsage", () => {
  test("attributes call arguments and results per server and tool", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "ignored" },
          { type: "toolCall", callId: "c1", name: "mcp__srv__list", arguments: { path: "/tmp" } },
          { type: "text", text: "ignored" },
        ],
      },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "hello" }] },
    ]
    const usage = estimateMcpContextUsage(messages)
    expect(Object.keys(usage)).toEqual(["srv"])
    // name "mcp__srv__list"(14) + arguments {"path":"/tmp"}(15) + result "hello"(5) = 34 chars → ceil(34/4)
    expect(usage.srv.tokens).toBe(9)
    expect(usage.srv.calls).toBe(1)
    expect(usage.srv.tools).toEqual([{ tool: "list", calls: 1, tokens: 9 }])
  })

  test("separates servers and sums multiple calls", () => {
    const messages = [
      {
        role: "assistant",
        content: [
          { type: "toolCall", callId: "c1", name: "mcp__a__x", arguments: {} },
          { type: "toolCall", callId: "c2", name: "mcp__b__y", arguments: {} },
          { type: "toolCall", callId: "c3", name: "mcp__a__x", arguments: {} },
        ],
      },
      { role: "toolResult", toolCallId: "c1", content: "out-a1" },
      { role: "toolResult", toolCallId: "c3", content: "out-a2" },
    ]
    const usage = estimateMcpContextUsage(messages)
    expect(usage.a.calls).toBe(2)
    expect(usage.b.calls).toBe(1)
    // Per call: name "mcp__a__x"(9) + arguments {}(2) = 11; results 6 + 6.
    expect(usage.a.tools).toEqual([{ tool: "x", calls: 2, tokens: Math.ceil((11 * 2 + 6 + 6) / 4) }])
    expect(usage.b.tools).toEqual([{ tool: "y", calls: 1, tokens: Math.ceil(11 / 4) }])
  })

  test("ignores results without a matching call and non-MCP tools", () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", callId: "c1", name: "read", arguments: {} }],
      },
      { role: "toolResult", toolCallId: "c1", content: "local tool output" },
      { role: "toolResult", toolCallId: "unknown", content: "orphan" },
    ]
    expect(estimateMcpContextUsage(messages)).toEqual({})
  })

  test("counts images at the fixed estimated size", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", callId: "c1", name: "mcp__s__shot", arguments: {} }] },
      {
        role: "toolResult",
        toolCallId: "c1",
        content: [{ type: "image", data: "should-not-count", mimeType: "image/png" }],
      },
    ]
    const usage = estimateMcpContextUsage(messages)
    expect(usage.s.tokens).toBe(Math.ceil((12 + 2 + 4800) / 4))
  })

  test("returns an empty object for sessions without MCP activity", () => {
    expect(estimateMcpContextUsage([])).toEqual({})
    expect(estimateMcpContextUsage([{ role: "user", content: "hi" }])).toEqual({})
  })
})

describe("estimateMcpLoadUsage", () => {
  test("estimates each tool's definition cost and the server total", () => {
    const defs = [
      { name: "list", description: "List files", inputSchema: { type: "object", properties: {} } },
      { name: "run", description: "Run a command", inputSchema: { type: "object" } },
    ]
    const load = estimateMcpLoadUsage("srv", defs)
    expect(load).not.toBeNull()
    expect(load!.server).toBe("srv")
    expect(load!.toolCount).toBe(2)
    // Per tool: full `mcp__srv__<name>` + description + parameters JSON, at
    // 4 chars/token. Parameters mirror pi's toParameters: a schema without
    // `properties` gains an empty one before it is serialized.
    const expected = defs.map(def => {
      const parameters = { ...def.inputSchema, properties: def.inputSchema.properties ?? {} }
      const chars = `mcp__srv__${def.name}`.length + def.description!.length + JSON.stringify(parameters).length
      return Math.ceil(chars / 4)
    })
    expect(load!.tokens).toBe(expected[0] + expected[1])
    expect(load!.tools.map(tool => tool.tool)).toEqual(["list", "run"])
    expect(load!.tools.map(tool => tool.tokens)).toEqual(expected)
  })

  test("sorts tools by descending cost", () => {
    const defs = [
      { name: "small", description: "S", inputSchema: { type: "object" } },
      {
        name: "large",
        description: "A much longer description that costs many more tokens",
        inputSchema: { type: "object" },
      },
    ]
    const load = estimateMcpLoadUsage("srv", defs)
    expect(load!.tools.map(tool => tool.tool)).toEqual(["large", "small"])
  })

  test("mirrors pi's description fallback and schema normalization", () => {
    const load = estimateMcpLoadUsage("my srv", [{ name: "tool" }])
    expect(load!.tools).toHaveLength(1)
    // No description → pi's fixed fallback text; schema-less input becomes
    // {"type":"object","properties":{}}; server name is sanitized.
    const chars =
      "mcp__my_srv__tool".length +
      "MCP tool tool from server my srv".length +
      JSON.stringify({ type: "object", properties: {} }).length
    expect(load!.tokens).toBe(Math.ceil(chars / 4))
  })

  test("keeps schema fields like required in the estimate", () => {
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
    const withSchema = estimateMcpLoadUsage("srv", [{ name: "t", description: "d", inputSchema: schema }])
    const bare = estimateMcpLoadUsage("srv", [
      { name: "t", description: "d", inputSchema: { type: "object", properties: {} } },
    ])
    expect(withSchema!.tokens).toBeGreaterThan(bare!.tokens)
  })

  test("returns null without tool definitions", () => {
    expect(estimateMcpLoadUsage("srv", [])).toBeNull()
  })
})
