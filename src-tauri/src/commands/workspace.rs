//! Workspace groups (multi-directory projects): validate the selected roots
//! and render the manifest handed to the pix-workspace extension via the
//! `PIX_WORKSPACE` env var.

use serde::Deserialize;
use serde_json::json;
use std::path::Path;

use crate::errors::pix_error;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceContext {
    name: String,
    primary: String,
    roots: Vec<String>,
}

/// Render the selected roots as metadata; no file contents are loaded here.
fn same_directory(left: &Path, right: &Path) -> bool {
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}

fn workspace_manifest(project: &str, workspace: &WorkspaceContext) -> Result<String, String> {
    if workspace.name.trim().is_empty()
        || workspace.name.chars().count() > 120
        || workspace.roots.is_empty()
        || workspace.roots.len() > 32
    {
        return Err(pix_error("workspaceInvalid", "工作区目录列表无效"));
    }
    let cwd = dunce::canonicalize(project).map_err(|e| e.to_string())?;
    let primary = dunce::canonicalize(&workspace.primary).map_err(|e| e.to_string())?;
    let mut roots: Vec<std::path::PathBuf> = Vec::new();
    for root in &workspace.roots {
        let canonical = dunce::canonicalize(root).map_err(|e| e.to_string())?;
        if !canonical.is_dir() {
            return Err(format!("Not a workspace directory: {root}"));
        }
        if !roots.iter().any(|root| same_directory(root, &canonical)) {
            roots.push(canonical);
        }
    }
    if !roots.iter().any(|root| same_directory(root, &primary))
        || !roots.iter().any(|root| same_directory(root, &cwd))
    {
        return Err("Current and primary directories must belong to the workspace".into());
    }
    let manifest = json!({
        "name": workspace.name,
        "primary": primary.to_string_lossy(),
        "currentWorkingDirectory": cwd.to_string_lossy(),
        "roots": roots.iter().map(|path| path.to_string_lossy().into_owned()).collect::<Vec<_>>(),
    });
    Ok(manifest.to_string())
}

/// The manifest handed to the pix-workspace extension (via the PIX_WORKSPACE
/// env var), or None for plain sessions and when the project-group feature is
/// disabled. Prompt sections are injected by the extension, so no CLI flags
/// are involved and pi keeps its native APPEND_SYSTEM.md discovery.
pub(crate) fn workspace_manifest_for(
    project: &str,
    workspace: Option<WorkspaceContext>,
    workspace_groups: bool,
) -> Result<Option<String>, String> {
    match (workspace_groups, workspace) {
        (true, Some(workspace)) => Ok(Some(workspace_manifest(project, &workspace)?)),
        _ => Ok(None),
    }
}

#[cfg(test)]
mod workspace_tests {
    use super::*;

    #[test]
    fn workspace_context_lists_validated_roots() {
        let base = std::env::temp_dir().join(format!("pix-roots-{}", uuid::Uuid::new_v4()));
        let primary = base.join("primary");
        let other = base.join("other");
        std::fs::create_dir_all(&primary).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        let group = WorkspaceContext {
            name: "Backend + Frontend".into(),
            primary: primary.to_string_lossy().into_owned(),
            roots: vec![
                primary.to_string_lossy().into_owned(),
                other.to_string_lossy().into_owned(),
            ],
        };
        let manifest = workspace_manifest(&group.primary, &group).unwrap();
        assert!(manifest.contains("Backend + Frontend"));
        assert!(manifest.contains("currentWorkingDirectory"));
        assert!(manifest
            .contains(&serde_json::to_string(&other.to_string_lossy().to_string()).unwrap()));
        assert!(workspace_manifest(&base.to_string_lossy(), &group).is_err());
        assert_eq!(
            workspace_manifest_for(&group.primary, Some(group.clone()), true).unwrap(),
            Some(manifest)
        );
        assert_eq!(
            workspace_manifest_for(&group.primary.clone(), Some(group), false).unwrap(),
            None
        );
        std::fs::remove_dir_all(base).unwrap();
    }
}
