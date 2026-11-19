import fs from "node:fs"
import path from "node:path"

const TEXT_MAX = 512 * 1024
const IMAGE_MAX = 8 * 1024 * 1024
// CSV 表格预览的契约必须与 src-tauri/src/csv_preview.rs 逐项一致：分页、
// 截断、分隔符嗅探（平票顺序）、BOM、`limit = 0` 的默认值、以及单页字节预算。
const CSV_PAGE_MAX_ROWS = 1000
const CSV_PAGE_DEFAULT_ROWS = 200
const CSV_MAX_COLUMNS = 128
const CSV_CELL_MAX_CHARS = 4096
const CSV_CELL_MAX_CHARS_BYTES = CSV_CELL_MAX_CHARS * 6
const CSV_MAX_FILE_BYTES = 256 * 1024 * 1024
const CSV_PAGE_MAX_BYTES = 1024 * 1024
const SNIFF_BYTES = 8 * 1024
const READ_CHUNK = 64 * 1024
const BOM = [0xef, 0xbb, 0xbf]
const CANDIDATES = [44, 9, 59]
const mimes = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
  gif: "image/gif", webp: "image/webp", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif",
}
const fail = (code, fallback, params = {}) => {
  throw { code, fallback, params }
}
const extOf = relative => path.extname(relative).slice(1).toLowerCase()

function read({ project, path: relative, op, offset = 0, limit = CSV_PAGE_DEFAULT_ROWS }) {
  const root = fs.realpathSync(project)
  if (!fs.statSync(root).isDirectory()) fail("projectDirMissing", "项目目录不存在")
  if (typeof relative !== "string" || relative.includes("\\") || relative.includes("\0") ||
      path.isAbsolute(relative) || (relative && relative.split("/").some(p => !p || p === "." || p === "..")) ||
      (!relative && op !== "list")) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  const file = fs.realpathSync(path.join(root, relative))
  const inside = path.relative(root, file)
  if (inside === ".." || inside.startsWith(`..${path.sep}`) || path.isAbsolute(inside))
    fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  if (op === "list") {
    return fs.readdirSync(file, { withFileTypes: true })
      .filter(e => e.isDirectory() || e.isFile()).slice(0, 2000)
      .map(e => ({ name: e.name, path: relative ? `${relative}/${e.name}` : e.name, is_dir: e.isDirectory() }))
      .sort((a, b) => Number(b.is_dir) - Number(a.is_dir) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  }
  if (op === "csv") return readCsv({ file, relative, offset, limit })
  if (op !== "preview") throw new Error("Unknown file operation")
  if (!fs.statSync(file).isFile()) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  const fd = fs.openSync(file, "r")
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
    const mime = mimes[path.extname(relative).slice(1).toLowerCase()]
    if (mime && stat.size > IMAGE_MAX) fail("previewImageTooLarge", "图片过大，无法预览（上限 {limit} MB）", { limit: 8 })
    const buffer = Buffer.alloc(Math.min(stat.size, mime ? IMAGE_MAX + 1 : TEXT_MAX + 1))
    let length = 0
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, null)
      if (!count) break
      length += count
    }
    const bytes = buffer.subarray(0, length)
    const result = { kind: "text", text: null, truncated: false, mime: null, data: null }
    if (bytes.subarray(0, 8000).includes(0)) {
      return mime ? { ...result, kind: "image", mime, data: bytes.toString("base64") } : { ...result, kind: "binary" }
    }
    let end = Math.min(length, TEXT_MAX)
    while (end > 0 && end < length && (bytes[end] & 0xc0) === 0x80) end--
    return { ...result, text: bytes.subarray(0, end).toString("utf8"), truncated: length > TEXT_MAX }
  } finally { fs.closeSync(fd) }
}

/**
 * 只在文件开头 8 KB 内统计候选分隔符（不要求读到首个换行），引号内不计。
 * 平票按 逗号 → 制表符 → 分号 的优先级（与 Rust 侧同序）；无候选时按扩展名回退。
 */
