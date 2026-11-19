import fs from "node:fs"
import path from "node:path"

const TEXT_MAX = 512 * 1024
const IMAGE_MAX = 8 * 1024 * 1024
// CSV 表格预览的分页契约必须与 src-tauri/src/csv_preview.rs 完全一致。
const CSV_PAGE_MAX_ROWS = 1000
const CSV_PAGE_DEFAULT_ROWS = 200
const CSV_MAX_COLUMNS = 128
const CSV_CELL_MAX_CHARS = 4096
const CSV_MAX_FILE_BYTES = 256 * 1024 * 1024
const CSV_CHUNK = 64 * 1024
const mimes = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg",
  gif: "image/gif", webp: "image/webp", ico: "image/x-icon", bmp: "image/bmp", avif: "image/avif",
}
const fail = (code, fallback, params = {}) => {
  throw { code, fallback, params }
}

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

const extOf = relative => path.extname(relative).slice(1).toLowerCase()

/** 首行（跳过引号内内容）统计候选分隔符，与 Rust 侧嗅探规则一致。 */
function sniffDelimiter(firstLine, relative) {
  const counts = [[44, 0], [9, 0], [59, 0]]
  let inQuotes = false
  for (const byte of firstLine.subarray(0, 8192)) {
    if (byte === 34) { inQuotes = !inQuotes; continue }
    if (inQuotes) continue
    for (const entry of counts) if (byte === entry[0]) entry[1] += 1
  }
  const best = counts.filter(entry => entry[1] > 0).sort((a, b) => b[1] - a[1])[0]
  return best ? best[0] : extOf(relative) === "tsv" ? 9 : 44
}

/**
 * 逐物理行流式读取：CSV 预览永远不是「整份文件进内存」，远端超宽表格也只回传
 * 一页（offset/limit 与 Rust 的 read_csv_page 同语义）。RFC 4180 宽松口径：
 * 引号只在字段起始处开启引用块，块内 `""` 是字面引号，块内分隔符与换行是字面量。
 */
