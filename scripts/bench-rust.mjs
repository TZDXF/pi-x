// 测量 Rust 后端的冷构建、热构建、单文件增量构建耗时与构建目录占用。
//
// 用法：
//   node scripts/bench-rust.mjs                    # 冷构建：本进程 mkdtemp 新建唯一目录，结束即删除
//   node scripts/bench-rust.mjs --keep             # 同上，但保留临时目录（便于事后检查产物）
//   node scripts/bench-rust.mjs --target-dir ../bench-out --skip-cold   # 只读复用已有产物
//   pnpm run bench:rust -- --repeats 5 --file src/paths.rs
//
// 删除授权来自「能力证明」，而且只有一种来源：
// - 脚本只在两种时机创建一个目录：本进程 `mkdtemp`（随机名）。该目录在创建后立刻用 `lstat`
//   确认「是目录、不是符号链接/junction」，同一笔 stat 的 bigint `dev`+`ino` 就是登记身份，
//   登记不再走 realpath；登记与首次使用之间再做一次身份比对，不一致就放弃并拒绝删除。
// - 删除前先复核（路径未变、非链接、身份一致、路径策略通过），再把目录原子重命名到带
//   `randomUUID()` 的私有临时名，按新路径复核同一身份后才 `rmSync`。
// - 外部目录（`--target-dir`）没有冷清理能力：它只能配合 `--skip-cold` 只读复用，脚本对它
//   不删除、不创建、不写入任何东西，也从不登记为可删对象。冷构建不接受 `--target-dir`。
// - 被复用目录仍做保护规则校验：不在仓库内部、不是仓库祖先、不是磁盘根、不是无法归一的
//   远端 UNC 命名空间（`\\localhost\C$`、`\\?\UNC\`、`\\?\C:\`、8.3 短名先归一再比较）。

import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { performance } from "node:perf_hooks"

const repoRoot = fileURLToPath(new URL("../", import.meta.url))
const manifest = path.join(repoRoot, "src-tauri", "Cargo.toml")
const SESSION_PREFIX = "pix-bench-rust-"

export class TargetDirUnsafeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = "TargetDirUnsafeError"
    this.code = code
  }
}

/** realpath 解析后的真实路径；解析失败返回 null（没有可作为删除对象的内容）。 */
export function realPathOf(target) {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return null
  }
}

