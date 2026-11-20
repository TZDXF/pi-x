//! CSV/TSV table preview for the project-files sidebar.
//!
//! A large delimited file must never travel through one JSON payload, so each
//! request parses the file streamingly and returns one bounded slice of rows
//! plus file-level metadata (header, row count, column count). The renderer
//! keeps only a window of rows, and this module keeps the IPC payload bounded
//! as well: at most [`CSV_PAGE_MAX_ROWS`] rows, [`CSV_MAX_COLUMNS`] columns,
//! [`CSV_CELL_MAX_CHARS`] characters per cell and — a **hard** cap —
//! [`CSV_PAGE_MAX_BYTES`] serialized bytes per response (header included).
//!
//! Parsing is a byte-level state machine fed in fixed-size chunks: a physical
//! line is never buffered whole, so a single 100 MB row costs constant memory
//! and linear time. Bytes that belong to no visible field (the bulk of a
//! first-page scan) are skipped a run at a time, and visible cells are copied
//! a run at a time, so the per-byte cost stays a tight loop.
//!
//! Rules (RFC 4180, lenient; identical in the Node twin
//! `src-tauri/resources/remote_files.mjs` and the client parser
//! `src/lib/csvTable.ts`):
//!
//! * `"` only opens a quoted run at the start of a field; `""` inside a run is
//!   a literal quote; the delimiter and line breaks inside a run are content.
//! * A trailing CR outside a quoted run is dropped (CRLF), a bare LF ends the
//!   record, a CR/LF inside a quoted run stays in the cell (CRLF collapses to
//!   one LF).
//! * Empty physical lines outside a quoted run are not records.
//! * A record still open at end of file is completed (a missing trailing
//!   newline never loses the last row).
//! * A leading UTF-8 BOM is dropped before any parsing.
//! * The delimiter is sniffed from the **first line only** (outside quoted
//!   runs, at most [`SNIFF_BYTES`]); ties prefer comma, then tab, then
//!   semicolon; a single-column file falls back to the extension.
//!
//! The first record is always reported as the header row (the convention GitHub,
//! Excel and most CSV viewers use), so a headerless file loses its first data
//! row to the header. Rows below it are indexed from 0 as data rows: `offset`
//! and `total_rows` never include the header.

use serde::Serialize;
use serde_json::json;
use std::fs::File;
use std::io::Read;

use crate::errors::{pix_error_detail, pix_error_with};

/// Hard cap on rows returned by a single request.
pub const CSV_PAGE_MAX_ROWS: u64 = 1000;
/// Page size used when the caller omits or zeroes `limit`.
pub const CSV_PAGE_DEFAULT_ROWS: u64 = 200;
/// Columns kept per row; wider records keep the first N and report the real count.
pub const CSV_MAX_COLUMNS: usize = 128;
/// Longest cell kept verbatim (chars); longer cells are truncated.
pub const CSV_CELL_MAX_CHARS: usize = 4096;
/// Files above this size are refused: every page request rescans from the start.
pub const CSV_MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Hard cap on one response, header included. Kept far below the 16 MiB SSH
/// exec output limit (`ssh::transport::MAX_EXEC_OUTPUT_BYTES`) so a slice of
/// wide or long cells can never fail the transport: the slice is trimmed
/// instead and reports `budgetTruncated`, and the client continues from
/// `offset + rows.len()`.
pub const CSV_PAGE_MAX_BYTES: usize = 1024 * 1024;
/// JSON syntax overhead (field names, brackets, commas) never charged to cells.
const PAGE_OVERHEAD_BYTES: usize = 4 * 1024;
/// Byte budget behind the character cap above (6 bytes per char keeps the cap
/// exact for UTF-8 while still bounding a pathological single-cell file).
const CELL_MAX_BYTES: usize = CSV_CELL_MAX_CHARS * 6;
/// Bytes inspected when sniffing the delimiter (never past the first line).
const SNIFF_BYTES: usize = 8 * 1024;
/// Bytes read per chunk while scanning.
const READ_CHUNK: usize = 64 * 1024;
/// UTF-8 byte order mark that spreadsheets like to prepend.
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
/// Candidate separators, in tie-break priority order.
const CANDIDATES: [u8; 3] = [b',', b'\t', b';'];

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CsvPage {
    /// Data-row index of `rows[0]`; the header row is never part of `rows`.
    pub offset: u64,
    pub rows: Vec<Vec<String>>,
    /// First record of the file, used as the column titles.
    pub header: Option<Vec<String>>,
    /// More data rows exist after this page (`offset + rows.len()`).
    pub more: bool,
    /// Data-row count excluding the header; only computed for the first page
    /// (`offset == 0`), where the scan necessarily reads the whole file.
    pub total_rows: Option<u64>,
    /// Field count of the widest row. Exact for the whole file on the first
    /// page, and at least the header width on later pages.
    pub column_count: usize,
    /// At least one row has more fields than [`CSV_MAX_COLUMNS`].
    pub truncated_columns: bool,
    /// At least one cell was cut at [`CSV_CELL_MAX_CHARS`].
    pub truncated_cells: bool,
    /// This page was cut by [`CSV_PAGE_MAX_BYTES`], not by `limit`.
    pub budget_truncated: bool,
    /// Field separator as a display string: `,` `\t` or `;`.
    pub delimiter: String,
    pub file_bytes: u64,
}

/// Read one page of a project-relative CSV/TSV file.
pub async fn read_csv_page(
    project: String,
    path: String,
    offset: u64,
    limit: u64,
) -> Result<CsvPage, String> {
    tokio::task::spawn_blocking(move || read_page(&project, &path, offset, limit))
        .await
        .map_err(|e| e.to_string())?
}

fn read_error(path: &str) -> impl Fn(std::io::Error) -> String + '_ {
    move |e| {
        pix_error_detail(
            "previewReadFailed",
            "读取文件失败: {detail}",
            format!("{path}: {e}"),
        )
    }
}

