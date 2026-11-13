// 测量 Rust 后端的冷构建、热构建、单文件增量构建耗时与构建目录占用。
//
// 用法：
//   node scripts/bench-rust.mjs                    # 在 mkdtemp 唯一临时目录冷构建，结束即删除
//   node scripts/bench-rust.mjs --keep             # 同上，但保留临时目录（便于事后检查产物）
//   node scripts/bench-rust.mjs --target-dir ../bench-before [--file src/paths.rs] [--repeats 5]
//   node scripts/bench-rust.mjs --target-dir ../bench-after --skip-cold
//
// 清理授权来自「能力证明」而不是「黑名单 + 标记」：
// - 冷清理只删本进程用 mkdtemp / mkdir 创建并登记过的目录。删除前重跑 realpath、比对
//   目录身份（bigint dev+ino）与路径策略，任一项变化即拒绝；因此伪造标记、UNC 别名、
//   校验后再切换链接都不构成删除授权。
// - --target-dir 只在三种情形下允许冷构建：路径不存在（本进程创建并登记）、目录为空
//   （直接使用、不删除）、本就是本进程创建的目录（删除后重建）。其它一律拒绝，提示改用
//   --skip-cold。全程不写任何标记文件。
// - 无论哪种模式，目标都必须不在仓库内部、不是仓库祖先、不是磁盘根、不是无法归一的远端
//   UNC 命名空间，并且取得到可靠身份；取不到身份即拒绝，不猜。
// - --skip-cold 是纯复用：不删除、不创建、不写标记，目录必须已存在。

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

/**
 * 目录身份：bigint `dev:ino`。同一目录经本地盘符、`\\localhost\C$`、`\\?\UNC\`、8.3 短名
 * 等不同命名空间访问时这些值相同，因此它是跨命名空间比对的统一依据。取不到返回 null，
 * 调用方必须据此拒绝删除，而不是猜。
 */
export function identityOf(target) {
  try {
    const stat = fs.statSync(target, { bigint: true })
    return `${stat.dev}:${stat.ino}`
  } catch {
    return null
  }
}

const stripExtendedPrefix = value => value.replace(/^\\\\\?\\UNC\\/i, "\\\\").replace(/^\\\\\?\\/i, "")

/**
 * 把别名命名空间归一到盘符路径，仅用于保护规则比较（删除授权来自登记的身份，不来自路径）：
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

/** 本进程创建并登记的目录（真实路径 → 登记时的身份）。删除授权只来自这张表。 */
const createdThisRun = new Map()

/** 已登记（本进程创建）的目录列表，供自检与测试使用。 */
export function ownedTargetDirs() {
  return [...createdThisRun.keys()]
}

function register(directory) {
  const identity = identityOf(directory)
  if (identity === null) {
    createdThisRun.clear()
    throw new TargetDirUnsafeError("identity", `无法取得目录身份，拒绝把它当作可删除缓存：${directory}`)
  }
  createdThisRun.set(directory, identity)
}

/** 路径策略：磁盘根、远端 UNC、仓库根及其祖先、仓库内部（源码树整体，不依赖名单）。 */
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
 * 校验 target 目录：返回 { requested, real, entries, identity }。
 * real 为 realpath 结果（不存在时为 null，此时 identity 也为 null）。
 */
export function inspectTargetDir(targetDir, { allowMissing = true, repo = repoRoot } = {}) {
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
    if (allowMissing) return { requested, real: null, entries: [], identity: null }
    throw new TargetDirUnsafeError("missing", `复用模式要求 target-dir 已存在：${requested}`)
  }
  assertPathAllowed(real, { repo })
  if (!fs.lstatSync(real).isDirectory()) {
    throw new TargetDirUnsafeError("not-directory", `target-dir 不是目录：${real}`)
  }
  const identity = identityOf(real)
  if (identity === null) {
    throw new TargetDirUnsafeError("identity", `无法取得目录身份，拒绝把它当作可删除缓存：${real}`)
  }
  return { requested, real, entries: fs.readdirSync(real), identity }
}

/** 新建唯一会话目录并登记；删除授权随之建立。 */
export function createSessionTargetDir({ repo = repoRoot, parent = os.tmpdir() } = {}) {
  const created = fs.mkdtempSync(path.join(parent, SESSION_PREFIX))
  const real = realPathOf(created)
  if (real === null) throw new TargetDirUnsafeError("identity", `无法解析新建 target 目录：${created}`)
  assertPathAllowed(real, { repo })
  register(real)
  return real
}

