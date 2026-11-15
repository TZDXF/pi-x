import { test, expect, onTestFinished } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// scripts/run-with-utf8.mjs 是 `pnpm test` / `pnpm run check` 里 Cargo 的入口：它必须
// 原样透传参数、stdout 与退出码，Windows 上还要在子命令运行期间把控制台代码页切到
// 65001 并在结束后恢复。
const script = fileURLToPath(new URL("../scripts/run-with-utf8.mjs", import.meta.url))
const isWindows = process.platform === "win32"

const run = (args, options = {}) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", ...options })

// 一个把 argv 原样打印出来的 .cmd 包装：用来验证 cmd 回退路径不会拆坏参数。
function temporaryDirectory() {
  const root = mkdtempSync(join(tmpdir(), "pix-utf8-test-"))
  onTestFinished(() => {
    const target = realpathSync(root)
    expect(dirname(target)).toBe(realpathSync(tmpdir()))
    expect(basename(target).startsWith("pix-utf8-test-")).toBeTruthy()
    rmSync(target, { recursive: true, force: true })
  })
  return root
}

function cmdWrapper() {
  const root = temporaryDirectory()
  const echo = join(root, "echo-argv.js")
  writeFileSync(echo, "process.stdout.write(JSON.stringify(process.argv.slice(2)))\n", "utf8")
  const wrapper = join(root, "echo-argv.cmd")
  writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "%~dp0echo-argv.js" %*\r\n`, "utf8")
  return wrapper
}

test("透传子命令的标准输出", () => {
  const result = run([process.execPath, "-e", "process.stdout.write('hello')"])
  expect(result.status).toBe(0)
  expect(result.stdout).toBe("hello")
})

test("透传子命令的退出码", () => {
  expect(run([process.execPath, "-e", "process.exit(3)"]).status).toBe(3)
})

test("缺少参数时以用法错误退出", () => {
  expect(run([]).status).toBe(2)
})

test("直接运行可执行文件时逐字透传参数数组", () => {
  const args = ["a b", "", 'a"b', "--manifest-path", "a&b", "%PATH%"]
  const result = run([
    process.execPath,
    "-e",
    "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
    "--",
    ...args,
  ])
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual(args)
})

test.runIf(isWindows)(".cmd 回退路径不拆坏参数", () => {
  const wrapper = cmdWrapper()
  // 空参数、含空格、含引号、以及真实 Cargo 会遇到的形态必须逐字送达。
  for (const args of [
    ["", "plain"],
    ["a b", "c"],
    ['he said "hi"', "c"],
    ["a&b", "a|b", "a^b", "a<b", "a>b", "a(b)", "%PATH%", "!PATH!"],
    ["--manifest-path", "src-tauri/Cargo.toml"],
  ]) {
    const result = run([wrapper, ...args])
    expect(result.status, `argv ${JSON.stringify(args)}`).toBe(0)
    expect(JSON.parse(result.stdout), `argv ${JSON.stringify(args)}`).toEqual(args)
  }
})

test.runIf(isWindows)("子命令运行期间代码页为 65001，结束后恢复", () => {
  const readCodePage = () => {
    const result = spawnSync(`${process.env.SystemRoot}\\System32\\chcp.com`, [], { encoding: "latin1" })
    return Number(result.stdout.match(/(\d{3,5})\s*$/)[1])
  }
  const before = readCodePage()
  // 子进程把运行期间读到的代码页打印出来：脚本切换过就对不上父进程的值。
  const probe = "process.stdout.write(require('node:child_process').execSync('chcp', { encoding: 'latin1' }))"
  const result = run([process.execPath, "-e", probe])
  expect(result.status).toBe(0)
  if (before !== 65001) expect(result.stdout).toContain("65001")
  expect(readCodePage()).toBe(before)
})

for (const failure of ["read", "set", "restore"]) {
  test.runIf(isWindows)(`代码页 ${failure} 失败时警告并保留子命令输出与退出码`, () => {
    const hook = join(temporaryDirectory(), "chcp-failure.mjs")
    // 只替换 chcp 的返回值，真正执行受测脚本与子命令；不改变测试终端的代码页。
    writeFileSync(
      hook,
      `import cp from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
const original = cp.spawnSync
const failure = ${JSON.stringify(failure)}
cp.spawnSync = (command, args, options) => {
  if (!command.toLowerCase().endsWith("chcp.com")) return original(command, args, options)
  if (args.length === 0) {
    return failure === "read"
      ? { status: 1, stdout: Buffer.alloc(0) }
      : { status: 0, stdout: Buffer.from("Active code page: 936\\r\\n") }
  }
  const failed = (failure === "set" && args[0] === "65001") ||
    (failure === "restore" && args[0] === "936")
  return { status: failed ? 1 : 0 }
}
syncBuiltinESMExports()
`,
      "utf8",
    )
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        pathToFileURL(hook).href,
        script,
        process.execPath,
        "-e",
        "process.stdout.write('continued'); process.exit(7)",
      ],
      { encoding: "utf8" },
    )
    expect(result.status).toBe(7)
    expect(result.stdout).toBe("continued")
    expect(result.stderr).toContain("[run-with-utf8]")
  })
}
