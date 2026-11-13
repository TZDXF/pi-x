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
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import {
  TargetDirUnsafeError,
  assertOwnedDirUsable,
  createSessionTargetDir,
  deleteOwnedDir,
  identityOf,
  inspectReusableDir,
  localizeNamespace,
  median,
  ownedTargetDirs,
  parseArgs,
  realPathOf,
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
  return { base, repo, dispose: () => rmSync(base, { recursive: true, force: true }) }
}

function withTempDir(body) {
  const dir = mkdtempSync(join(tmpdir(), "pix-bench-scratch-"))
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function expectRejected(target, code, options) {
  try {
    inspectReusableDir(target, options)
  } catch (error) {
    expect(error).toBeInstanceOf(TargetDirUnsafeError)
    expect(error.code).toBe(code)
    return error
  }
  throw new Error(`应拒绝但通过了：${target}`)
}

// 需要符号链接能力的用例：创建失败时显式 ctx.skip，不静默 return（避免假通过）。
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
  expect(readdirSync(target)).toEqual([])
  deleteOwnedDir(target)
  expect(existsSync(target)).toBe(false)
  expect(ownedTargetDirs()).not.toContain(target)
})

test("R1：mkdtemp 之后立刻被换成 junction → 校验失败、不登记、受害者数据不变", ctx => {
  const victim = mkdtempSync(join(tmpdir(), "pix-bench-victim-"))
  const precious = join(victim, "precious.txt")
  writeFileSync(precious, "must survive\n")
  let createdPath
  let swapped = false
  try {
    let error
    try {
      // 在 mkdtemp 返回、登记之前把目录换成指向受害者的链接，复现 R1 的窗口。
      createSessionTargetDir({
        afterCreate: created => {
          createdPath = created
          rmSync(created, { recursive: true, force: true })
          swapped = linkOrSkip(ctx, victim, created, linkType())
        },
      })
    } catch (caught) {
      error = caught
    }
    if (!swapped) return // ctx.skip 已标记，不产生假通过
    expect(error).toBeInstanceOf(TargetDirUnsafeError)
    expect(["changed", "source"]).toContain(error.code)
    // 未被登记 → 不在删除授权表里。
    expect(ownedTargetDirs()).not.toContain(realPathOf(victim))
    expect(readFileSync(precious, "utf8").trim()).toBe("must survive")
  } finally {
    if (createdPath) rmSync(createdPath, { recursive: true, force: true })
    rmSync(victim, { recursive: true, force: true })
  }
})

test("R1：登记后、首次使用前被换成 junction → 拒绝使用且不删除", ctx => {
  const victim = mkdtempSync(join(tmpdir(), "pix-bench-victim2-"))
  const precious = join(victim, "precious.txt")
  writeFileSync(precious, "must survive\n")
  const target = createSessionTargetDir()
  let swapped = false
  try {
    rmSync(target, { recursive: true, force: true })
    swapped = linkOrSkip(ctx, victim, target, linkType())
    if (!swapped) return
    let error
    try {
      assertOwnedDirUsable(target)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TargetDirUnsafeError)
    expect(error.code).toBe("changed")
    // 脚本不会对这个被换掉的路径执行删除，受害者内容保持原样。
    expect(() => deleteOwnedDir(target)).toThrow(TargetDirUnsafeError)
    expect(readFileSync(precious, "utf8").trim()).toBe("must survive")
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(victim, { recursive: true, force: true })
  }
})

test("R2：冷构建不接受 --target-dir，外部目录没有冷清理代码路径", () => {
  const external = join(tmpdir(), "pix-bench-external-never-created")
  // 冷构建 + 外部目录 → 参数阶段直接拒绝。
  expect(() => parseArgs(["--target-dir", external])).toThrow(/只读复用/)
  // 复用模式不会为不存在的路径创建目录（没有 mkdir 认领窗口）。
  expect(() => reuseTargetDir(external)).toThrow(TargetDirUnsafeError)
  expect(existsSync(external)).toBe(false)
  // 存在的外部目录只读复用，永不进入删除授权表。
  withTempDir(dir => {
    const foreign = join(dir, "foreign")
    mkdirSync(foreign)
    writeFileSync(join(foreign, "keep.txt"), "keep")
    expect(reuseTargetDir(foreign)).toBe(realPathOf(foreign))
    expect(ownedTargetDirs()).not.toContain(realPathOf(foreign))
    expect(() => deleteOwnedDir(realPathOf(foreign))).toThrow(TargetDirUnsafeError)
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("keep")
    expect(readdirSync(foreign)).toEqual(["keep.txt"])
  })
})

