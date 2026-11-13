// 测量 Rust 后端的冷构建、热构建、单文件增量构建耗时与构建目录占用。
//
// 用法：
//   node scripts/bench-rust.mjs --target-dir ../bench-before [--file src/paths.rs] [--repeats 5]
//   node scripts/bench-rust.mjs --target-dir ../bench-after --skip-cold
//
// 始终使用独立的 target 目录：冷构建才能从零开始，也不会污染日常增量状态。
// 对比优化前后请保持同一台机器、同一工具链；报告开头会打印 cargo/rustc 版本。
// 先跑 --skip-cold 预热一次，再跑正式的冷构建，避免磁盘缓存差异影响冷构建耗时。
//
// 安全约定（冷构建要清空 target 目录，因此先校验、再删除）：
// - 目标路径先规范化：符号链接、Windows junction、8.3 短名都通过 realpath 解析成真实绝对路径，
//   校验与删除都作用在真实路径上，不会顺着链接误删链接之外的内容；
// - 拒绝磁盘根 / UNC 根、仓库根及其所有祖先（含 `--target-dir .`、`..` 的误用）、
//   源码目录及其内部；
// - 只清理「脚本自建或带本脚本标记」的目录：不存在或为空时由脚本创建并写入标记；
//   已存在、非空且无标记的目录一律拒绝，绝不先清空再判断；
// - `--skip-cold`（复用模式）不做任何删除，外来目录只读不写标记。

import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import path from "node:path"
import { performance } from "node:perf_hooks"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const manifest = path.join(repoRoot, "src-tauri", "Cargo.toml")

/** 脚本在自建 target 目录里留下的标记文件；有标记才允许递归删除。 */
export const MARKER_FILE = ".pix-bench-rust-target.json"
const MARKER_BODY = `${JSON.stringify({ tool: "bench-rust", purpose: "disposable cargo target dir" }, null, 2)}\n`

// 不得被 target 覆盖或删除的源码目录（相对仓库根）。这些目录内部一律拒绝使用 target-dir。
const SOURCE_DIRS = [
  ".github",
  "src",
  "tests",
  "e2e",
  "scripts",
  "public",
  "src-tauri/src",
  "src-tauri/tests",
  "src-tauri/capabilities",
  "src-tauri/icons",
  "src-tauri/resources",
  "src-tauri/gen",
]

export class TargetDirUnsafeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "TargetDirUnsafeError"
    this.code = code
  }
}

const normalize = value => {
  const stripped = value.replace(/[\\/]+$/, "")
  return process.platform === "win32" ? stripped.toLowerCase() : stripped
}

/** parent 是否为 child 本身或其祖先。Windows 路径大小写不敏感，两侧都按小写比较。 */
function isAncestorOrSelf(parent, child) {
  const left = path.resolve(parent)
  const right = path.resolve(child)
  if (normalize(left) === normalize(right)) return true
  const relative = path.relative(left, right)
  if (path.isAbsolute(relative)) return false
  return relative.split(path.sep).filter(Boolean)[0] !== ".."
}

function isFileSystemRoot(target) {
  const filesystemRoot = path.parse(path.resolve(target)).root
  return filesystemRoot !== "" && normalize(path.resolve(target)) === normalize(filesystemRoot)
}

/** realpath 解析后的真实路径；路径不存在或不可解析时返回 null（此时没有可删除内容）。 */
export function realPathOf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    // 解析失败（不存在、是磁盘根、权限不足等）：没有可删除的内容。
    // 保护规则已经先按 path.resolve 结果校验过，这里返回 null 不会让未校验路径进入删除流程。
    return null
  }
}

function readMarker(directory) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(directory, MARKER_FILE), "utf8"))
    return typeof parsed === "object" && parsed !== null && parsed.tool === "bench-rust"
  } catch {
    return false
  }
}

