import { readFileSync } from "node:fs"
import { expect, test } from "vitest"
import { isCsvTableExt } from "@/lib/fileKind"
import {
  CSV_MAX_VIRTUAL_ROWS,
  CSV_OVERSCAN,
  CSV_PAGE_CACHE_LIMIT,
  CSV_PAGE_ROWS,
  CSV_ROW_HEIGHT,
  csvBodyHeight,
  csvCellText,
  csvCells,
  csvColumnLabel,
  csvPageOf,
  csvPagesForWindow,
  csvRenderedColumns,
  csvRowWindow,
  csvUsesVirtualScroll,
  CSV_MAX_COLUMNS,
  parseCsvPage,
  parseCsvRows,
  sniffDelimiter,
} from "@/lib/csvTable"

// TZD-137：CSV 表格预览的纯逻辑部分——分页窗口、虚拟滚动行窗口与解析规则。
// 大文件性能的关键前提是「渲染行数只由视口高度决定」，这些用例固定该契约。

test("csv/tsv extensions select the table view", () => {
  expect(isCsvTableExt("data.csv")).toBeTruthy()
  expect(isCsvTableExt("导出/大表.TSV")).toBeTruthy()
  expect(!isCsvTableExt("data.csvx")).toBeTruthy()
  expect(!isCsvTableExt("src/main.ts")).toBeTruthy()
  expect(!isCsvTableExt(".csv")).toBeTruthy()
})

test("the rendered row window depends on viewport height, not on row count", () => {
  const viewport = CSV_ROW_HEIGHT * 20
  const small = csvRowWindow(0, viewport, 100)
  const huge = csvRowWindow(0, viewport, 2_000_000)
  // 同样的视口只渲染同样多的行；行数从 100 涨到 200 万，DOM 规模不变。
  expect(small.end - small.start).toBe(huge.end - huge.start)
  expect(huge.end - huge.start).toBeLessThanOrEqual(20 + CSV_OVERSCAN * 2)
  expect(huge.start).toBe(0)
})

test("above the virtual-scroll ceiling the view switches to paged navigation", () => {
  // 浏览器（Chromium）单个元素的像素高度上限约 33.5M：26px 行高下约 128 万行，
  // 超过就必须换导航方式，否则「滚到底」到不了最后一行。
  expect(csvUsesVirtualScroll(CSV_MAX_VIRTUAL_ROWS)).toBe(true)
  expect(csvUsesVirtualScroll(CSV_MAX_VIRTUAL_ROWS + 1)).toBe(false)
  expect(CSV_MAX_VIRTUAL_ROWS * CSV_ROW_HEIGHT).toBeLessThan(33_554_432)
})

test("the row window follows scrolling and clamps to the last row", () => {
  const viewport = CSV_ROW_HEIGHT * 10
  const middle = csvRowWindow(CSV_ROW_HEIGHT * 500, viewport, 1000)
  expect(middle.start).toBe(500 - CSV_OVERSCAN)
  expect(middle.end).toBeLessThanOrEqual(1000)
  const end = csvRowWindow(CSV_ROW_HEIGHT * 1000, viewport, 1000)
  expect(end.start).toBeGreaterThan(900)
  expect(end.end).toBe(1000)
  expect(csvRowWindow(0, 0, 1000)).toEqual({ start: 0, end: 0 })
  expect(csvRowWindow(0, viewport, 0)).toEqual({ start: 0, end: 0 })
})

test("row windows map onto the pages that must be fetched", () => {
  expect(csvPageOf(0)).toBe(0)
  expect(csvPageOf(CSV_PAGE_ROWS)).toBe(1)
  expect(csvPageOf(CSV_PAGE_ROWS * 3 + 7)).toBe(3)
  expect(csvPagesForWindow(0, 10)).toEqual([0])
  expect(csvPagesForWindow(CSV_PAGE_ROWS - 1, CSV_PAGE_ROWS + 1)).toEqual([0, 1])
  expect(csvPagesForWindow(CSV_PAGE_ROWS * 4, CSV_PAGE_ROWS * 4)).toEqual([])
  // 一个视口窗口最多触及两页，因此每次滚动最多两次分页请求。
  expect(csvPagesForWindow(100, 100 + 20).length).toBeLessThanOrEqual(2)
})