function readCsv({ file, relative, offset, limit }) {
  const fileBytes = fs.statSync(file).size
  if (!fs.statSync(file).isFile()) fail("previewPathInvalid", "无效的文件路径: {detail}", { detail: relative })
  if (fileBytes > CSV_MAX_FILE_BYTES)
    fail("csvFileTooLarge", "文件过大，无法以表格预览（上限 {limit} MB）", { limit: CSV_MAX_FILE_BYTES / 1024 / 1024 })
  const clamped = Math.min(Math.max(1, Number(limit) || CSV_PAGE_DEFAULT_ROWS), CSV_PAGE_MAX_ROWS)
  const start = Math.max(0, Number(offset) || 0)

  const sniffFd = fs.openSync(file, "r")
  let firstLine
  try {
    firstLine = sniffLine(sniffFd)
  } finally {
    fs.closeSync(sniffFd)
  }
  const delimiter = sniffDelimiter(firstLine, relative)

  const fd = fs.openSync(file, "r")
  try {
    const reader = new LineReader(fd)
    const parser = new RowParser(delimiter)
    let header = null
    const rows = []
    let totalRows = 0
    let more = false
    let columnCount = 0
    let truncatedColumns = false
    let truncatedCells = false
    let record = 0
    let inRecord = false
    let line
    while ((line = reader.next()) !== null) {
      if (!inRecord) {
        const dataRow = Math.max(0, record - 1)
        parser.beginRow(header === null || (dataRow >= start && dataRow < start + clamped))
      }
      const feed = parser.feed(line)
      if (feed === "continue") { inRecord = true; continue }
      if (feed === "blank") continue
      inRecord = false
      const row = feed
      const inWindow = record > 0 && record - 1 >= start && record - 1 < start + clamped
      if (header === null || inWindow) {
        columnCount = Math.max(columnCount, row.fieldCount)
        truncatedColumns = truncatedColumns || row.fieldCount > CSV_MAX_COLUMNS
        truncatedCells = truncatedCells || row.truncatedCells
      }
      if (header === null) {
        header = row.fields
      } else {
        if (inWindow) rows.push(row.fields)
        totalRows += 1
        if (record - 1 >= start + clamped) {
          more = true
          if (start > 0) break
        }
      }
      record += 1
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
      delimiter: delimiter === 9 ? "\\t" : delimiter === 59 ? ";" : ",",
      fileBytes,
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** 只取首个物理行（嗅探用），不读整份文件。 */
function sniffLine(fd) {
  const chunk = Buffer.alloc(CSV_CHUNK)
  const count = fs.readSync(fd, chunk, 0, CSV_CHUNK, null)
  if (!count) return Buffer.alloc(0)
  const head = chunk.subarray(0, count)
  const newline = head.indexOf(10)
  return newline < 0 ? head : head.subarray(0, newline)
}

/** 分块缓冲的逐行读取器：一次只在内存里保留一个块和当前行。 */
class LineReader {
  constructor(fd) {
    this.fd = fd
    this.buffer = Buffer.alloc(0)
    this.offset = 0
    this.eof = false
  }
  fill() {
    if (this.eof) return false
    const chunk = Buffer.alloc(CSV_CHUNK)
    const count = fs.readSync(this.fd, chunk, 0, CSV_CHUNK, null)
    if (!count) { this.eof = true; return false }
    this.buffer = Buffer.concat([this.buffer.subarray(this.offset), chunk.subarray(0, count)])
    this.offset = 0
    return true
  }
  /** 下一个物理行（不含行尾 `\n`），EOF 返回 null。 */
  next() {
    let newline
    while ((newline = this.buffer.indexOf(10, this.offset)) < 0) {
      if (!this.fill()) {
        if (this.offset >= this.buffer.length) return null
        const tail = this.buffer.subarray(this.offset)
        this.offset = this.buffer.length
        return tail
      }
    }
    const line = this.buffer.subarray(this.offset, newline)
    this.offset = newline + 1
    return line
  }
}

/** RFC 4180 行内状态机：与 Rust `RowParser` 同一套规则。 */
class RowParser {
  constructor(delimiter) {
    this.delimiter = String.fromCharCode(delimiter)
    this.beginRow(false)
  }
  beginRow(collect) {
    this.collect = collect
    this.field = ""
    this.fieldCount = 0
    this.fields = []
    this.inQuotes = false
    this.atFieldStart = true
    this.cellTruncated = false
  }
  push(char) {
    if (!this.collect) return
    if (this.field.length < CSV_CELL_MAX_CHARS * 6) this.field += char
    else this.cellTruncated = true
  }
  endField() {
    this.fieldCount += 1
    if (this.collect && this.fields.length < CSV_MAX_COLUMNS) {
      if (this.field.length > CSV_CELL_MAX_CHARS) {
        this.field = Array.from(this.field).slice(0, CSV_CELL_MAX_CHARS).join("")
        this.cellTruncated = true
      }
      this.fields.push(this.field)
    }
    this.field = ""
    this.atFieldStart = true
  }
  /** "continue"（引用块跨行）、"blank"（空行）或已完成的记录。 */
  feed(lineBuffer) {
    const raw = lineBuffer.toString("utf8")
    const text = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (!text.length && !this.inQuotes) return "blank"
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (this.inQuotes) {
        if (char === '"') {
          if (text[index + 1] === '"') { this.push('"'); index += 1 }
          else this.inQuotes = false
          continue
        }
        this.push(char)
        continue
      }
      if (this.atFieldStart && char === '"') {
        this.inQuotes = true
        this.atFieldStart = false
        continue
      }
      if (char === this.delimiter) {
        this.endField()
        continue
      }
      this.push(char)
      this.atFieldStart = false
    }
    if (this.inQuotes) {
      this.push("\n")
      return "continue"
    }
    this.endField()
    return { fields: this.fields, fieldCount: this.fieldCount, truncatedCells: this.cellTruncated }
  }
}

try {
  console.log("PIX_FILES=" + JSON.stringify({ data: read(JSON.parse(process.argv[1])) }))
} catch (error) {
  console.log("PIX_FILES=" + JSON.stringify({ error: error.code && error.fallback && error.params ? error :
    { code: "previewReadFailed", fallback: "读取文件失败: {detail}", params: { detail: String(error) } } }))
}