function writeMarker(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, MARKER_FILE), MARKER_BODY)
  } catch (error) {
    // 悬空链接、只读挂载等情况下无法建立可丢弃缓存，直接拒绝而不是继续构建。
    throw new TargetDirUnsafeError("not-writable", `无法在 target-dir 写入标记：${directory}（${error.code}）`)
  }
}

/** 路径存在但 realpath 解析不到目标（悬空符号链接/junction）：没有可回收内容，也拒绝当作 target。 */
function isDanglingLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink() && realPathOf(target) === null
  } catch {
    return false
  }
}

/**
 * 校验 target 目录：返回 { requested, real, entries, owned }。
 * requested 是 path.resolve 结果；real 是 realpath 结果（不存在时为 null）。
 * 任一形态（传入路径与其真实路径）违反保护规则就拒绝，避免用链接绕过检查。
 */
export function inspectTargetDir(targetDir, { sourceRoot = repoRoot, allowUnowned = false } = {}) {
  if (typeof targetDir !== "string" || targetDir.trim() === "") {
    throw new TargetDirUnsafeError("invalid", "缺少 --target-dir 路径")
  }
  // 先校验 path.resolve 结果，再校验 realpath 结果：两者任一不合规都拒绝，
  // 这样用链接别名指向受保护路径也绕不过检查。
  const requested = path.resolve(targetDir)
  const sourceDirs = SOURCE_DIRS.map(relative => path.resolve(sourceRoot, relative))
  assertPathAllowed(requested, sourceRoot, sourceDirs)
  if (isDanglingLink(requested)) {
    throw new TargetDirUnsafeError("dangling-link", `target-dir 是悬空的符号链接/junction：${requested}`)
  }

  const real = realPathOf(requested)
  if (real === null) return { requested, real, entries: [], owned: false }
  assertPathAllowed(real, sourceRoot, sourceDirs)
  if (!fs.lstatSync(real).isDirectory()) {
    throw new TargetDirUnsafeError("not-directory", `target-dir 不是目录：${real}`)
  }
  const entries = fs.readdirSync(real)
  const owned = readMarker(real)
  if (!allowUnowned && entries.length > 0 && !owned) {
    throw new TargetDirUnsafeError(
      "unowned",
      `拒绝删除非空且无本脚本标记的目录：${real}（确认是可丢弃缓存后请手动清空，或改用新目录）`,
    )
  }
  return { requested, real, entries, owned }
}

function assertPathAllowed(candidate, sourceRoot, sourceDirs) {
  if (isFileSystemRoot(candidate)) {
    throw new TargetDirUnsafeError("root", `拒绝使用磁盘根目录作为 target-dir：${candidate}`)
  }
  if (isAncestorOrSelf(candidate, sourceRoot)) {
    throw new TargetDirUnsafeError(
      "source",
      `拒绝删除仓库根或其祖先：${candidate}（仓库根 ${path.resolve(sourceRoot)}）`,
    )
  }
  for (const sourceDir of sourceDirs) {
    if (isAncestorOrSelf(sourceDir, candidate) || isAncestorOrSelf(candidate, sourceDir)) {
      throw new TargetDirUnsafeError(
        "source",
        `拒绝在源码目录上或内部使用 target-dir：${candidate}（源码目录 ${sourceDir}）`,
      )
    }
  }
}

/**
 * 冷构建前调用：校验 → 只删除脚本自建/带标记的目录 → 立即重建并写入标记。
 * 返回真正生效的真实路径；返回时该目录必定带标记。
 */
export function resetTargetDir(targetDir, options = {}) {
  const { requested } = inspectTargetDir(targetDir, options)
  // 删除前按路径重新解析：realpath 把符号链接/junction 解析成被指向的真实目录，
  // 因此后续删除只命中真实目录内部，不会顺着链接跑到别的位置。
  const target = realPathOf(requested) ?? requested
  if (target !== requested) {
    // 传入的是链接：只允许清理「链接目标本身」这个已校验过的可丢弃缓存。
    // 只删目标内部条目、不删目标目录，避免把用户的链接变成悬空链接。
    if (!fs.existsSync(target)) {
      writeMarker(target)
      return target
    }
    for (const entry of fs.readdirSync(target)) {
      fs.rmSync(path.join(target, entry), { recursive: true, force: true })
    }
  } else if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true })
  }
  writeMarker(target)
  return realPathOf(target) ?? target
}

