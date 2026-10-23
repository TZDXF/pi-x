import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, test } from "vitest"

const script = fileURLToPath(new URL("../src-tauri/resources/session_snapshot.cjs", import.meta.url))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function harness() {
  const root = mkdtempSync(join(tmpdir(), "pix-session-snapshot-"))
  roots.push(root)
  const sessions = join(root, "sessions", "project")
  mkdirSync(sessions, { recursive: true })
  const file = join(sessions, "original.jsonl")
  const content = '{"type":"session","id":"original"}\n'
  writeFileSync(file, content)
  const run = (request: Record<string, unknown>) => {
    const stdout = execFileSync(process.execPath, [script], {
      input: JSON.stringify({ file, ...request }),
      encoding: "utf8",
      env: { ...process.env, PI_CODING_AGENT_DIR: root },
      stdio: ["pipe", "pipe", "pipe"],
    })
    return JSON.parse(stdout.trim().replace(/^PIX_SESSION_SNAPSHOT=/, ""))
  }
  return { root, sessions, file, content, run }
}

test("remote snapshot read and write preserve the original file and adopt the independent copy", () => {
  const h = harness()
  expect(h.run({ op: "read" })).toEqual({ content: h.content })
  const copy = '{"type":"session","id":"copy"}\n'
  const result = h.run({ op: "write", name: "copy.jsonl", content: copy })
  expect(result.file).toBe(join(h.sessions, "copy.jsonl"))
  expect(readFileSync(result.file, "utf8")).toBe(copy)
  expect(JSON.parse(readFileSync(join(h.sessions, "copy.pix.json"), "utf8"))).toEqual({
    archived: false,
    title_generation_attempted: false,
  })
  expect(readFileSync(h.file, "utf8")).toBe(h.content)
  expect(() => h.run({ op: "write", name: "copy.jsonl", content: "overwrite" })).toThrow()
  expect(readFileSync(result.file, "utf8")).toBe(copy)
}, 15_000)

test("remote snapshots reject files outside the session root", () => {
  const h = harness()
  const file = join(h.root, "outside.jsonl")
  writeFileSync(file, h.content)
  expect(() => h.run({ op: "read", file })).toThrow(/Invalid session path/)
  expect(() => h.run({ op: "write", file, name: "copy.jsonl", content: h.content })).toThrow(/Invalid session path/)
  expect(readFileSync(file, "utf8")).toBe(h.content)
}, 15_000)

test.each(["../outside.jsonl", "sub/copy.jsonl", "sub\\copy.jsonl", "copy.txt"])(
  "remote snapshots reject invalid copy name %s",
  name => {
    const h = harness()
    expect(() => h.run({ op: "write", name, content: h.content })).toThrow(/Invalid session filename/)
    expect(readdirSync(h.sessions)).toEqual(["original.jsonl"])
  },
)

test("remote snapshot adoption failure removes only the new copy", () => {
  const h = harness()
  writeFileSync(join(h.sessions, "copy.pix.json"), "existing metadata")
  expect(() => h.run({ op: "write", name: "copy.jsonl", content: h.content })).toThrow()
  expect(readdirSync(h.sessions).sort()).toEqual(["copy.pix.json", "original.jsonl"])
  expect(readFileSync(h.file, "utf8")).toBe(h.content)
})
