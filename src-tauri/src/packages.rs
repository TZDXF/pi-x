//! Pi package management: browse the official catalog at https://pi.dev/packages
//! and drive `pi install / remove / update` for the user.

use serde::Serialize;
use serde_json::Value;
use std::process::Stdio;
use tauri::AppHandle;

use crate::{commands, pi_locate, trust};

const CATALOG_URL: &str = "https://pi.dev/packages";
const COMMAND_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

// ---------------------------------------------------------------------------
// Catalog (pi.dev/packages)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CatalogPackage {
    pub name: String,
    pub description: String,
    pub author: String,
    /// Downloads in the last month (as reported by the catalog page).
    pub downloads_month: u64,
    /// Last publish time, unix epoch milliseconds.
    pub updated_ms: u64,
    /// Resource types the package ships (extension / skill / prompt / theme).
    pub types: Vec<String>,
    /// Install source, e.g. `npm:pi-mcp-adapter`.
    pub source: String,
    /// Absolute URL of the detail page on pi.dev.
    pub detail_url: String,
    pub npm_url: Option<String>,
}

fn unescape_html(s: &str) -> String {
    s.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

fn strip_tags(s: &str) -> String {
    let re = regex::Regex::new(r"<[^>]*>").unwrap();
    re.replace_all(s, "").to_string()
}

fn parse_catalog(html: &str) -> Vec<CatalogPackage> {
    let attr = |tag: &str, key: &str| -> Option<String> {
        let re = regex::Regex::new(&format!(r#"{key}="([^"]*)""#)).ok()?;
        Some(unescape_html(re.captures(tag)?.get(1)?.as_str()))
    };
    let desc_re = regex::Regex::new(r#"(?s)<p class="packages-desc">(.*?)</p>"#).unwrap();
    let author_re = regex::Regex::new(r#"(?s)<div class="packages-meta">\s*<span>(.*?)</span>"#).unwrap();
    let npm_re = regex::Regex::new(r#"href="(https://www\.npmjs\.com/package/[^"]+)""#).unwrap();
    let install_re = regex::Regex::new(r"pi install ([^\s<]+)").unwrap();

    let mut out = Vec::new();
    for chunk in html.split(r#"data-package-card="true""#).skip(1) {
        let end = chunk.find("</article>").unwrap_or(chunk.len());
        let card = &chunk[..end];
        // attributes live on the opening <article> tag
        let tag_end = card.find('>').unwrap_or(0);
        let tag = &card[..tag_end];

        let Some(name) = attr(tag, "data-package-name") else { continue };
        let description = desc_re
            .captures(card)
            .map(|c| strip_tags(&unescape_html(c.get(1).unwrap().as_str())).trim().to_string())
            .unwrap_or_default();
        let author = author_re
            .captures(card)
            .map(|c| strip_tags(c.get(1).unwrap().as_str()).trim().to_string())
            .unwrap_or_default();
        let downloads_month = attr(tag, "data-package-downloads")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let updated_ms = attr(tag, "data-package-date")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);
        let mut types: Vec<String> = attr(tag, "data-package-types")
            .map(|v| v.split_whitespace().map(|s| s.to_string()).collect())
            .unwrap_or_default();
        if types.is_empty() {
            types.push("package".into());
        }
        let source = install_re
            .captures(card)
            .map(|c| unescape_html(c.get(1).unwrap().as_str()))
            .unwrap_or_else(|| format!("npm:{name}"));
        let npm_url = npm_re.captures(card).map(|c| c.get(1).unwrap().as_str().to_string());

        out.push(CatalogPackage {
            detail_url: format!("https://pi.dev/packages/{name}"),
            name,
            description,
            author,
            downloads_month,
            updated_ms,
            types,
            source,
            npm_url,
        });
    }
    out
}

/// Fetch and parse the official pi package catalog (https://pi.dev/packages).
#[tauri::command]
pub async fn package_catalog() -> Result<Vec<CatalogPackage>, String> {
    let html = tauri::async_runtime::spawn_blocking(|| {
        ureq::get(CATALOG_URL)
            .set("User-Agent", "pi-x desktop")
            .timeout(std::time::Duration::from_secs(30))
            .call()
            .map_err(|e| format!("获取插件市场失败: {e}"))?
            .into_string()
            .map_err(|e| format!("读取插件市场响应失败: {e}"))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(parse_catalog(&html))
}

// ---------------------------------------------------------------------------
// Installed packages (settings.json, global + project)
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InstalledPackage {
    /// Install source as stored in settings.json.
    pub source: String,
    /// "global" (~/.pix/agent/settings.json) or "project" (<cwd>/.pi/settings.json)
    pub scope: String,
    /// Resource filters when the object form is used (`{source, extensions, ...}`),
    /// passed through verbatim for display.
    pub filters: Option<Value>,
}

fn read_packages_file(path: &std::path::Path, scope: &str, out: &mut Vec<InstalledPackage>) {
    let Ok(raw) = std::fs::read_to_string(path) else { return };
    let Ok(doc) = serde_json::from_str::<Value>(&raw) else { return };
    let Some(list) = doc.get("packages").and_then(|v| v.as_array()) else { return };
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
    read_packages_file(&trust::agent_dir().join("settings.json"), "global", &mut out);
    if let Some(p) = project.filter(|s| !s.trim().is_empty()) {
        read_packages_file(
            &std::path::Path::new(&p).join(".pi").join("settings.json"),
            "project",
            &mut out,
        );
    }
    out
}

// ---------------------------------------------------------------------------
// pi CLI runner (install / remove / update)
// ---------------------------------------------------------------------------

async fn run_pi(app: &AppHandle, args: &[String], cwd: Option<&str>) -> Result<String, String> {
    use pi_locate::Launcher;
    use tokio::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let cfg = commands::app_config_get(app.clone())?;
    let info = pi_locate::detect(cfg.pi_path).await;
    if !info.found {
        return Err("未找到 pi，请先在设置中配置 pi 路径".into());
    }

    let mut cmd = match info.launcher {
        Some(Launcher::Node { node, script }) => {
            let mut c = Command::new(node);
            c.arg(script);
            c
        }
        Some(Launcher::Binary { path }) => Command::new(path),
        None => {
            let path = info.path.clone().ok_or("无法确定 pi 启动方式")?;
            let mut c = Command::new("cmd");
            c.arg("/C").arg(path);
            c
        }
    };
    cmd.env("PI_CODING_AGENT_DIR", crate::trust::agent_dir());
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
        .map_err(|_| "操作超时（5 分钟）".to_string())?
        .map_err(|e| format!("启动 pi 失败: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let text = format!("{stdout}{stderr}").trim().to_string();
    if output.status.success() {
        Ok(text)
    } else {
        Err(if text.is_empty() {
            format!("pi 退出码: {}", output.status)
        } else {
            text
        })
    }
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
    let cwd = if local { project.as_deref() } else { None };
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
    let cwd = if local { project.as_deref() } else { None };
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
    fn parses_catalog_cards() {
        let html = r#"<article class="surface-panel content-card" data-package-card="true" data-package-name="pi-mcp-adapter" data-package-search="x" data-package-types="extension skill" data-package-downloads="972000" data-package-date="1788380245174" data-package-sort-name="pi-mcp-adapter"><div class="packages-card-body"><h3 class="packages-name"><a href="/packages/pi-mcp-adapter">pi-mcp-adapter</a></h3><p class="packages-desc">MCP adapter &amp; more</p><div class="packages-meta"><span>nicopreme</span><span>972K/mo</span><span>1d ago</span></div><div class="packages-links"><a href="https://www.npmjs.com/package/pi-mcp-adapter">npm</a></div><div class="packages-install"><code><span class="prefix">$</span> pi install npm:pi-mcp-adapter</code></div></div></article>"#;
        let pkgs = parse_catalog(html);
        assert_eq!(pkgs.len(), 1);
        let p = &pkgs[0];
        assert_eq!(p.name, "pi-mcp-adapter");
        assert_eq!(p.description, "MCP adapter & more");
        assert_eq!(p.author, "nicopreme");
        assert_eq!(p.downloads_month, 972000);
        assert_eq!(p.updated_ms, 1788380245174);
        assert_eq!(p.types, vec!["extension", "skill"]);
        assert_eq!(p.source, "npm:pi-mcp-adapter");
        assert_eq!(p.npm_url.as_deref(), Some("https://www.npmjs.com/package/pi-mcp-adapter"));
    }

    #[test]
    fn parses_live_catalog_fixture() {
        let html = include_str!("../tests/fixtures/packages.html");
        let pkgs = parse_catalog(html);
        assert!(pkgs.len() >= 50, "expected >= 50 packages, got {}", pkgs.len());
        let mcp = pkgs.iter().find(|p| p.name == "pi-mcp-adapter").expect("pi-mcp-adapter");
        assert_eq!(mcp.source, "npm:pi-mcp-adapter");
        assert!(mcp.downloads_month > 0);
        assert!(!mcp.author.is_empty());
        // every card needs a usable install source and detail URL
        for p in &pkgs {
            assert!(!p.source.is_empty(), "{}: empty source", p.name);
            assert!(p.detail_url.starts_with("https://pi.dev/packages/"));
        }
    }

    #[test]
    fn empty_types_fall_back_to_package() {
        let html = r#"<article data-package-card="true" data-package-name="x" data-package-types="" data-package-downloads="0" data-package-date="0"><p class="packages-desc"></p></article>"#;
        let pkgs = parse_catalog(html);
        assert_eq!(pkgs[0].types, vec!["package"]);
    }
}
