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
  const call = (path: string, op = "preview", extra: Record<string, number> = {}) => {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", helper, "--", JSON.stringify({ project, path, op, ...extra })],
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

// TZD-137：远端 CSV 表格预览必须与本地 Rust 侧同语义——同一套引号/换行规则、
// 同一套 offset/limit 分页、同一份列数与截断标志。
test("remote csv pages follow the local parser and page contract", () => {
  const { project, call } = fixture()
  const crlf = String.fromCharCode(13)
  const lf = String.fromCharCode(10)
  const tab = String.fromCharCode(9)
  const csv = ["id,note", '1,"a, b"', '2,"say ""hi"""', '3,"line one', 'line two"', ""].join(crlf + lf)
  writeFileSync(join(project, "table.csv"), csv)
  writeFileSync(join(project, "wide.tsv"), ["a" + tab + "b" + tab + "c", "1" + tab + "2" + tab + "3", ""].join(lf))

  expect(call("table.csv", "csv", { offset: 0, limit: 10 }).data).toMatchObject({
    offset: 0,
    header: ["id", "note"],
    rows: [
      ["1", "a, b"],
      ["2", 'say "hi"'],
      ["3", "line one" + lf + "line two"],
    ],
    totalRows: 3,
    columnCount: 2,
    more: false,
    delimiter: ",",
  })
  // 翻页：只回请求窗口，后续页不再统计总数（少一遍全文扫描）。
  expect(call("table.csv", "csv", { offset: 1, limit: 1 }).data).toMatchObject({
    offset: 1,
    rows: [["2", 'say "hi"']],
    more: true,
    totalRows: null,
  })
  expect(call("wide.tsv", "csv").data).toMatchObject({ header: ["a", "b", "c"], delimiter: "\\t" })
  expect(call("table.csv", "csv", { offset: 0, limit: 1000 }).data.rows).toHaveLength(3)
  expect(call("../table.csv", "csv").error.code).toBe("previewPathInvalid")
})

// TZD-137 复验 P2：本地 Rust 与远端 Node 必须逐项同口径。这里直接比对两份
// 实现里的契约常量与关键行为，任一单边漂移都会让本用例失败。
test("local Rust and remote Node enforce the same csv contract", () => {
  const rust = readFileSync(resolve("src-tauri/src/csv_preview.rs"), "utf8")
  const node = readFileSync(resolve("src-tauri/resources/remote_files.mjs"), "utf8")
  const rustConst = (name: string) => {
    const match = new RegExp(`pub const ${name}: [^=]+ = ([^;]+);`).exec(rust)
    return match?.[1].trim()
  }
  const nodeConst = (name: string) => {
    const match = new RegExp(`const ${name} = ([^\n]+)`).exec(node)
    return match?.[1].trim()
  }
  const pairs: [string, string][] = [
    ["CSV_PAGE_MAX_ROWS", "CSV_PAGE_MAX_ROWS"],
    ["CSV_PAGE_DEFAULT_ROWS", "CSV_PAGE_DEFAULT_ROWS"],
    ["CSV_MAX_COLUMNS", "CSV_MAX_COLUMNS"],
    ["CSV_CELL_MAX_CHARS", "CSV_CELL_MAX_CHARS"],
    ["CSV_MAX_FILE_BYTES", "CSV_MAX_FILE_BYTES"],
    ["CSV_PAGE_MAX_BYTES", "CSV_PAGE_MAX_BYTES"],
  ]
  for (const [rustName, nodeName] of pairs) {
    const rustValue = rustConst(rustName)
    const nodeValue = nodeConst(nodeName)
    expect(rustValue, `missing ${rustName}`).toBeTruthy()
    expect(nodeValue, `missing ${nodeName}`).toBeTruthy()
    // `1024 * 1024` / `8 * 1024` 这类表达式原样比较即可：两边写法必须一致。
    expect(nodeValue!.replace(/\s+/g, "")).toBe(rustValue!.replace(/\s+/g, ""))
  }
  // 平票优先级：逗号 → 制表符 → 分号（两边的候选顺序一致，只是写法不同）。
  const rustCandidates = /const CANDIDATES: \[u8; 3\] = \[([^\]]+)\];/.exec(rust)?.[1]
  expect(rustCandidates, "missing Rust CANDIDATES").toBeTruthy()
  expect(rustCandidates!.replace(/\s+/g, "")).toBe("b',',b'\\t',b';'")
  expect(node).toContain("const CANDIDATES = [44, 9, 59]")
})

// 复验 P2：BOM + 引号表头、平票分隔符、恰好 4096 个 4 字节字符、limit=0 的默认值。
test("remote csv matches the local parser on the reported divergences", () => {
  const { project, call } = fixture()
  const lf = String.fromCharCode(10)
  const bom = String.fromCharCode(0xfeff)
  writeFileSync(join(project, "bom.csv"), `${bom}"id",note${lf}1,2${lf}`)
  writeFileSync(join(project, "tie.csv"), `a,b;c${lf}1,2${lf}`)
  const emoji = "😀".repeat(4096)
  writeFileSync(join(project, "emoji.csv"), `id,text${lf}1,${emoji}${lf}`)
  writeFileSync(join(project, "many.csv"), `${lf}`.repeat(0) + ["id", ...Array(600).fill("row")].join(lf) + lf)

  expect(call("bom.csv", "csv").data.header).toEqual(["id", "note"])
  expect(call("tie.csv", "csv").data.delimiter).toBe(",")
  const emojiPage = call("emoji.csv", "csv").data
  expect(Array.from(emojiPage.rows[0][1])).toHaveLength(4096)
  expect(emojiPage.truncatedCells).toBe(false)
  const zeroLimit = call("many.csv", "csv", { offset: 0, limit: 0 }).data
  expect(zeroLimit.rows).toHaveLength(200)
})

// 复验 P1：一页的序列化字节必须有界，且下一段 offset 不跳行。
test("remote csv slices stay inside the byte budget without skipping rows", () => {
  const { project, call } = fixture()
  const lf = String.fromCharCode(10)
  const columns = 128
  const cell = "x".repeat(4096)
  const header = Array.from({ length: columns }, (_, index) => `c${index}`).join(",")
  const cells = Array.from({ length: columns - 1 }, () => cell).join(",")
  const lines = [header]
  for (let row = 0; row < 40; row++) lines.push(`${row},${cells}`)
  writeFileSync(join(project, "wide.csv"), lines.join(lf) + lf)

  const first = call("wide.csv", "csv", { offset: 0, limit: 500 }).data
  expect(first.budgetTruncated).toBe(true)
  expect(first.more).toBe(true)
  expect(first.rows.length).toBeLessThan(40)
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(1024 * 1024 + 64 * 1024)
  const next = call("wide.csv", "csv", { offset: first.rows.length, limit: 500 }).data
  expect(next.rows[0][0]).toBe(String(first.rows.length))
})

// 复验 P2：首页必须报出整表真实列数（含第 501 行才出现的宽行）。
test("a wide row beyond the first slice is still reported on the first page", () => {
  const { project, call } = fixture()
  const lf = String.fromCharCode(10)
  const wide = Array.from({ length: 129 }, (_, index) => `v${index}`).join(",")
  const lines = ["id"]
  for (let row = 0; row < 500; row++) lines.push(`r${row}`)
  lines.push(wide)
  writeFileSync(join(project, "late-wide.csv"), lines.join(lf) + lf)
  const page = call("late-wide.csv", "csv", { offset: 0, limit: 500 }).data
  expect(page.totalRows).toBe(501)
  expect(page.columnCount).toBe(129)
  expect(page.truncatedColumns).toBe(true)
})
