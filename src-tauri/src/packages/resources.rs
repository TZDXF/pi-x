//! Resource management: enable / disable individual resources per package,
//! mirroring `pi config` (writes +/- patterns into the package's settings entry).

use serde::Serialize;
use serde_json::Value;

use crate::{
    errors::{pix_error, pix_error_detail},
    trust,
};

use super::runner::package_list;

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
    regex::Regex::new(&re)
        .map(|r| r.is_match(path))
        .unwrap_or(false)
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
    let mut enabled = includes.is_empty()
        || includes
            .iter()
            .any(|p| glob_match(p.trim_end_matches("/*"), rel) || glob_match(p, rel));
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
fn package_root_dir(
    source: &str,
    scope: &str,
    project: Option<&str>,
) -> Option<std::path::PathBuf> {
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

    let git_spec = source.strip_prefix("git:").or_else(|| {
        (source.starts_with("https://")
            || source.starts_with("http://")
            || source.starts_with("ssh://"))
        .then_some(source)
    });
    if let Some(spec) = git_spec {
        let spec = spec
            .strip_prefix("https://")
            .or_else(|| spec.strip_prefix("http://"))
            .unwrap_or(spec);
        let spec = spec.strip_prefix("ssh://").unwrap_or(spec);
        // `git@host:path` shorthand -> `host/path`
        let spec = match spec.split_once(':') {
            Some((prefix, rest)) if prefix.contains('@') => {
                format!(
                    "{}/{}",
                    prefix.split('@').next_back().unwrap_or(prefix),
                    rest
                )
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
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
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
                        out.extend(
                            files
                                .iter()
                                .filter(|f| f.starts_with(&*e.trim_start_matches("./")))
                                .cloned(),
                        );
                    }
                }
            }
        }
        _ => {
            let dir = root.join(resource_type);
            if dir.is_dir() {
                out.extend(
                    files
                        .iter()
                        .filter(|f| f.starts_with(resource_type))
                        .cloned(),
                );
            }
        }
    }

    if resource_type == "skills" {
        // A package can ship both SKILL.md directories and standalone Markdown
        // skills. Keep both instead of dropping files whenever a directory exists.
        out = out
            .into_iter()
            .filter_map(|rel| {
                if rel == "SKILL.md" {
                    Some(".".to_string())
                } else if let Some(dir) = rel.strip_suffix("/SKILL.md") {
                    Some(dir.to_string())
                } else if rel.to_ascii_lowercase().ends_with(".md") {
                    Some(rel)
                } else {
                    None
                }
            })
            .filter(|rel| {
                let path = root.join(rel);
                let nested_in_skill = path
                    .ancestors()
                    .skip(1)
                    .take_while(|parent| *parent != root)
                    .any(|parent| parent.join("SKILL.md").is_file());
                !nested_in_skill
                    && (path.is_dir() && path.join("SKILL.md").is_file()
                        || path.is_file() && crate::skills::valid_skill_markdown(&path))
            })
            .collect();
    }
    out.sort();
    out.dedup();
    out
}

/// Enabled skill locations from installed personal and current-project packages.
/// Reuse the same manifest and settings filters as the package resources UI.
pub(crate) struct PackageSkillPath {
    pub path: std::path::PathBuf,
    pub source: String,
}

