//! CSV/TSV table preview for the project-files sidebar.
//!
//! A large delimited file must never travel through one JSON payload, so each
//! request parses the file streamingly and returns one bounded page of rows
//! plus file-level metadata (header, row count, column count). The renderer
//! keeps only a window of rows, and this module keeps the IPC payload bounded
//! as well: at most [`CSV_PAGE_MAX_ROWS`] rows, [`CSV_MAX_COLUMNS`] columns,
//! [`CSV_CELL_MAX_CHARS`] characters per cell and [`CSV_PAGE_MAX_BYTES`]
//! serialized bytes per response.
//!
//! Parsing is a byte-level state machine fed in fixed-size chunks: a physical
//! line is never buffered whole, so a single 100 MB row costs constant memory
//! and linear time (the previous line-at-a-time reader copied the unterminated
//! prefix once per chunk, i.e. quadratic in line length).
//!
//! Rules (RFC 4180, lenient; identical in the Node twin
//! `src-tauri/resources/remote_files.mjs` and the client parser
//! `src/lib/csvTable.ts`):
//!
//! * `"` only opens a quoted run at the start of a field; `""` inside a run is
//!   a literal quote; the delimiter and line breaks inside a run are content.
//! * A trailing CR outside a quoted run is dropped (CRLF), a bare LF ends the
//!   record, a CR/LF inside a quoted run stays in the cell.
//! * Empty physical lines outside a quoted run are not records.
//! * A leading UTF-8 BOM is dropped before any parsing.
//! * The delimiter is sniffed from the first [`SNIFF_BYTES`] bytes outside
//!   quoted runs; ties prefer comma, then tab, then semicolon; a single-column
//!   file falls back to the extension.
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
/// Serialized size budget for one page. Kept far below the 16 MiB SSH exec
/// output limit (`ssh::transport::MAX_EXEC_OUTPUT_BYTES`) so a page of wide or
/// long cells can never fail the transport: the page is trimmed instead and
/// reports `more`, and the client continues from `offset + rows.len()`.
pub const CSV_PAGE_MAX_BYTES: usize = 1024 * 1024;
/// Byte budget behind the character cap above (6 bytes per char keeps the cap
/// exact for UTF-8 while still bounding a pathological single-cell file).
const CELL_MAX_BYTES: usize = CSV_CELL_MAX_CHARS * 6;
/// Bytes inspected when sniffing the delimiter (never the whole first line).
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

