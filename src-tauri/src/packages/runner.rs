//! Installed packages (settings.json) and the pi CLI runner that backs
//! install / remove / update.

use serde::Serialize;
use serde_json::Value;
use std::process::Stdio;
use tauri::AppHandle;

use crate::{
    commands,
    errors::{pix_error, pix_error_detail},
    pi_locate, trust,
};

const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPackage {
    /// Install source as stored in settings.json.
    pub source: String,
    /// "global" (~/.pi/agent/settings.json) or "project" (<cwd>/.pi/settings.json)
    pub scope: String,
    /// Resource filters when the object form is used (`{source, extensions, ...}`),
    /// passed through verbatim for display.
    pub filters: Option<Value>,
}

fn read_packages_file(path: &std::path::Path, scope: &str, out: &mut Vec<InstalledPackage>) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let Ok(doc) = serde_json::from_str::<Value>(&raw) else {
        return;
    };
    let Some(list) = doc.get("packages").and_then(|v| v.as_array()) else {
        return;
    };
    for entry in list {
        match entry {
            Value::String(s) => out.push(InstalledPackage {
                source: s.clone(),
                scope: scope.into(),
                filters: None,
            }),
            Value::Object(_) => {
                if let Some(s) = entry.get("source").and_then(|v| v.as_str()) {
                    let mut filters = entry.clone();
                    if let Some(obj) = filters.as_object_mut() {
                        obj.remove("source");
                    }
                    out.push(InstalledPackage {
                        source: s.to_string(),
                        scope: scope.into(),
                        filters: Some(filters),
                    });
                }
            }
            _ => {}
        }
    }
}

/// List installed packages from global settings and, when given, the project's
/// `.pi/settings.json`.
#[tauri::command]
pub fn package_list(project: Option<String>) -> Vec<InstalledPackage> {
    let mut out = Vec::new();
    read_packages_file(
        &trust::agent_dir().join("settings.json"),
        "global",
        &mut out,
    );
    if let Some(p) = project.filter(|s| !s.trim().is_empty()) {
        read_packages_file(
            &std::path::Path::new(&p).join(".pi").join("settings.json"),
            "project",
            &mut out,
        );
    }
    out
}

pub(crate) async fn run_pi(
    app: &AppHandle,
    args: &[String],
    cwd: Option<&str>,
) -> Result<String, String> {
    use pi_locate::Launcher;
    use tokio::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let cfg = commands::app_config_get(app.clone())?;
    let info = pi_locate::detect(cfg.pi_path).await;
    if !info.found {
        return Err(pix_error(
            "piNotFound",
            "未找到 pi，请先在设置中配置 pi 路径",
        ));
    }

    let mut cmd = match info.launcher {
        Some(Launcher::Node { node, script }) => {
            let mut c = Command::new(node);
            c.arg(script);
            c
        }
        Some(Launcher::Binary { path }) => Command::new(path),
        None => {
            let path = info
                .path
                .clone()
                .ok_or_else(|| pix_error("piLaunchUnknown", "无法确定 pi 启动方式"))?;
            let mut c = Command::new("cmd");
            c.arg("/C").arg(path);
            c
        }
    };
    cmd.args(args);
    if let Some(dir) = cwd.filter(|s| !s.trim().is_empty()) {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let output = tokio::time::timeout(COMMAND_TIMEOUT, cmd.output())
        .await
        .map_err(|_| pix_error("operationTimeout", "操作超时（5 分钟）"))?
        .map_err(|e| pix_error_detail("startPiFailed", format!("启动 pi 失败: {e}"), e))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = format!("{stdout}{stderr}").trim().to_string();
    if output.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            pix_error_detail(
                "piExitCode",
                format!("pi 退出码: {}", output.status),
                output.status,
            )
        } else {
            text
        })
    }
}

// A missing project must never make `pi install -l` use the app process's cwd.
fn local_project_dir(project: Option<&str>) -> Result<&str, String> {
    let dir = project
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| pix_error("projectDirRequired", "请选择要安装的项目文件夹"))?;
    let path = std::path::Path::new(dir);
    if !path.is_absolute() || !path.is_dir() {
        return Err(pix_error_detail(
            "projectDirInvalid",
            format!("项目文件夹不存在或不是完整路径: {dir}"),
            dir,
        ));
    }
    Ok(dir)
}

/// `pi install <source>` — scope "project" installs project-locally (`-l`).
#[tauri::command]
pub async fn package_install(
    app: AppHandle,
    source: String,
    scope: Option<String>,
    project: Option<String>,
) -> Result<String, String> {
    let local = scope.as_deref() == Some("project");
    let mut args = vec!["install".to_string(), source];
    if local {
        args.push("-l".into());
    }
    let cwd = if local {
        Some(local_project_dir(project.as_deref())?)
    } else {
        None
    };
    run_pi(&app, &args, cwd).await
}

/// `pi remove <source>` — scope "project" removes from project settings (`-l`).
#[tauri::command]
pub async fn package_remove(
    app: AppHandle,
    source: String,
    scope: Option<String>,
    project: Option<String>,
) -> Result<String, String> {
    let local = scope.as_deref() == Some("project");
    let mut args = vec!["remove".to_string(), source];
    if local {
        args.push("-l".into());
    }
    let cwd = if local {
        Some(local_project_dir(project.as_deref())?)
    } else {
        None
    };
    run_pi(&app, &args, cwd).await
}

/// Update one package (`pi update --extension <src>`) or, when `source` is
/// empty, all packages (`pi update --extensions`).
#[tauri::command]
pub async fn package_update(app: AppHandle, source: Option<String>) -> Result<String, String> {
    let args = match source.filter(|s| !s.trim().is_empty()) {
        Some(s) => vec!["update".to_string(), "--extension".into(), s],
        None => vec!["update".to_string(), "--extensions".into()],
    };
    run_pi(&app, &args, None).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_install_requires_explicit_existing_directory() {
        assert!(local_project_dir(None).is_err());
        assert!(local_project_dir(Some("  ")).is_err());
        assert!(local_project_dir(Some("relative-project")).is_err());
        assert!(local_project_dir(Some("/nonexistent-pi-x-test-project")).is_err());
        let dir = std::env::current_dir().unwrap();
        assert_eq!(local_project_dir(dir.to_str()), Ok(dir.to_str().unwrap()));
    }
}
