import { test, expect } from "vitest"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// scripts/run-with-utf8.mjs 是 `pnpm test` / `pnpm run check` 里 Cargo 的入口：它必须
// 原样透传参数、stdout 与退出码（Windows 上额外把控制台代码页切到 65001）。
const script = fileURLToPath(new URL("../scripts/run-with-utf8.mjs", import.meta.url))

const run = args => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" })

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
