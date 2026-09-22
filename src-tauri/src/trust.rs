//! Project trust decisions, mirroring pi's `~/.pi/agent/trust.json` logic
//! (see pi dist/core/trust-manager.js):
//! - file format: `{ "<canonical path>": true | false | null }`, sorted keys,
//!   2-space pretty JSON + trailing newline
//! - lookup walks from cwd up to the filesystem root; nearest true/false wins
//! - trust is required when cwd/.pi contains trust-requiring resources, or
//!   when cwd or an ancestor contains `.agents/skills` (excluding the user's
//!   own `~/.agents/skills`)
//!
//! Path normalization must match Node's `realpathSync`, i.e. WITHOUT the
//! `\\?\` extended-length prefix that Rust's fs::canonicalize produces on
//! Windows — hence `dunce::canonicalize`.

use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const TRUST_ENTRIES: &[&str] = &[
    "settings.json",
    "extensions",
    "skills",
    "prompts",
    "themes",
    "SYSTEM.md",
    "APPEND_SYSTEM.md",
];

pub fn agent_dir() -> PathBuf {
    crate::data_dir::root().join("agent")
}

fn canon(p: &Path) -> String {
    match dunce::canonicalize(p) {
        Ok(x) => x.to_string_lossy().to_string(),
        Err(_) => p.to_string_lossy().to_string(),
    }
}

fn same_path(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
}

fn trust_file() -> PathBuf {
    agent_dir().join("trust.json")
}

fn read_trust_map() -> Result<BTreeMap<String, Value>, String> {
    let path = trust_file();
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("failed to read trust.json: {e}"))?;
    let raw = raw.trim_start_matches('\u{feff}');
    let parsed: Value = serde_json::from_str(raw).map_err(|e| format!("failed to parse trust.json: {e}"))?;
    let mut map = BTreeMap::new();
    if let Value::Object(obj) = parsed {
        for (k, v) in obj {
            if v.is_boolean() || v.is_null() {
                map.insert(k, v);
            }
        }
    }
    Ok(map)
}

fn write_trust_map(map: &BTreeMap<String, Value>) -> Result<(), String> {
    let path = trust_file();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // BTreeMap iterates in sorted key order, matching pi's writer.
    let mut obj = Map::new();
    for (k, v) in map {
        obj.insert(k.clone(), v.clone());
    }
    let body = Value::Object(obj);
    std::fs::write(&path, format!("{}\n", serde_json::to_string_pretty(&body).unwrap()))
        .map_err(|e| e.to_string())
}

fn find_nearest_decision(map: &BTreeMap<String, Value>, cwd: &str) -> Option<bool> {
    let mut current = PathBuf::from(cwd);
    loop {
        let key = current.to_string_lossy().to_string();
        for (k, v) in map {
            if same_path(k, &key) {
                if let Some(decision) = v.as_bool() {
                    return Some(decision);
                }
            }
        }
        match current.parent() {
            Some(p) if p != current => current = p.to_path_buf(),
            _ => return None,
        }
    }
}

fn has_trust_requiring_resources(cwd: &Path) -> bool {
    let pi_dir = cwd.join(".pi");
    if pi_dir.exists() && TRUST_ENTRIES.iter().any(|e| pi_dir.join(e).exists()) {
        return true;
    }
    let user_agents_skills = dirs::home_dir()
        .map(|h| h.join(".agents").join("skills"))
        .map(|p| canon(&p))
        .unwrap_or_default();
    let mut current = cwd.to_path_buf();
    loop {
        let dir = current.join(".agents").join("skills");
        if dir.exists() && canon(&dir) != user_agents_skills {
            return true;
        }
        match current.parent() {
            Some(p) if p != current => current = p.to_path_buf(),
            _ => return false,
        }
    }
}

/// Current trust state for a project folder, consumed by the desktop UI.
pub async fn status(project: &str) -> Result<Value, String> {
    let project = project.to_string();
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let cwd = PathBuf::from(project);
        let canonical = dunce::canonicalize(&cwd).unwrap_or(cwd);
        let cwd_s = canonical.to_string_lossy().to_string();
        let map = read_trust_map()?;
        let decision = find_nearest_decision(&map, &cwd_s);
        let has_resources = has_trust_requiring_resources(&canonical);
        let parent_path = canonical
            .parent()
            .filter(|p| *p != canonical)
            .map(|p| p.to_string_lossy().to_string());
        Ok(json!({
            "projectPath": cwd_s,
            "parentPath": parent_path,
            "hasTrustRequiringResources": has_resources,
            // true | false | null (no saved decision)
            "decision": decision,
            // show the trust dialog?
            "needsDecision": has_resources && decision.is_none(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Persist a decision in pi's exact format.
pub async fn save(project: &str, trusted: bool, trust_parent: bool) -> Result<Value, String> {
    let project = project.to_string();
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let mut map = read_trust_map()?;
        let cwd = PathBuf::from(project);
        let canonical = dunce::canonicalize(&cwd).unwrap_or(cwd);
        let project_key = canonical.to_string_lossy().to_string();
        if trust_parent {
            if let Some(parent) = canonical.parent() {
                map.insert(parent.to_string_lossy().to_string(), Value::Bool(trusted));
            }
            // pi writes project decision `null`, which means "delete key"
            map.remove(&project_key);
        } else {
            map.insert(project_key, Value::Bool(trusted));
        }
        write_trust_map(&map)?;
        Ok(json!({ "ok": true }))
    })
    .await
    .map_err(|e| e.to_string())?
}
