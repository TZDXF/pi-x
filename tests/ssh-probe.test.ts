import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, test } from "vitest"
import * as vue from "vue"
import { compileTemplate, parse } from "vue/compiler-sfc"
import ts from "typescript"

// 直接渲染真实模板中的测试结果区，覆盖成功、缺少 pi 与失败分支。
for (const [file, state] of [
  ["src/components/CreateProjectDialog.vue", "probeResult"],
  ["src/components/settings/SshSettings.vue", "formProbe"],
]) {
  const source = readFileSync(resolve(file), "utf8")
  const template = parse(source).descriptor.template!.content
  const start = template.indexOf(`<${state === "probeResult" ? "p" : "div"} v-if="${state}"`)
  const tag = state === "probeResult" ? "p" : "div"
  const end = template.indexOf(`</${tag}>`, start) + tag.length + 3
  const compiled = compileTemplate({ source: template.slice(start, end), filename: file, id: "probe-status-test" })
  const code = ts.transpileModule(compiled.code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} as { render: (context: Record<string, unknown>, cache: unknown[]) => vue.VNode } }
  new Function("exports", "require", code)(module.exports, () => vue)

  function render(result: { ok: boolean; piFound: boolean; error?: string }) {
    return module.exports.render(
      { [state]: result, t: (key: string) => key, tBackendError: (error: string) => error, probeLines: () => [] },
      [],
    )
  }

  function text(node: unknown): string {
    if (typeof node === "string") return node
    if (Array.isArray(node)) return node.map(text).join("")
    return vue.isVNode(node) && node.type !== vue.Comment ? text(node.children) : ""
  }

  for (const piFound of [true, false]) {
    test(`${file}: 连接成功只提示连接正常（piFound=${piFound}）`, () => {
      expect(text(render({ ok: true, piFound })).trim()).toBe("ssh.probeOk")
    })
  }

  test(`${file}: 连接失败仍显示实际错误`, () => {
    expect(text(render({ ok: false, piFound: false, error: "connection failed" })).trim()).toBe("connection failed")
  })
}

// 在临时 HOME/PATH 中执行真实探测脚本，不连接 SSH，也不调用已安装的 pi。
const shell = process.platform === "win32" ? "C:/Program Files/Git/bin/sh.exe" : "/bin/sh"
const payload = readFileSync(resolve("src-tauri/src/ssh/payload.rs"), "utf8")
const probeScript = payload.match(/pub const PROBE_SCRIPT: &str = r#"([\s\S]*?)"#;/)![1]
function shellPath(path: string): string {
  const slashed = path.replace(/\\/g, "/")
  return process.platform === "win32"
    ? slashed.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`)
    : slashed
}
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "pix-probe-test-"))) throw new Error("Unsafe test cleanup")
    rmSync(root, { recursive: true, force: true })
  }
})

for (const [pathPi, deployedPi] of [
  [true, false],
  [false, true],
  [true, true],
  [false, false],
]) {
  test.skipIf(!existsSync(shell))(`探测 pi：PATH=${pathPi}, PiX 部署=${deployedPi}`, () => {
    const root = mkdtempSync(join(tmpdir(), "pix-probe-test-"))
    roots.push(root)
    const bin = join(root, "bin")
    const deployedBin = join(root, ".pix", "pi", "bin")
    mkdirSync(bin)
    mkdirSync(deployedBin, { recursive: true })
    for (const [enabled, dir, version] of [
      [pathPi, bin, "path-pi"],
      [deployedPi, deployedBin, "1.0.2"],
    ] as const) {
      if (!enabled) continue
      const file = join(dir, "pi")
      writeFileSync(file, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
      chmodSync(file, 0o755)
    }
    const result = spawnSync(
      shell,
      [
        "-c",
        `
      HOME=$1
      PATH="$HOME/bin"
      uname() { printf '%s\\n' Linux; }
      node() { printf '%s\\n' v22.0.0; }
      head() { IFS= read -r line; printf '%s\\n' "$line"; }
      ${probeScript}
    `,
        "probe-test",
        shellPath(root),
      ],
      { encoding: "utf8", timeout: 10000 },
    )
    expect(result.status, result.stderr).toBe(0)
    const expectedBin = pathPi ? join(bin, "pi") : deployedPi ? join(deployedBin, "pi") : ""
    expect(result.stdout).toContain(`PI_BIN=${shellPath(expectedBin)}\n`)
    if (pathPi || deployedPi) expect(result.stdout).toContain(`PI_V=${pathPi ? "path-pi" : "1.0.2"}\n`)
    else expect(result.stdout).not.toContain("PI_V=")
    expect(result.stdout).toContain("PIX_PROBE_DONE")
  })
}