test("删除走原子重命名：成功后不留下临时停放目录", () => {
  const target = createSessionTargetDir()
  const parent = dirname(target)
  writeFileSync(join(target, "payload.bin"), "44")
  deleteOwnedDir(target)
  expect(existsSync(target)).toBe(false)
  expect(readdirSync(parent).filter(name => name.includes(".deleting-"))).toEqual([])
})

test("只删除本进程创建的目录：未登记目录一律拒绝", () => {
  withTempDir(outer => {
    const foreign = join(outer, "foreign")
    mkdirSync(foreign)
    writeFileSync(join(foreign, "keep.txt"), "keep")
    expect(() => deleteOwnedDir(foreign)).toThrow(TargetDirUnsafeError)
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("keep")
  })
})

test("伪造标记无效：仓库内既有目录带 tool=bench-rust 标记也拒绝", () => {
  const fx = fixture()
  try {
    const directory = join(fx.repo, "src-tauri", "scripts")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "helper.mjs"), "export const helper = 1\n")
    writeFileSync(join(directory, ".pix-bench-rust-target.json"), '{"tool":"bench-rust","purpose":"important"}')
    expectRejected(directory, "source", { repo: fx.repo })
    expect(existsSync(join(directory, "helper.mjs"))).toBe(true)
  } finally {
    fx.dispose()
  }
})

