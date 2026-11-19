//! CSV/TSV table preview for the project-files sidebar.
//!
//! A large delimited file must never travel through one JSON payload, so each
//! request parses the file streamingly and returns one bounded page of rows
//! plus file-level metadata (header, row count, column count). The renderer
//! keeps only a window of rows, and this module keeps the IPC payload bounded
//! as well: at most [`CSV_PAGE_MAX_ROWS`] rows, [`CSV_MAX_COLUMNS`] columns and
//! [`CSV_CELL_MAX_CHARS`] characters per cell.
//!
//! Parsing follows RFC 4180 leniently: `"` only opens a quoted run at the start
//! of a field, `""` inside a quoted run is a literal quote, the delimiter
//! inside a quoted run is literal, and a quoted run may contain hard line
//! breaks. The delimiter is sniffed from the first line (comma, tab or
//! semicolon), so `.tsv` and semicolon-separated exports both work.
//!
//! The first record is always reported as the header row (the convention GitHub,
//! Excel and most CSV viewers use), so a headerless file loses its first data
//! row to the header. Rows below it are indexed from 0 as data rows: `offset`
//! and `total_rows` never include the header.

use serde::Serialize;
use serde_json::json;
use std::fs::File;
use std::io::{BufRead, BufReader};

use crate::errors::{pix_error_detail, pix_error_with};

/// Hard cap on rows returned by a single request.
pub const CSV_PAGE_MAX_ROWS: u64 = 1000;
/// Page size used when the caller omits `limit`.
pub const CSV_PAGE_DEFAULT_ROWS: u64 = 200;
/// Columns rendered per row; wider records keep the first N and report the real count.
pub const CSV_MAX_COLUMNS: usize = 128;
/// Longest cell kept verbatim (chars); longer cells are truncated.
pub const CSV_CELL_MAX_CHARS: usize = 4096;
/// Files above this size are refused: every page request rescans from the start.
pub const CSV_MAX_FILE_BYTES: u64 = 256 * 1024 * 1024;
/// Byte budget behind the character cap above (6 bytes per char keeps the cap
/// exact for UTF-8 while still bounding a pathological single-cell file).
const CELL_MAX_BYTES: usize = CSV_CELL_MAX_CHARS * 6;
/// Bytes inspected when sniffing the delimiter.
const SNIFF_BYTES: usize = 8 * 1024;
/// UTF-8 byte order mark that spreadsheets like to prepend.
const BOM: &[u8] = &[0xEF, 0xBB, 0xBF];

#[derive(Serialize, serde::Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CsvPage {
    /// Data-row index of `rows[0]`; the header row is never part of `rows`.
    pub offset: u64,
    pub rows: Vec<Vec<String>>,
    /// First record of the file, used as the column titles.
    pub header: Option<Vec<String>>,
    /// More data rows exist after this page.
    pub more: bool,
    /// Data-row count excluding the header; only computed for the first page
    /// (`offset == 0`), where the scan necessarily reads the whole file.
    pub total_rows: Option<u64>,
    /// Field count of the widest row: exact on the first page, and on later
    /// pages at least the header width.
    pub column_count: usize,
    /// At least one row has more fields than [`CSV_MAX_COLUMNS`].
    pub truncated_columns: bool,
    /// At least one cell was cut at [`CSV_CELL_MAX_CHARS`].
    pub truncated_cells: bool,
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
    let limit = limit.clamp(1, CSV_PAGE_MAX_ROWS);
    // 首行只用于嗅探分隔符；扫描从文件开头重新读，两趟互不干扰。
    let mut sniff_reader = BufReader::new(File::open(&file).map_err(read_error(path))?);
    let mut first_line = Vec::new();
    sniff_reader
        .read_until(b'\n', &mut first_line)
        .map_err(read_error(path))?;
    drop(sniff_reader);
    let delimiter = sniff_delimiter(&first_line, path);
    let mut reader = BufReader::new(File::open(&file).map_err(read_error(path))?);
    scan(&mut reader, delimiter, offset, limit, file_bytes).map_err(read_error(path))
}

