//! Project trust is read and persisted by the installed Pi implementation.
use serde_json::{json, Value};
use std::path::PathBuf;

/// Match Pi's getAgentDir, including a user-supplied environment override.
pub fn agent_dir() -> PathBuf {
    resolve_agent_dir(
        std::env::var("PI_CODING_AGENT_DIR").ok().as_deref(),
        &dirs::home_dir().expect("Cannot locate user home directory"),
    )
}

fn resolve_agent_dir(value: Option<&str>, home: &std::path::Path) -> PathBuf {
    match value.filter(|s| !s.is_empty()) {
        Some("~") => home.to_path_buf(),
        Some(s) if s.starts_with("~/") || s.starts_with("~\\") => home.join(&s[2..]),
        Some(s) => PathBuf::from(s),
        None => home.join(".pi").join("agent"),
    }
}

pub async fn status(project: &str) -> Result<Value, String> {
    let request = json!({"op": "trust_status", "project": project});
    tokio::task::spawn_blocking(move || crate::pi_data::call(request))
        .await
        .map_err(|e| e.to_string())?
}
pub async fn save(project: &str, trusted: bool, trust_parent: bool) -> Result<Value, String> {
    let request = json!({"op": "trust_save", "project": project, "trusted": trusted, "trustParent": trust_parent});
    tokio::task::spawn_blocking(move || crate::pi_data::call(request))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pi_directory_respects_environment() {
        let home = std::path::Path::new("/home/test");
        assert_eq!(resolve_agent_dir(None, home), home.join(".pi/agent"));
        assert_eq!(resolve_agent_dir(Some(""), home), home.join(".pi/agent"));
        assert_eq!(
            resolve_agent_dir(Some("~/custom"), home),
            home.join("custom")
        );
        assert_eq!(
            resolve_agent_dir(Some("/custom/agent"), home),
            PathBuf::from("/custom/agent")
        );
    }
}