/** `--skip-cold`（复用模式）：绝不删除。自建或带标记的目录补写标记，外来目录只读。 */
export function reuseTargetDir(targetDir, options = {}) {
  const { requested, real, entries, owned } = inspectTargetDir(targetDir, { ...options, allowUnowned: true })
  if (real === null) writeMarker(requested)
  else if (owned || entries.length === 0) writeMarker(real)
  return realPathOf(requested) ?? requested
}

export function parseArgs(argv) {
  const options = {
    targetDir: path.join(repoRoot, "..", "bench-rust"),
    file: "src/paths.rs",
    repeats: 5,
    skipCold: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--target-dir") options.targetDir = path.resolve(argv[++index] ?? "")
    else if (arg === "--file") options.file = argv[++index] ?? ""
    else if (arg === "--repeats") options.repeats = Number(argv[++index])
    else if (arg === "--skip-cold") options.skipCold = true
    else throw new Error(`未知参数：${arg}`)
  }
  options.file = path.resolve(repoRoot, "src-tauri", options.file)
  if (!fs.existsSync(options.file)) throw new Error(`找不到要 touch 的文件：${options.file}`)
  if (!Number.isInteger(options.repeats) || options.repeats < 1) throw new Error("--repeats 必须是正整数")
  return options
}

/** 常规中位数：奇数样本取正中，偶数样本取中间两个的平均值。 */
export function median(values) {
  const sorted = values.slice().sort((a, b) => a - b)
  if (sorted.length === 0) throw new Error("样本为空，无法计算中位数")
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function runCapture(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repoRoot, env, shell: false, stdio: ["ignore", "pipe", "pipe"] })
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
      cwd: repoRoot,
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
  let bytes = 0n
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
          // NTFS inode 可能超过 2^53，用 bigint 防止不同 inode 被舍入成同一个键。
          const stat = fs.statSync(target, { bigint: true })
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

const gb = bytes => `${(Number(bytes) / 1024 ** 3).toFixed(2)}G`
const sec = ms => `${(ms / 1000).toFixed(1)}s`

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const target = options.skipCold ? reuseTargetDir(options.targetDir) : resetTargetDir(options.targetDir)
  const env = { ...process.env, CARGO_TERM_COLOR: "never", CARGO_TARGET_DIR: target }
  const lines = [
    `cargo: ${await runCapture("cargo", ["--version"], env)}`,
    `rustc: ${await runCapture("rustc", ["--version"], env)}`,
    `target-dir: ${target}（${options.skipCold ? "复用已有目录，未删除" : "脚本管理，已清空"}）`,
  ]
  if (!options.skipCold) lines.push(`冷构建（清空 target 后 cargo build）：${sec(await runBuild(env))}`)
  lines.push(`热构建（无改动 cargo build）：${sec(await runBuild(env))}`)
  const incremental = []
  for (let index = 0; index < options.repeats; index += 1) {
    const now = new Date()
    fs.utimesSync(options.file, now, now)
    incremental.push(await runBuild(env))
  }
  lines.push(
    `单文件增量（touch ${path.relative(repoRoot, options.file)}，${options.repeats} 次）：` +
      `${incremental.map(sec).join(" / ")}，中位 ${sec(median(incremental))}`,
  )
  const relative = ["debug", "debug/deps", "debug/incremental", "debug/build"]
  const parts = relative.map(sub => {
    const directory = path.join(target, sub)
    return fs.existsSync(directory) ? `${sub} ${gb(dirBytes(directory))}` : `${sub} -`
  })
  lines.push(`构建目录占用：合计 ${gb(dirBytes(target))}（${parts.join("，")}）`)
  console.log(lines.join("\n"))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[bench-rust] ${error.message}`)
    process.exitCode = 1
  })
}