fn read_page(project: &str, path: &str, offset: u64, limit: u64) -> Result<CsvPage, String> {
    let (_root, file) = crate::file_preview::resolve_preview_file(project, path)?;
    let file_bytes = std::fs::metadata(&file).map_err(read_error(path))?.len();
    if file_bytes > CSV_MAX_FILE_BYTES {
        return Err(pix_error_with(
            "csvFileTooLarge",
            "文件过大，无法以表格预览（上限 {limit} MB）",
            json!({ "limit": CSV_MAX_FILE_BYTES / 1024 / 1024 }),
        ));
    }
    // 嗅探只看文件开头一小段（不要求读到首个换行），因此超长首行也不影响。
    let mut head = Vec::with_capacity(SNIFF_BYTES);
    File::open(&file)
        .and_then(|mut handle| {
            handle
                .by_ref()
                .take(SNIFF_BYTES as u64)
                .read_to_end(&mut head)
        })
        .map_err(read_error(path))?;
    let sniff = sniff_delimiter(&head, path);
    let mut handle = File::open(&file).map_err(read_error(path))?;
    scan(&mut handle, &sniff, offset, limit, file_bytes).map_err(read_error(path))
}

#[derive(Debug, Clone, Default)]
struct Sniff {
    delimiter: u8,
    /// Leading BOM bytes to skip before parsing (0 or 3).
    bom_bytes: usize,
}

/// Pick the separator from the **first line** (outside quoted runs, at most
/// [`SNIFF_BYTES`]). Counting the whole file head instead let a data row full
/// of semicolons outvote a comma header and split a legitimate CSV.
/// Ties keep the earlier candidate (comma → tab → semicolon); a file with no
/// candidate falls back to the extension.
fn sniff_delimiter(head: &[u8], path: &str) -> Sniff {
    let bom_bytes = if head.starts_with(BOM) { BOM.len() } else { 0 };
    let body = &head[bom_bytes..];
    let mut counts = [0usize; 3];
    let mut in_quotes = false;
    for &byte in body.iter().take(SNIFF_BYTES) {
        match byte {
            b'"' => in_quotes = !in_quotes,
            b'\n' if !in_quotes => break,
            _ if !in_quotes => {
                if let Some(index) = CANDIDATES.iter().position(|candidate| *candidate == byte) {
                    counts[index] += 1;
                }
            }
            _ => {}
        }
    }
    let mut best: Option<(usize, usize)> = None;
    for (index, count) in counts.iter().enumerate() {
        if *count > 0 && best.is_none_or(|(_, winner)| *count > winner) {
            best = Some((index, *count));
        }
    }
    let delimiter = best.map(|(index, _)| CANDIDATES[index]).unwrap_or_else(|| {
        if crate::file_preview::ext_of(path) == "tsv" {
            b'\t'
        } else {
            b','
        }
    });
    Sniff {
        delimiter,
        bom_bytes,
    }
}

fn delimiter_label(byte: u8) -> String {
    match byte {
        b'\t' => "\\t".into(),
        b';' => ";".into(),
        _ => ",".into(),
    }
}

/// Cut `text` to at most [`CSV_CELL_MAX_CHARS`] chars on a char boundary.
fn char_truncate(text: &str) -> (&str, bool) {
    match text.char_indices().nth(CSV_CELL_MAX_CHARS) {
        Some((index, _)) => (&text[..index], true),
        None => (text, false),
    }
}

/// One completed record: stored (column-capped) cells plus bookkeeping that is
/// maintained even for rows outside the requested window.
struct ParsedRow {
    fields: Vec<String>,
    /// Real field count before the column cap.
    field_count: usize,
    truncated_cells: bool,
}

/// RFC 4180 byte-level state machine. One physical line is never buffered:
/// each byte is consumed as it is read, so memory stays constant regardless of
/// row width and time stays linear in the file size.
struct RowParser {
    delimiter: u8,
    /// Assemble field text only for rows that reach the client.
    collect: bool,
    field: Vec<u8>,
    field_count: usize,
    fields: Vec<String>,
    in_quotes: bool,
    /// A `"` was consumed inside a quoted run and needs one byte of lookahead
    /// to tell an escaped quote (`""`) from the end of the run.
    pending_quote: bool,
    /// A CR was consumed inside a quoted run: CRLF in a cell becomes one LF.
    pending_cr: bool,
    at_field_start: bool,
    cell_truncated: bool,
    /// Any record content seen so far (blank lines have none).
    started: bool,
}

impl RowParser {
    fn new(delimiter: u8) -> Self {
        Self {
            delimiter,
            collect: false,
            field: Vec::new(),
            field_count: 0,
            fields: Vec::new(),
            in_quotes: false,
            pending_quote: false,
            pending_cr: false,
            at_field_start: true,
            cell_truncated: false,
            started: false,
        }
    }

    fn begin_row(&mut self, collect: bool) {
        self.collect = collect;
        self.field.clear();
        self.field_count = 0;
        self.fields.clear();
        self.in_quotes = false;
        self.pending_quote = false;
        self.pending_cr = false;
        self.at_field_start = true;
        self.cell_truncated = false;
        self.started = false;
    }

    fn push(&mut self, byte: u8) {
        self.started = true;
        if !self.collect {
            return;
        }
        if self.field.len() < CELL_MAX_BYTES {
            self.field.push(byte);
        } else {
            self.cell_truncated = true;
        }
    }

    /// A run of ordinary field bytes (no delimiter, newline, CR or quote).
    fn push_run(&mut self, bytes: &[u8]) {
        if bytes.is_empty() {
            return;
        }
        self.started = true;
        self.at_field_start = false;
        if !self.collect {
            return;
        }
        let room = CELL_MAX_BYTES.saturating_sub(self.field.len());
        if bytes.len() <= room {
            self.field.extend_from_slice(bytes);
        } else {
            self.field.extend_from_slice(&bytes[..room]);
            self.cell_truncated = true;
        }
    }

    fn end_field(&mut self) {
        self.field_count += 1;
        if self.collect && self.fields.len() < CSV_MAX_COLUMNS {
            // `String::from_utf8_lossy` on the collected bytes; an unterminated
            // multi-byte sequence at the cap becomes U+FFFD, as before.
            let raw = String::from_utf8_lossy(&self.field).into_owned();
            let (text, cut) = char_truncate(&raw);
            self.cell_truncated |= cut;
            self.fields.push(text.to_owned());
        }
        self.field.clear();
        self.at_field_start = true;
    }

