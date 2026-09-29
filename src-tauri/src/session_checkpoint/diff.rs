//! 快照差异的输出结构与 `git diff` 机器可读输出的解析。

use std::collections::HashMap;

use serde::Serialize;

use super::git::{to_workspace_relative, RepoLayout};

#[derive(Serialize, Clone)]
pub struct CheckpointFileDiff {
    /// 相对项目目录的路径（正斜杠）。
    pub path: String,
    /// added | deleted | modified | renamed
    pub kind: String,
    pub added: u64,
    pub removed: u64,
    #[serde(rename = "originalPath")]
    pub original_path: Option<String>,
}

pub(super) struct NameStatusEntry {
    pub(super) kind: String,
    pub(super) path: String,
    pub(super) original_path: Option<String>,
}

fn map_kind(status: &str) -> String {
    match status.chars().next().unwrap_or('M') {
        'A' => "added".into(),
        'D' => "deleted".into(),
        'R' | 'C' => "renamed".into(),
        _ => "modified".into(),
    }
}

/// 解析 `git diff --name-status -z`：记录间以 NUL 分隔，rename 占三个字段。
pub(super) fn parse_name_status(stdout: &str) -> Vec<NameStatusEntry> {
    let records: Vec<&str> = stdout.split('\0').filter(|record| !record.is_empty()).collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let status = records[index];
        let kind = map_kind(status);
        if kind == "renamed" {
            let (Some(original), Some(path)) = (records.get(index + 1), records.get(index + 2)) else {
                break;
            };
            entries.push(NameStatusEntry {
                kind,
                path: (*path).to_string(),
                original_path: Some((*original).to_string()),
            });
            index += 3;
            continue;
        }
        let Some(path) = records.get(index + 1) else { break };
        entries.push(NameStatusEntry { kind, path: (*path).to_string(), original_path: None });
        index += 2;
    }
    entries
}

/// 解析 `git diff --numstat -z`：`added\tremoved\tpath`，rename 时路径拆成两段 NUL 记录。
pub(super) fn parse_numstat(stdout: &str) -> HashMap<String, (u64, u64)> {
    let records: Vec<&str> = stdout.split('\0').filter(|record| !record.is_empty()).collect();
    let mut stats = HashMap::new();
    let mut index = 0;
    while index < records.len() {
        let fields: Vec<&str> = records[index].split('\t').collect();
        if fields.len() < 3 {
            index += 1;
            continue;
        }
        let parse = |value: &str| value.parse::<u64>().unwrap_or(0);
        let added = parse(fields[0]);
        let removed = parse(fields[1]);
        if !fields[2].is_empty() {
            stats.insert(fields[2].to_string(), (added, removed));
            index += 1;
            continue;
        }
        // rename：old/new 是紧随其后的两条 NUL 记录。
        let (Some(original), Some(path)) = (records.get(index + 1), records.get(index + 2)) else {
            break;
        };
        stats.insert((*path).to_string(), (added, removed));
        stats.insert((*original).to_string(), (added, removed));
        index += 3;
    }
    stats
}

pub(super) fn parse_ls_tree(stdout: &str) -> HashMap<String, String> {
    let mut entries = HashMap::new();
    for record in stdout.split('\0').filter(|record| !record.is_empty()) {
        let Some(tab) = record.find('\t') else { continue };
        let path = &record[tab + 1..];
        let header: Vec<&str> = record[..tab].split(' ').collect();
        if header.len() < 3 {
            continue;
        }
        entries.insert(path.to_string(), header[2].to_string());
    }
    entries
}

pub(super) fn merge_diff(
    layout: &RepoLayout,
    entries: &[NameStatusEntry],
    stats: &HashMap<String, (u64, u64)>,
) -> Vec<CheckpointFileDiff> {
    entries
        .iter()
        .map(|entry| {
            let stat = stats
                .get(&entry.path)
                .or_else(|| entry.original_path.as_deref().and_then(|path| stats.get(path)))
                .copied()
                .unwrap_or((0, 0));
            CheckpointFileDiff {
                path: to_workspace_relative(layout, &entry.path),
                kind: entry.kind.clone(),
                added: stat.0,
                removed: stat.1,
                original_path: entry
                    .original_path
                    .as_deref()
                    .map(|path| to_workspace_relative(layout, path)),
            }
        })
        .collect()
}