function sniffDelimiter(head, relative) {
  const bomBytes = head.subarray(0, 3).equals(Buffer.from(BOM)) ? 3 : 0
  const counts = [0, 0, 0]
  let inQuotes = false
  for (const byte of head.subarray(bomBytes, bomBytes + SNIFF_BYTES)) {
    if (byte === 34) { inQuotes = !inQuotes; continue }
    if (inQuotes) continue
    const index = CANDIDATES.indexOf(byte)
    if (index >= 0) counts[index] += 1
  }
  let best = -1
  for (let index = 0; index < counts.length; index++) {
    if (counts[index] > 0 && (best < 0 || counts[index] > counts[best])) best = index
  }
  return {
    delimiter: best >= 0 ? CANDIDATES[best] : extOf(relative) === "tsv" ? 9 : 44,
    bomBytes,
  }
}

/** 单元格成本：UTF-8 字节 + JSON 引号，另加需要转义的字符。与 Rust 侧同一估算。 */
function cellCost(cell) {
  let escapes = 0
  for (const char of cell) if (char === '"' || char === "\\") escapes += 1
  return cell.length + 3 + escapes
}
const rowCost = row => row.reduce((total, cell) => total + cellCost(cell), 0)

/**
 * 逐字节流式解析（与 Rust `RowParser` 同一状态机）：整行从不缓冲，因此一个
 * 128 MiB 的物理行也只占常数内存、耗时随字节数线性增长（旧实现按块重复拼接
 * 未结束的行，是 O(n²)）。RFC 4180 宽松口径：引号只在字段起始处开启引用块，
 * 块内 `""` 是字面引号，块内分隔符与换行是字面量。
 */
class RowParser {
  constructor(delimiter) {
    this.delimiter = delimiter
    this.beginRow(false)
  }
  beginRow(collect) {
    this.collect = collect
    // 按字节累积，字段结束时才解码：逐字节 String.fromCharCode 会把多字节
    // UTF-8（含 emoji 等代理对）拆成乱码（验收 P2 的 emoji 用例）。
    this.bytes = []
    this.field = ""
    this.fieldBytes = 0
    this.fieldCount = 0
    this.fields = []
    this.inQuotes = false
    this.pendingQuote = false
    this.pendingCr = false
    this.atFieldStart = true
    this.cellTruncated = false
    this.started = false
  }
  push(byte) {
    this.started = true
    if (!this.collect) return
    if (this.fieldBytes < CSV_CELL_MAX_CHARS_BYTES) {
      this.bytes.push(byte)
      this.fieldBytes += 1
    } else this.cellTruncated = true
  }
  endField() {
    this.fieldCount += 1
    this.field = this.bytes.length ? Buffer.from(this.bytes).toString("utf8") : ""
    this.bytes = []
    if (this.collect && this.fields.length < CSV_MAX_COLUMNS) {
      // 与 Rust 同口径：按**码位**截断，正好等于上限不算截断。UTF-16 length
      // 只是快速下界（它永远 ≥ 码位数），超过后再按码位精确判断。
      if (this.field.length > CSV_CELL_MAX_CHARS) {
        const chars = Array.from(this.field)
        if (chars.length > CSV_CELL_MAX_CHARS) {
          this.field = chars.slice(0, CSV_CELL_MAX_CHARS).join("")
          this.cellTruncated = true
        }
      }
      this.fields.push(this.field)
    }
    this.field = ""
    this.fieldBytes = 0
    this.atFieldStart = true
  }
  takeRow() {
    const row = { fields: this.fields, fieldCount: this.fieldCount, truncatedCells: this.cellTruncated }
    this.fields = []
    return row
  }
  /** "continue" / "blank" / 完成的行。 */
  feed(byte) {
    let current = byte
    while (true) {
      if (this.pendingQuote) {
        this.pendingQuote = false
        if (current === 34) { this.push(34); return "continue" }
        this.inQuotes = false
      }
      if (this.pendingCr) {
        this.pendingCr = false
        if (current === 10) { this.push(10); return "continue" }
        this.push(13)
      }
      if (this.inQuotes) {
        if (current === 34) { this.pendingQuote = true; return "continue" }
        if (current === 13) { this.pendingCr = true; return "continue" }
        this.push(current)
        return "continue"
      }
      if (current === 34 && this.atFieldStart) {
        this.inQuotes = true
        this.atFieldStart = false
        this.started = true
        return "continue"
      }
      if (current === 10) {
        if (!this.started && this.fieldCount === 0) return "blank"
        this.endField()
        return this.takeRow()
      }
      if (current === 13) return "continue"
      if (current === this.delimiter) {
        this.endField()
        this.started = true
        return "continue"
      }
      this.push(current)
      this.atFieldStart = false
      return "continue"
    }
  }
}

