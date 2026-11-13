// 测量 Rust 后端的冷构建、热构建、单文件增量构建耗时与构建目录占用。
//
// 用法：
//   node scripts/bench-rust.mjs --target-dir ../bench-before [--file src/paths.rs] [--repeats 5]
//   node scripts/bench-rust.mjs --target-dir ../bench-after --skip-cold
//
// 始终使用独立的 target 目录：冷构建才能从零开始，也不会污染日常增量状态。
// 对比优化前后请保持同一台机器、同一工具链；报告开头会打印 cargo/rustc 版本。
// 先跑 --skip-cold 预热一次，再跑正式的冷构建，避免磁盘缓存差异影响冷构建耗时。

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"

const root = fileURLToPath(new URL("../", import.meta.url))
const manifest = path.join(root, "src-tauri", "Cargo.toml")

function parseArgs(argv) {
  const options = { targetDir: path.join(root, "..", "bench-rust"), file: "src/paths.rs", repeats: 5, skipCold: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--target-dir") options.targetDir = path.resolve(argv[++index])
    else if (arg === "--file") options.file = argv[++index]
    else if (arg === "--repeats") options.repeats = Number(argv[++index])
    else if (arg === "--skip-cold") options.skipCold = true
    else throw new Error(`未知参数：${arg}`)
  }
  options.file = path.resolve(root, "src-tauri", options.file)
  if (!fs.existsSync(options.file)) throw new Error(`找不到要 touch 的文件：${options.file}`)
  if (!Number.isInteger(options.repeats) || options.repeats < 1) throw new Error("--repeats 必须是正整数")
  return options
}

function runCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, shell: false, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", chunk => (stdout += chunk))
    child.stderr.on("data", chunk => (stderr += chunk))
    child.once("error", reject)
    child.once("exit", code =>
      code === 0 ? resolve(stdout.trim()) : reject(new Error(`${command} 退出 ${code}\n${stderr}`)),
    )
  })
}

function runBuild(env) {
  return new Promise((resolve, reject) => {
    const started = performance.now()
    const child = spawn("cargo", ["build", "--manifest-path", manifest], {
      cwd: root,
      env,
      shell: false,
      stdio: "ignore",
    })
    child.once("error", reject)
    child.once("exit", code =>
      code === 0 ? resolve(performance.now() - started) : reject(new Error(`cargo build 退出 ${code}`)),
    )
  })
}

function dirBytes(directory) {
  let bytes = 0
  const seen = new Set()
  const stack = [directory]
  while (stack.length > 0) {
    const current = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(target)
      else if (entry.isFile()) {
        try {
          // 硬链接的同一 inode 只计一次，避免把 cargo 的硬链接备份重复算进占用。
          const stat = fs.statSync(target)
          const key = `${stat.dev}:${stat.ino}`
          if (seen.has(key)) continue
          seen.add(key)
          bytes += stat.size
        } catch {
          // 构建中被替换的文件跳过，统计只用于量级对比。
        }
      }
    }
  }
  return bytes
}

const gb = bytes => `${(bytes / 1024 ** 3).toFixed(2)}G`
const sec = ms => `${(ms / 1000).toFixed(1)}s`
const median = values => values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)]

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const env = { ...process.env, CARGO_TERM_COLOR: "never", CARGO_TARGET_DIR: options.targetDir }
  const lines = [
    `cargo: ${await runCapture("cargo", ["--version"], env)}`,
    `rustc: ${await runCapture("rustc", ["--version"], env)}`,
    `target-dir: ${options.targetDir}`,
  ]
  if (!options.skipCold) {
    fs.rmSync(options.targetDir, { recursive: true, force: true })
    lines.push(`冷构建（清空 target 后 cargo build）：${sec(await runBuild(env))}`)
  }
  lines.push(`热构建（无改动 cargo build）：${sec(await runBuild(env))}`)
  const incremental = []
  for (let index = 0; index < options.repeats; index += 1) {
    const now = new Date()
    fs.utimesSync(options.file, now, now)
    incremental.push(await runBuild(env))
  }
  lines.push(
    `单文件增量（touch ${path.relative(root, options.file)}，${options.repeats} 次）：` +
      `${incremental.map(sec).join(" / ")}，中位 ${sec(median(incremental))}`,
  )
  const relative = ["debug", "debug/deps", "debug/incremental", "debug/build"]
  const parts = relative.map(sub => {
    const directory = path.join(options.targetDir, sub)
    return fs.existsSync(directory) ? `${sub} ${gb(dirBytes(directory))}` : `${sub} -`
  })
  lines.push(`构建目录占用：合计 ${gb(dirBytes(options.targetDir))}（${parts.join("，")}）`)
  console.log(lines.join("\n"))
}

main().catch(error => {
  console.error(`[bench-rust] ${error.message}`)
  process.exitCode = 1
})
