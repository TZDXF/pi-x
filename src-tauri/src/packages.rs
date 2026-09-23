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
    /// "global" (~/.pi/agent/settings.json) or "project" (<cwd>/.pi/settings.json)
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

// ---------------------------------------------------------------------------
// Resource management (enable / disable individual resources per package,
// mirroring `pi config`: writes +/- patterns into the package's settings entry)
// ---------------------------------------------------------------------------

const RESOURCE_TYPES: [&str; 4] = ["extensions", "skills", "prompts", "themes"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PackageResource {
    /// extensions | skills | prompts | themes
    pub resource_type: String,
    /// Path relative to the package root, posix separators.
    pub path: String,
    pub enabled: bool,
}

fn settings_path_for(scope: &str, project: Option<&str>) -> std::path::PathBuf {
    if scope == "project" {
        if let Some(p) = project.map(str::trim).filter(|s| !s.is_empty()) {
            return std::path::Path::new(p).join(".pi").join("settings.json");
        }
    }
    trust::agent_dir().join("settings.json")
}

/// Locate the `packages` array entry matching `source`; returns (index, is_object).
fn find_package_entry<'a>(doc: &'a Value, source: &str) -> Option<usize> {
    doc.get("packages")?
        .as_array()?
        .iter()
        .position(|e| match e {
            Value::String(s) => s == source,
            Value::Object(_) => e.get("source").and_then(|v| v.as_str()) == Some(source),
            _ => false,
        })
}

/// User filter patterns for one resource type; `None` when the key is absent
/// (load all). `Some([])` means load none.
fn filter_patterns(entry: &Value, resource_type: &str) -> Option<Vec<String>> {
    let arr = entry.get(resource_type)?.as_array()?;
    Some(
        arr.iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect(),
    )
}

/// Strip a leading override marker (`!`, `+`, `-`) from a filter pattern.
fn strip_pattern_marker(p: &str) -> &str {
    p.strip_prefix(['!', '+', '-']).unwrap_or(p)
}

/// Simplistic glob matcher supporting `**`, `*`, `?` against posix paths.
fn glob_match(pattern: &str, path: &str) -> bool {
    let mut re = String::from("^");
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '*' => {
                if chars.peek() == Some(&'*') {
                    chars.next();
                    // `**/` should also match zero segments
                    if chars.peek() == Some(&'/') {
                        chars.next();
                        re.push_str("(?:.*/)?");
                    } else {
                        re.push_str(".*");
                    }
                } else {
                    re.push_str("[^/]*");
                }
            }
            '?' => re.push_str("[^/]"),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::Regex::new(&re).map(|r| r.is_match(path)).unwrap_or(false)
}

/// Whether a resource is enabled under the given filter patterns
/// (mirrors pi's pattern semantics: plain patterns include, `!` excludes,
/// `+path` / `-path` force-include / force-exclude exact paths).
fn resource_enabled(rel: &str, patterns: Option<&[String]>) -> bool {
    let Some(pats) = patterns else { return true };
    if pats.is_empty() {
        return false; // explicit `[]` loads none of this type
    }
    let includes: Vec<&String> = pats
        .iter()
        .filter(|p| !p.starts_with(['!', '+', '-']))
        .collect();
    let mut enabled = includes.is_empty() || includes.iter().any(|p| glob_match(p.trim_end_matches("/*"), rel) || glob_match(p, rel));
    for p in pats {
        let marker = p.chars().next();
        let target = strip_pattern_marker(p);
        match marker {
            Some('!') if glob_match(target, rel) => enabled = false,
            Some('+') if target == rel => enabled = true,
            Some('-') if target == rel => enabled = false,
            _ => {}
        }
    }
    enabled
}