pub(crate) fn package_skill_paths(project: Option<&str>) -> Vec<PackageSkillPath> {
    let mut paths = Vec::new();
    for package in package_list(project.map(str::to_string)) {
        let Some(root) = package_root_dir(&package.source, &package.scope, project) else {
            continue;
        };
        let patterns = package
            .filters
            .as_ref()
            .and_then(|filters| filters.get("skills"))
            .and_then(|v| v.as_array())
            .map(|entries| {
                entries
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect::<Vec<_>>()
            });
        for rel in collect_resources(&root, "skills") {
            if resource_enabled(&rel, patterns.as_deref()) {
                paths.push(PackageSkillPath {
                    path: root.join(rel),
                    source: package.source.clone(),
                });
            }
        }
    }
    paths
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
        .map_err(|e| pix_error_detail("settingsReadFailed", format!("读取设置失败: {e}"), e))?;
    let doc: Value = serde_json::from_str(&raw)
        .map_err(|e| pix_error_detail("settingsParseFailed", format!("解析设置失败: {e}"), e))?;
    let idx = find_package_entry(&doc, &source)
        .ok_or_else(|| pix_error("pluginNotInSettings", "设置中未找到该插件"))?;
    let entry = &doc["packages"][idx];

    let root = package_root_dir(&source, &scope, project.as_deref()).ok_or_else(|| {
        pix_error(
            "pluginInstallDirNotFound",
            "未找到插件安装目录（尚未安装或来源不支持）",
        )
    })?;

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
        return Err(pix_error_detail(
            "unknownResourceType",
            format!("未知资源类型: {resource_type}"),
            resource_type,
        ));
    }
    let settings_file = settings_path_for(&scope, project.as_deref());
    let raw = std::fs::read_to_string(&settings_file).unwrap_or_else(|_| "{}".into());
    let mut doc: Value = serde_json::from_str(&raw)
        .map_err(|e| pix_error_detail("settingsParseFailed", format!("解析设置失败: {e}"), e))?;

    let idx = find_package_entry(&doc, &source)
        .ok_or_else(|| pix_error("pluginNotInSettings", "设置中未找到该插件"))?;
    let packages = doc
        .get_mut("packages")
        .and_then(|v| v.as_array_mut())
        .ok_or_else(|| pix_error("packagesConfigInvalid", "packages 配置无效"))?;

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

    let obj = entry
        .as_object_mut()
        .ok_or_else(|| pix_error("packagesConfigInvalid", "packages 配置无效"))?;
    obj.insert(
        resource_type,
        serde_json::Value::Array(updated.into_iter().map(serde_json::Value::String).collect()),
    );

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
        serde_json::to_string_pretty(&doc).map_err(|e| {
            pix_error_detail("settingsSerializeFailed", format!("序列化设置失败: {e}"), e)
        })?,
    )
    .map_err(|e| pix_error_detail("settingsWriteFailed", format!("写入设置失败: {e}"), e))
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn package_skills_include_manifest_directories_and_files_and_honor_filters() {
        let tmp = std::env::temp_dir().join(format!("pix-package-skills-{}", uuid::Uuid::new_v4()));
        let project = tmp.join("project");
        let package = project.join("plugin");
        let skill = package.join("custom").join("demo");
        std::fs::create_dir_all(&skill).unwrap();
        std::fs::create_dir_all(project.join(".pi")).unwrap();
        std::fs::write(
            skill.join("SKILL.md"),
            "---\nname: demo\ndescription: Demo\n---\n",
        )
        .unwrap();
        std::fs::write(
            package.join("custom").join("single.md"),
            "---\ndescription: Single\n---\n",
        )
        .unwrap();
        std::fs::create_dir_all(skill.join("references")).unwrap();
        std::fs::write(
            skill.join("references").join("guide.md"),
            "---\nname: not-a-skill\ndescription: Reference documentation\n---\n",
        )
        .unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"pi":{"skills":["./custom"]}}"#,
        )
        .unwrap();
        std::fs::write(
            project.join(".pi").join("settings.json"),
            r#"{"packages":[{"source":"plugin","skills":["-custom/demo"]}]}"#,
        )
        .unwrap();

        let resources = collect_resources(&package, "skills");
        assert_eq!(resources, vec!["custom/demo", "custom/single.md"]);
        let paths = package_skill_paths(Some(project.to_str().unwrap()));
        assert!(!paths.iter().any(|p| p.path == skill));
        assert!(paths
            .iter()
            .any(|p| p.path == package.join("custom").join("single.md")));

        std::fs::write(
            project.join(".pi").join("settings.json"),
            r#"{"packages":["plugin"]}"#,
        )
        .unwrap();
        let paths = package_skill_paths(Some(project.to_str().unwrap()));
        assert!(paths.iter().any(|p| p.path == skill));
        assert!(paths
            .iter()
            .any(|p| p.path == package.join("custom").join("single.md")));
        std::fs::remove_dir_all(tmp).unwrap();
    }

    #[test]
    fn npm_name_strips_version() {
        let dir = package_root_dir("npm:@scope/pkg@1.2.3", "__none__", None);
        assert!(dir.is_none()); // not installed, but must not panic
    }
}

/// List every file inside an installed package root (relative, posix paths),
/// mirroring the walk used for resource discovery (ignores node_modules,
/// .git, .pi, dist and dotfiles).
#[tauri::command]
pub fn package_list_files(
    source: String,
    scope: String,
    project: Option<String>,
) -> Result<Vec<String>, String> {
    let root = package_root_dir(&source, &scope, project.as_deref()).ok_or_else(|| {
        pix_error(
            "pluginInstallDirNotFound",
            "未找到插件安装目录（尚未安装或来源不支持）",
        )
    })?;
    let mut files = Vec::new();
    walk_files(&root, &root, &mut files);
    files.sort();
    Ok(files)
}