test("伪造标记 + junction 也拒绝：标记不再是任何删除授权", ctx => {
  const fx = fixture()
  try {
    const directory = join(fx.repo, "src-tauri", "scripts")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, ".pix-bench-rust-target.json"), '{"tool":"bench-rust"}')
    writeFileSync(join(directory, "helper.mjs"), "export const helper = 1\n")
    const link = join(fx.base, "link-to-fake")
    if (!linkOrSkip(ctx, directory, link, linkType())) return
    expectRejected(link, "source", { repo: fx.repo })
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

// 下列断言依赖 Windows 命名空间语义：只有 Windows 的 path.resolve 才把 `\\\\host\\share`
// 当绝对路径，盘符 / 8.3 短名 / localhost share 归一只在 Windows 成立。非 Windows 显式 skip，
// 不静默 return（否则会出现"本地 18 passed、CI 却红"的假通过）。POSIX 等价覆盖见下一个用例。
test("UNC 别名按统一身份识别，落在仓库内则拒绝（仅 Windows 命名空间语义）", ctx => {
  if (process.platform !== "win32") {
    ctx.skip("windows-path-semantics only")
    return
  }
  const fx = fixture()
  try {
    const rel = fx.repo.slice(3)
    expectRejected(`\\\\localhost\\C$\\${rel}`, "source", { repo: fx.repo })
    expectRejected(`\\\\?\\UNC\\localhost\\C$\\${rel}`, "source", { repo: fx.repo })
    expectRejected(`\\\\?\\C:\\${rel}`, "source", { repo: fx.repo })
    expect(identityOf(fx.repo)).toBe(identityOf(`\\\\localhost\\C$\\${rel}`))
  } finally {
    fx.dispose()
  }
})

// POSIX 上的等价正向覆盖：不依赖 UNC 写法，用真实存在的仓库内路径验证 source 拒绝。
test("仓库内真实路径被 source 拒绝（跨平台正向覆盖）", () => {
  expectRejected(resolve(repoRoot, "src-tauri", "src"), "source")
  expectRejected(resolve(repoRoot, "scripts"), "source")
  expectRejected(repoRoot, "source")
})

test("远端 UNC 命名空间无法归一身份时拒绝，而不是猜（仅 Windows 命名空间语义）", ctx => {
  if (process.platform !== "win32") {
    ctx.skip("windows-path-semantics only")
    return
  }
  expectRejected("\\\\otherhost\\share\\target", "namespace")
  expectRejected("\\\\?\\UNC\\otherhost\\share\\target", "namespace")
})

// localizeNamespace 是纯字符串归一，不含平台分支，因此三种平台期望值相同，可跨平台断言。
test("命名空间归一：localhost share 映射回盘符路径", () => {
  expect(localizeNamespace("\\\\localhost\\C$\\Users\\x")).toEqual({ path: "C:\\Users\\x", remote: false })
  expect(localizeNamespace("\\\\?\\UNC\\localhost\\C$\\Users\\x")).toEqual({ path: "C:\\Users\\x", remote: false })
  expect(localizeNamespace("\\\\?\\C:\\Users\\x")).toEqual({ path: "C:\\Users\\x", remote: false })
  expect(localizeNamespace("\\\\server\\share\\x").remote).toBe(true)
})

test("删除前身份切换会被拒绝：不删除任何内容（确定性模拟竞态）", ctx => {
  const victim = mkdtempSync(join(tmpdir(), "pix-bench-racevictim-"))
  const precious = join(victim, "paths.rs")
  writeFileSync(precious, "source\n")
  const owned = createSessionTargetDir()
  try {
    let error
    try {
      deleteOwnedDir(owned, {
        beforeDelete: directory => {
          rmSync(directory, { recursive: true, force: true })
          if (!linkOrSkip(ctx, victim, directory, linkType())) mkdirSync(directory, { recursive: true })
        },
      })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(TargetDirUnsafeError)
    expect(["changed", "source"]).toContain(error.code)
    expect(readFileSync(precious, "utf8").trim()).toBe("source")
  } finally {
    rmSync(owned, { recursive: true, force: true })
    rmSync(victim, { recursive: true, force: true })
  }
})

test("reuseTargetDir 纯复用：不删除、不创建、不写标记，目录必须已存在", () => {
  withTempDir(outer => {
    const existing = join(outer, "existing")
    mkdirSync(existing)
    writeFileSync(join(existing, "artifact.bin"), "reuse")
    expect(reuseTargetDir(existing)).toBe(realPathOf(existing))
    expect(readFileSync(join(existing, "artifact.bin"), "utf8")).toBe("reuse")
    expect(readdirSync(existing)).toEqual(["artifact.bin"])

    const missing = join(outer, "missing")
    expect(() => reuseTargetDir(missing)).toThrow(TargetDirUnsafeError)
    expect(existsSync(missing)).toBe(false)
  })
})

test("普通文件、悬空链接、指向文件的链接均拒绝", ctx => {
  withTempDir(outer => {
    const file = join(outer, "plain.txt")
    writeFileSync(file, "x")
    expectRejected(file, "not-directory")

    const dangling = join(outer, "dangling")
    if (linkOrSkip(ctx, join(outer, "missing-target"), dangling, linkType())) {
      expectRejected(dangling, "dangling-link")
      expect(lstatSync(dangling).isSymbolicLink()).toBe(true)
    }

    const fileLink = join(outer, "file-link")
    if (linkOrSkip(ctx, file, fileLink, "file")) expectRejected(fileLink, "not-directory")
  })
})

test("链接指向源码目录：拒绝且源码不受影响", ctx => {
  withTempDir(outer => {
    const link = join(outer, "to-src")
    if (!linkOrSkip(ctx, resolve(repoRoot, "src-tauri", "src"), link, linkType())) return
    expectRejected(link, "source")
    expect(statSync(resolve(repoRoot, "src-tauri", "src", "paths.rs")).isFile()).toBe(true)
  })
})

test("中位数：奇数取正中，偶数取中间两个的平均值", () => {
  expect(median([19.6, 19.0, 19.3])).toBeCloseTo(19.3)
  expect(median([9.4, 9.2, 9.2, 9.2, 9.3])).toBeCloseTo(9.2)
  expect(median([1, 3])).toBe(2)
  expect(median([1, 2, 3, 4])).toBe(2.5)
  expect(() => median([])).toThrow()
})