test("the scroll body height is linear in rows and the page cache stays bounded", () => {
  expect(csvBodyHeight(0)).toBe(0)
  expect(csvBodyHeight(1_000_000)).toBe(1_000_000 * CSV_ROW_HEIGHT)
  expect(csvBodyHeight(-5)).toBe(0)
  expect(CSV_PAGE_CACHE_LIMIT).toBeGreaterThan(1)
})

test("short rows are padded so columns never shift, and cell text stays single-line", () => {
  expect(csvCells(["a"], 3)).toEqual(["a", "", ""])
  expect(csvCells(["a", "b", "c"], 3)).toEqual(["a", "b", "c"])
  expect(csvCells(undefined, 2)).toEqual(["", ""])
  expect(csvCells(["a", "b", "c", "d"], 2)).toEqual(["a", "b", "c", "d"])
  expect(csvCellText("line one\nline two")).toBe("line one⏎line two")
  expect(csvCellText("crlf\r\ntext")).toBe("crlf⏎text")
  expect(csvCellText("plain")).toBe("plain")
})

test("missing header cells fall back to positional titles", () => {
  expect(csvColumnLabel(["id", "name"], 1)).toBe("name")
  expect(csvColumnLabel(["id", ""], 1)).toBe("#2")
  expect(csvColumnLabel(null, 0)).toBe("#1")
})

test("quoted cells keep delimiters, doubled quotes and hard line breaks", () => {
  const parsed = parseCsvRows('name,note\r\n"a, b","say ""hi"""\r\nplain,x\r\n', "data.csv")
  expect(parsed.header).toEqual(["name", "note"])
  expect(parsed.rows).toEqual([
    ["a, b", 'say "hi"'],
    ["plain", "x"],
  ])
  expect(parsed.columnCount).toBe(2)
  const multiline = parseCsvRows('id,body\n1,"line one\nline two"\n2,flat\n', "data.csv")
  expect(multiline.rows).toEqual([
    ["1", "line one\nline two"],
    ["2", "flat"],
  ])
})

test("empty lines outside quotes are not records and a BOM is stripped", () => {
  const parsed = parseCsvRows("\uFEFFa,b\n\n1,2\n", "data.csv")
  expect(parsed.header).toEqual(["a", "b"])
  expect(parsed.rows).toEqual([["1", "2"]])
})

test("the delimiter is sniffed from the header line and falls back to the extension", () => {
  expect(sniffDelimiter("a\tb\tc", "x.csv")).toBe("\t")
  expect(sniffDelimiter("a;b;c", "x.csv")).toBe(";")
  expect(sniffDelimiter("only,one", "x.csv")).toBe(",")
  expect(sniffDelimiter("single", "x.tsv")).toBe("\t")
  expect(sniffDelimiter("single", "x.csv")).toBe(",")
  // 引号内的分隔符不参与嗅探。
  expect(sniffDelimiter('"a;b;c",d', "x.csv")).toBe(",")
  expect(parseCsvRows("a;b\n1;2\n", "x.csv").delimiter).toBe(";")
  expect(parseCsvRows("a\tb\n1\t2\n", "x.tsv").delimiter).toBe("\\t")
})

test("rows wider than the column cap keep the first N and report the real width", () => {
  const header = Array.from({ length: 130 }, (_, i) => `c${i}`).join(",")
  const wide = Array.from({ length: 140 }, (_, i) => `v${i}`).join(",")
  const parsed = parseCsvRows(`${header}\n${wide}\n`, "wide.csv")
  expect(parsed.rows[0].length).toBe(128)
  expect(parsed.columnCount).toBe(140)
  expect(parsed.truncatedColumns).toBe(true)
})

test("long cells are cut per character instead of per byte", () => {
  const long = "中".repeat(5000)
  const parsed = parseCsvRows(`id,text\n1,${long}\n`, "long.csv")
  expect(Array.from(parsed.rows[0][1]).length).toBe(4096)
  expect(parsed.truncatedCells).toBe(true)
})

