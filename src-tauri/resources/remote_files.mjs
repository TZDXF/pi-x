/**
 * 远端 CSV/TSV 表格预览（`op: "csv"`）。本文件的实现必须与
 * `src-tauri/src/csv_preview.rs` 逐项一致：分页、列/字符/字节上限、分隔符嗅探
 * （只看首行、平票顺序）、BOM、`limit = 0` 的默认值、以及「无末尾换行也要交付
 * 最后一条记录」。`tests/remote-files.test.ts` 会直接比对两边的常量与行为。
 */
import fs from "node:fs"

const TEXT_MAX = 512 * 1024
const IMAGE_MAX = 8 * 1024 * 1024
const CSV_PAGE_MAX_ROWS = 1000
const CSV_PAGE_DEFAULT_ROWS = 200
const CSV_MAX_COLUMNS = 128
const CSV_CELL_MAX_CHARS = 4096
const CSV_CELL_MAX_CHARS_BYTES = CSV_CELL_MAX_CHARS * 6
const CSV_MAX_FILE_BYTES = 256 * 1024 * 1024
const CSV_PAGE_MAX_BYTES = 1024 * 1024
const CSV_BYTE_OVERHEAD = 4 * 1024
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
const extOf = relative => {
  const name = relative.split(/[\\/]/).pop() || ""
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ""
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
    const mime = mimes[extOf(relative)]
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
 * 只统计**首行**（引号外、最多 8 KB）的候选分隔符。把整段文件开头都算进去，
 * 会让「表头是逗号、数据行里全是分号」的合法 CSV 被误判（复验 P2）。
 * 平票按 逗号 → 制表符 → 分号 的优先级（与 Rust 同序）；无候选时按扩展名回退。
 */
function sniffDelimiter(head, relative) {
  const bomBytes = head.subarray(0, 3).equals(Buffer.from(BOM)) ? 3 : 0
  const counts = [0, 0, 0]
  let inQuotes = false
  for (const byte of head.subarray(bomBytes, bomBytes + SNIFF_BYTES)) {
    if (byte === 34) { inQuotes = !inQuotes; continue }
    if (byte === 10 && !inQuotes) break
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

/**
 * 单元格序列化成本：UTF-8 字节 + JSON 引号 + 需要转义的字符。JSON 会把引号和
 * 反斜杠转成 2 字节，把每个控制字符（LF / CR / TAB / 其他 C0 与 DEL）转成 2
 * 字节以上。与 Rust 侧 `cell_cost` 同口径（见下方逐字符估算）。
 */
function cellCost(cell) {
  // JSON 的短转义（\\ " \b \t \n \f \r）只多 1 字节；
  // 其余 C0（U+0000..U+001F）写成 6 字节的 \u0001 形式，即多 5 字节。
  // 只按 1 字节计让 U+0001 单元格整页到 3.12 MB（预算 1 MiB）；只算引号/反斜杠
  // 又让 LF 单元格少算一半（实测 2.08 MB）。与 Rust 侧 `cell_cost` 同口径。
  let cost = Buffer.byteLength(cell, "utf8") + 3
  for (const char of cell) {
    const code = char.charCodeAt(0)
    if (char === '"' || char === "\\") cost += 1
    else if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13) cost += 1
    else if (code < 0x20) cost += 5
  }
  return cost
}
const rowCost = row => row.reduce((total, cell) => total + cellCost(cell), 0)

/** 保留前若干单元格，使序列化后不超过 `budget`（至少保留一个）。 */
function fitRow(fields, budget) {
  let cost = 0
  let keep = 0
  for (const field of fields) {
    const next = cost + cellCost(field)
    if (keep > 0 && next > budget) break
    cost = next
    keep += 1
  }
  if (keep < fields.length) return { fields: fields.slice(0, Math.max(1, keep)), cut: true }
  return { fields, cut: false }
}

/**
 * 逐字节流式解析（与 Rust `RowParser` 同一状态机）：整行从不缓冲，因此一个
 * 128 MiB 的物理行也只占常数内存、耗时随字节数线性增长。RFC 4180 宽松口径：
 * 引号只在字段起始处开启引用块，块内 `""` 是字面引号，块内分隔符与换行是字面量。
 */
class RowParser {
  constructor(delimiter) {
    this.delimiter = delimiter
    this.beginRow(false)
  }
  beginRow(collect) {
    this.collect = collect
    // 按字节累积，字段结束时才解码：逐字节 String.fromCharCode 会把多字节
    // UTF-8（含 emoji 等代理对）拆成乱码。
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
  /** 一段普通字段字节（不含分隔符/换行/CR/引号）。 */
  pushRun(bytes) {
    if (!bytes.length) return
    this.started = true
    this.atFieldStart = false
    if (!this.collect) return
    const room = Math.max(0, CSV_CELL_MAX_CHARS_BYTES - this.fieldBytes)
    if (bytes.length <= room) {
      for (let index = 0; index < bytes.length; index++) this.bytes.push(bytes[index])
      this.fieldBytes += bytes.length
    } else {
      for (let index = 0; index < room; index++) this.bytes.push(bytes[index])
      this.fieldBytes += room
      this.cellTruncated = true
    }
  }
  endField() {
    this.fieldCount += 1
    this.field = this.bytes.length ? Buffer.from(this.bytes).toString("utf8") : ""
    this.bytes = []
    if (this.collect && this.fields.length < CSV_MAX_COLUMNS) {
      // 与 Rust 同口径：按**码位**截断，正好等于上限不算截断。
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
  finishRecord() {
    // EOF flush：引用块里尚未落盘的 CR 属于单元格内容；`pendingQuote` 只是
    // 文件末尾缺失的前瞻，不能当成内容追加。
    if (this.pendingCr) {
      this.pendingCr = false
      this.push(13)
    }
    this.pendingQuote = false
    this.inQuotes = false
    this.endField()
    const row = { fields: this.fields, fieldCount: this.fieldCount, truncatedCells: this.cellTruncated }
    this.fields = []
    return row
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
  const cap = CSV_PAGE_MAX_BYTES - CSV_BYTE_OVERHEAD

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

  const state = {
    header: null,
    headerCost: 0,
    rows: [],
    totalRows: 0,
    more: false,
    columnCount: 0,
    truncatedColumns: false,
    truncatedCells: false,
    budgetTruncated: false,
    collectedBytes: 0,
    budgetExhausted: false,
    record: 0,
  }

  const fd = fs.openSync(file, "r")
  try {
    const parser = new RowParser(sniff.delimiter)
    let atBoundary = true
    let bomSkip = sniff.bomBytes
    let stop = false
    const buffer = Buffer.alloc(READ_CHUNK)

    scan: while (!stop) {
      const read = fs.readSync(fd, buffer, 0, READ_CHUNK, null)
      if (!read) break
      let index = 0
      while (index < read) {
        if (bomSkip > 0) {
          const skip = Math.min(bomSkip, read - index)
          bomSkip -= skip
          index += skip
          continue
        }
        if (atBoundary) {
          const dataRow = Math.max(0, state.record - 1)
          const windowed = state.header !== null && !state.budgetExhausted &&
            dataRow >= start && dataRow < start + clamped
          parser.beginRow(state.header === null || windowed)
          atBoundary = false
        }
        const byte = buffer[index]
        // 引号内的引号前瞻：块内 `""` 是字面引号，单个引号结束引用块。
        // 收尾引号之前待处理的 CR 属于单元格内容，否则它会与记录分隔 LF 配对，
        // 把下一条记录吞进同一格。
        if (parser.pendingQuote) {
          parser.pendingQuote = false
          if (parser.pendingCr) {
            parser.pendingCr = false
            parser.push(13)
          }
          if (byte === 34) { parser.push(34); index += 1; continue }
          parser.inQuotes = false
        }
        if (parser.inQuotes) {
          if (byte === 34) parser.pendingQuote = true
          else if (byte === 13) {
            // `pendingCr` 只有一个槽位：连续的第二个 CR 必须先把前一个落盘，
            // 否则 `"a<CR><CR>"` 只剩下一个 CR（复验 P1）。
            if (parser.pendingCr) {
              parser.pendingCr = false
              parser.push(13)
            }
            parser.pendingCr = true
          } else {
            if (parser.pendingCr) {
              parser.pendingCr = false
              if (byte === 10) { parser.push(10); index += 1; continue }
              parser.push(13)
            }
            parser.push(byte)
          }
          index += 1
          continue
        }
        // 字段起始处的引号开启引用块；字段中间的字面引号是普通内容，必须在这里
        // 被消耗掉，否则快路径遇到引号就停下，扫描原地打转。
        if (byte === 34) {
          if (parser.atFieldStart) {
            parser.inQuotes = true
            parser.started = true
          } else parser.push(34)
          parser.atFieldStart = false
          index += 1
          continue
        }
        if (byte === 13) { index += 1; continue }
        if (byte === 10) {
          index += 1
          if (!parser.started && parser.fieldCount === 0) { atBoundary = true; continue }
          const row = parser.finishRecord()
          atBoundary = true
          stop = finishRecord(state, row, start, clamped, cap)
          if (stop) break scan
          continue
        }
        if (byte === parser.delimiter) {
          parser.endField()
          parser.started = true
          index += 1
          continue
        }
        // 普通字段内容：一次吃掉整段（快路径）。
        let run = index
        while (run < read) {
          const b = buffer[run]
          if (b === parser.delimiter || b === 10 || b === 13 || b === 34) break
          run += 1
        }
        parser.pushRun(buffer.subarray(index, run))
        index = run
      }
    }

    // 文件没有末尾换行时，最后一条完整记录仍要交付（否则末行会丢，复验 P1）。
    if (!atBoundary && parser.started) {
      finishRecord(state, parser.finishRecord(), start, clamped, cap)
    }
    return {
      offset: start,
      rows: state.rows,
      header: state.header,
      more: state.more,
      totalRows: start === 0 ? state.totalRows : null,
      columnCount: state.columnCount,
      truncatedColumns: state.truncatedColumns,
      truncatedCells: state.truncatedCells,
      budgetTruncated: state.budgetTruncated,
      delimiter: sniff.delimiter === 9 ? "\\t" : sniff.delimiter === 59 ? ";" : ",",
      fileBytes,
    }
  } finally {
    fs.closeSync(fd)
  }
}

/** 把一条完成的记录并入页状态；返回是否可以停止扫描。与 Rust `finish_record` 同序。 */
function finishRecord(state, row, start, limit, cap) {
  if (state.record === 0) {
    state.columnCount = Math.max(state.columnCount, row.fieldCount)
    state.truncatedColumns = state.truncatedColumns || row.fieldCount > CSV_MAX_COLUMNS
    state.truncatedCells = state.truncatedCells || row.truncatedCells
    // 表头也占页字节：不计入预算，1 MB 上限在宽表上就不成立。
    const fitted = fitRow(row.fields, Math.floor(cap / 2))
    state.truncatedColumns = state.truncatedColumns || fitted.cut
    state.headerCost = rowCost(fitted.fields)
    state.header = fitted.fields
    state.record = 1
    return false
  }
  const dataRow = state.record - 1
  if (start === 0 || (dataRow >= start && dataRow < start + limit)) {
    state.columnCount = Math.max(state.columnCount, row.fieldCount)
    state.truncatedColumns = state.truncatedColumns || row.fieldCount > CSV_MAX_COLUMNS
    state.truncatedCells = state.truncatedCells || row.truncatedCells
  }
  state.totalRows += 1
  const inWindow = dataRow >= start && dataRow < start + limit
  if (inWindow && !state.budgetExhausted) {
    const cost = rowCost(row.fields)
    const pageCost = state.headerCost + state.collectedBytes + cost
    if (state.rows.length === 0) {
      if (pageCost > cap) {
        const fitted = fitRow(row.fields, Math.max(0, cap - state.headerCost))
        state.truncatedColumns = state.truncatedColumns || fitted.cut
        state.budgetTruncated = true
        state.collectedBytes += rowCost(fitted.fields)
        state.rows.push(fitted.fields)
      } else {
        state.collectedBytes += cost
        state.rows.push(row.fields)
      }
    } else if (pageCost > cap) {
      state.budgetExhausted = true
      state.budgetTruncated = true
      state.more = true
    } else {
      state.collectedBytes += cost
      state.rows.push(row.fields)
    }
  }
  if (!state.more && dataRow >= start + limit) state.more = true
  state.record += 1
  return start > 0 && (state.budgetExhausted || dataRow >= start + limit)
}

try {
  console.log("PIX_FILES=" + JSON.stringify({ data: read(JSON.parse(process.argv[1])) }))
} catch (error) {
  console.log("PIX_FILES=" + JSON.stringify({ error: error.code && error.fallback && error.params ? error :
    { code: "previewReadFailed", fallback: "读取文件失败: {detail}", params: { detail: String(error) } } }))
}