/// Pick the separator by counting candidates in the first bytes of the file,
/// ignoring quoted runs. Ties prefer comma, then tab, then semicolon; a file
/// with no candidate falls back to the extension.
fn sniff_delimiter(head: &[u8], path: &str) -> Sniff {
    let bom_bytes = if head.starts_with(BOM) { BOM.len() } else { 0 };
    let body = &head[bom_bytes..];
    let mut counts = [0usize; 3];
    let mut in_quotes = false;
    for &byte in body.iter().take(SNIFF_BYTES) {
        match byte {
            b'"' => in_quotes = !in_quotes,
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
        // 平票保留先出现的候选（逗号 → 制表符 → 分号），与 Node 侧同序。
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

enum Feed {
    /// The byte was consumed; the record continues.
    Continues,
    Row(ParsedRow),
    /// Empty physical line outside any quoted run: not a record.
    Blank,
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
    /// Any byte seen in the current record (blank lines have none).
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

    fn feed(&mut self, byte: u8) -> Feed {
        if self.pending_quote {
            self.pending_quote = false;
            if byte == b'"' {
                self.push(b'"');
                return Feed::Continues;
            }
            // The run ended: this byte is ordinary content, not a quote.
            self.in_quotes = false;
        }
        {
            if self.pending_cr {
                self.pending_cr = false;
                if byte == b'\n' {
                    // CRLF inside a cell collapses to a single LF.
                    self.push(b'\n');
                    return Feed::Continues;
                }
                // A lone CR stays as CR; fall through to handle this byte.
                self.push(b'\r');
            }
            if self.in_quotes {
                if byte == b'"' {
                    self.pending_quote = true;
                    return Feed::Continues;
                }
                if byte == b'\r' {
                    self.pending_cr = true;
                    return Feed::Continues;
                }
                // Content bytes keep their LF (hard line break in a cell).
                self.push(byte);
                return Feed::Continues;
            }
            match byte {
                b'"' if self.at_field_start => {
                    self.in_quotes = true;
                    self.at_field_start = false;
                    self.started = true;
                    return Feed::Continues;
                }
                b'\n' => {
                    if !self.started && self.field_count == 0 {
                        return Feed::Blank;
                    }
                    self.end_field();
                    return Feed::Row(self.take_row());
                }
                // CRLF: the CR outside a quoted run is dropped, LF ends the record.
                b'\r' => return Feed::Continues,
                b if b == self.delimiter => {
                    self.end_field();
                    self.started = true;
                    return Feed::Continues;
                }
                _ => {
                    self.push(byte);
                    self.at_field_start = false;
                    return Feed::Continues;
                }
            }
        }
    }
}

/// Rough serialized size of one cell: the UTF-8 bytes, the quotes JSON adds,
/// and one byte per character that needs escaping. The estimator only feeds the
/// page byte budget, so a few percent of slack is fine.
fn cell_cost(cell: &str) -> usize {
    cell.len() + 3 + cell.bytes().filter(|b| *b == b'"' || *b == b'\\').count()
}

fn row_cost(row: &[String]) -> usize {
    row.iter().map(|cell| cell_cost(cell)).sum()
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
    let mut parser = RowParser::new(sniff.delimiter);
    let mut header: Option<Vec<String>> = None;
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
    let mut buffer = vec![0u8; READ_CHUNK];

    'read: loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        for &byte in &buffer[..read] {
            if bom_skip > 0 {
                bom_skip -= 1;
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
            match parser.feed(byte) {
                Feed::Continues => continue,
                Feed::Blank => {
                    at_boundary = true;
                    continue;
                }
                Feed::Row(row) => {
                    at_boundary = true;
                    if record == 0 {
                        header = Some(row.fields);
                        column_count = column_count.max(row.field_count);
                        truncated_columns |= row.field_count > CSV_MAX_COLUMNS;
                        truncated_cells |= row.truncated_cells;
                        record = 1;
                        continue;
                    }
                    let data_row = record - 1;
                    // 首页本来就要扫完整份文件（为了 total_rows 与整表列数），
                    // 因此列数与截断标记对**所有**行累计；后续页只看表头与窗口行。
                    if offset == 0 || (data_row >= offset && data_row < offset + limit) {
                        column_count = column_count.max(row.field_count);
                        truncated_columns |= row.field_count > CSV_MAX_COLUMNS;
                        truncated_cells |= row.truncated_cells;
                    }
                    total_rows += 1;
                    let in_window = data_row >= offset && data_row < offset + limit;
                    if in_window && !budget_exhausted {
                        let cost = row_cost(&row.fields);
                        if !rows.is_empty() && collected_bytes + cost > CSV_PAGE_MAX_BYTES {
                            // Byte budget reached: stop collecting but keep the
                            // row index intact, the client continues from here.
                            budget_exhausted = true;
                            budget_truncated = true;
                            more = true;
                        } else {
                            collected_bytes += cost;
                            rows.push(row.fields);
                        }
                    }
                    if !more && data_row >= offset + limit {
                        more = true;
                    }
                    if offset > 0 && (budget_exhausted || data_row >= offset + limit) {
                        // Later pages need neither the exact total nor a rescan.
                        break 'read;
                    }
                    record += 1;
                }
            }
        }
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
        // BOM + 引号表头：BOM 只剥一次，表头单元格不带字面引号。
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
        assert!(first.more, "second record exists past the one-row window");
        let second = page(csv, 1, 1);
        assert_eq!(second.rows, vec![vec!["2".to_string(), "flat".to_string()]]);
        assert_eq!(
            second.total_rows, None,
            "later pages do not rescan the whole file"
        );
    }

    #[test]
    fn blank_lines_are_not_records_and_lone_quote_cells_are_kept() {
        let csv = "a,b\n\n1,2\n\"\",x\n";
        let out = page(csv, 0, 10);
        assert_eq!(out.total_rows, Some(2));
        assert_eq!(out.rows[1], vec![String::new(), "x".to_string()]);
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
        // 制表符与分号平票时制表符优先（逗号 > 制表符 > 分号）。
        assert_eq!(sniff_delimiter(b"a\tb;c\n", "x.csv").delimiter, b'\t');
        assert_eq!(sniff_delimiter(b"a;b\tc\n", "x.csv").delimiter, b'\t');
        // 引号内的分隔符不参与嗅探。
        assert_eq!(sniff_delimiter(b"\"a;b;c\",d\n", "x.csv").delimiter, b',');
        // 单列文件按扩展名回退。
        assert_eq!(sniff_delimiter(b"single\n", "x.tsv").delimiter, b'\t');
        assert_eq!(sniff_delimiter(b"single\n", "x.csv").delimiter, b',');
        // 只有开头的 BOM 被标记跳过，且不影响嗅探。
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
        // 回归（验收 P2）：首页必须报出整表的真实列数，而不只是首屏窗口里的列数。
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
        // 回归（验收 P2）：正好 4096 个 4 字节 emoji 既不算截断，也不该多切一刀。
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

    /// 首列是行号、其余 127 列各 4096 字符：单行序列化约 0.5 MB，两行就会越
    /// 过 1 MB 预算，同时行号让「下一页从哪一行开始」可直接断言。
    fn wide_rows(row_count: usize) -> String {
        let header = (0..CSV_MAX_COLUMNS)
            .map(|i| format!("c{i}"))
            .collect::<Vec<_>>()
            .join(",");
        let cell = "x".repeat(CSV_CELL_MAX_CHARS);
        let cells = (0..CSV_MAX_COLUMNS - 1)
            .map(|_| cell.clone())
            .collect::<Vec<_>>()
            .join(",");
        let mut csv = String::from(&header);
        csv.push('\n');
        for row in 0..row_count {
            csv.push_str(&format!("{row},{cells}\n"));
        }
        csv
    }

    #[test]
    fn the_byte_budget_trims_a_page_without_skipping_rows() {
        // 回归（验收 P1）：一页的序列化字节必须有界，且下一段页码不丢行。
        let csv = wide_rows(40);
        let first = page(&csv, 0, 500);
        assert!(first.budget_truncated, "wide cells exceed the budget");
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
        let serialized = serde_json::to_vec(&first).unwrap().len();
        assert!(
            serialized <= CSV_PAGE_MAX_BYTES + 64 * 1024,
            "page payload {serialized} must stay near the budget"
        );
    }

    #[test]
    fn at_least_one_row_is_always_returned() {
        // 预算不能把「一行都放不下」变成空页：第一行总是收下。
        let csv = wide_rows(3);
        let out = page(&csv, 0, 1);
        assert_eq!(out.rows.len(), 1, "a one-row page still returns that row");
        assert!(out.more);
        assert!(
            !out.budget_truncated,
            "limit cut it first, not the byte budget"
        );
    }

    #[test]
    fn a_very_long_physical_line_is_parsed_in_constant_memory() {
        // 回归（验收 P1）：一整个 8 MB 的单行不应被逐块反复拷贝（旧实现是
        // O(n^2)），这里验证正确性，并用宽松时限固定「不随行长爆炸」。
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
        // 稀疏文件：只改长度，不写真实数据。
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

    /// 合成 100 万行 CSV（约 40 MB），测首屏整表扫描、中段分页与载荷上界。
    /// dev profile（opt-level 0）计时，因此是**上界**，不是 release 实测值。
    /// 运行：cargo test --manifest-path src-tauri/Cargo.toml csv_perf -- --ignored --nocapture
    #[test]
    #[ignore]
    fn csv_perf_million_rows() {
        let root = std::env::temp_dir().join(format!("pix-csv-perf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("million.csv");
        let mut handle = std::fs::File::create(&file).unwrap();
        writeln!(handle, "id,name,amount,note").unwrap();
        for row in 0..1_000_000u32 {
            writeln!(
                handle,
                "{row},name{row},{}.{},备注 row {row}",
                row % 997,
                row % 13
            )
            .unwrap();
        }
        drop(handle);
        let bytes = std::fs::metadata(&file).unwrap().len();
        println!(
            "synthetic csv: {} rows, {:.1} MB",
            1_000_000,
            bytes as f64 / 1e6
        );

        let first = std::time::Instant::now();
        let page = read_page(&root.to_string_lossy(), "million.csv", 0, 500).unwrap();
        println!("first page (offset 0, full scan): {:?}", first.elapsed());
        assert_eq!(page.rows.len(), 500);
        assert_eq!(page.total_rows, Some(1_000_000));
        assert!(page.more);

        let mid = std::time::Instant::now();
        let page = read_page(&root.to_string_lossy(), "million.csv", 999_000, 500).unwrap();
        println!("tail page (offset 999000): {:?}", mid.elapsed());
        assert_eq!(page.rows.len(), 500, "last page is full: 1000000 data rows");

        let payload = serde_json::to_vec(&page).unwrap();
        println!("page payload: {} KB", payload.len() / 1024);
        assert!(payload.len() < CSV_PAGE_MAX_BYTES);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 单行 128 MiB：旧实现按块重复拼接未结束的行（O(n²)），在本机 20s 时限内
    /// 没有任何输出；现在逐字节消费，耗时与字节数线性相关。
    #[test]
    #[ignore]
    fn csv_perf_one_giant_row_stays_linear() {
        let root = std::env::temp_dir().join(format!("pix-csv-long-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let file = root.join("long.csv");
        let mut handle = std::fs::File::create(&file).unwrap();
        write!(
            handle,
            "id,text
1,"
        )
        .unwrap();
        let chunk = "z".repeat(1024 * 1024);
        for _ in 0..128 {
            handle.write_all(chunk.as_bytes()).unwrap();
        }
        handle
            .write_all(
                b"
2,end
",
            )
            .unwrap();
        drop(handle);
        let started = std::time::Instant::now();
        let page = read_page(&root.to_string_lossy(), "long.csv", 0, 500).unwrap();
        println!("128 MiB single row: {:?}", started.elapsed());
        assert_eq!(
            page.rows.len(),
            2,
            "the row after the giant one is still indexed"
        );
        assert_eq!(page.total_rows, Some(2));
        assert!(page.truncated_cells);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(20),
            "linear parse must finish well inside the SSH exec timeout"
        );
        let payload = serde_json::to_vec(&page).unwrap();
        println!("giant-row page payload: {} KB", payload.len() / 1024);
        assert!(payload.len() < CSV_PAGE_MAX_BYTES);
        std::fs::remove_dir_all(&root).unwrap();
    }

    /// 宽表（128 列 × 40 行 × 4096 ASCII/格）是最容易撑爆 SSH 输出的形状，
    /// 这里固定「一页序列化后必须远低于 16 MiB 传输上限」。
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
        assert!(payload < CSV_PAGE_MAX_BYTES + 64 * 1024);
        assert!(
            payload < crate::ssh::transport::MAX_EXEC_OUTPUT_BYTES,
            "one page must fit the SSH exec output limit"
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
