import { afterEach, expect, test } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const helper = readFileSync(resolve("src-tauri/resources/remote_trust.mjs"), "utf8")
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "pix-trust-test-"))) throw new Error("Unsafe test cleanup")
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture(bundled: boolean) {
  const root = mkdtempSync(join(tmpdir(), "pix-trust-test-"))
  roots.push(root)
  const project = join(root, "parent", "project")
  mkdirSync(project, { recursive: true })
  mkdirSync(join(root, "core"))
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module" }))
  // A deterministic SDK substitute; no installed pi, credentials or model requests.
  const sdk = `
    import { readFileSync, writeFileSync, existsSync } from 'node:fs';
    import { join, dirname } from 'node:path';
    export const getAgentDir = () => ${JSON.stringify(root)};
    export class ProjectTrustStore {
      constructor(dir) { this.file = join(dir, 'trust.json'); }
      read() { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}; }
      get(project) { const data = this.read(); for (let p = project;; p = dirname(p)) {
        if (typeof data[p] === 'boolean') return data[p];
        if (p === dirname(p)) return null;
      } }
      setMany(updates) { const data = this.read(); for (const u of updates) data[u.path] = u.decision;
        writeFileSync(this.file, JSON.stringify(data)); }
    }
    export const hasTrustRequiringProjectResources = () => true;
    export class SettingsManager {
      static create() { return new SettingsManager(); }
      drainErrors() { return []; }
      getDefaultProjectTrust() { return 'ask'; }
    }
  `
  writeFileSync(join(root, "index.js"), sdk)
  writeFileSync(join(root, "config.js"), 'export { getAgentDir } from "./index.js"')
  for (const name of ["trust-manager", "settings-manager"]) {
    writeFileSync(join(root, "core", `${name}.js`), 'export * from "../index.js"')
  }
  const call = (request: Record<string, unknown>) => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", helper, root, ...(bundled ? ["bundle"] : [])],
      {
        input: JSON.stringify({ project, ...request }),
        encoding: "utf8",
        timeout: 10000,
      },
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  return { call, project, root }
}

for (const bundled of [false, true]) {
  test(`remote trust preserves decisions and parent inheritance (bundle=${bundled})`, () => {
    const { call, project, root } = fixture(bundled)
    expect(call({ op: "trust_status" })).toMatchObject({ needsDecision: true, decision: null })
    expect(call({ op: "trust_save", trusted: false })).toMatchObject({ needsDecision: false, decision: false })
    expect(call({ op: "trust_save", trusted: true, trustParent: true })).toMatchObject({
      needsDecision: false,
      decision: true,
    })
    const data = JSON.parse(readFileSync(join(root, "trust.json"), "utf8"))
    expect(data[project]).toBeNull()
    expect(data[join(root, "parent")]).toBe(true)
    expect(call({ op: "trust_save", trusted: false })).toMatchObject({ decision: false })
  })
}