/** 跟随链接取身份（`dev`+`ino`，bigint）：跨命名空间比对的统一依据。取不到返回 null。 */
export function identityOf(target) {
  try {
    const stat = fs.statSync(target, { bigint: true })
    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}

/**
 * 不跟随链接取身份：目录被换成符号链接/junction 时返回 null，调用方必须据此拒绝。
 * 这个 `lstat` 也是「创建即核对」的那一笔 stat，登记身份直接取自它，避免 realpath 与 stat
 * 之间再出现窗口。
 */
function ownedIdentityOf(directory) {
  try {
    const stat = fs.lstatSync(directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null
    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}

const stripExtendedPrefix = value => value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "")

/**
 * 把别名命名空间归一到盘符路径，仅用于保护规则比较：
 * - `\\?\UNC\localhost\C$\...`、`\\?\C:\...` 先剥掉扩展长度前缀；
 * - `\\localhost\C$\...`、`\\127.0.0.1\C$\...`、`\\.\C$\...` 映射回 `C:\...`；
 * - 其它远端 UNC（`\\host\share\...`）无法确定归属，返回 remote=true，调用方必须拒绝。
 */
export function localizeNamespace(value) {
  const stripped = stripExtendedPrefix(value)
  const localShare = stripped.match(/^\\\\(?:localhost|127\.0\.0\.1|\.)\\([A-Za-z])(?:\$)?(?:[\\/](.*))?$/i)
  if (localShare) {
    const rest = (localShare[2] ?? "").replace(/[\\/]+/g, "\\").replace(/^\\+/, "")
    return { path: `${localShare[1].toUpperCase()}:\\${rest}`, remote: false }
  }
  if (/^\\\\/.test(stripped)) return { path: stripped, remote: true }
  return { path: stripped, remote: false }
}

const normalizePath = value => {
  const stripped = value.replace(/[\\/]+$/, "")
  return process.platform === "win32" ? stripped.toLowerCase() : stripped
}

function isAncestorOrSelf(parent, child) {
  const left = path.resolve(parent)
  const right = path.resolve(child)
  if (normalizePath(left) === normalizePath(right)) return true
  const relative = path.relative(left, right)
  if (path.isAbsolute(relative)) return false
  return relative.split(path.sep).filter(Boolean)[0] !== ".."
}

function isFileSystemRoot(target) {
  const filesystemRoot = path.parse(path.resolve(target)).root
  return filesystemRoot !== "" && normalizePath(path.resolve(target)) === normalizePath(filesystemRoot)
}

/** 本进程创建并登记的目录：真实路径 → 创建时那一笔 lstat 得到的身份。删除授权只来自这里。 */
const createdThisRun = new Map()

/** 已登记（本进程创建）的目录列表，供自检与测试使用。 */
export function ownedTargetDirs() {
  return [...createdThisRun.keys()]
}

/** 路径策略：磁盘根、远端 UNC、仓库根及其祖先、仓库内部（整棵源码树，不依赖名单）。 */
function assertPathAllowed(candidate, { repo = repoRoot } = {}) {
  const localized = localizeNamespace(candidate)
  if (localized.remote) {
    throw new TargetDirUnsafeError("namespace", `无法确定远端 UNC 路径的真实归属，拒绝使用：${candidate}`)
  }
  if (isFileSystemRoot(localized.path)) {
    throw new TargetDirUnsafeError("root", `拒绝使用磁盘根目录作为 target-dir：${candidate}`)
  }
  const root = path.resolve(repo)
  if (isAncestorOrSelf(localized.path, root)) {
    throw new TargetDirUnsafeError("source", `拒绝使用仓库根或其祖先作为 target-dir：${candidate}（仓库根 ${root}）`)
  }
  if (isAncestorOrSelf(root, localized.path)) {
    throw new TargetDirUnsafeError("source", `拒绝在仓库内部使用 target-dir：${candidate}（仓库根 ${root}）`)
  }
}

function isDanglingLink(target) {
  try {
    return fs.lstatSync(target).isSymbolicLink() && realPathOf(target) === null
  } catch {
    return false
  }
}

/**
 * 校验一个**已存在**的外部目录能否被只读复用：返回 { requested, real, entries, identity }。
 * 只做读取与校验，绝不创建、删除或写入。
 */
export function inspectReusableDir(targetDir, { repo = repoRoot } = {}) {
  if (typeof targetDir !== "string" || targetDir.trim() === "") {
    throw new TargetDirUnsafeError("invalid", "缺少 --target-dir 路径")
  }
  const requested = path.resolve(targetDir)
  assertPathAllowed(requested, { repo })
  if (isDanglingLink(requested)) {
    throw new TargetDirUnsafeError("dangling-link", `target-dir 是悬空的符号链接/junction：${requested}`)
  }
  const real = realPathOf(requested)
  if (real === null) {
    throw new TargetDirUnsafeError("missing", `复用模式要求 target-dir 已存在：${requested}`)
  }
  assertPathAllowed(real, { repo })
  if (!fs.lstatSync(real).isDirectory()) {
    throw new TargetDirUnsafeError("not-directory", `target-dir 不是目录：${real}`)
  }
  const identity = identityOf(real)
  if (identity === null) {
    throw new TargetDirUnsafeError("identity", `无法取得目录身份：${real}`)
  }
  return { requested, real, entries: fs.readdirSync(real), identity }
}

/** `--skip-cold`：外部目录只读复用。不删除、不创建、不写标记、不登记。 */
export function reuseTargetDir(targetDir, { repo = repoRoot } = {}) {
  return inspectReusableDir(targetDir, { repo }).real
}

/**
 * 冷构建唯一入口：`mkdtemp` 新建随机名目录，创建后立刻用同一笔 `lstat` 完成
 * 「是目录、不是链接、取到身份」三件事并登记，不再走 realpath，避免「mkdtemp → realpath →
 * register」之间被换成 junction 记到受害者路径。
 * `afterCreate` 仅供测试在该窗口内确定性模拟换向，生产调用不传。
 */
export function createSessionTargetDir({ repo = repoRoot, parent = os.tmpdir(), afterCreate } = {}) {
  const created = fs.mkdtempSync(path.join(parent, SESSION_PREFIX))
  if (afterCreate) afterCreate(created)
  const identity = ownedIdentityOf(created)
  if (identity === null) {
    // 已被换成链接/非目录：只摘掉重解析点本身（unlink 不会进入链接目标），绝不递归删除。
    try {
      if (fs.lstatSync(created).isSymbolicLink()) fs.unlinkSync(created)
    } catch {
      // 清理失败不影响结论：这里本来就不允许删除。
    }
    throw new TargetDirUnsafeError(
      "changed",
      `新建 target 目录在创建后立即校验失败（已被替换成链接或非目录），放弃使用：${created}`,
    )
  }
  try {
    assertPathAllowed(created, { repo })
  } catch (error) {
    fs.rmSync(created, { recursive: true, force: true })
    throw error
  }
  createdThisRun.set(created, identity)
  return created
}

/**
 * 登记与首次使用之间的身份复核：路径不变、非链接、身份仍是登记值。
 * 不一致即拒绝（调用方随之放弃删除），把授权证明里剩下的窗口关掉。
 */
export function assertOwnedDirUsable(directory, { repo = repoRoot } = {}) {
  const recorded = createdThisRun.get(directory)
  if (recorded === undefined) {
    throw new TargetDirUnsafeError("unowned", `目录未在本轮登记，不能用作冷构建 target：${directory}`)
  }
  const current = ownedIdentityOf(directory)
  if (current !== recorded) {
    throw new TargetDirUnsafeError(
      "changed",
      `首次使用前目录身份变化，放弃使用：${directory}（${recorded} → ${current}）`,
    )
  }
  assertPathAllowed(directory, { repo })
  return directory
}

/**
 * 单次删除前复核：路径未变、不是符号链接/junction、身份与登记值一致、路径策略通过。
 * 任何一项不满足就拒绝，绝不在不确定状态下删除。
 */
function verifyOwnedDir(directory, recorded, repo) {
  if (realPathOf(directory) !== directory) {
    throw new TargetDirUnsafeError("changed", `删除前路径解析结果变化，拒绝删除：${directory}`)
  }
  const current = ownedIdentityOf(directory)
  if (current !== recorded) {
    throw new TargetDirUnsafeError(
      "changed",
      `删除前目录身份变化或被替换成链接，拒绝删除：${directory}（${recorded} → ${current}）`,
    )
  }
  assertPathAllowed(directory, { repo })
}

/**
 * 删除本进程登记过的目录。
 * 流程：复核 → （仅测试用的时序钩子）→ 复核 → 原子重命名到带随机 nonce 的私有临时名 →
 * 复核同一身份 → 删除。重命名之后路径由本次调用独占，外部无法预先替换。
 * 任何一步不一致都抛出错误（并尽量还原），而不是"尽量删掉"。
 * `beforeDelete` 仅供测试确定性模拟竞态时序，生产调用不传。
 */
export function deleteOwnedDir(directory, { repo = repoRoot, beforeDelete } = {}) {
  const recorded = createdThisRun.get(directory)
  if (recorded === undefined) {
    throw new TargetDirUnsafeError("unowned", `拒绝删除非本进程创建的目录：${directory}`)
  }
  verifyOwnedDir(directory, recorded, repo)
  if (beforeDelete) beforeDelete(directory)
  verifyOwnedDir(directory, recorded, repo)

  const parking = `${directory}.deleting-${randomUUID()}`
  try {
    fs.renameSync(directory, parking)
  } catch (error) {
    throw new TargetDirUnsafeError("changed", `无法原子重命名待删目录，拒绝删除：${directory}（${error.code}）`)
  }
  try {
    const parkedIdentity = ownedIdentityOf(parking)
    if (parkedIdentity !== recorded) {
      fs.renameSync(parking, directory)
      throw new TargetDirUnsafeError(
        "changed",
        `重命名后发现目录身份不一致，已还原并拒绝删除：${directory}（${recorded} → ${parkedIdentity}）`,
      )
    }
    fs.rmSync(parking, { recursive: true, force: true })
  } finally {
    createdThisRun.delete(directory)
  }
  if (fs.existsSync(directory) || fs.existsSync(parking) || realPathOf(directory) !== null) {
    throw new TargetDirUnsafeError("changed", `删除后仍存在残留，请检查权限：${directory}`)
  }
}

export function parseArgs(argv) {
  const options = { targetDir: undefined, file: "src/paths.rs", repeats: 5, skipCold: false, keep: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--target-dir") options.targetDir = path.resolve(argv[++index] ?? "")
    else if (arg === "--file") options.file = argv[++index] ?? ""
    else if (arg === "--repeats") options.repeats = Number(argv[++index])
    else if (arg === "--skip-cold") options.skipCold = true
    else if (arg === "--keep") options.keep = true
    else throw new Error(`未知参数：${arg}`)
  }
  options.file = path.resolve(repoRoot, "src-tauri", options.file)
  if (!fs.existsSync(options.file)) throw new Error(`找不到要 touch 的文件：${options.file}`)
  if (!Number.isInteger(options.repeats) || options.repeats < 1) throw new Error("--repeats 必须是正整数")
  if (options.skipCold && options.targetDir === undefined) {
    throw new Error("--skip-cold 需要配合 --target-dir 指定要复用的目录")
  }
  if (!options.skipCold && options.targetDir !== undefined) {
    throw new Error(
      "冷构建只在脚本自己 mkdtemp 出来的目录里进行，不接受 --target-dir；" +
        "外部目录只读复用，请用 --target-dir <目录> --skip-cold",
    )
  }
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
  // 冷构建只在本进程新建的目录里跑；外部目录仅只读复用。
  const target = options.skipCold ? reuseTargetDir(options.targetDir) : assertOwnedDirUsable(createSessionTargetDir())
  const cleanup = !options.skipCold && !options.keep
  const mode = options.skipCold
    ? "复用已有目录，未删除"
    : cleanup
      ? "本进程 mkdtemp 新建，结束即删除"
      : "本进程新建，--keep 保留"
  const env = { ...process.env, CARGO_TERM_COLOR: "never", CARGO_TARGET_DIR: target }
  const lines = [
    `cargo: ${await runCapture("cargo", ["--version"], env)}`,
    `rustc: ${await runCapture("rustc", ["--version"], env)}`,
    `target-dir: ${target}（${mode}）`,
  ]
  try {
    if (!options.skipCold) lines.push(`冷构建（空 target 后 cargo build）：${sec(await runBuild(env))}`)
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
  } finally {
    if (cleanup) deleteOwnedDir(target)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[bench-rust] ${error.message}`)
    process.exitCode = 1
  })
}