/**
 * 单次删除前复核：realpath 未变、不是符号链接/junction、身份与登记值一致、路径策略通过。
 * 任何一项不满足就拒绝，绝不在不确定状态下删除。
 */
function verifyOwnedDir(directory, recorded, repo) {
  const current = realPathOf(directory)
  if (current !== directory) {
    throw new TargetDirUnsafeError("changed", `删除前路径解析结果变化，拒绝删除：${directory} → ${current}`)
  }
  let stat
  try {
    stat = fs.lstatSync(directory)
  } catch {
    throw new TargetDirUnsafeError("changed", `删除前目录已不可访问，拒绝删除：${directory}`)
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    // 目录被换成符号链接/junction：内容不在本进程创建的范围内，直接拒绝。
    throw new TargetDirUnsafeError("changed", `删除前被替换成符号链接/junction，拒绝删除：${directory}`)
  }
  const identity = identityOf(directory)
  if (identity !== recorded) {
    throw new TargetDirUnsafeError("changed", `删除前目录身份变化，拒绝删除：${directory}（${recorded} → ${identity}）`)
  }
  assertPathAllowed(directory, { repo })
  return identity
}

/**
 * 删除本进程登记过的目录。
 * 流程：复核 → （仅测试用的时序钩子）→ 复核 → 原子重命名到不可预测的非临时名 → 复核身份 → 删除。
 * 重命名之后路径由本次调用临时决定（含随机 nonce），外部无法预先替换，因此"校验后再切换"的
 * 窗口被压到只剩下"rename 前后"这两个原子动作之间，且 rename 后仍会比对 dev+ino。
 * 任何一步不一致都抛出错误并尽量把目录还原回原名，而不是"尽量删掉"。
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
    // 重命名后按新路径重新取身份：与登记值不符说明路径已被换过，还原并拒绝。
    const parkedIdentity = identityOf(parking)
    const parkedIsLink = fs.lstatSync(parking).isSymbolicLink()
    if (parkedIdentity !== recorded || parkedIsLink) {
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

/**
 * 冷构建前调用。无参数时新建会话目录；给了路径时只接受三种情形：
 * 不存在（本进程创建并登记）、目录为空（直接使用、不删除）、本进程本轮已创建（删除后重建）。
 * 其它情况一律拒绝冷清理，并提示改用 --skip-cold。全程不写标记文件。
 */
export function resetTargetDir(targetDir, { repo = repoRoot } = {}) {
  if (targetDir === undefined) return createSessionTargetDir({ repo })

  const { requested, real, entries, identity } = inspectTargetDir(targetDir, { repo })
  if (real === null) {
    try {
      fs.mkdirSync(requested, { recursive: true })
    } catch (error) {
      throw new TargetDirUnsafeError(
        "not-writable",
        `无法创建 target-dir：${requested}（${error.code}）。检查路径是否带未转义的扩展前缀或 UNC 别名。`,
      )
    }
    const created = realPathOf(requested)
    if (created === null) throw new TargetDirUnsafeError("identity", `无法解析新建 target 目录：${requested}`)
    assertPathAllowed(created, { repo })
    register(created)
    return created
  }
  if (createdThisRun.has(real)) {
    deleteOwnedDir(real, { repo })
    fs.mkdirSync(real, { recursive: true })
    register(real)
    return real
  }
  // 空目录：直接使用，不需要也不允许删除。
  if (entries.length === 0) return real
  throw new TargetDirUnsafeError(
    "unowned",
    `拒绝冷清理非本进程创建的目录：${real}（身份 ${identity}）。` +
      "需要干净冷构建时不传 --target-dir，由脚本在临时目录里新建；" +
      "要继续用这个目录请加 --skip-cold；确认目录可丢弃也可以先手动删除。",
  )
}

/** `--skip-cold`：纯复用。不删除、不创建、不写任何标记；目录必须已存在。 */
export function reuseTargetDir(targetDir, { repo = repoRoot } = {}) {
  const { real } = inspectTargetDir(targetDir, { allowMissing: false, repo })
  return real
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
  // 仅会话临时目录在结束时回收；外部 --target-dir 一律保留，供前后对比复用。
  const cleanup = options.targetDir === undefined && !options.keep
  const env = { ...process.env, CARGO_TERM_COLOR: "never", CARGO_TARGET_DIR: target }
  const lines = [
    `cargo: ${await runCapture("cargo", ["--version"], env)}`,
    `rustc: ${await runCapture("rustc", ["--version"], env)}`,
    `target-dir: ${target}（${options.skipCold ? "复用已有目录，未删除" : cleanup ? "本进程新建，结束即删除" : "本次使用，保留"}）`,
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
