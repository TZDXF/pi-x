/**
 * CSV/TSV table preview helpers: bounded pages, a fixed-row-height virtual
 * window and a client-side parser for the bounded-text callers.
 *
 * The backend (`read_csv_page` in Rust, and its Node twin in
 * `src-tauri/resources/remote_files.mjs`) owns the streaming parser for
 * project files. This module mirrors those rules for the callers that only
 * ever hand the preview a bounded text blob (`readFile` overrides: package
 * resources and code-comment previews), so both paths render identically.
 */
import { extOf } from "./fileKind"

/**
 * One page of a delimited file, mirroring the Rust `CsvPage` payload
 * (`#[serde(rename_all = "camelCase")]`).
 */
export interface CsvPage {
  /** Data-row index of `rows[0]`; the header row is never part of `rows`. */
  offset: number
  rows: string[][]
  header: string[] | null
  /** More data rows exist after this page. */
  more: boolean
  /** Data-row count excluding the header; null on later pages. */
  totalRows: number | null
  /** Real width of the widest row; may exceed {@link CSV_MAX_COLUMNS}. */
  columnCount: number
  truncatedColumns: boolean
  truncatedCells: boolean
  /** The backend cut this page at its byte budget instead of at `limit`. */
  budgetTruncated: boolean
  /** Display form of the field separator: `,` `\t` or `;`. */
  delimiter: string
  fileBytes: number
}

/** Text blob parsed in one go (client mode: bounded `readFile` payloads). */
export interface CsvText {
  header: string[] | null
  rows: string[][]
  columnCount: number
  truncatedColumns: boolean
  truncatedCells: boolean
  delimiter: string
  fileBytes: number
}

/**
 * Row height in px. Virtualisation needs a constant height: every cell renders
 * one line and truncates with an ellipsis, so multi-line quoted cells show
 * their hard line breaks as `⏎` instead of growing the row.
 */
export const CSV_ROW_HEIGHT = 26
/** Rows requested per page; must stay under the backend hard cap (1000). */
export const CSV_PAGE_ROWS = 500
/** Overscan rows rendered above and below the viewport. */
export const CSV_OVERSCAN = 8
/** Pages kept in memory, so scrolling never leaves the working set unbounded. */
export const CSV_PAGE_CACHE_LIMIT = 6
/**
 * Rows kept in memory, independent of how the chunks happen to merge. Chunk
 * *count* alone was not a bound: adjacent slices merge into one ever growing
 * chunk, so nine 500-row screens could sit in memory with no eviction.
 */
export const CSV_PAGE_CACHE_ROWS = CSV_PAGE_CACHE_LIMIT * CSV_PAGE_ROWS
/**
 * Highest row count that keeps a single absolutely-positioned scroll surface
 * below the browser's element-height ceiling (Chromium ~33.5M px; at
 * [`CSV_ROW_HEIGHT`] that is ~1.28M rows, so 1M leaves headroom). Above it the
 * table switches to page navigation instead of an unreachable scrollbar tail.
 */
export const CSV_MAX_VIRTUAL_ROWS = 1_000_000
/** Backend caps mirrored here so the UI can state them in its hints. */
export const CSV_MAX_COLUMNS = 128
export const CSV_MAX_CELL_CHARS = 4096

export interface CsvWindow {
  /** First row index to render (data rows, header excluded). */
  start: number
  /** Exclusive end index. */
  end: number
}

/**
 * Rows to render for a viewport. Fully virtual: the rendered row count depends
 * on viewport height only, never on the file's row count.
 */
export function csvRowWindow(
  scrollTop: number,
  viewportHeight: number,
  rowCount: number,
  rowHeight = CSV_ROW_HEIGHT,
  overscan = CSV_OVERSCAN,
): CsvWindow {
  if (rowCount <= 0 || viewportHeight <= 0) return { start: 0, end: 0 }
  const first = Math.max(0, Math.floor(Math.max(scrollTop, 0) / rowHeight) - overscan)
  const visible = Math.ceil(viewportHeight / rowHeight) + overscan * 2
  const end = Math.min(rowCount, first + visible)
  return { start: first, end: Math.max(first, end) }
}

/** Whether `rowCount` rows fit one virtual scroll surface. */
export const csvUsesVirtualScroll = (rowCount: number) => rowCount <= CSV_MAX_VIRTUAL_ROWS

/** Page index containing `row` for fixed-size pages. */
export const csvPageOf = (row: number, pageSize = CSV_PAGE_ROWS) => Math.max(0, Math.floor(Math.max(row, 0) / pageSize))

/** Page indexes needed to render `[start, end)`. */
export function csvPagesForWindow(start: number, end: number, pageSize = CSV_PAGE_ROWS): number[] {
  if (end <= start) return []
  const first = csvPageOf(start, pageSize)
  const last = csvPageOf(end - 1, pageSize)
  return Array.from({ length: last - first + 1 }, (_, i) => first + i)
}

