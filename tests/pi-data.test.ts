import { test, expect } from "vitest"
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname, basename } from "node:path"
import { spawnSync } from "node:child_process"

// Opt in with the dist directory of a real installed Pi. Never touch user data.
const dist = process.env.PI_TEST_SDK
const script = readFileSync(new URL("../src-tauri/resources/pi_data.mjs", import.meta.url), "utf8")
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "pix-pi-data-test-"))
  t.onTestFinished(() => {
    const target = realpathSync(root)
    expect(dirname(target)).toBe(realpathSync(tmpdir()))
    expect(basename(target).startsWith("pix-pi-data-test-")).toBeTruthy()
    rmSync(target, { recursive: true, force: true })
  })
  const agent = join(root, "agent"),
    project = join(root, "project")
  mkdirSync(agent)
  mkdirSync(project)
  function call(request, success = true) {
    const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script, dist], {
      input: JSON.stringify(request),
      encoding: "utf8",
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agent },
      timeout: 15000,
    })
    if (!success) {
      expect(child.status).not.toBe(0)
      return child.stderr
    }
    expect(child.status, child.stderr || String(child.error)).toBe(0)
    return JSON.parse(child.stdout)
  }
  return { root, agent, project, call }
}

test("installed Pi persists settings without a PiX copy and retains unrelated data", { skip: !dist }, t => {
  const { agent, root, call } = fixture(t)
  const path = join(agent, "settings.json")
  writeFileSync(path, JSON.stringify({ theme: "dark", retry: { enabled: false }, defaultThinkingLevel: "high" }))
  call({ op: "settings_save", settings: { defaultProvider: "test", defaultModel: "vendor/model" } })
  call({ op: "settings_save", settings: { skills: ["C:/skill.md", "!**/excluded/**"] } })
  let saved = JSON.parse(readFileSync(path, "utf8"))
  expect(saved.defaultProvider).toBe("test")
  expect(saved.defaultModel).toBe("vendor/model")
  expect(saved.theme).toBe("dark")
  expect(saved.retry.enabled).toBe(false)
  expect(call({ op: "settings_get" }).defaultThinkingLevel).toBe("high")
  expect(saved.skills).toEqual(["C:/skill.md", "!**/excluded/**"])
  call({ op: "settings_save", settings: { defaultProvider: null, defaultModel: null } })
  saved = JSON.parse(readFileSync(path, "utf8"))
  expect(saved.defaultProvider).toBe(undefined)
  expect(saved.defaultModel).toBe(undefined)
  expect(existsSync(join(root, ".pix"))).toBe(false)
})

test("Pi trust handles resources, parent inheritance, and explicit denial", { skip: !dist }, t => {
  const { agent, root, project, call } = fixture(t)
  mkdirSync(join(project, ".pi"))
  writeFileSync(join(project, ".pi", "settings.json"), "{}")
  expect(call({ op: "trust_status", project }).needsDecision).toBe(true)
  call({ op: "trust_save", project, trusted: true, trustParent: true })
  expect(call({ op: "trust_status", project }).decision).toBe(true)
  let stored = JSON.parse(readFileSync(join(agent, "trust.json"), "utf8"))
  expect(stored[root]).toBe(true)
  call({ op: "trust_save", project, trusted: false, trustParent: false })
  expect(call({ op: "trust_status", project }).decision).toBe(false)
  stored = JSON.parse(readFileSync(join(agent, "trust.json"), "utf8"))
  expect(stored[project]).toBe(false)
})

test("Pi native session names roundtrip and automatic names preserve manual names", { skip: !dist }, t => {
  const { root, project, call } = fixture(t)
  const file = join(root, "session.jsonl")
  writeFileSync(
    file,
    [
      { type: "session", version: 3, id: "test", timestamp: new Date().toISOString(), cwd: project },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "hello", timestamp: Date.now() },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: new Date().toISOString(),
        message: { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: Date.now() },
      },
    ]
      .map(v => JSON.stringify(v))
      .join("\n") + "\n",
  )
  expect(call({ op: "session_name", file, title: "Manual" })).toBe("Manual")
  expect(call({ op: "session_name", file, title: "Auto", onlyIfEmpty: true })).toBe("Manual")
  expect(call({ op: "session_name", file })).toBe("Manual")
  const entries = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map(v => JSON.parse(v))
  expect(entries.at(-1).type).toBe("session_info")
  expect(entries.at(-1).name).toBe("Manual")
  expect(existsSync(file.replace(".jsonl", ".pix.json"))).toBe(false)
})

test("Pi exports a saved session file directly without opening a runtime", { skip: !dist }, t => {
  const { root, project, call } = fixture(t)
  const file = join(root, "conversation.jsonl"),
    outputPath = join(root, "chosen.html")
  writeFileSync(
    file,
    [
      { type: "session", version: 3, id: "saved", timestamp: new Date().toISOString(), cwd: project },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: new Date().toISOString(),
        message: { role: "user", content: "offline export marker", timestamp: Date.now() },
      },
    ]
      .map(v => JSON.stringify(v))
      .join("\n") + "\n",
  )
  expect(call({ op: "session_export_html", file, outputPath })).toBe(outputPath)
  expect(readFileSync(outputPath, "utf8").startsWith("<!DOCTYPE html>")).toBeTruthy()
})

test("retry count merges into the global file and invalid patches are rejected", { skip: !dist }, t => {
  const { agent, call } = fixture(t)
  const path = join(agent, "settings.json")
  writeFileSync(path, "{}")
  expect(call({ op: "settings_get" }).retry, "the default comes from Pi").toEqual({ maxRetries: 3 })

  writeFileSync(
    path,
    JSON.stringify({
      theme: "dark",
      retry: { enabled: false, maxRetries: 9, baseDelayMs: 500, provider: { maxRetries: 2 } },
    }),
  )
  call({ op: "settings_save", settings: { retry: { maxRetries: 5 } } })
  let saved = JSON.parse(readFileSync(path, "utf8"))
  expect(saved.retry.maxRetries).toBe(5)
  expect(saved.theme).toBe("dark")
  expect(saved.retry.enabled, "untouched retry keys survive the patch").toBe(false)
  expect(saved.retry.baseDelayMs).toBe(500)
  expect(saved.retry.provider).toEqual({ maxRetries: 2 })
  expect(call({ op: "settings_get" }).retry).toEqual({ maxRetries: 5 })

  for (const retry of [
    { maxRetries: -1 },
    { maxRetries: 1.5 },
    { maxRetries: "5" },
    { enabled: false },
    { baseDelayMs: 1 },
    3,
  ]) {
    call({ op: "settings_save", settings: { retry } }, false)
  }
  saved = JSON.parse(readFileSync(path, "utf8"))
  expect(saved.retry.maxRetries, "invalid patches never reach the file").toBe(5)
  expect(saved.retry.enabled).toBe(false)
})

test("malformed Pi settings and invalid patches fail without replacing the file", { skip: !dist }, t => {
  const { agent, call } = fixture(t)
  const file = join(agent, "settings.json")
  writeFileSync(file, "{broken")
  call({ op: "settings_get" }, false)
  call({ op: "settings_save", settings: { skills: [] } }, false)
  expect(readFileSync(file, "utf8")).toBe("{broken")
  writeFileSync(file, "{}")
  call({ op: "settings_save", settings: { defaultProvider: "p", defaultModel: "m", skills: false } }, false)
  expect(readFileSync(file, "utf8")).toBe("{}")
})