/// Read one file inside an installed package for preview. `path` is relative
/// to the package root with forward slashes. Text files are capped at 512 KB
/// on a UTF-8 boundary; binary content is rejected with `resourceBinary`.
#[tauri::command]
pub fn package_read_file(
    source: String,
    scope: String,
    path: String,
    project: Option<String>,
) -> Result<String, String> {
    // Reject path traversal: the relative path must stay inside the package root.
    if path.contains("..") || path.starts_with('/') || path.starts_with('\\') || path.contains(':') {
        return Err(pix_error("invalidResourcePath", "无效的资源路径"));
    }
    let root = package_root_dir(&source, &scope, project.as_deref()).ok_or_else(|| {
        pix_error(
            "pluginInstallDirNotFound",
            "未找到插件安装目录（尚未安装或来源不支持）",
        )
    })?;
    let file = root.join(&path);
    let canonical = dunce::canonicalize(&file).map_err(|e| {
        pix_error_detail(
            "resourceReadFailed",
            format!("读取资源文件失败: {} ({e})", file.display()),
            format!("{}: {e}", file.display()),
        )
    })?;
    let canonical_root = dunce::canonicalize(&root)
        .map_err(|e| pix_error_detail("pluginInstallDirNotFound", format!("解析插件目录失败: {e}"), e))?;
    if !canonical.starts_with(&canonical_root) {
        return Err(pix_error("invalidResourcePath", "资源路径越界"));
    }
    let bytes = std::fs::read(&canonical).map_err(|e| {
        pix_error_detail(
            "resourceReadFailed",
            format!("读取资源文件失败: {} ({e})", file.display()),
            format!("{}: {e}", file.display()),
        )
    })?;
    // Binary sniff (git style): NUL in the first 8 KB, or invalid UTF-8 overall.
    let sniff_end = bytes.len().min(8_000);
    if bytes[..sniff_end].contains(&0) {
        return Err(pix_error("resourceBinary", "二进制文件，不支持文本预览"));
    }
    String::from_utf8(bytes).map_err(|_| pix_error("resourceBinary", "二进制文件，不支持文本预览"))
}

/// Translate a package resource file's content using the configured
/// translation model. Spawns an isolated pi process (same pattern as title
/// generation) and returns the translated text.
#[tauri::command]
pub async fn package_translate(
    app: tauri::AppHandle,
    content: String,
    target_lang: String,
) -> Result<String, String> {
    let config = crate::commands::app_config_get(app)?;
    let model = config.translation_model.clone().or_else(|| config.default_model.clone());
    let Some(model) = model else {
        return Err(pix_error("noTranslationModel", "未配置翻译模型，请在模型配置中选择"));
    };
    if model.provider.trim().is_empty() || model.model_id.trim().is_empty() || content.trim().is_empty() {
        return Err(pix_error("noTranslationModel", "翻译模型或内容为空"));
    }
    let pi = crate::pi_locate::detect(config.pi_path).await;
    let mut cmd = match pi.launcher {
        Some(crate::pi_locate::Launcher::Node { node, script }) => {
            let mut c = tokio::process::Command::new(node);
            c.arg(script);
            c
        }
        Some(crate::pi_locate::Launcher::Binary { path }) => tokio::process::Command::new(path),
        None => return Err(pix_error("piNotFound", "未找到 pi，无法执行翻译")),
    };
    cmd.args([
        "--print", "--mode", "json", "--no-session", "--no-tools", "--no-extensions",
        "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "--provider", model.provider.trim(),
        "--model", model.model_id.trim(),
        "--append-system-prompt", "",
        "--system-prompt",
        "You are a translator. Translate the user's input into the requested language. Preserve markdown formatting, code blocks, and inline code exactly. Output only the translation, no explanations.",
    ])
    .args(crate::builtin_extensions::provider_extension_args(
        &model.provider,
    ))
    .current_dir(crate::trust::agent_dir())
    .stdin(std::process::Stdio::piped())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null())
    .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let output = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().ok_or("Missing stdin")?;
        let prompt = format!("Translate the following into {target_lang}:\n\n{content}");
        { use tokio::io::AsyncWriteExt; stdin.write_all(prompt.as_bytes()).await }.map_err(|e| e.to_string())?;
        drop(stdin);
        let mut stdout = child.stdout.take().ok_or("Missing stdout")?;
        let mut buf = Vec::new();
        tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut buf).await.map_err(|e| e.to_string())?;
        child.wait().await.map_err(|e| e.to_string())?;
        Ok::<_, String>(buf)
    })
    .await
    .map_err(|_| pix_error("translationTimeout", "翻译超时（2 分钟）"))??;

    // Extract text from the last assistant message_end event (same as title generation).
    let mut translated = String::new();
    for line in output.split(|b| *b == b'\n') {
        let Ok(event) = serde_json::from_slice::<Value>(line) else { continue };
        if event["type"] != "message_end" || event["message"]["role"] != "assistant" { continue; }
        if matches!(event["message"]["stopReason"].as_str(), Some("error" | "aborted")) {
            return Err(pix_error("translationFailed", "翻译模型返回错误"));
        }
        if let Some(blocks) = event["message"]["content"].as_array() {
            let text = blocks.iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("");
            if !text.trim().is_empty() {
                translated = text;
            }
        }
    }
    if translated.trim().is_empty() {
        return Err(pix_error("translationEmpty", "翻译结果为空"));
    }
    Ok(translated)
}