    fn take_row(&mut self) -> ParsedRow {
        ParsedRow {
            fields: std::mem::take(&mut self.fields),
            field_count: self.field_count,
            truncated_cells: self.cell_truncated,
        }
    }

    /// Complete the record currently in the parser (used by the LF branch and
    /// by the end-of-file flush). A cell that was still inside a quoted run
    /// when the file ended may hold an unwritten CR (`"a<CR>` then EOF), and a
    /// trailing `"` may still be waiting for its one-byte lookahead — both must
    /// be written before the field is sealed, otherwise the value silently
    /// loses its last characters. A `pending_quote` at EOF is the run's closing
    /// quote (the file simply ends there) and must **not** be added as content.
    fn finish_record(&mut self) -> ParsedRow {
        if self.pending_cr {
            self.pending_cr = false;
            self.push(b'\r');
        }
        self.pending_quote = false;
        self.in_quotes = false;
        self.end_field();
        self.take_row()
    }
}

/// Rough serialized size of one cell: the UTF-8 bytes, the two quotes JSON adds
/// to every string, and the bytes its escapes consume.
///
/// JSON's short escapes (`\\`, `\"`, `\b`, `\t`, `\n`, `\f`, `\r`)
/// add one byte; every other C0 character (U+0000..U+001F apart from those) is
/// written as a six-byte `\u0001`-style escape, i.e. five extra bytes.
/// Charging control characters a single extra byte let a page of U+0001 cells
/// reach 3.12 MB against the 1 MiB budget, and charging only quotes and
/// backslashes under-counted LF cells by 2x (2.08 MB observed).
fn cell_cost(cell: &str) -> usize {
    let mut cost = cell.len() + 3;
    for c in cell.chars() {
        cost += match c {
            '"' | '\\' => 1,
            '\u{8}' | '\t' | '\n' | '\u{c}' | '\r' => 1,
            c if (c as u32) < 0x20 => 5,
            _ => 0,
        };
    }
    cost
}

fn row_cost(row: &[String]) -> usize {
    row.iter().map(|cell| cell_cost(cell)).sum()
}

/// Keep a row's leading cells while the serialized size fits `budget`.
/// Returns the possibly shortened row and whether any cell was dropped.
fn fit_row(mut fields: Vec<String>, budget: usize) -> (Vec<String>, bool) {
    let mut cost = 0usize;
    let mut keep = 0usize;
    for field in &fields {
        let next = cost + cell_cost(field);
        if keep > 0 && next > budget {
            break;
        }
        cost = next;
        keep += 1;
    }
    if keep < fields.len() {
        fields.truncate(keep.max(1));
        (fields, true)
    } else {
        (fields, false)
    }
}

fn scan<R: Read>(
    reader: &mut R,
    sniff: &Sniff,
    offset: u64,
    limit: u64,
    file_bytes: u64,
) -> std::io::Result<CsvPage> {
    // `limit = 0` means "use the default page size" (a caller that omits `limit`
    // already lands here through `unwrap_or`); both sides agree on that.
    let limit = if limit == 0 {
        CSV_PAGE_DEFAULT_ROWS
    } else {
        limit.min(CSV_PAGE_MAX_ROWS)
    };
    let cap = CSV_PAGE_MAX_BYTES.saturating_sub(PAGE_OVERHEAD_BYTES);
    let mut parser = RowParser::new(sniff.delimiter);
    let mut header: Option<Vec<String>> = None;
    let mut header_cost = 0usize;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total_rows: u64 = 0;
    let mut more = false;
    let mut column_count = 0usize;
    let mut truncated_columns = false;
    let mut truncated_cells = false;
    let mut budget_truncated = false;
    let mut collected_bytes = 0usize;
    let mut budget_exhausted = false;
    // Physical record index; record 0 is the header, so data row = record - 1.
    let mut record: u64 = 0;
    // True at a record boundary: the collect decision is made by the first byte.
    let mut at_boundary = true;
    let mut bom_skip = sniff.bom_bytes;
    let mut stop = false;
    let mut buffer = vec![0u8; READ_CHUNK];

    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let chunk = &buffer[..read];
        let mut i = 0usize;
        while i < chunk.len() {
            if bom_skip > 0 {
                let skip = bom_skip.min(chunk.len() - i);
                bom_skip -= skip;
                i += skip;
                continue;
            }
            if at_boundary {
                let data_row = record.saturating_sub(1);
                let windowed = header.is_some()
                    && !budget_exhausted
                    && data_row >= offset
                    && data_row < offset + limit;
                // The header (first record) is always collected.
                parser.begin_row(header.is_none() || windowed);
                at_boundary = false;
            }

            let byte = chunk[i];

            // 引号内的引号前瞻：块内 `""` 是字面引号，单个引号结束引用块。
            // 收尾引号之前待处理的 CR 属于单元格内容（`"a<CR>"` 的单元格就是 `a<CR>`），
            // 否则它会与后面的记录分隔 LF 配对，把下一条记录吞进同一格。
            if parser.pending_quote {
                parser.pending_quote = false;
                if parser.pending_cr {
                    parser.pending_cr = false;
                    parser.push(b'\r');
                }
                if byte == b'"' {
                    parser.push(b'"');
                    i += 1;
                    continue;
                }
                parser.in_quotes = false;
            }

            // 引用块内：`<CR><LF>` 折叠成一个 LF，其余字节原样保留（CR 也算内容）。
            if parser.in_quotes {
                if byte == b'"' {
                    parser.pending_quote = true;
                } else if byte == b'\r' {
                    if parser.pending_cr {
                        parser.pending_cr = false;
                        parser.push(b'\r');
                    }
                    parser.pending_cr = true;
                } else {
                    if parser.pending_cr {
                        parser.pending_cr = false;
                        if byte == b'\n' {
                            parser.push(b'\n');
                            i += 1;
                            continue;
                        }
                        parser.push(b'\r');
                    }
                    parser.push(byte);
                }
                i += 1;
                continue;
            }

            // 字段起始处的引号开启引用块；字段中间的字面引号是普通内容。
            // 后者必须在这里被消耗掉，否则扫描会在同一位置原地打转
            // （复验的 2 秒超时卡死即此）。
            if byte == b'"' {
                if parser.at_field_start {
                    parser.in_quotes = true;
                    parser.started = true;
                } else {
                    parser.push(b'"');
                }
                parser.at_field_start = false;
                i += 1;
                continue;
            }

            match byte {
                b'\r' => {
                    // CRLF：CR 属于行尾分隔，不算记录内容。
                    i += 1;
                    continue;
                }
                b'\n' => {
                    i += 1;
                    if !parser.started && parser.field_count == 0 {
                        at_boundary = true;
                        continue;
                    }
                    let row = parser.finish_record();
                    at_boundary = true;
                    stop |= finish_record(
                        row,
                        &mut record,
                        &mut header,
                        &mut header_cost,
                        &mut rows,
                        &mut total_rows,
                        &mut more,
                        &mut column_count,
                        &mut truncated_columns,
                        &mut truncated_cells,
                        &mut budget_truncated,
                        &mut collected_bytes,
                        &mut budget_exhausted,
                        offset,
                        limit,
                        cap,
                    );
                    if stop {
                        break;
                    }
                    continue;
                }
                _ if byte == parser.delimiter => {
                    parser.end_field();
                    parser.started = true;
                    i += 1;
                    continue;
                }
                _ => {
                    // 普通字段内容：一次吃掉整段（快路径，减少逐字节开销）。
                    let rest = &chunk[i..];
                    let run = rest
                        .iter()
                        .position(|b| {
                            *b == parser.delimiter || *b == b'\n' || *b == b'\r' || *b == b'"'
                        })
                        .unwrap_or(rest.len());
                    parser.push_run(&rest[..run]);
                    i += run;
                    continue;
                }
            }
        }
        if stop {
            break;
        }
    }

    // 文件没有末尾换行时，最后一条完整记录仍要交付（否则末行会丢）。
    if !at_boundary && parser.started {
        let row = parser.finish_record();
        finish_record(
            row,
            &mut record,
            &mut header,
            &mut header_cost,
            &mut rows,
            &mut total_rows,
            &mut more,
            &mut column_count,
            &mut truncated_columns,
            &mut truncated_cells,
            &mut budget_truncated,
            &mut collected_bytes,
            &mut budget_exhausted,
            offset,
            limit,
            cap,
        );
    }

    Ok(CsvPage {
        offset,
        rows,
        header,
        more,
        total_rows: (offset == 0).then_some(total_rows),
        column_count,
        truncated_columns,
        truncated_cells,
        budget_truncated,
        delimiter: delimiter_label(sniff.delimiter),
        file_bytes,
    })
}

