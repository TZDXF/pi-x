//! Locate a usable `pi` executable and resolve HOW to launch it.
//!
//! On Windows, npm global installs create `.cmd` shims. Spawning those via
//! `cmd /C` is unreliable for piped subprocesses (npm's `goto #_undefined_#`
//! shim trick can exit silently), so we parse the shim and launch
//! `<node> <cli.js>` directly instead.

use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::errors::pix_error;

/// How to start the pi process.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Launcher {
    /// Run `<node> <script> [args...]`
    Node { node: String, script: String },
    /// Run `<path> [args...]` directly (native binary / sh script with shebang)
    Binary { path: String },
}

#[derive(Serialize, Clone, Default)]
pub struct PiInfo {
    pub found: bool,
    /// What the user selected / what was found on PATH (display + config)
    pub path: Option<String>,
    pub version: Option<String>,
    /// where it came from: "config" | "path"
    pub source: Option<String>,
    pub hint: String,
    pub launcher: Option<Launcher>,
}

fn candidate_names() -> &'static [&'static str] {
    if cfg!(windows) {
        &["pi.exe", "pi.cmd", "pi.bat", "pi"]
    } else {
        &["pi"]
    }
}

fn fallback_dirs() -> Vec<PathBuf> {
    let mut v = Vec::new();
    if let Some(appdata) = dirs::data_dir() {
        v.push(appdata.join("npm")); // npm global bin on Windows
    }
    if let Some(bin) = dirs::executable_dir() {
        v.push(bin.to_path_buf());
    }
    if let Some(home) = dirs::home_dir() {
        v.push(home.join(".local").join("bin"));
        v.push(home.join("bin"));
    }
    v
}

