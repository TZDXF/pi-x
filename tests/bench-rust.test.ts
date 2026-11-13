import { test, expect } from "vitest"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  MARKER_FILE,
  TargetDirUnsafeError,
  inspectTargetDir,
  median,
  realPathOf,
  resetTargetDir,
  reuseTargetDir,
} from "../scripts/bench-rust.mjs"

const repoRoot = resolve(import.meta.dirname, "..")

function tempDir() {
  return mkdtempSync(join(tmpdir(), "pix-bench-rust-"))
}

function withTempDir(body) {
  const dir = tempDir()
  try {
    return body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
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

test("拒绝磁盘根与 UNC 根", () => {
  expectRejected(process.platform === "win32" ? "C:\\" : "/", "root")
  if (process.platform === "win32") {
    expectRejected("\\\\?\\C:\\", "root")
  }
})

test("拒绝仓库根及其祖先（含 --target-dir . / .. 的误用）", () => {
  expectRejected(repoRoot, "source")
  expectRejected(resolve(repoRoot, ".."), "source")
  expectRejected(resolve(repoRoot, "..", ".."), "source")
})

test("拒绝源码目录本身与其内部", () => {
  expectRejected(resolve(repoRoot, "src-tauri"), "source")
  expectRejected(resolve(repoRoot, "src-tauri", "src"), "source")
  expectRejected(join(repoRoot, "src-tauri", "src", "target-bench"), "source")
})

test("拒绝非空且无标记的目录，且内容保持原样", () =>
  withTempDir(parent => {
    const foreign = join(parent, "valuable-source")
    mkdirSync(foreign)
    const file = join(foreign, "keep.txt")
    writeFileSync(file, "must survive")
    const error = expectRejected(foreign, "unowned")
    expect(error.message).toContain(foreign)
    expect(readFileSync(file, "utf8")).toBe("must survive")
    expect(existsSync(join(foreign, MARKER_FILE))).toBe(false)
  }))

test("拒绝把普通文件当 target-dir", () =>
  withTempDir(parent => {
    const file = join(parent, "not-a-dir")
    writeFileSync(file, "x")
    expectRejected(file, "not-directory")
  }))

test("空目录可使用：清空后写入脚本标记", () =>
  withTempDir(parent => {
    const target = join(parent, "empty-target")
    mkdirSync(target)
    const applied = resetTargetDir(target)
    expect(realPathOf(applied)).not.toBeNull()
    expect(existsSync(join(applied, MARKER_FILE))).toBe(true)
    expect(inspectTargetDir(target).owned).toBe(true)
  }))

test("带标记的目录可清理：只删除该目录内部内容", () =>
  withTempDir(parent => {
    const target = join(parent, "owned-target")
    mkdirSync(target)
    resetTargetDir(target)
    writeFileSync(join(target, "stale-artifact.bin"), "44")
    const sibling = join(parent, "sibling.txt")
    writeFileSync(sibling, "untouched")
    const applied = resetTargetDir(target)
    expect(existsSync(join(applied, "stale-artifact.bin"))).toBe(false)
    expect(existsSync(join(applied, MARKER_FILE))).toBe(true)
    expect(readFileSync(sibling, "utf8")).toBe("untouched")
  }))

test("复用模式不删除任何内容，也不给外来目录写标记", () =>
  withTempDir(parent => {
    const foreign = join(parent, "foreign")
    mkdirSync(foreign)
    const file = join(foreign, "keep.txt")
    writeFileSync(file, "reuse")
    use(foreign)
    expect(readFileSync(file, "utf8")).toBe("reuse")
    expect(existsSync(join(foreign, MARKER_FILE))).toBe(false)
    function use(dir) {
      const applied = reuseTargetDir(dir)
      expect(applied).toBe(realPathOf(foreign))
    }
  }))

test("Windows junction / 符号链接按最终真实路径校验：指向源码的链接被拒绝且不影响源码", () =>
  withTempDir(parent => {
    if (process.platform !== "win32") {
      // POSIX 上需要显式创建符号链接；创建失败（权限受限）时跳过该场景。
      try {
        symlinkSync(resolve(repoRoot, "src-tauri", "src"), join(parent, "link"), "dir")
      } catch {
        return
      }
    } else {
      // Windows 下创建目录 junction；不需要管理员权限（符号链接则需要）。
      symlinkSync(resolve(repoRoot, "src-tauri", "src"), join(parent, "link"), "junction")
    }
    expect(realPathOf(join(parent, "link"))).toBe(realPathOf(resolve(repoRoot, "src-tauri", "src")))
    expectRejected(join(parent, "link"), "source")
  }))

test("链接指向非空外来目录时被拒绝，且不删除链接目标中的文件", () =>
  withTempDir(parent => {
    const data = join(parent, "data")
    mkdirSync(data)
    const file = join(data, "keep.txt")
    writeFileSync(file, "valuable")
    const link = join(parent, "link")
    try {
      symlinkSync(data, link, process.platform === "win32" ? "junction" : "dir")
    } catch {
      return
    }
    expectRejected(link, "unowned")
    expect(readFileSync(file, "utf8")).toBe("valuable")
  }))

test("中位数：奇数取正中，偶数取中间两个的平均值", () => {
  expect(median([19.6, 19.0, 19.3])).toBeCloseTo(19.3)
  expect(median([9.4, 9.2, 9.2, 9.2, 9.3])).toBeCloseTo(9.2)
  expect(median([1, 3])).toBe(2)
  expect(median([1, 2, 3, 4])).toBe(2.5)
  expect(() => median([])).toThrow()
})

test("悬空链接被拒绝，且不删除链接本身", () =>
  withTempDir(parent => {
    const link = join(parent, "dangling")
    symlinkSync(join(parent, "missing-target"), link, process.platform === "win32" ? "junction" : "dir")
    const error = expectRejected(link, "dangling-link")
    // existsSync 跟随链接，悬空链接要用 lstat 确认「链接本身还在」。
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(error.message).toContain("dangling")
  }))

test("指向文件的链接被拒绝为非目录", () =>
  withTempDir(parent => {
    const file = join(parent, "plain.txt")
    writeFileSync(file, "x")
    const link = join(parent, "file-link")
    symlinkSync(file, link, "file")
    expectRejected(link, "not-directory")
  }))

test("链接指向带标记的可丢弃缓存：清理目标内部，链接本身仍然有效", () =>
  withTempDir(parent => {
    const data = join(parent, "cache")
    mkdirSync(data)
    resetTargetDir(data)
    writeFileSync(join(data, "stale.bin"), "44")
    const link = join(parent, "link")
    symlinkSync(data, link, process.platform === "win32" ? "junction" : "dir")
    const applied = resetTargetDir(link)
    expect(applied).toBe(realPathOf(data))
    expect(existsSync(join(data, "stale.bin"))).toBe(false)
    expect(existsSync(join(data, MARKER_FILE))).toBe(true)
    // 删除的是目标目录内部条目，链接自身没有被拆掉，下次仍可复用。
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(link, MARKER_FILE))).toBe(true)
  }))