/// Count candidate separators on the first line, ignoring quoted runs.
fn sniff_delimiter(first_line: &[u8], path: &str) -> u8 {
    let bytes = first_line.strip_prefix(BOM).unwrap_or(first_line);
    let mut counts = [(b',', 0usize), (b'\t', 0), (b';', 0)];
    let mut in_quotes = false;
    for &byte in bytes.iter().take(SNIFF_BYTES) {
        match byte {
            b'"' => in_quotes = !in_quotes,
            _ if !in_quotes => {
                for (candidate, count) in counts.iter_mut() {
                    if byte == *candidate {
                        *count += 1;
                    }
                }
            }
            _ => {}
        }
    }
    counts
        .iter()
        .copied()
        .filter(|(_, count)| *count > 0)
        .max_by_key(|(_, count)| *count)
        .map(|(byte, _)| byte)
        // 单列文件没有分隔符可嗅探：按扩展名给稳定默认，避免整份文本被当成一列。
        .unwrap_or_else(|| {
            if crate::file_preview::ext_of(path) == "tsv" {
                b'\t'
            } else {
                b','
            }
        })
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
    /// The line ended inside a quoted run; the record continues on the next line.
    Continues,
    Row(ParsedRow),
    /// Empty physical line outside any quoted run: not a record.
    Blank,
}

/// RFC 4180 state machine fed one physical line at a time.
struct RowParser {
    delimiter: u8,
    /// Assemble field text only for rows that reach the client.
    collect: bool,
    field: Vec<u8>,
    field_count: usize,
    fields: Vec<String>,
    in_quotes: bool,
    at_field_start: bool,
    cell_truncated: bool,
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
            at_field_start: true,
            cell_truncated: false,
        }
    }

    fn begin_row(&mut self, collect: bool) {
        self.collect = collect;
        self.field.clear();
        self.field_count = 0;
        self.fields.clear();
        self.in_quotes = false;
        self.at_field_start = true;
        self.cell_truncated = false;
    }

    fn push(&mut self, byte: u8) {
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
            let raw = String::from_utf8_lossy(&self.field).into_owned();
            let (text, cut) = char_truncate(&raw);
            self.cell_truncated |= cut;
            self.fields.push(text.to_owned());
        }
        self.field.clear();
        self.at_field_start = true;
    }

    fn feed(&mut self, line: &[u8]) -> Feed {
        // CRLF: drop the trailing CR so it never lands in the last cell.
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() && !self.in_quotes {
            return Feed::Blank;
        }
        let mut index = 0;
        while index < line.len() {
            let byte = line[index];
            if self.in_quotes {
                if byte == b'"' {
                    if line.get(index + 1) == Some(&b'"') {
                        self.push(b'"');
                        index += 2;
                        continue;
                    }
                    self.in_quotes = false;
                    index += 1;
                    continue;
                }
                self.push(byte);
                index += 1;
                continue;
            }
            if self.at_field_start && byte == b'"' {
                self.in_quotes = true;
                self.at_field_start = false;
                index += 1;
                continue;
            }
            if byte == self.delimiter {
                self.end_field();
                index += 1;
                continue;
            }
            self.push(byte);
            self.at_field_start = false;
            index += 1;
        }
        if self.in_quotes {
            // A hard line break inside a quoted cell: keep it and resume next line.
            self.push(b'\n');
            return Feed::Continues;
        }
        self.end_field();
        Feed::Row(ParsedRow {
            fields: std::mem::take(&mut self.fields),
            field_count: self.field_count,
            truncated_cells: self.cell_truncated,
        })
    }
}

