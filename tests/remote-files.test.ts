import { afterEach, expect, test } from "vitest"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const helper = readFileSync(resolve("src-tauri/resources/remote_files.mjs"), "utf8")
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(tmpdir(), "pix-files-test-"))) throw new Error("Unsafe cleanup")
    rmSync(root, { recursive: true, force: true })
  }
})
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "pix-files-test-"))
  roots.push(root)
  const project = join(root, "project ' 中文")
  mkdirSync(project)
  const call = (path: string, op = "preview") => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", helper, "--", JSON.stringify({ project, path, op })],
      { encoding: "utf8", timeout: 10000 },
    )
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout.trim().replace(/^PIX_FILES=/, ""))
  }
  return { root, project, call }
}
test("remote directory listing and text, SVG, image and binary previews", () => {
  const { project, call } = fixture()
  mkdirSync(join(project, "src"))
  writeFileSync(join(project, "src", "文 ' 件.md"), "# Hello 中文")
  writeFileSync(join(project, "icon.svg"), "<svg></svg>")
  writeFileSync(join(project, "image.png"), Buffer.from([137, 80, 78, 71, 0]))
  writeFileSync(join(project, "data.bin"), Buffer.from([0, 1]))
  expect(call("", "list").data[0]).toEqual({ name: "src", path: "src", is_dir: true })
  expect(call("src", "list").data[0].path).toBe("src/文 ' 件.md")
  expect(call("src/文 ' 件.md").data.text).toBe("# Hello 中文")
  expect(call("icon.svg").data.kind).toBe("text")
  expect(call("image.png").data).toMatchObject({ kind: "image", mime: "image/png", data: "iVBORwA=" })
  expect(call("data.bin").data.kind).toBe("binary")
})
test("remote previews enforce size limits and UTF-8 boundaries", () => {
  const { project, call } = fixture()
  writeFileSync(join(project, "big.txt"), "a".repeat(512 * 1024 - 1) + "中文")
  expect(call("big.txt").data).toMatchObject({ truncated: true, text: "a".repeat(512 * 1024 - 1) })
  writeFileSync(join(project, "big.png"), Buffer.alloc(8 * 1024 * 1024 + 1))
  expect(call("big.png").error.code).toBe("previewImageTooLarge")
})
test("remote file access rejects traversal, directories and escaping links", () => {
  const { root, project, call } = fixture()
  mkdirSync(join(root, "outside"))
  writeFileSync(join(root, "outside", "secret.txt"), "secret")
  symlinkSync(join(root, "outside"), join(project, "link"), "junction")
  for (const name of ["../outside/secret.txt", "/etc/passwd", "link/secret.txt", "", "a/../b", "a\\b"])
    expect(call(name).error.code).toBe("previewPathInvalid")
  expect(call("link", "list").error.code).toBe("previewPathInvalid")
  expect(call("", "list").data).toEqual([])
  expect(call("missing").error.code).toBe("previewReadFailed")
})