/** A row's cells padded to `columnCount`, so short records never shift columns. */
export function csvCells(row: string[] | undefined, columnCount: number): string[] {
  const cells = row ?? []
  if (cells.length >= columnCount) return cells
  return [...cells, ...Array.from({ length: columnCount - cells.length }, () => "")]
}

/** Single-line cell text: hard line breaks inside a quoted cell become `⏎`. */
export const csvCellText = (cell: string) => cell.replace(/\r\n?/g, "\n").replace(/\n/g, "⏎")

/** Total scroll height for `rowCount` rows. */
export const csvBodyHeight = (rowCount: number, rowHeight = CSV_ROW_HEIGHT) => Math.max(0, rowCount) * rowHeight

/** Header title for a column without a header cell (ragged or headerless files). */
export const csvColumnLabel = (header: string[] | null, index: number) => header?.[index]?.trim() || `#${index + 1}`

/**
 * Columns actually rendered: the backend reports the real width of the widest
 * row (which can exceed the cap for diagnostics), but rendering more than
 * [`CSV_MAX_COLUMNS`] columns would mean hundreds of header/DOM nodes per row.
 */
export function csvRenderedColumns(columnCount: number): number {
  const count = Math.floor(columnCount)
  if (!Number.isFinite(count)) return 0
  return Math.max(0, Math.min(CSV_MAX_COLUMNS, count))
}

/** Column width in px, narrower as the table gets wider. */
export function csvCellWidth(columns: number): number {
  if (columns <= 4) return 224
  if (columns <= 12) return 160
  return 128
}

/** Separator display form, matching the backend's `delimiter` field. */
export const csvDelimiterLabel = (delimiter: string) => (delimiter === "\t" ? "\\t" : delimiter)

/**
 * Pick the separator by counting candidates on the header line outside quoted
 * runs (comma, tab, semicolon). A single-column file has nothing to sniff, so
 * the extension decides.
 */
export function sniffDelimiter(firstLine: string, path: string): string {
  // 只看首行：把数据行也算进去会让「逗号表头 + 数据行里全是分号」被误判。
  // 平票保持先出现的候选（逗号 → 制表符 → 分号），与 Rust/Node 同序。
  const head = firstLine.slice(0, 8192)
  let best: { candidate: string; count: number } | null = null
  for (const candidate of [",", "\t", ";"]) {
    const count = countOutsideQuotes(head, candidate)
    if (count > 0 && (!best || count > best.count)) best = { candidate, count }
  }
  return best?.candidate ?? (extOf(path) === "tsv" ? "\t" : ",")
}

function countOutsideQuotes(line: string, candidate: string): number {
  let count = 0
  let inQuotes = false
  for (const char of line) {
    if (char === '"') inQuotes = !inQuotes
    else if (char === candidate && !inQuotes) count += 1
  }
  return count
}

/**
 * Parse delimited text into records, RFC 4180 leniently: `"` only opens a
 * quoted run at the start of a field, `""` inside a run is a literal quote,
 * delimiters and line breaks inside a run are literal content. Empty lines
 * outside a quoted run are not records. Records are column-capped and cells
 * cut per character exactly like the backend, so both paths agree.
 */
export function parseCsvRows(
  text: string,
  path: string,
  limits: { maxColumns?: number; maxCellChars?: number } = {},
): CsvText {
  const maxColumns = limits.maxColumns ?? CSV_MAX_COLUMNS
  const maxCellChars = limits.maxCellChars ?? CSV_MAX_CELL_CHARS
  const body = stripBom(text)
  const delimiter = sniffDelimiter(firstSplitLine(body), path)

  const rows: string[][] = []
  /** Real field count per record, before the column cap (for `columnCount`). */
  const widths: number[] = []
  let cells: string[] = []
  let fieldCount = 0
  let field = ""
  let started = false
  let truncatedCells = false
  let inQuotes = false
  let pendingCr = false
  let atFieldStart = true

  const commitField = () => {
    fieldCount += 1
    if (cells.length < maxColumns) {
      // 与 Rust 侧同口径：超长单元格按字符截断，不按字节。
      const chars = Array.from(field)
      if (chars.length > maxCellChars) {
        cells.push(chars.slice(0, maxCellChars).join(""))
        truncatedCells = true
      } else cells.push(field)
    }
    field = ""
    atFieldStart = true
  }
  // 引用块外的空行不是记录：它既不产生行，也不移动行号。
  const commitRow = () => {
    if (!started) return
    commitField()
    rows.push(cells)
    widths.push(fieldCount)
    cells = []
    fieldCount = 0
    started = false
  }

  for (let index = 0; index < body.length; index++) {
    const char = body[index]
    if (pendingCr) {
      pendingCr = false
      if (char === "\n") {
        field += "\n"
        started = true
        continue
      }
      field += "\r"
    }
    if (inQuotes) {
      if (char === '"') {
        if (body[index + 1] === '"') {
          field += '"'
          index += 1
        } else inQuotes = false
        continue
      }
      // 单元格内 CRLF 折叠成一个 LF；孤立 CR 原样保留（与 Rust/Node 同口径）。
      if (char === "\r") {
        pendingCr = true
        started = true
        continue
      }
      field += char
      started = true
      continue
    }
    if (atFieldStart && char === '"') {
      inQuotes = true
      started = true
      continue
    }
    if (char === "\r") continue
    if (char === delimiter) {
      commitField()
      started = true
      continue
    }
    if (char === "\n") {
      commitRow()
      field = ""
      continue
    }
    field += char
    started = true
  }
  // 没有末尾换行时，循环末尾的 commitRow() 仍会提交最后一条完整记录。
  commitRow()
  return finalize(rows, widths, delimiter, body.length, maxColumns, truncatedCells)
}