function readCsv({ file, relative, offset, limit }) {
  if (!fs.statSync(file).isFile()) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  const fileBytes = fs.statSync(file).size
  if (fileBytes > CSV_MAX_FILE_BYTES)
    fail("csvFileTooLarge", "文件过大，无法以表格预览（上限 {limit} MB）", { limit: CSV_MAX_FILE_BYTES / 1024 / 1024 })
  // `limit = 0` 表示「用默认页大小」，与 Rust 侧一致。
  const requested = Number(limit)
  const clamped = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), CSV_PAGE_MAX_ROWS)
    : CSV_PAGE_DEFAULT_ROWS
  const start = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0

  const sniffFd = fs.openSync(file, "r")
  let head
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const count = fs.readSync(sniffFd, buffer, 0, SNIFF_BYTES, null)
    head = buffer.subarray(0, count)
  } finally {
    fs.closeSync(sniffFd)
  }
  const sniff = sniffDelimiter(head, relative)

  const fd = fs.openSync(file, "r")
  try {
    const parser = new RowParser(sniff.delimiter)
    let header = null
    const rows = []
    let totalRows = 0
    let more = false
    let columnCount = 0
    let truncatedColumns = false
    let truncatedCells = false
    let budgetTruncated = false
    let collectedBytes = 0
    let budgetExhausted = false
    let record = 0
    let atBoundary = true
    let bomSkip = sniff.bomBytes
    const buffer = Buffer.alloc(READ_CHUNK)

    scan: while (true) {
      const read = fs.readSync(fd, buffer, 0, READ_CHUNK, null)
      if (!read) break
      for (let index = 0; index < read; index++) {
        const byte = buffer[index]
        if (bomSkip > 0) { bomSkip -= 1; continue }
        if (atBoundary) {
          const dataRow = Math.max(0, record - 1)
          const windowed = header !== null && !budgetExhausted && dataRow >= start && dataRow < start + clamped
          parser.beginRow(header === null || windowed)
          atBoundary = false
        }
        const feed = parser.feed(byte)
        if (feed === "continue") continue
        if (feed === "blank") { atBoundary = true; continue }
        atBoundary = true
        const row = feed
        if (record === 0) {
          header = row.fields
          columnCount = Math.max(columnCount, row.fieldCount)
          truncatedColumns = truncatedColumns || row.fieldCount > CSV_MAX_COLUMNS
          truncatedCells = truncatedCells || row.truncatedCells
          record = 1
          continue
        }
        const dataRow = record - 1
        // 首页本来就要扫完整份文件，因此列数与截断标记对**所有**行累计。
        if (start === 0 || (dataRow >= start && dataRow < start + clamped)) {
          columnCount = Math.max(columnCount, row.fieldCount)
          truncatedColumns = truncatedColumns || row.fieldCount > CSV_MAX_COLUMNS
          truncatedCells = truncatedCells || row.truncatedCells
        }
        totalRows += 1
        const inWindow = dataRow >= start && dataRow < start + clamped
        if (inWindow && !budgetExhausted) {
          const cost = rowCost(row.fields)
          if (rows.length > 0 && collectedBytes + cost > CSV_PAGE_MAX_BYTES) {
            budgetExhausted = true
            budgetTruncated = true
            more = true
          } else {
            collectedBytes += cost
            rows.push(row.fields)
          }
        }
        if (!more && dataRow >= start + clamped) more = true
        if (start > 0 && (budgetExhausted || dataRow >= start + clamped)) break scan
        record += 1
      }
    }
    return {
      offset: start,
      rows,
      header,
      more,
      totalRows: start === 0 ? totalRows : null,
      columnCount,
      truncatedColumns,
      truncatedCells,
      budgetTruncated,
      delimiter: sniff.delimiter === 9 ? "\\t" : sniff.delimiter === 59 ? ";" : ",",
      fileBytes,
    }
  } finally {
    fs.closeSync(fd)
  }
}

try {
  console.log("PIX_FILES=" + JSON.stringify({ data: read(JSON.parse(process.argv[1])) }))
} catch (error) {
  console.log("PIX_FILES=" + JSON.stringify({ error: error.code && error.fallback && error.params ? error :
    { code: "previewReadFailed", fallback: "读取文件失败: {detail}", params: { detail: String(error) } } }))
}
