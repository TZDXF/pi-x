import { test, expect } from "vitest"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import fs from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  TargetDirUnsafeError,
  createSessionTargetDir,
  deleteOwnedDir,
  identityOf,
  inspectTargetDir,
  localizeNamespace,
  median,
  ownedTargetDirs,
  realPathOf,
  resetTargetDir,
  reuseTargetDir,
} from "../scripts/bench-rust.mjs"

const repoRoot = resolve(import.meta.dirname, "..")

/** 一次性夹具：外壳目录 + 伪造仓库，避免碰真实源码。 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "pix-bench-fixture-"))
  const repo = join(base, "repo")
  mkdirSync(join(repo, "src-tauri", "src"), { recursive: true })
  writeFileSync(join(repo, "src-tauri", "src", "paths.rs"), "pub fn eq() {}\n")
  writeFileSync(join(repo, "valuable-source.txt"), "must survive\n")
  return {
    base,
    repo,
    dispose: () => rmSync(base, { recursive: true, force: true }),
  }
}

function expectRejected(target, code, options) {
  try {
    inspectTargetDir(target, options)
  } catch (error) {
    expect(error).toBeInstanceOf(TargetDirUnsafeError)
    expect(error.code).toBe(code)
    return error
  }
  throw new Error(`应拒绝但通过了：${target}`)
}

function expectResetRejected(target, code, options) {
  try {
    resetTargetDir(target, options)
  } catch (error) {
    expect(error).toBeInstanceOf(TargetDirUnsafeError)
    expect(error.code).toBe(code)
    return error
  }
  throw new Error(`应拒绝冷清理但通过了：${target}`)
}

// 需要符号链接能力的用例：创建失败时显式 skip，不静默 return（避免假通过）。
function linkOrSkip(ctx, target, link, type) {
  try {
    symlinkSync(target, link, type)
    return true
  } catch (error) {
    ctx.skip(`symlink unsupported on this platform: ${error.code}`)
    return false
  }
}

const linkType = () => (process.platform === "win32" ? "junction" : "dir")

test("默认冷构建：mkdtemp 唯一目录，登记后可回收，不写任何标记", () => {
  const target = createSessionTargetDir()
  expect(target).toBe(realPathOf(target))
  expect(existsSync(target)).toBe(true)
  expect(ownedTargetDirs()).toContain(target)
  // 目录里不应出现任何标记文件（能力证明方案不依赖标记）。
  expect(fs.readdirSync(target)).toEqual([])
  deleteOwnedDir(target)
  expect(existsSync(target)).toBe(false)
  expect(ownedTargetDirs()).not.toContain(target)
})

test("删除走原子重命名：成功后不留下临时停放目录", () => {
  const target = createSessionTargetDir()
  const parent = dirname(target)
  writeFileSync(join(target, "payload.bin"), "44")
  deleteOwnedDir(target)
  expect(existsSync(target)).toBe(false)
  const leftovers = readdirSync(parent).filter(name => name.includes(".deleting-"))
  expect(leftovers).toEqual([])
})

test("只删除本进程创建的目录：未登记目录一律拒绝", () => {
  const outer = mkdtempSync(join(tmpdir(), "pix-bench-unowned-"))
  try {
    const foreign = join(outer, "foreign")
    mkdirSync(foreign)
    writeFileSync(join(foreign, "keep.txt"), "keep")
    try {
      deleteOwnedDir(foreign)
      throw new Error("应拒绝")
    } catch (error) {
      expect(error).toBeInstanceOf(TargetDirUnsafeError)
      expect(error.code).toBe("unowned")
    }
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("keep")
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test("伪造标记无效：目录里有 tool=bench-rust 的标记也拒绝冷清理", () => {
  const fx = fixture()
  try {
    const directory = join(fx.repo, "src-tauri", "scripts")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "helper.mjs"), "export const helper = 1\n")
    // 审查的复现：在既有源码目录里放最小伪造标记，旧实现会直接删除该目录。
    writeFileSync(join(directory, ".pix-bench-rust-target.json"), '{"tool":"bench-rust"}')
    writeFileSync(join(directory, ".pix-bench-rust-target.json"), '{"tool":"bench-rust","purpose":"important"}')
    expectResetRejected(directory, "source", { repo: fx.repo })
    expect(existsSync(join(directory, "helper.mjs"))).toBe(true)
  } finally {
    fx.dispose()
  }
})

test("伪造标记 + junction 也拒绝：标记不再是任何删除授权", ctx => {
  const fx = fixture()
  try {
    const directory = join(fx.base, "cache-with-fake-marker")
    mkdirSync(directory)
    writeFileSync(join(directory, ".pix-bench-rust-target.json"), '{"tool":"bench-rust"}')
    writeFileSync(join(directory, "helper.mjs"), "export const helper = 1\n")
    expectResetRejected(directory, "unowned", { repo: fx.repo })
    expect(existsSync(join(directory, "helper.mjs"))).toBe(true)

    const link = join(fx.base, "link-to-fake")
    if (!linkOrSkip(ctx, directory, link, linkType())) return
    expectResetRejected(link, "unowned", { repo: fx.repo })
    expect(existsSync(join(directory, "helper.mjs"))).toBe(true)
  } finally {
    fx.dispose()
  }
})

test("拒绝磁盘根与仓库根及其祖先", () => {
  expectRejected(process.platform === "win32" ? "C:\\" : "/", "root")
  expectRejected(repoRoot, "source")
  expectRejected(resolve(repoRoot, ".."), "source")
  expectRejected(resolve(repoRoot, "..", ".."), "source")
})

test("拒绝仓库内部任意路径（不再依赖源码目录白名单）", () => {
  expectRejected(resolve(repoRoot, "src-tauri"), "source")
  expectRejected(resolve(repoRoot, "src-tauri", "src"), "source")
  expectRejected(resolve(repoRoot, "src-tauri", "scripts"), "source")
  expectRejected(resolve(repoRoot, "docs"), "source")
  expectRejected(join(repoRoot, "src-tauri", "target-bench"), "source")
})

test("UNC 别名按统一身份识别，落在仓库内则拒绝", () => {
  const fx = fixture()
  try {
    // 夹具仓库与真实仓库同盘，用本地盘符 + localhost share 两种写法指向它。
    const repoPlain = fx.repo
    const rel = repoPlain.slice(3)
    const unc = `\\\\localhost\\C$\\${rel}`
    const uncExtended = `\\\\?\\UNC\\localhost\\C$\\${rel}`
    expectRejected(unc, "source", { repo: fx.repo })
    expectRejected(uncExtended, "source", { repo: fx.repo })
    // 对照：同一目录的本地写法同样被拒，且三者身份一致。
    expect(identityOf(unc) ?? identityOf(repoPlain)).toBe(identityOf(repoPlain))
  } finally {
    fx.dispose()
  }
})

test("远端 UNC 命名空间无法归一身份时拒绝，而不是猜", () => {
  expectRejected("\\\\otherhost\\share\\target", "namespace")
  expectRejected("\\\\?\\UNC\\otherhost\\share\\target", "namespace")
})

test("命名空间归一：localhost share 映射回盘符路径", () => {
  expect(localizeNamespace("\\\\localhost\\C$\\Users\\x")).toEqual({ path: "C:\\Users\\x", remote: false })
  expect(localizeNamespace("\\\\?\\UNC\\localhost\\C$\\Users\\x")).toEqual({ path: "C:\\Users\\x", remote: false })
  expect(localizeNamespace("\\\\?\\C:\\Users\\x")).toEqual({ path: "C:\\Users\\x", remote: false })
  expect(localizeNamespace("\\\\server\\share\\x").remote).toBe(true)
})

test("删除前身份切换会被拒绝：不删除任何内容（确定性模拟竞态）", () => {
  const outer = mkdtempSync(join(tmpdir(), "pix-bench-race-"))
  try {
    const owned = createSessionTargetDir()
    const victim = join(outer, "victim")
    mkdirSync(victim)
    writeFileSync(join(victim, "paths.rs"), "source\n")
    // 在两次复核之间把登记目录换掉（模拟审查里「校验后再 realpath」的窗口）。
    let error
    try {
      deleteOwnedDir(owned, {
        beforeDelete: directory => {
          rmSync(directory, { recursive: true, force: true })
          try {
            symlinkSync(victim, directory, linkType())
          } catch {
            // 平台上建不了链接时退化为创建一个空目录，同样改变身份。
            mkdirSync(directory, { recursive: true })
          }
        },
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TargetDirUnsafeError)
    expect(["changed", "source"]).toContain(error.code)
    expect(readFileSync(join(victim, "paths.rs"), "utf8").trim()).toBe("source")
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test("reuseTargetDir 纯复用：不删除、不创建、不写标记，目录必须已存在", () => {
  const outer = mkdtempSync(join(tmpdir(), "pix-bench-reuse-"))
  try {
    const existing = join(outer, "existing")
    mkdirSync(existing)
    writeFileSync(join(existing, "artifact.bin"), "reuse")
    const returned = reuseTargetDir(existing)
    expect(returned).toBe(realPathOf(existing))
    expect(readFileSync(join(existing, "artifact.bin"), "utf8")).toBe("reuse")
    expect(fs.readdirSync(existing)).toEqual(["artifact.bin"])

    const missing = join(outer, "missing")
    expect(() => reuseTargetDir(missing)).toThrow(TargetDirUnsafeError)
    expect(existsSync(missing)).toBe(false)
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test("resetTargetDir 只接受不存在 / 空 / 本轮自建；非空外来目录拒绝", () => {
  const outer = mkdtempSync(join(tmpdir(), "pix-bench-reset-"))
  try {
    const missing = join(outer, "new-target")
    const applied = resetTargetDir(missing)
    expect(existsSync(applied)).toBe(true)
    expect(ownedTargetDirs()).toContain(applied)

    const empty = join(outer, "empty")
    mkdirSync(empty)
    expect(resetTargetDir(empty)).toBe(realPathOf(empty))
    expect(fs.readdirSync(empty)).toEqual([])

    const foreign = join(outer, "foreign")
    mkdirSync(foreign)
    writeFileSync(join(foreign, "keep.txt"), "keep")
    expectResetRejected(foreign, "unowned")
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("keep")
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test("普通文件、悬空链接、指向文件的链接均拒绝", ctx => {
  const outer = mkdtempSync(join(tmpdir(), "pix-bench-shape-"))
  try {
    const file = join(outer, "plain.txt")
    writeFileSync(file, "x")
    expectRejected(file, "not-directory")

    const dangling = join(outer, "dangling")
    if (linkOrSkip(ctx, join(outer, "missing-target"), dangling, linkType())) {
      expectRejected(dangling, "dangling-link")
      expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
    }

    const fileLink = join(outer, "file-link")
    if (linkOrSkip(ctx, file, fileLink, "file")) {
      expectRejected(fileLink, "not-directory")
    }
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test("链接指向源码目录：拒绝且源码不受影响", ctx => {
  const outer = mkdtempSync(join(tmpdir(), "pix-bench-srclink-"))
  try {
    const link = join(outer, "to-src")
    if (!linkOrSkip(ctx, resolve(repoRoot, "src-tauri", "src"), link, linkType())) return
    expectRejected(link, "source")
    expect(statSync(resolve(repoRoot, "src-tauri", "src", "paths.rs")).isFile()).toBe(true)
  } finally {
    rmSync(outer, { recursive: true, force: true })
  }
})

test("中位数：奇数取正中，偶数取中间两个的平均值", () => {
  expect(median([19.6, 19.0, 19.3])).toBeCloseTo(19.3)
  expect(median([9.4, 9.2, 9.2, 9.2, 9.3])).toBeCloseTo(9.2)
  expect(median([1, 3])).toBe(2)
  expect(median([1, 2, 3, 4])).toBe(2.5)
  expect(() => median([])).toThrow()
})