/// Resolve the on-disk root of an installed package, mirroring pi's install
/// layout (npm under `<base>/npm/node_modules/<name>`, git under
/// `<base>/git/<host>/<path>`, local paths used verbatim).
fn package_root_dir(source: &str, scope: &str, project: Option<&str>) -> Option<std::path::PathBuf> {
    let agent_dir = trust::agent_dir();
    let project_dir = project.map(str::trim).filter(|s| !s.is_empty());
    let base = |sub: &str| -> std::path::PathBuf {
        if scope == "project" {
            project_dir
                .map(|p| std::path::Path::new(p).join(".pi").join(sub))
                .unwrap_or_else(|| agent_dir.join(sub))
        } else {
            agent_dir.join(sub)
        }
    };

    if let Some(spec) = source.strip_prefix("npm:") {
        // strip a trailing version: `@scope/pkg@1.2.3` -> `@scope/pkg`
        let name = if let Some(rest) = spec.strip_prefix('@') {
            match rest.find('/') {
                Some(slash) => {
                    let after = &rest[slash + 1..];
                    match after.find('@') {
                        Some(at) => format!("@{}", &rest[..slash + 1 + at]),
                        None => spec.to_string(),
                    }
                }
                None => spec.to_string(),
            }
        } else {
            spec.split('@').next().unwrap_or(spec).to_string()
        };
        let dir = base("npm").join("node_modules").join(&name);
        return dir.is_dir().then_some(dir);
    }

    let git_spec = source
        .strip_prefix("git:")
        .or_else(|| {
            (source.starts_with("https://")
                || source.starts_with("http://")
                || source.starts_with("ssh://"))
            .then_some(source)
        });
    if let Some(spec) = git_spec {
        let spec = spec.strip_prefix("https://").or_else(|| spec.strip_prefix("http://")).unwrap_or(spec);
        let spec = spec.strip_prefix("ssh://").unwrap_or(spec);
        // `git@host:path` shorthand -> `host/path`
        let spec = match spec.split_once(':') {
            Some((prefix, rest)) if prefix.contains('@') => {
                format!("{}/{}", prefix.split('@').next_back().unwrap_or(prefix), rest)
            }
            _ => spec.to_string(),
        };
        // strip pinned ref (`...@v1`) — only when it follows a `/`
        let spec = match spec.rfind('@') {
            Some(at) if spec[..at].contains('/') => spec[..at].to_string(),
            _ => spec,
        };
        let (host, path) = spec.split_once('/')?;
        let dir = base("git").join(host).join(path);
        return dir.is_dir().then_some(dir);
    }

    // local path (absolute, or relative to the settings file's directory)
    let p = std::path::Path::new(source);
    let dir = if p.is_absolute() {
        p.to_path_buf()
    } else if scope == "project" {
        project_dir.map(|d| std::path::Path::new(d).join(p))?
    } else {
        agent_dir.join(p)
    };
    dir.is_dir().then_some(dir)
}

const IGNORED_DIRS: [&str; 4] = ["node_modules", ".git", ".pi", "dist"];

fn walk_files(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if path.is_dir() {
            if !IGNORED_DIRS.contains(&name.as_str()) && !name.starts_with('.') {
                walk_files(&path, root, out);
            }
        } else if name.starts_with('.') {
            continue;
        } else if let Ok(rel) = path.strip_prefix(root) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// Collect resource paths (relative, posix) for one type, honouring the
/// package.json `pi` manifest when present, else conventional directories.
fn collect_resources(root: &std::path::Path, resource_type: &str) -> Vec<String> {
    let manifest_entry = std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|pkg| pkg.get("pi").cloned())
        .and_then(|pi| pi.get(resource_type).cloned());

    let mut files = Vec::new();
    walk_files(root, root, &mut files);

    let mut out: Vec<String> = Vec::new();
    match &manifest_entry {
        Some(Value::Array(entries)) => {
            for e in entries.iter().filter_map(|v| v.as_str()) {
                if e.starts_with('!') || e.starts_with('+') || e.starts_with('-') {
                    continue; // manifest-level overrides: keep base enumeration
                }
                if e.contains('*') || e.contains('?') {
                    out.extend(files.iter().filter(|f| glob_match(e, f)).cloned());
                } else {
                    let target = root.join(e);
                    if target.is_file() {
                        out.push(e.trim_start_matches("./").to_string());
                    } else if target.is_dir() {
                        out.extend(files.iter().filter(|f| f.starts_with(&*e.trim_start_matches("./"))).cloned());
                    }
                }
            }
        }
        _ => {
            let dir = root.join(resource_type);
            if dir.is_dir() {
                out.extend(files.iter().filter(|f| f.starts_with(resource_type)).cloned());
            }
        }
    }

    if resource_type == "skills" {
        // skills load via their SKILL.md; address the skill directory instead
        let mut dirs: Vec<String> = out
            .iter()
            .filter_map(|f| {
                if f.ends_with("SKILL.md") {
                    f.rsplit_once('/').map(|(d, _)| d.to_string())
                } else {
                    None
                }
            })
            .collect();
        dirs.sort();
        dirs.dedup();
        if !dirs.is_empty() {
            return dirs;
        }
    }
    out.sort();
    out.dedup();
    out
}