test("parseCsvPage only materialises the requested window", () => {
  const rows = Array.from({ length: 20 }, (_, i) => `${i},v${i}`)
  const text = `id,value\n${rows.join("\n")}\n`
  const page = parseCsvPage(text, "data.csv", 5, 3)
  expect(page.header).toEqual(["id", "value"])
  expect(page.rows).toEqual([
    ["5", "v5"],
    ["6", "v6"],
    ["7", "v7"],
  ])
  expect(page.more).toBe(true)
  expect(page.totalRows).toBe(20)
  expect(page.offset).toBe(5)
  expect(page.fileBytes).toBe(text.length)
  expect(parseCsvPage(text, "data.csv", 0, 200).more).toBe(false)
})

// 预览面板接入（TZD-137）：CSV 走表格视图，且项目模式下不预读整份文件——
// 512 KB 文本上限对大表没有意义，整份读回也会压垮 IPC。
test("the file preview routes csv files to the table view without pre-reading them", () => {
  const source = readFileSync(new URL("../src/components/ProjectFilePreview.vue", import.meta.url), "utf8")
  expect(source).toContain('import CsvTablePreview from "@/components/CsvTablePreview.vue"')
  expect(source).toMatch(/isCsv = computed\(\(\) => isCsvTableExt\(props\.path\)\)/)
  // 默认表格视图，工具栏提供切回源码的开关。
  expect(source).toMatch(/csvRendered = ref\(true\)/)
  expect(source).toContain("data-csv-toggle")
  // 项目模式的分页读取由子组件负责，load() 直接返回，不发起 read_file_preview。
  expect(source).toMatch(/if \(showCsvTable\.value && !props\.readFile\) \{\s+loading\.value = false\s+return/)
  expect(source).toMatch(/<CsvTablePreview\s+v-if="showCsvTable && !readFile"/)
  // readFile 覆盖（资源/批注预览）没有分页通道，改为把有界文本交给子组件解析。
  expect(source).toMatch(/const csvText = computed\(\(\) => \(props\.readFile \? text\.value : undefined\)\)/)
})

// 验收回归（TZD-137 复验 P1/P2）——纯逻辑部分。

test("only the first 128 columns are rendered, however wide the file is", () => {
  // 后端报「真实宽度」用于提示，渲染必须被 128 截断，否则 200 列会渲染 200 个
  // 表头与每行 200 格（验收 P1）。
  expect(csvRenderedColumns(200)).toBe(CSV_MAX_COLUMNS)
  expect(csvRenderedColumns(CSV_MAX_COLUMNS)).toBe(CSV_MAX_COLUMNS)
  expect(csvRenderedColumns(3)).toBe(3)
  expect(csvRenderedColumns(0)).toBe(0)
  expect(csvRenderedColumns(Number.NaN)).toBe(0)
  const cells = csvCells(
    Array.from({ length: 200 }, (_, index) => `c${index}`),
    CSV_MAX_COLUMNS,
  )
  expect(cells.length).toBe(200, "pads only, never grows")
  expect(cells.slice(0, CSV_MAX_COLUMNS).at(-1)).toBe("c127")
})

test("delimiter ties resolve to comma, then tab, then semicolon (same as Rust/Node)", () => {
  expect(sniffDelimiter("a,b;c", "x.csv")).toBe(",")
  expect(sniffDelimiter("a\tb;c", "x.csv")).toBe("\t")
  expect(sniffDelimiter("a;b\tc", "x.csv")).toBe("\t")
  expect(sniffDelimiter("a;b;c", "x.csv")).toBe(";")
})

test("CRLF inside a quoted cell collapses to one LF", () => {
  const parsed = parseCsvRows('id,body\n1,"line one\r\nline two"\n', "data.csv")
  expect(parsed.rows[0][1]).toBe("line one\nline two")
  const crlfRecords = parseCsvRows("a,b\r\n1,2\r\n", "data.csv")
  expect(crlfRecords.rows).toEqual([["1", "2"]])
})

test("the client page mirrors the backend's byte-budget flag", () => {
  const page = parseCsvPage("a,b\n1,2\n", "data.csv", 0, 10)
  // 本地解析持有整份有界文本，不存在按字节裁剪的页。
  expect(page.budgetTruncated).toBe(false)
  expect(page.totalRows).toBe(1)
})