function finalize(
  rows: string[][],
  widths: number[],
  delimiter: string,
  fileBytes: number,
  maxColumns: number,
  truncatedCells: boolean,
): CsvText {
  const header = rows[0] ?? null
  return {
    header: header ? header.slice(0, maxColumns) : null,
    rows: rows.slice(1),
    columnCount: widths.reduce((widest, width) => Math.max(widest, width), 0),
    truncatedColumns: widths.some(width => width > maxColumns),
    truncatedCells,
    delimiter: csvDelimiterLabel(delimiter),
    fileBytes,
  }
}

/** Drop a leading UTF-8 BOM (spreadsheet exports prepend one). */
const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

function firstSplitLine(text: string): string {
  const breakIndex = text.search(/\r?\n/)
  return breakIndex < 0 ? text : text.slice(0, breakIndex)
}

/**
 * Parse a bounded text blob into one page, for callers that already hold a
 * page-shaped window (tests and the client-mode override path).
 */
export function parseCsvPage(
  text: string,
  path: string,
  offset = 0,
  limit = CSV_PAGE_ROWS,
  limits: { maxColumns?: number; maxCellChars?: number } = {},
): CsvPage {
  const parsed = parseCsvRows(text, path, limits)
  return {
    offset,
    rows: parsed.rows.slice(offset, offset + limit),
    header: parsed.header,
    more: parsed.rows.length > offset + limit,
    // 本地解析持有整份有界文本，任何一页都能给出准确总数。
    totalRows: parsed.rows.length,
    columnCount: parsed.columnCount,
    truncatedColumns: parsed.truncatedColumns,
    truncatedCells: parsed.truncatedCells,
    // 本地解析持有整份有界文本，不存在「按字节裁剪」。
    budgetTruncated: false,
    delimiter: parsed.delimiter,
    fileBytes: parsed.fileBytes,
  }
}

/**
 * Paged mode shows one slice at a time, and slice lengths vary (the backend
 * trims to its byte budget), so neither "current offset − current length" nor
 * "the largest smaller offset we ever showed" proves which screen comes before
 * the current one.
 *
 * Two different facts must not be confused:
 *
 * * **seen start** — an offset the user has been on. It proves nothing about
 *   adjacency: after a refresh the restored screen may sit at 1500 while 0 is
 *   merely the home screen.
 * * **confirmed edge** — "we moved from A to B in this generation", recorded at
 *   the moment of navigation (forward: A + its *measured* length; backward: the
 *   predecessor we just resolved).
 *
 * Back-paging only uses confirmed edges, and only inside the current
 * `generation`. Without an edge it reports `null` and the caller disables the
 * control instead of jumping to a guessed offset.
 */
export interface ScreenEdge {
  /** Screen the user left. */
  from: number
  /** Screen the user landed on. */
  to: number
  /** Load generation the move happened in. */
  generation: number
}

/**
 * Record `from → to` as a confirmed adjacency for `generation`. Only forward
 * moves create an edge: going back re-uses the edge it came from, and recording
 * the reverse pair too would evict the forward edges under a bounded list (back
 * paging then lost its predecessor and started bouncing). Edges from older
 * generations are dropped — slice boundaries move when the file changes.
 */
export function rememberScreenEdge(
  edges: ScreenEdge[],
  from: number,
  to: number,
  generation: number,
  limit: number,
): ScreenEdge[] {
  if (to <= from) return edges.filter(edge => edge.generation === generation)
  // 去重按 (from, to) 这一对，而不是只按 `to`：一次「前进 A→B」和随后的
  // 「后退 B→A」会共享同一个 `to`，只按 `to` 去重会把真正的前向边覆盖掉。
  const base = edges.filter(edge => edge.generation === generation && !(edge.from === from && edge.to === to))
  const next = [...base, { from, to, generation }]
  while (next.length > limit) next.shift()
  return next
}

/** Verified predecessor of `baseRow` in `generation`, or `null`. */
export function confirmedPredecessor(edges: ScreenEdge[], generation: number, baseRow: number): number | null {
  // 只要「真正在它之前」的边：后退操作也会记下 `300 → 150`，那个 `from` 大于
  // 当前屏，不是前驱。
  const incoming = edges.filter(
    candidate => candidate.generation === generation && candidate.to === baseRow && candidate.from < baseRow,
  )
  if (!incoming.length) return null
  return Math.max(...incoming.map(candidate => candidate.from))
}
