import { expect, test } from "vitest"
import { spawnSync } from "node:child_process"

// Optional installed-SDK contract check. No providers, credentials or model calls.
const dist = process.env.PI_TEST_SDK
test(
  "pi-schema validates ordinary MCP JSON Schema without TypeBox and preserves the raw input",
  { skip: !dist },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `
    import { createRequire } from "node:module";
    import { existsSync, readFileSync } from "node:fs";
    import { pathToFileURL } from "node:url";
    import { join } from "node:path";
    const require = createRequire(join(process.argv[1], "index.js"));
    const root = require.resolve.paths("@earendil-works/pi-ai")
      .map(path => join(path, "@earendil-works/pi-ai")).find(path => existsSync(join(path, "package.json")));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const { validateToolArguments } = await import(pathToFileURL(join(root, pkg.exports["."].import)).href);
    const tool = { name: "mcp_tool", parameters: { type: "object", properties: {
      limit: { type: "integer" }, paths: { type: "array", items: { type: "string" } }
    }, required: ["limit", "paths"] } };
    const input = { limit: "3", paths: "a" };
    const value = validateToolArguments(tool, { arguments: input });
    let error;
    try { validateToolArguments(tool, { arguments: { limit: "invalid" } }); }
    catch (e) { error = e.message; }
    console.log(JSON.stringify({ input, value, error }));
  `,
        dist!,
      ],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    )
    expect(result.status, result.stderr).toBe(0)
    const parsed = JSON.parse(result.stdout)
    expect(parsed.input).toEqual({ limit: "3", paths: "a" })
    expect(parsed.value).toEqual({ limit: 3, paths: ["a"] })
    expect(parsed.error).toContain("- limit: expected integer, got string")
    expect(parsed.error).toContain("- paths: missing")
  },
)