/// Fold one completed record into the page state. Returns whether scanning can
/// stop (a later page already has its window and the budget verdict).
#[allow(clippy::too_many_arguments)]
fn finish_record(
    row: ParsedRow,
    record: &mut u64,
    header: &mut Option<Vec<String>>,
    header_cost: &mut usize,
    rows: &mut Vec<Vec<String>>,
    total_rows: &mut u64,
    more: &mut bool,
    column_count: &mut usize,
    truncated_columns: &mut bool,
    truncated_cells: &mut bool,
    budget_truncated: &mut bool,
    collected_bytes: &mut usize,
    budget_exhausted: &mut bool,
    offset: u64,
    limit: u64,
    cap: usize,
) -> bool {
    if *record == 0 {
        *column_count = (*column_count).max(row.field_count);
        *truncated_columns |= row.field_count > CSV_MAX_COLUMNS;
        *truncated_cells |= row.truncated_cells;
        // 表头也占页字节：不计入预算会让「1 MB 上限」在宽表上不成立。
        let (fields, cut) = fit_row(row.fields, cap / 2);
        *truncated_columns |= cut;
        *header_cost = row_cost(&fields);
        *header = Some(fields);
        *record = 1;
        return false;
    }
    let data_row = *record - 1;
    // 首页本来就要扫完整份文件（为了 total_rows 与整表列数），因此列数与
    // 截断标记对**所有**行累计；后续页只看表头与窗口行。
    if offset == 0 || (data_row >= offset && data_row < offset + limit) {
        *column_count = (*column_count).max(row.field_count);
        *truncated_columns |= row.field_count > CSV_MAX_COLUMNS;
        *truncated_cells |= row.truncated_cells;
    }
    *total_rows += 1;
    let in_window = data_row >= offset && data_row < offset + limit;
    if in_window && !*budget_exhausted {
        let cost = row_cost(&row.fields);
        let page_cost = *header_cost + *collected_bytes + cost;
        if rows.is_empty() {
            // 页里至少要有一行；单行超预算时裁掉尾部单元格而不是返回空页。
            if page_cost > cap {
                let available = cap.saturating_sub(*header_cost);
                let (fields, cut) = fit_row(row.fields, available);
                *truncated_columns |= cut;
                *budget_truncated = true;
                *collected_bytes += row_cost(&fields);
                rows.push(fields);
            } else {
                *collected_bytes += cost;
                rows.push(row.fields);
            }
        } else if page_cost > cap {
            // 预算用尽：停止收集，但行号不变，客户端从 offset + rows.len() 续读。
            *budget_exhausted = true;
            *budget_truncated = true;
            *more = true;
        } else {
            *collected_bytes += cost;
            rows.push(row.fields);
        }
    }
    if !*more && data_row >= offset + limit {
        *more = true;
    }
    *record += 1;
    if offset > 0 && (*budget_exhausted || data_row >= offset + limit) {
        // Later pages need neither the exact total nor a rescan.
        return true;
    }
    false
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn page(csv: &str, offset: u64, limit: u64) -> CsvPage {
        let sniff = sniff_delimiter(csv.as_bytes(), "data.csv");
        scan(
            &mut Cursor::new(csv.as_bytes()),
            &sniff,
            offset,
            limit,
            csv.len() as u64,
        )
        .unwrap()
    }

    fn project() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("pix-csv-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    /// 复验（P1）复现：最后一条记录以引号结束且文件没有末尾换行。
    #[test]
    fn a_missing_trailing_newline_never_loses_the_last_record() {
        let csv = "id,note\n1,one\n2,\"two\"";
        let out = page(csv, 0, 1);
        assert_eq!(
            out.total_rows,
            Some(2),
            "the third record is the 2nd data row"
        );
        assert!(out.more, "a page of 1 row must report the second row");
        let second = page(csv, 1, 1);
        assert_eq!(
            second.rows,
            vec![vec!["2".to_string(), "two".to_string()]],
            "the last row is reachable and unquoted"
        );
        // 也覆盖「没有末尾换行但没有引号」的普通情况。
        let plain = page("id\n1\n2", 0, 10);
        assert_eq!(plain.total_rows, Some(2));
        assert_eq!(plain.rows.len(), 2);
    }

    #[test]
    fn parses_header_and_rows_with_quotes_crlf_and_bom() {
        let csv = "\u{feff}name,note\r\n\"a, b\",\"say \"\"hi\"\"\"\r\nplain,x\r\n";
        let out = page(csv, 0, 10);
        assert_eq!(
            out.header.as_deref(),
            Some(&["name".to_string(), "note".to_string()][..])
        );
        assert_eq!(
            out.rows,
            vec![
                vec!["a, b".to_string(), "say \"hi\"".to_string()],
                vec!["plain".to_string(), "x".to_string()]
            ]
        );
        assert_eq!(out.total_rows, Some(2));
        assert_eq!(out.column_count, 2);
        assert!(!out.more);
        assert_eq!(out.delimiter, ",");
    }

    #[test]
    fn bom_stripping_and_quoting_agree_with_the_node_twin() {
        let out = page("\u{feff}\"id\",note\n1,2\n", 0, 10);
        assert_eq!(
            out.header.as_deref(),
            Some(&["id".to_string(), "note".to_string()][..])
        );
        assert_eq!(out.delimiter, ",");
    }

    #[test]
    fn quoted_cells_may_span_physical_lines_without_shifting_indexes() {
        let csv = "id,body\n1,\"line one\nline two\"\n2,flat\n3,flat\n";
        let out = page(csv, 0, 10);
        assert_eq!(out.rows.len(), 3);
        assert_eq!(out.rows[0][1], "line one\nline two");
        assert_eq!(out.rows[2][0], "3");
        let first = page(csv, 0, 1);
        assert!(first.more);
        let second = page(csv, 1, 1);
        assert_eq!(second.rows, vec![vec!["2".to_string(), "flat".to_string()]]);
        assert_eq!(second.total_rows, None);
    }

    #[test]
    fn blank_lines_are_not_records_and_lone_quote_cells_are_kept() {
        let csv = "a,b\n\n1,2\n\"\",x\n";
        let out = page(csv, 0, 10);
        assert_eq!(out.total_rows, Some(2));
        assert_eq!(out.rows[1], vec![String::new(), "x".to_string()]);
    }

    /// 复验（P2）复现：表头是逗号分隔、数据行里有很多分号，不能被误判成分号。
    #[test]
    fn data_rows_never_outvote_the_header_when_sniffing() {
        let csv = "id,note\n1,a;b;c;d\n";
        let out = page(csv, 0, 10);
        assert_eq!(out.delimiter, ",");
        assert_eq!(out.column_count, 2);
        assert_eq!(out.rows, vec![vec!["1".to_string(), "a;b;c;d".to_string()]]);
        // 反向同理：制表符表头不会被数据行里的逗号挤掉。
        let tab = page("a\tb\n1,x,y,z\n", 0, 10);
        assert_eq!(tab.delimiter, "\\t");
        assert_eq!(tab.column_count, 2);
    }

    #[test]
    fn delimiter_sniffing_matches_the_node_twin() {
        assert_eq!(
            page("a\tb\tc\n1\t2\t3\n", 0, 10).delimiter,
            "\\t",
            "tab wins on count"
        );
        assert_eq!(page("a;b;c\n1;2;3\n", 0, 10).delimiter, ";");
        // 平票时按 逗号 → 制表符 → 分号 的优先级，Node 侧同序。
        assert_eq!(sniff_delimiter(b"a,b;c\n", "x.csv").delimiter, b',');
        assert_eq!(sniff_delimiter(b"a\tb;c\n", "x.csv").delimiter, b'\t');
        assert_eq!(sniff_delimiter(b"a;b\tc\n", "x.csv").delimiter, b'\t');
        assert_eq!(sniff_delimiter(b"\"a;b;c\",d\n", "x.csv").delimiter, b',');
        assert_eq!(sniff_delimiter(b"single\n", "x.tsv").delimiter, b'\t');
        assert_eq!(sniff_delimiter(b"single\n", "x.csv").delimiter, b',');
        let sniff = sniff_delimiter("\u{feff}a,b\n".as_bytes(), "x.csv");
        assert_eq!(sniff.bom_bytes, BOM.len());
        assert_eq!(sniff.delimiter, b',');
        // 超长首行也只嗅探前 8 KB（不要求读到换行）。
        let mut head = vec![b'a'; SNIFF_BYTES * 2];
        head[5] = b',';
        assert_eq!(sniff_delimiter(&head, "x.csv").delimiter, b',');
    }

    #[test]
    fn rows_wider_than_the_column_cap_report_the_real_count() {
        let header = (0..CSV_MAX_COLUMNS)
            .map(|i| format!("c{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let wide = (0..CSV_MAX_COLUMNS + 5)
            .map(|i| format!("v{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let csv = format!("{header}\n{wide}\n");
        let out = page(&csv, 0, 10);
        assert_eq!(out.column_count, CSV_MAX_COLUMNS + 5);
        assert!(out.truncated_columns);
        assert_eq!(out.rows[0].len(), CSV_MAX_COLUMNS, "cells are capped");
    }

    #[test]
    fn a_wide_row_outside_the_first_page_still_shows_up_on_the_first_page() {
        let mut csv = String::from("id\n");
        for row in 0..500 {
            csv.push_str(&format!("r{row}\n"));
        }
        let wide = (0..CSV_MAX_COLUMNS + 1)
            .map(|i| format!("v{i}"))
            .collect::<Vec<_>>()
            .join(",");
        csv.push_str(&format!("{wide}\n"));
        let out = page(&csv, 0, 500);
        assert_eq!(out.total_rows, Some(501));
        assert_eq!(out.column_count, CSV_MAX_COLUMNS + 1);
        assert!(out.truncated_columns);
    }

    #[test]
    fn long_cells_are_cut_on_a_char_boundary() {
        let long = "中".repeat(CSV_CELL_MAX_CHARS + 10);
        let csv = format!("id,text\n1,{long}\n");
        let out = page(&csv, 0, 10);
        assert_eq!(out.rows[0][1].chars().count(), CSV_CELL_MAX_CHARS);
        assert!(out.truncated_cells);
    }

    #[test]
    fn exactly_the_cell_cap_is_not_truncated() {
        let emoji = "😀".repeat(CSV_CELL_MAX_CHARS);
        let out = page(&format!("id,text\n1,{emoji}\n"), 0, 10);
        assert_eq!(out.rows[0][1].chars().count(), CSV_CELL_MAX_CHARS);
        assert!(!out.truncated_cells, "exact cap is not a truncation");
    }

    #[test]
    fn page_size_zero_uses_the_default_and_huge_values_the_cap() {
        let mut csv = String::from("id\n");
        for i in 0..CSV_PAGE_MAX_ROWS + 20 {
            csv.push_str(&format!("{i}\n"));
        }
        assert_eq!(page(&csv, 0, 0).rows.len(), CSV_PAGE_DEFAULT_ROWS as usize);
        let out = page(&csv, 0, u64::MAX);
        assert_eq!(out.rows.len(), CSV_PAGE_MAX_ROWS as usize);
        assert!(out.more);
        assert_eq!(out.total_rows, Some(CSV_PAGE_MAX_ROWS + 20));
    }

    /// 128 列 × 4096 字符的行：单行序列化约 0.5 MB（ASCII）或 1.5 MB（中文）。
    /// 首列是行号，其余 127 列填 `cell`。
    fn wide_rows(row_count: usize, cell: &str) -> String {
        let header = (0..CSV_MAX_COLUMNS)
            .map(|i| format!("c{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let cells = (0..CSV_MAX_COLUMNS - 1)
            .map(|_| cell.to_string())
            .collect::<Vec<_>>()
            .join(",");
        let mut csv = String::from(&header);
        csv.push('\n');
        for row in 0..row_count {
            csv.push_str(&format!("{row},{cells}\n"));
        }
        csv
    }

    fn assert_page_fits(page: &CsvPage) {
        let serialized = serde_json::to_vec(page).unwrap().len();
        assert!(
            serialized <= CSV_PAGE_MAX_BYTES,
            "serialized page {serialized} must stay inside {CSV_PAGE_MAX_BYTES}"
        );
    }

    #[test]
    fn the_byte_budget_trims_a_page_without_skipping_rows() {
        let csv = wide_rows(40, &"x".repeat(CSV_CELL_MAX_CHARS));
        let first = page(&csv, 0, 500);
        assert_page_fits(&first);
        assert!(first.budget_truncated);
        assert!(first.more);
        assert!(!first.rows.is_empty());
        assert!(
            first.rows.len() < 40,
            "the budget must cut the page before 40 rows: {}",
            first.rows.len()
        );
        let next = page(&csv, first.rows.len() as u64, 500);
        assert_eq!(
            next.rows[0][0],
            first.rows.len().to_string(),
            "the next page starts exactly after the trimmed one (no skipped row)"
        );
    }

    /// 复验（P1）复现：每格 4096 个 3 字节汉字时，旧实现返回 3.1 MB。
    #[test]
    fn wide_cjk_cells_stay_inside_the_byte_budget() {
        let csv = wide_rows(40, &"界".repeat(CSV_CELL_MAX_CHARS));
        let first = page(&csv, 0, 500);
        let size = serde_json::to_vec(&first).unwrap().len();
        println!("cjk wide page: {} rows, {} B", first.rows.len(), size);
        assert_page_fits(&first);
        assert!(first.budget_truncated);
        assert_eq!(first.rows.len(), 1, "only one 1.5 MB row fits");
        let next = page(&csv, 1, 500);
        assert_eq!(next.rows[0][0], "1", "no row is skipped by the budget");
        // 单行也超预算时裁掉尾部单元格，而不是返回空页。
        assert!(first.rows[0].len() < CSV_MAX_COLUMNS);
    }

    #[test]
    fn the_header_also_counts_against_the_page_budget() {
        // 128 列 × 4096 汉字的表头本身就 1.5 MB：裁到预算内，页面仍可用。
        let header = (0..CSV_MAX_COLUMNS)
            .map(|i| format!("c{i}") + &"界".repeat(CSV_CELL_MAX_CHARS))
            .collect::<Vec<_>>()
            .join(",");
        let out = page(&format!("{header}\n1,2\n"), 0, 10);
        assert_page_fits(&out);
        assert!(out.header.as_ref().unwrap().len() <= CSV_MAX_COLUMNS);
        assert!(out.truncated_columns || out.header.as_ref().unwrap().len() < CSV_MAX_COLUMNS);
        assert_eq!(
            out.rows.len(),
            1,
            "a trimmed header still leaves room for a row"
        );
    }

    #[test]
    fn at_least_one_row_is_always_returned() {
        let csv = wide_rows(3, &"x".repeat(CSV_CELL_MAX_CHARS));
        let out = page(&csv, 0, 1);
        assert_eq!(out.rows.len(), 1, "a one-row page still returns that row");
        assert!(out.more);
    }

    #[test]
    fn a_very_long_physical_line_is_parsed_in_constant_memory() {
        let long = "z".repeat(8 * 1024 * 1024);
        let csv = format!("id,text\n1,{long}\n");
        let started = std::time::Instant::now();
        let out = page(&csv, 0, 10);
        assert_eq!(out.rows[0][1].len(), CSV_CELL_MAX_CHARS);
        assert!(out.truncated_cells);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(5),
            "8 MB row took {:?}",
            started.elapsed()
        );
    }

    #[test]
    fn reading_a_project_file_follows_the_shared_path_guard() {
        let root = project();
        std::fs::write(root.join("data.csv"), "a,b\n1,2\n").unwrap();
        let out = read_page(&root.to_string_lossy(), "data.csv", 0, 10).unwrap();
        assert_eq!(out.rows, vec![vec!["1".to_string(), "2".to_string()]]);
        assert_eq!(out.file_bytes, 8);
        for bad in ["../data.csv", "/etc/passwd", "missing.csv", ""] {
            let err = read_page(&root.to_string_lossy(), bad, 0, 10).unwrap_err();
            assert!(
                err.contains("previewPathInvalid") || err.contains("previewReadFailed"),
                "{bad}: {err}"
            );
        }
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn oversized_files_are_refused_before_parsing() {
        let root = project();
        let file = root.join("huge.csv");
        std::fs::write(&file, "a\n").unwrap();
        let handle = std::fs::OpenOptions::new().write(true).open(&file).unwrap();
        handle.set_len(CSV_MAX_FILE_BYTES + 1).unwrap();
        let err = read_page(&root.to_string_lossy(), "huge.csv", 0, 10).unwrap_err();
        assert!(err.contains("csvFileTooLarge"), "{err}");
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]
mod perf_tests {
    use super::*;
    use std::io::Write;

    /// 合成 `rows` 行 CSV，写进临时目录并返回其根。
    fn synthetic(rows: u32) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("pix-csv-perf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("million.csv");
        let mut handle = std::fs::File::create(&file).unwrap();
        writeln!(handle, "id,name,amount,note").unwrap();
        for row in 0..rows {
            writeln!(
                handle,
                "{row},name{row},{}.{},备注 row {row}",
                row % 997,
                row % 13
            )
            .unwrap();
        }
        drop(handle);
        root
    }

    /// 同一进程内重复测量：返回每次耗时（毫秒），用于报告「中位数/最差」而不是
    /// 单次最佳值。运行：
    /// cargo test --release --manifest-path src-tauri/Cargo.toml csv_perf -- --ignored --nocapture
    #[test]
    #[ignore]
    fn csv_perf_million_rows() {
        let root = synthetic(1_000_000);
        let bytes = std::fs::metadata(root.join("million.csv")).unwrap().len();
        println!(
            "synthetic csv: {} rows, {:.1} MB",
            1_000_000,
            bytes as f64 / 1e6
        );
        let mut first_ms = Vec::new();
        let mut tail_ms = Vec::new();
        for _ in 0..5 {
            let started = std::time::Instant::now();
            let page = read_page(&root.to_string_lossy(), "million.csv", 0, 500).unwrap();
            first_ms.push(started.elapsed().as_millis() as u64);
            assert_eq!(page.rows.len(), 500);
            assert_eq!(page.total_rows, Some(1_000_000));
            assert!(page.more);

            let started = std::time::Instant::now();
            let page = read_page(&root.to_string_lossy(), "million.csv", 999_000, 500).unwrap();
            tail_ms.push(started.elapsed().as_millis() as u64);
            assert_eq!(page.rows.len(), 500);
            let payload = serde_json::to_vec(&page).unwrap().len();
            println!("page payload: {} KB", payload / 1024);
            assert!(payload < CSV_PAGE_MAX_BYTES);
        }
        println!("first page ms: {first_ms:?}");
        println!("tail page ms: {tail_ms:?}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[ignore]
    fn csv_perf_one_giant_row_stays_linear() {
        let root = std::env::temp_dir().join(format!("pix-csv-long-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("long.csv");
        let mut handle = std::fs::File::create(&file).unwrap();
        write!(handle, "id,text\n1,").unwrap();
        let chunk = "z".repeat(1024 * 1024);
        for _ in 0..128 {
            handle.write_all(chunk.as_bytes()).unwrap();
        }
        handle.write_all(b"\n2,end\n").unwrap();
        drop(handle);
        let started = std::time::Instant::now();
        let page = read_page(&root.to_string_lossy(), "long.csv", 0, 500).unwrap();
        println!("128 MiB single row: {:?}", started.elapsed());
        assert_eq!(page.rows.len(), 2);
        assert_eq!(page.total_rows, Some(2));
        assert!(page.truncated_cells);
        assert!(serde_json::to_vec(&page).unwrap().len() <= CSV_PAGE_MAX_BYTES);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    #[ignore]
    fn csv_perf_wide_long_cells_stay_under_the_transport_limit() {
        let root = std::env::temp_dir().join(format!("pix-csv-wide-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("wide.csv");
        let header = (0..CSV_MAX_COLUMNS)
            .map(|i| format!("c{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let cell = "a".repeat(CSV_CELL_MAX_CHARS);
        let mut handle = std::fs::File::create(&file).unwrap();
        writeln!(handle, "{header}").unwrap();
        for _ in 0..40 {
            let row = (0..CSV_MAX_COLUMNS)
                .map(|_| cell.clone())
                .collect::<Vec<_>>()
                .join(",");
            writeln!(handle, "{row}").unwrap();
        }
        drop(handle);
        let started = std::time::Instant::now();
        let page = read_page(&root.to_string_lossy(), "wide.csv", 0, 500).unwrap();
        let payload = serde_json::to_vec(&page).unwrap().len();
        println!(
            "wide page: {} rows, payload {:.2} MB, {:?}",
            page.rows.len(),
            payload as f64 / 1e6,
            started.elapsed()
        );
        assert!(page.budget_truncated);
        assert!(payload <= CSV_PAGE_MAX_BYTES);
        assert!(
            payload < crate::ssh::transport::MAX_EXEC_OUTPUT_BYTES,
            "one page must fit the SSH exec output limit"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}

#[cfg(test)]
mod repro_tests {
    use super::*;
    use std::io::Cursor;
    use std::time::{Duration, Instant};

    fn page(csv: &str, offset: u64, limit: u64) -> CsvPage {
        let sniff = sniff_delimiter(csv.as_bytes(), "data.csv");
        scan(
            &mut Cursor::new(csv.as_bytes()),
            &sniff,
            offset,
            limit,
            csv.len() as u64,
        )
        .unwrap()
    }

    /// 复验 P1：字段中间的字面引号曾让扫描原地打转（探针 2s 超时、无输出）。
    #[test]
    fn a_literal_quote_mid_field_never_stalls_the_scan() {
        let started = Instant::now();
        let out = page("id,note\n1,a\"b\n", 0, 10);
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "scan must terminate quickly, took {:?}",
            started.elapsed()
        );
        assert_eq!(out.total_rows, Some(1));
        assert_eq!(out.rows, vec![vec!["1".to_string(), "a\"b".to_string()]]);
        // 连续多个字面引号同样不能卡住。
        let started = Instant::now();
        let many = page("id\n1\na\"\"\"\"b\n", 0, 10);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(many.rows.len(), 2);
    }

    /// 复验 P1：引用块内孤立 CR 曾是内容，收尾引号后却与记录分隔 LF 配对，
    /// 把下一条记录吞进同一格。
    #[test]
    fn a_lone_cr_inside_quotes_never_swallows_the_next_record() {
        let out = page("id,note\n1,\"a\r\"\n2,b\n", 0, 10);
        assert_eq!(out.total_rows, Some(2));
        assert_eq!(
            out.rows,
            vec![
                vec!["1".to_string(), "a\r".to_string()],
                vec!["2".to_string(), "b".to_string()]
            ]
        );
    }

    /// 复验 P1（EOF 边界）：引用块在文件末尾直接结束时，尚未落盘的 CR 也是内容。
    #[test]
    fn a_quoted_cell_ending_in_cr_before_eof_keeps_that_cr() {
        let csv = format!("id,note\n1,\"a\r\"");
        let out = page(&csv, 0, 10);
        assert_eq!(out.total_rows, Some(1));
        assert_eq!(out.rows, vec![vec!["1".to_string(), format!("a\r")]]);
        // 结尾引号只是引用块的收尾，不能被当成内容追加。
        let plain = page(&format!("id,note\n1,\"a\""), 0, 10);
        assert_eq!(plain.rows, vec![vec!["1".to_string(), "a".to_string()]]);
    }

    /// 复验 P1（连续 CR 边界）：`pending_cr` 只有一个槽位，连续两个 CR 都必须保留。
    #[test]
    fn consecutive_crs_inside_quotes_are_all_kept() {
        let csv = format!("id,note\n1,\"a\r\r\"\n2,b\n");
        let out = page(&csv, 0, 10);
        assert_eq!(out.total_rows, Some(2));
        assert_eq!(
            out.rows,
            vec![
                vec!["1".to_string(), format!("a\r\r")],
                vec!["2".to_string(), "b".to_string()]
            ]
        );
    }

    /// 复验 P1：U+0001 / U+001F 序列化为 6 字节 `\uXXXX`，旧的「控制字符只 +1」
    /// 估算让整页到 3.12 MB，必须计满 5 字节额外开销。
    #[test]
    fn six_byte_control_escapes_count_against_the_page_budget() {
        for code in [1u32, 0x1f] {
            let unit = char::from_u32(code).unwrap();
            let cell = unit.to_string().repeat(CSV_CELL_MAX_CHARS);
            let header = (0..CSV_MAX_COLUMNS)
                .map(|i| format!("c{i}"))
                .collect::<Vec<_>>()
                .join(",");
            let cells = (0..CSV_MAX_COLUMNS - 1)
                .map(|_| format!("\"{cell}\""))
                .collect::<Vec<_>>()
                .join(",");
            let mut csv = String::from(&header);
            csv.push('\n');
            for row in 0..3 {
                csv.push_str(&format!("{row},{cells}\n"));
            }
            let out = page(&csv, 0, 500);
            let serialized = serde_json::to_vec(&out).unwrap().len();
            println!("U+{code:04X} page: {} rows, {serialized} B", out.rows.len());
            assert!(
                serialized <= CSV_PAGE_MAX_BYTES,
                "U+{code:04X} page {serialized} must stay inside {CSV_PAGE_MAX_BYTES}"
            );
            assert!(out.budget_truncated);
            let next = page(&csv, out.rows.len() as u64, 500);
            assert_eq!(next.rows[0][0], out.rows.len().to_string());
        }
    }

    /// 复验 P1：JSON 控制字符（LF 等）转义后每字符 2 字节，旧估算只算双引号和
    /// 反斜杠，128 列 × 4096 个 LF 的首页实测 2.08 MB，远超 1 MiB 预算。
    #[test]
    fn control_characters_count_against_the_page_budget() {
        let cell = "\n".repeat(CSV_CELL_MAX_CHARS);
        let header = (0..CSV_MAX_COLUMNS)
            .map(|i| format!("c{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let cells = (0..CSV_MAX_COLUMNS - 1)
            .map(|_| format!("\"{cell}\""))
            .collect::<Vec<_>>()
            .join(",");
        let mut csv = String::from(&header);
        csv.push('\n');
        for row in 0..3 {
            csv.push_str(&format!("{row},{cells}\n"));
        }
        let out = page(&csv, 0, 500);
        let serialized = serde_json::to_vec(&out).unwrap().len();
        println!(
            "control-char page: {} rows, {} B",
            out.rows.len(),
            serialized
        );
        assert!(
            serialized <= CSV_PAGE_MAX_BYTES,
            "serialized page {serialized} must stay inside {CSV_PAGE_MAX_BYTES}"
        );
        assert!(out.budget_truncated);
        let next = page(&csv, out.rows.len() as u64, 500);
        assert_eq!(
            next.rows[0][0],
            out.rows.len().to_string(),
            "no row skipped by the budget"
        );
    }
}