fn scan_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(path_var) = std::env::var_os("PATH") {
        dirs.extend(std::env::split_paths(&path_var));
    }
    for d in fallback_dirs() {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

pub(crate) fn is_windows_script(path: &str) -> bool {
    let lower = path.to_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// Parse an npm `.cmd` shim and resolve (node, cli.js) paths.
///
/// npm shims look like:
/// ```text
/// ... & "%_prog%"  "%dp0%\node_modules\@scope\pkg\dist\bundle\cli.js" %*
/// ```
/// `%_prog%` is `%dp0%\node.exe` when a node.exe sits next to the shim,
/// otherwise plain `node` (resolved from PATH at spawn time).
fn resolve_windows_shim(shim: &Path) -> Option<Launcher> {
    let content = std::fs::read_to_string(shim).ok()?;
    let dp0 = shim.parent()?;

    // find the LAST quoted token that points at the packaged JS entry
    let mut script_rel: Option<String> = None;
    for segment in content.split('"').skip(1).step_by(2) {
        let seg = segment.trim();
        if seg.contains("node_modules") && seg.to_lowercase().ends_with(".js") {
            script_rel = Some(seg.to_string());
        }
    }
    let script_rel = script_rel?;

    // strip %dp0% / %~dp0 prefix and leading separators
    let mut rel = script_rel
        .replace("%dp0%", "")
        .replace("%~dp0", "")
        .replace('/', "\\");
    while rel.starts_with('\\') {
        rel.remove(0);
    }
    if rel.is_empty() {
        return None;
    }
    let script = dp0.join(&rel);
    if !script.exists() {
        return None;
    }

    // prefer the node.exe sitting next to the shim; fall back to PATH lookup
    let node = dp0
        .join("node.exe")
        .exists()
        .then(|| dp0.join("node.exe").to_string_lossy().to_string())
        .unwrap_or_else(|| "node".to_string());

    Some(Launcher::Node {
        node,
        script: script.to_string_lossy().to_string(),
    })
}

fn build_launcher(path: &str) -> Option<Launcher> {
    let p = Path::new(path);
    if cfg!(windows) && is_windows_script(path) {
        resolve_windows_shim(p)
    } else {
        Some(Launcher::Binary {
            path: path.to_string(),
        })
    }
}

pub async fn detect(custom_path: Option<String>) -> PiInfo {
    // 1) user-configured path wins
    if let Some(p) = custom_path.filter(|s| !s.trim().is_empty()) {
        let p = p.trim().to_string();
        if Path::new(&p).exists() {
            let launcher = build_launcher(&p);
            let version = probe_version(&p, launcher.as_ref()).await;
            return PiInfo {
                found: true,
                path: Some(p),
                version,
                source: Some("config".into()),
                hint: String::new(),
                launcher,
            };
        }
    }

    // 2) scan PATH + common install locations
    for dir in scan_dirs() {
        for name in candidate_names() {
            let candidate = dir.join(name);
            if candidate.is_file() {
                let path = candidate.to_string_lossy().to_string();
                let launcher = build_launcher(&path);
                let version = probe_version(&path, launcher.as_ref()).await;
                return PiInfo {
                    found: true,
                    path: Some(path),
                    version,
                    source: Some("path".into()),
                    hint: String::new(),
                    launcher,
                };
            }
        }
    }

    PiInfo {
        found: false,
        path: None,
        version: None,
        source: None,
        hint: "Install pi with: npm install -g --ignore-scripts @earendil-works/pi-coding-agent"
            .into(),
        launcher: None,
    }
}

/// Run `pi --version` to confirm the resolved launcher actually works.
async fn probe_version(path: &str, launcher: Option<&Launcher>) -> Option<String> {
    use std::process::Stdio;
    use tokio::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let mut cmd = match launcher {
        Some(Launcher::Node { node, script }) => {
            let mut c = Command::new(node);
            c.arg(script).arg("--version");
            c
        }
        Some(Launcher::Binary { path }) => {
            let mut c = Command::new(path);
            c.arg("--version");
            c
        }
        None => {
            let mut c = Command::new("cmd");
            c.arg("/C").arg(path).arg("--version");
            c
        }
    };
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.stdin(Stdio::null());
    let output = cmd.output().await.ok()?;

    let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text.lines().next().unwrap_or("").to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Parses an npm `.cmd` shim with Windows separators; unreachable on other
    // platforms (build_launcher only resolves shims under cfg(windows)).
    #[cfg(windows)]
    #[test]
    fn resolves_npm_cmd_shim() {
        let dir = std::env::temp_dir().join("pix-shim-test");
        std::fs::create_dir_all(&dir).unwrap();
        let shim = dir.join("pi.cmd");
        std::fs::write(
            &shim,
            "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST \"%dp0%\\node.exe\" (\r\n  SET \"_prog=%dp0%\\node.exe\"\r\n) ELSE (\r\n  SET \"_prog=node\"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & \"%_prog%\"  \"%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js\" %*\r\n",
        )
        .unwrap();
        // script file must exist for the resolver to accept it
        let script = dir
            .join("node_modules")
            .join("@earendil-works")
            .join("pi-coding-agent")
            .join("dist")
            .join("bundle");
        std::fs::create_dir_all(&script).unwrap();
        let script = script.join("cli.js");
        std::fs::write(&script, "").unwrap();
        // fake node.exe next to the shim so the resolver picks it
        std::fs::write(dir.join("node.exe"), b"").unwrap();

        let launcher = resolve_windows_shim(&shim).expect("should resolve");
        match launcher {
            Launcher::Node { node, script: s } => {
                assert_eq!(s, script.to_string_lossy().to_string());
                assert!(node.ends_with("node.exe"));
            }
            _ => panic!("expected Node launcher"),
        }
    }
}

/// Resolve the installed SDK next to the selected CLI; never install a second Pi.
pub fn sdk_launcher(custom: Option<&str>) -> Result<(String, PathBuf), String> {
    let candidates: Vec<PathBuf> = if let Some(path) = custom.filter(|s| !s.trim().is_empty() && Path::new(s.trim()).is_file()) {
        vec![PathBuf::from(path.trim())]
    } else {
        scan_dirs().into_iter().flat_map(|dir| candidate_names().iter().map(move |name| dir.join(name))).collect()
    };
    for path in candidates {
        if !path.is_file() { continue; }
        let launcher = build_launcher(&path.to_string_lossy());
        let (node, script) = match launcher {
            Some(Launcher::Node { node, script }) => (node, PathBuf::from(script)),
            _ => {
                let real = dunce::canonicalize(&path).map_err(|e| e.to_string())?;
                if real.extension().and_then(|v| v.to_str()) != Some("js") {
                    return Err(pix_error("piSdkMissing", "所选 Pi 未提供 Node.js SDK，请选择 npm 版 Pi。"));
                }
                ("node".into(), real)
            }
        };
        for parent in script.ancestors().skip(1).take(4) {
            if parent.join("core/settings-manager.js").is_file() && parent.join("config.js").is_file() {
                return Ok((node, parent.to_path_buf()));
            }
        }
        break; // Never use a different Pi installation than the selected launcher.
    }
    Err(pix_error("piSdkUnavailable", "当前 Pi 安装未提供可用 SDK。请使用带 dist/core 的 npm 版 Pi；PiX 不会另建数据或绕过信任检查。"))
}