/// List an installed package's resources with their enabled state.
#[tauri::command]
pub fn package_resources(
    source: String,
    scope: String,
    project: Option<String>,
) -> Result<Vec<PackageResource>, String> {
    let settings_file = settings_path_for(&scope, project.as_deref());
    let raw = std::fs::read_to_string(&settings_file)
        .map_err(|e| format!("读取设置失败: {e}"))?;
    let doc: Value = serde_json::from_str(&raw).map_err(|e| format!("解析设置失败: {e}"))?;
    let idx = find_package_entry(&doc, &source).ok_or("设置中未找到该插件")?;
    let entry = &doc["packages"][idx];

    let root = package_root_dir(&source, &scope, project.as_deref())
        .ok_or("未找到插件安装目录（尚未安装或来源不支持）")?;

    let mut out = Vec::new();
    for rt in RESOURCE_TYPES {
        let patterns = filter_patterns(entry, rt);
        let enabled_fn = |rel: &str| resource_enabled(rel, patterns.as_deref());
        for rel in collect_resources(&root, rt) {
            out.push(PackageResource {
                resource_type: rt.to_string(),
                enabled: enabled_fn(&rel),
                path: rel,
            });
        }
    }
    Ok(out)
}

/// Enable or disable one resource of an installed package by writing a
/// `+path` / `-path` pattern into the package's settings entry (same shape as
/// `pi config` writes).
#[tauri::command]
pub fn package_set_resource(
    source: String,
    scope: String,
    project: Option<String>,
    resource_type: String,
    path: String,
    enabled: bool,
) -> Result<(), String> {
    if !RESOURCE_TYPES.contains(&resource_type.as_str()) {
        return Err(format!("未知资源类型: {resource_type}"));
    }
    let settings_file = settings_path_for(&scope, project.as_deref());
    let raw = std::fs::read_to_string(&settings_file).unwrap_or_else(|_| "{}".into());
    let mut doc: Value = serde_json::from_str(&raw).map_err(|e| format!("解析设置失败: {e}"))?;

    let idx = find_package_entry(&doc, &source).ok_or("设置中未找到该插件")?;
    let packages = doc.get_mut("packages").and_then(|v| v.as_array_mut()).ok_or("packages 配置无效")?;

    // ensure object form
    if packages[idx].is_string() {
        let s = packages[idx].as_str().unwrap_or_default().to_string();
        packages[idx] = serde_json::json!({ "source": s });
    }
    let entry = &mut packages[idx];

    let existing = entry
        .get(&resource_type)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    // replace any pattern already targeting this path
    let mut updated: Vec<String> = existing
        .into_iter()
        .filter(|p| strip_pattern_marker(p) != path)
        .collect();
    updated.push(format!("{}{}", if enabled { '+' } else { '-' }, path));

    let obj = entry.as_object_mut().ok_or("packages 配置无效")?;
    obj.insert(resource_type, serde_json::Value::Array(
        updated.into_iter().map(serde_json::Value::String).collect(),
    ));

    // collapse back to a plain string when no filters remain
    let has_filters = RESOURCE_TYPES.iter().any(|k| {
        obj.get(*k)
            .and_then(|v| v.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false)
    });
    if !has_filters {
        let source_val = obj.get("source").cloned().unwrap_or_default();
        packages[idx] = source_val;
    }

    std::fs::write(
        &settings_file,
        serde_json::to_string_pretty(&doc).map_err(|e| format!("序列化设置失败: {e}"))?,
    )
    .map_err(|e| format!("写入设置失败: {e}"))
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

    #[test]
    fn glob_matching() {
        assert!(glob_match("extensions/*.ts", "extensions/foo.ts"));
        assert!(!glob_match("extensions/*.ts", "extensions/sub/foo.ts"));
        assert!(glob_match("extensions/**/*.ts", "extensions/sub/foo.ts"));
        assert!(glob_match("extensions/**/*.ts", "extensions/foo.ts"));
        assert!(glob_match("skills/*/SKILL.md", "skills/demo/SKILL.md"));
        assert!(!glob_match("skills/*", "other/x"));
    }

    #[test]
    fn resource_enabled_semantics() {
        // absent key -> all enabled
        assert!(resource_enabled("a.ts", None));
        // explicit [] -> none enabled
        assert!(!resource_enabled("a.ts", Some(&[])));
        // exclusion overrides
        let pats: Vec<String> = vec!["!a.ts".into()];
        assert!(!resource_enabled("a.ts", Some(&pats)));
        assert!(resource_enabled("b.ts", Some(&pats)));
        // force-exclude beats force-include
        let pats: Vec<String> = vec!["+a.ts".into(), "-a.ts".into()];
        assert!(!resource_enabled("a.ts", Some(&pats)));
        // plain includes gate everything else
        let pats: Vec<String> = vec!["extensions/*.ts".into()];
        assert!(resource_enabled("extensions/a.ts", Some(&pats)));
        assert!(!resource_enabled("skills/x/SKILL.md", Some(&pats)));
    }

    #[test]
    fn npm_name_strips_version() {
        let dir = package_root_dir("npm:@scope/pkg@1.2.3", "__none__", None);
        assert!(dir.is_none()); // not installed, but must not panic
    }
}