fn scan<R: BufRead>(
    reader: &mut R,
    delimiter: u8,
    offset: u64,
    limit: u64,
    file_bytes: u64,
) -> std::io::Result<CsvPage> {
    let mut parser = RowParser::new(delimiter);
    let mut header: Option<Vec<String>> = None;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total_rows: u64 = 0;
    let mut more = false;
    let mut column_count = 0usize;
    let mut truncated_columns = false;
    let mut truncated_cells = false;
    let limit = limit.clamp(1, CSV_PAGE_MAX_ROWS);
    // Physical record index; record 0 is the header, so data row = record - 1.
    let mut record: u64 = 0;
    // Set while a quoted cell spans multiple physical lines.
    let mut in_record = false;
    let mut first_line = true;

    loop {
        let mut line = Vec::new();
        if reader.read_until(b'\n', &mut line)? == 0 {
            break;
        }
        let mut line = line.strip_suffix(b"\n").unwrap_or(&line).to_vec();
        if first_line {
            first_line = false;
            // 表格工具常给 UTF-8 加 BOM：只剥文件最开头那一个。
            if let Some(stripped) = line.strip_prefix(BOM) {
                line = stripped.to_vec();
            }
        }
        if !in_record {
            let data_row = record.saturating_sub(1);
            let windowed = header.is_some() && data_row >= offset && data_row < offset + limit;
            parser.begin_row(header.is_none() || windowed);
        }
        match parser.feed(&line) {
            Feed::Continues => {
                in_record = true;
                continue;
            }
            Feed::Blank => continue,
            Feed::Row(row) => {
                in_record = false;
                if record == 0 {
                    column_count = column_count.max(row.field_count);
                    truncated_columns |= row.field_count > CSV_MAX_COLUMNS;
                    truncated_cells |= row.truncated_cells;
                    header = Some(row.fields);
                    record += 1;
                    continue;
                }
                let data_row = record - 1;
                if data_row >= offset && data_row < offset + limit {
                    column_count = column_count.max(row.field_count);
                    truncated_columns |= row.field_count > CSV_MAX_COLUMNS;
                    truncated_cells |= row.truncated_cells;
                    rows.push(row.fields);
                }
                total_rows += 1;
                if data_row >= offset + limit {
                    more = true;
                    // Later pages need no exact total: stop once the window and
                    // the "more" flag are settled.
                    if offset > 0 {
                        break;
                    }
                }
                record += 1;
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
        delimiter: delimiter_label(delimiter),
        file_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn page(csv: &str, delimiter: u8, offset: u64, limit: u64) -> CsvPage {
        scan(
            &mut Cursor::new(csv.as_bytes()),
            delimiter,
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
        let out = page(csv, b',', 0, 10);
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
    fn quoted_cells_may_span_physical_lines_without_shifting_indexes() {
        let csv = "id,body\n1,\"line one\nline two\"\n2,flat\n3,flat\n";
        let out = page(csv, b',', 0, 10);
        assert_eq!(out.rows.len(), 3);
        assert_eq!(out.rows[0][1], "line one\nline two");
        assert_eq!(out.rows[2][0], "3");
        let first = page(csv, b',', 0, 1);
        assert!(first.more, "second record exists past the one-row window");
        let second = page(csv, b',', 1, 1);
        assert_eq!(second.rows, vec![vec!["2".to_string(), "flat".to_string()]]);
        assert_eq!(
            second.total_rows, None,
            "later pages do not rescan the whole file"
        );
    }

    #[test]
    fn blank_lines_are_not_records_and_lone_quote_cells_are_kept() {
        let csv = "a,b\n\n1,2\n\"\",x\n";
        let out = page(csv, b',', 0, 10);
        assert_eq!(out.total_rows, Some(2));
        assert_eq!(out.rows[1], vec![String::new(), "x".to_string()]);
    }

    #[test]
    fn delimiter_is_sniffed_from_the_header_line() {
        assert_eq!(page("a\tb\tc\n1\t2\t3\n", b'\t', 0, 10).column_count, 3);
        assert_eq!(page("a;b;c\n1;2;3\n", b';', 0, 10).delimiter, ";");
        assert_eq!(sniff_delimiter(b"a\tb\tc\n", "x.csv"), b'\t');
        assert_eq!(sniff_delimiter(b"a;b;c\n", "x.csv"), b';');
        assert_eq!(sniff_delimiter(b"only,one\n", "x.csv"), b',');
        assert_eq!(sniff_delimiter(b"single\n", "x.tsv"), b'\t');
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
        let out = page(&csv, b',', 0, 10);
        assert_eq!(out.column_count, CSV_MAX_COLUMNS + 5);
        assert!(out.truncated_columns);
        assert_eq!(out.rows[0].len(), CSV_MAX_COLUMNS);
    }

    #[test]
    fn long_cells_are_cut_on_a_char_boundary() {
        let long = "中".repeat(CSV_CELL_MAX_CHARS + 10);
        let csv = format!("id,text\n1,{long}\n");
        let out = page(&csv, b',', 0, 10);
        assert_eq!(out.rows[0][1].chars().count(), CSV_CELL_MAX_CHARS);
        assert!(out.truncated_cells);
    }

    #[test]
    fn page_size_is_clamped_to_the_hard_cap() {
        let mut csv = String::from("id\n");
        for i in 0..CSV_PAGE_MAX_ROWS + 20 {
            csv.push_str(&format!("{i}\n"));
        }
        let out = page(&csv, b',', 0, u64::MAX);
        assert_eq!(out.rows.len(), CSV_PAGE_MAX_ROWS as usize);
        assert!(out.more);
        assert_eq!(out.total_rows, Some(CSV_PAGE_MAX_ROWS + 20));
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
        assert!(
            payload.len() < 512 * 1024,
            "one page must stay under half a megabyte, got {}",
            payload.len()
        );
        std::fs::remove_dir_all(&root).unwrap();
    }
}
