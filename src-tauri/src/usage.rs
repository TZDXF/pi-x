//! 用量/成本汇总：扫描本机 pi 会话文件中持久化的 token/cost 数据。
//!
//! 数据源是 pi 自己写入会话 JSONL 的内容（不复制、不落盘）：每条 assistant
//! message 持久化 `usage { input, output, cacheRead, cacheWrite, totalTokens,
//! cost { total, … } }` 与 `provider`/`model`；会话首行 header 携带 `cwd` 与
//! 创建时间，`session_info` 条目携带会话名。扫描按条目时间戳过滤并聚合出
//! 总量、按天、按项目、按模型与会话明细；mtime 增量缓存只存内存，文件未变
//! 不重复解析。远程项目（SSH/WSL/Docker）的会话在远端主机上，不在本模块范围。

use crate::{sessions, trust::agent_dir};
use chrono::{DateTime, Local, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::UNIX_EPOCH;

/// 会话明细最多返回的行数；聚合视图（总量/按天/按项目/按模型）不受影响。
pub const MAX_SESSION_ROWS: usize = 500;

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct UsageTotals {
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write: u64,
    pub total_tokens: u64,
    pub cost: f64,
    pub messages: u32,
}

impl UsageTotals {
    fn add(&mut self, usage: &EntryUsage) {
        self.input += usage.input;
        self.output += usage.output;
        self.cache_read += usage.cache_read;
        self.cache_write += usage.cache_write;
        self.total_tokens += usage.total_tokens;
        self.cost += usage.cost;
        self.messages += 1;
    }
    fn add_aggregate(&mut self, other: &UsageTotals) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
        self.total_tokens += other.total_tokens;
        self.cost += other.cost;
        self.messages += other.messages;
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageDay {
    /// 本地时区的 `YYYY-MM-DD`。
    pub day: String,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageProject {
    pub project: String,
    pub sessions: u32,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageModel {
    pub provider: String,
    pub model: String,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageSessionRow {
    pub file: String,
    pub project: String,
    pub name: Option<String>,
    pub started_at: i64,
    pub last_at: i64,
    #[serde(flatten)]
    pub totals: UsageTotals,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub totals: UsageTotals,
    /// 过滤范围内有用量的会话数（明细行可能因截断小于此值）。
    pub sessions_scanned: u32,
    pub truncated: bool,
    pub by_day: Vec<UsageDay>,
    pub by_project: Vec<UsageProject>,
    pub by_model: Vec<UsageModel>,
    pub sessions: Vec<UsageSessionRow>,
}

/// 单条消息的用量数字；`total_tokens` 缺省时用各分项之和。
struct EntryUsage {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_write: u64,
    total_tokens: u64,
    cost: f64,
    model: Option<(String, String)>,
}

/// 只把确实带用量字段的对象当 usage，避免把无关 JSON 当数据累计。
fn entry_usage(value: &Value, provider: Option<&str>, model: Option<&str>) -> Option<EntryUsage> {
    if !value.is_object() {
        return None;
    }
    let field = |key: &str| value[key].as_u64().unwrap_or(0);
    let (input, output, cache_read, cache_write) =
        (field("input"), field("output"), field("cacheRead"), field("cacheWrite"));
    let cost = value["cost"]["total"].as_f64().unwrap_or(0.0);
    let has_any = input > 0 || output > 0 || cache_read > 0 || cache_write > 0 || cost != 0.0;
    if !has_any {
        return None;
    }
    let total_tokens = match value["totalTokens"].as_u64() {
        Some(tokens) => tokens,
        None => input + output + cache_read + cache_write,
    };
    Some(EntryUsage {
        input,
        output,
        cache_read,
        cache_write,
        total_tokens,
        cost,
        model: match (provider, model) {
            (Some(provider), Some(model)) if !provider.is_empty() && !model.is_empty() => {
                Some((provider.to_owned(), model.to_owned()))
            }
            _ => None,
        },
    })
}

/// 按天聚合的用量；模型归因随天一起存，保证任意时间过滤下各视图口径一致。
#[derive(Default, Clone)]
struct DayUsage {
    totals: UsageTotals,
    models: HashMap<(String, String), (u64, f64, u32)>,
}

impl DayUsage {
    fn add(&mut self, usage: &EntryUsage) {
        self.totals.add(usage);
        if let Some(key) = &usage.model {
            let entry = self.models.entry(key.clone()).or_default();
            entry.0 += usage.total_tokens;
            entry.1 += usage.cost;
            entry.2 += 1;
        }
    }
}

/// 单个会话文件的全部用量（全历史；时间过滤在聚合阶段应用）。
#[derive(Clone)]
struct SessionUsage {
    mtime: u64,
    cwd: String,
    created: i64,
    name: Option<String>,
    last_at: i64,
    days: HashMap<String, DayUsage>,
}

/// 条目时间戳：wrapper 的 RFC3339 优先，回落到 message 内的毫秒数。
fn entry_timestamp(entry: &Value) -> Option<i64> {
    if let Some(text) = entry["timestamp"].as_str() {
        if let Ok(time) = DateTime::parse_from_rfc3339(text) {
            return Some(time.timestamp_millis());
        }
    }
    entry["message"]["timestamp"].as_i64().or(entry["timestamp"].as_i64())
}

fn local_day(ts: i64) -> Option<String> {
    Local
        .timestamp_millis_opt(ts)
        .single()
        .map(|d| d.format("%Y-%m-%d").to_string())
}

/// 流式解析一个会话文件；无法读取或没有会话头时返回 None（调用方跳过）。
fn parse_session_usage(path: &Path, mtime: u64) -> Option<SessionUsage> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    // 会话 header：cwd 与创建时间。
    line.clear();
    reader.read_line(&mut line).ok()?;
    let header: Value = serde_json::from_str(line.trim()).ok()?;
    if header["type"].as_str() != Some("session") {
        return None;
    }
    let cwd = header["cwd"].as_str().unwrap_or_default().to_owned();
    let created = header["timestamp"]
        .as_str()
        .and_then(|t| DateTime::parse_from_rfc3339(t).ok())
        .map(|t| t.timestamp_millis())
        .unwrap_or(0);
    let mut usage = SessionUsage {
        mtime,
        cwd,
        created,
        name: None,
        last_at: created,
        days: HashMap::new(),
    };
    line.clear();
    while reader.read_line(&mut line).unwrap_or(0) > 0 {
        if let Ok(entry) = serde_json::from_str::<Value>(line.trim()) {
            // 非会话数据的行（banner 污染、截断写等）静默跳过，不让单个
            // 坏行丢掉整个文件或让扫描失败。
            match entry["type"].as_str() {
                Some("message") => {
                    let message = &entry["message"];
                    if message["role"].as_str() == Some("assistant") {
                        if let Some(data) = entry_usage(&message["usage"], message["provider"].as_str(), message["model"].as_str()) {
                            accumulate(&mut usage, entry_timestamp(&entry), &data);
                        }
                    }
                }
                // 兼容可能出现的独立 usage 条目（无模型归因）。
                Some("usage") => {
                    let payload = if entry["usage"].is_object() { &entry["usage"] } else { &entry };
                    if let Some(data) = entry_usage(payload, None, None) {
                        accumulate(&mut usage, entry_timestamp(&entry), &data);
                    }
                }
                Some("session_info") => {
                    if let Some(name) = entry["name"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
                        usage.name = Some(name.to_owned());
                    }
                }
                _ => {}
            }
        }
        line.clear();
    }
    Some(usage)
}

fn accumulate(usage: &mut SessionUsage, ts: Option<i64>, data: &EntryUsage) {
    let Some(ts) = ts else { return };
    let Some(day) = local_day(ts) else { return };
    usage.last_at = usage.last_at.max(ts);
    usage.days.entry(day).or_default().add(data);
}

fn list_session_files(root: &Path) -> Vec<(PathBuf, u64)> {
    let mut files = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if kind.is_dir() {
                pending.push(path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                let mtime = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                files.push((path, mtime));
            }
        }
    }
    files.sort();
    files
}

/// mtime 增量缓存：文件未变时复用上次的解析结果，稳态下重复查询零解析成本。
fn session_cache() -> &'static Mutex<HashMap<PathBuf, SessionUsage>> {
    static CACHE: OnceLock<Mutex<HashMap<PathBuf, SessionUsage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 聚合缓存中的会话用量；时间过滤按本地日粒度（边界日的部分时段可能跨窗口）。
fn summarize(
    collected: Vec<(PathBuf, SessionUsage)>,
    cutoff_day: String,
    project_norm: Option<&str>,
) -> UsageSummary {
    let mut summary = UsageSummary {
        totals: UsageTotals::default(),
        sessions_scanned: 0,
        truncated: false,
        by_day: Vec::new(),
        by_project: Vec::new(),
        by_model: Vec::new(),
        sessions: Vec::new(),
    };
    let mut days: HashMap<String, UsageTotals> = HashMap::new();
    let mut projects: HashMap<String, (u32, UsageTotals)> = HashMap::new();
    let mut models: HashMap<(String, String), UsageTotals> = HashMap::new();
    for (path, session) in collected {
        if let Some(filter) = project_norm {
            let cwd_norm = sessions::normalize(Path::new(&session.cwd)).unwrap_or(session.cwd.clone());
            if cwd_norm != filter {
                continue;
            }
        }
        // 只保留过滤范围内的天；无范围内用量的会话不出现在任何视图。
        let mut in_range = DayUsage::default();
        for (day, day_usage) in &session.days {
            if *day >= cutoff_day {
                in_range.totals.add_aggregate(&day_usage.totals);
                for (key, (tokens, cost, messages)) in &day_usage.models {
                    let entry = in_range.models.entry(key.clone()).or_default();
                    entry.0 += tokens;
                    entry.1 += cost;
                    entry.2 += messages;
                }
            }
        }
        if in_range.totals.messages == 0 {
            continue;
        }
        summary.sessions_scanned += 1;
        summary.totals.add_aggregate(&in_range.totals);
        for (day, day_usage) in &session.days {
            if *day >= cutoff_day {
                days.entry(day.clone()).or_default().add_aggregate(&day_usage.totals);
            }
        }
        let project = projects
            .entry(session.cwd.clone())
            .or_default();
        project.0 += 1;
        project.1.add_aggregate(&in_range.totals);
        for (key, (tokens, cost, messages)) in &in_range.models {
            let totals = models.entry(key.clone()).or_default();
            totals.total_tokens += tokens;
            totals.cost += cost;
            totals.messages += messages;
        }
        if summary.sessions.len() < MAX_SESSION_ROWS {
            summary.sessions.push(UsageSessionRow {
                file: path.to_string_lossy().into_owned(),
                project: session.cwd.clone(),
                name: session.name.clone(),
                started_at: session.created,
                last_at: session.last_at,
                totals: in_range.totals.clone(),
            });
        } else {
            summary.truncated = true;
        }
    }
    summary.by_day = days
        .into_iter()
        .map(|(day, totals)| UsageDay { day, totals })
        .collect();
    summary.by_day.sort_by(|a, b| a.day.cmp(&b.day));
    summary.by_project = projects
        .into_iter()
        .map(|(project, (sessions, totals))| UsageProject { project, sessions, totals })
        .collect();
    summary.by_project.sort_by(|a, b| {
        b.totals
            .cost
            .partial_cmp(&a.totals.cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.totals.total_tokens.cmp(&a.totals.total_tokens))
    });
    summary.by_model = models
        .into_iter()
        .map(|((provider, model), totals)| UsageModel { provider, model, totals })
        .collect();
    summary.by_model.sort_by(|a, b| {
        b.totals
            .cost
            .partial_cmp(&a.totals.cost)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.totals.total_tokens.cmp(&a.totals.total_tokens))
    });
    summary.sessions.sort_by(|a, b| b.last_at.cmp(&a.last_at));
    summary
}

#[tauri::command]
pub async fn usage_summary(days: Option<u32>, project: Option<String>) -> Result<UsageSummary, String> {
    tokio::task::spawn_blocking(move || {
        let days = days.unwrap_or(30);
        let project_norm = project.as_deref().and_then(|p| sessions::normalize(Path::new(p)));
        scan(&agent_dir().join("sessions"), days, project_norm.as_deref())
    })
    .await
    .map_err(|e| format!("usage scan failed: {e}"))?
}

/// 扫描会话根目录并聚合；根目录不存在（还没有任何会话）返回空汇总。
fn scan(root: &Path, days: u32, project_norm: Option<&str>) -> Result<UsageSummary, String> {
    if !root.is_dir() {
        return Ok(UsageSummary {
            totals: UsageTotals::default(),
            sessions_scanned: 0,
            truncated: false,
            by_day: Vec::new(),
            by_project: Vec::new(),
            by_model: Vec::new(),
            sessions: Vec::new(),
        });
    }
    let files = list_session_files(root);
    let cache = session_cache();
    let mut cache = cache.lock().unwrap_or_else(|p| p.into_inner());
    let mut collected = Vec::with_capacity(files.len());
    for (path, mtime) in files {
        // 先结束 cache 的不可变借用，再在 miss 分支里做可变插入。
        let cached = cache.get(&path).filter(|c| c.mtime == mtime).cloned();
        let usage = match cached {
            Some(usage) => usage,
            None => match parse_session_usage(&path, mtime) {
                Some(usage) => {
                    cache.insert(path.clone(), usage.clone());
                    usage
                }
                None => {
                    cache.remove(&path);
                    continue;
                }
            },
        };
        collected.push((path, usage));
    }
    // 本次扫描未见到的文件已不存在，缓存同步清理。
    let seen: Vec<PathBuf> = collected.iter().map(|(p, _)| p.clone()).collect();
    cache.retain(|path, _| seen.contains(path));
    let cutoff_day = match days {
        0 => String::new(),
        _ => {
            let now = Local::now();
            let boundary = now - chrono::Duration::days(days as i64);
            boundary.format("%Y-%m-%d").to_string()
        }
    };
    Ok(summarize(collected, cutoff_day, project_norm))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_session(dir: &Path, name: &str, lines: &[String]) -> PathBuf {
        std::fs::create_dir_all(dir).unwrap();
        let path = dir.join(name);
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();
        path
    }

    fn message_entry(ts: &str, provider: &str, model: &str, input: u64, output: u64, cost: f64) -> String {
        format!(
            r#"{{"type":"message","id":"m","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"text","text":"hi"}}],"provider":"{provider}","model":"{model}","usage":{{"input":{input},"output":{output},"cacheRead":0,"cacheWrite":0,"totalTokens":{},"cost":{{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":{cost}}}}},"stopReason":"stop"}}}}"#,
            input + output
        )
    }

    #[test]
    fn parses_messages_models_names_and_standalone_usage_entries() {
        let dir = std::env::temp_dir().join(format!("pix-usage-{}", uuid::Uuid::new_v4()));
        let path = write_session(
            &dir,
            "a.jsonl",
            &[
                r#"{"type":"session","version":3,"id":"s","timestamp":"2026-10-20T08:00:00.000Z","cwd":"C:\\code\\demo"}"#.into(),
                r#"{"type":"model_change","id":"x","timestamp":"2026-10-20T08:00:01.000Z","provider":"p","modelId":"m1"}"#.into(),
                message_entry("2026-10-20T09:00:00.000Z", "p", "m1", 100, 50, 0.5),
                r#"{"type":"message","id":"u","timestamp":"2026-10-20T09:01:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#.into(),
                r#"{"type":"session_info","id":"i","timestamp":"2026-10-20T09:01:10.000Z","name":"我的会话"}"#.into(),
                message_entry("2026-10-21T10:00:00.000Z", "p", "m2", 200, 80, 1.25),
                r#"{"type":"usage","id":"u2","timestamp":"2026-10-21T11:00:00.000Z","usage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15,"cost":{"total":0.05}}}"#.into(),
                "not json at all".into(),
                message_entry("2026-10-21T12:00:00.000Z", "p", "m1", 30, 20, 0.1),
            ],
        );
        let usage = parse_session_usage(&path, 1).unwrap();
        assert_eq!(usage.cwd, "C:\\code\\demo");
        assert_eq!(usage.created, DateTime::parse_from_rfc3339("2026-10-20T08:00:00.000Z").unwrap().timestamp_millis());
        assert_eq!(usage.name.as_deref(), Some("我的会话"));
        let total: u64 = usage.days.values().map(|d| d.totals.total_tokens).sum();
        let cost: f64 = usage.days.values().map(|d| d.totals.cost).sum();
        let messages: u32 = usage.days.values().map(|d| d.totals.messages).sum();
        assert_eq!(messages, 4); // user 消息与坏行不计
        assert_eq!(total, (100 + 50) + (200 + 80) + 15 + (30 + 20));
        assert!((cost - (0.5 + 1.25 + 0.05 + 0.1)).abs() < 1e-9);
        // 按模型归因：独立 usage 条目无模型，其余按 provider/model 聚合。
        let m1 = usage.days.values().map(|d| d.models.get(&("p".into(), "m1".into())).map(|e| e.0).unwrap_or(0)).sum::<u64>();
        assert_eq!(m1, (100 + 50) + (30 + 20));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn files_without_a_session_header_are_skipped() {
        let dir = std::env::temp_dir().join(format!("pix-usage-{}", uuid::Uuid::new_v4()));
        let path = write_session(&dir, "bad.jsonl", &[r#"{"type":"other"}"#.into()]);
        assert!(parse_session_usage(&path, 1).is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn summarize_filters_by_day_project_and_caps_rows() {
        let day_usage = |tokens: u64, cost: f64, messages: u32| DayUsage {
            totals: UsageTotals {
                input: tokens,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                total_tokens: tokens,
                cost,
                messages,
            },
            models: HashMap::from([(("p".into(), "m".into()), (tokens, cost, messages))]),
        };
        let session = |cwd: &str, days: Vec<(&str, DayUsage)>, last_at: i64| SessionUsage {
            mtime: 0,
            cwd: cwd.into(),
            created: 1_000,
            name: None,
            last_at,
            days: days
                .into_iter()
                .map(|(day, usage)| (day.to_owned(), usage))
                .collect(),
        };
        // cutoff 在 2026-10-21：老会话只剩当天之后的用量计入。
        let sessions = vec![
            (
                PathBuf::from("recent.jsonl"),
                session("C:\\code\\demo", vec![("2026-10-25", day_usage(100, 1.0, 2)), ("2026-10-10", day_usage(9_999, 9.0, 9))], 5_000),
            ),
            (
                PathBuf::from("other.jsonl"),
                session("C:\\code\\other", vec![("2026-10-26", day_usage(50, 0.5, 1))], 6_000),
            ),
            (
                PathBuf::from("stale.jsonl"),
                session("C:\\code\\demo", vec![("2026-10-01", day_usage(70, 0.7, 1))], 2_000),
            ),
        ];
        let summary = summarize(sessions, "2026-10-21".into(), None);
        assert_eq!(summary.sessions_scanned, 2);
        assert_eq!(summary.totals.total_tokens, 150);
        assert!((summary.totals.cost - 1.5).abs() < 1e-9);
        assert_eq!(summary.by_day.len(), 2);
        assert_eq!(summary.by_day[0].day, "2026-10-25");
        assert_eq!(summary.by_project.len(), 2);
        // 按费用降序：demo（1.0）在 other（0.5）前。
        assert_eq!(summary.by_project[0].project, "C:\\code\\demo");
        assert_eq!(summary.by_model.len(), 1);
        assert_eq!(summary.by_model[0].model, "m");
        // 会话明细按最近活动倒序，范围内无用量的会话不出现。
        assert_eq!(summary.sessions.len(), 2);
        assert_eq!(summary.sessions[0].file, "other.jsonl");

        // 项目过滤（归一化路径比较）。
        let sessions = vec![
            (
                PathBuf::from("recent.jsonl"),
                session("C:\\code\\demo", vec![("2026-10-25", day_usage(100, 1.0, 2))], 5_000),
            ),
            (
                PathBuf::from("other.jsonl"),
                session("C:\\code\\other", vec![("2026-10-26", day_usage(50, 0.5, 1))], 6_000),
            ),
        ];
        let summary = summarize(sessions, String::new(), Some("C:\\code\\other"));
        assert_eq!(summary.sessions_scanned, 1);
        assert_eq!(summary.totals.total_tokens, 50);
    }

    #[test]
    fn scan_handles_a_missing_root_and_real_files() {
        let missing = std::env::temp_dir().join(format!("pix-usage-none-{}", uuid::Uuid::new_v4()));
        let summary = scan(&missing, 30, None).unwrap();
        assert_eq!(summary.sessions_scanned, 0);
        assert!(summary.by_day.is_empty());

        let dir = std::env::temp_dir().join(format!("pix-usage-{}", uuid::Uuid::new_v4()));
        let project = dir.join("enc");
        write_session(
            &project,
            "a.jsonl",
            &[
                r#"{"type":"session","version":3,"id":"s","timestamp":"2026-10-25T08:00:00.000Z","cwd":"C:\\code\\demo"}"#.into(),
                message_entry("2026-10-25T09:00:00.000Z", "p", "m1", 100, 50, 0.5),
            ],
        );
        // 0 天表示全部历史。
        let summary = scan(&dir, 0, None).unwrap();
        assert_eq!(summary.sessions_scanned, 1);
        assert_eq!(summary.totals.total_tokens, 150);
        // 二次扫描命中缓存，结果一致。
        let again = scan(&dir, 0, None).unwrap();
        assert_eq!(again.totals.total_tokens, 150);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
