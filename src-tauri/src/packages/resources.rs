//! Resource management: enable / disable individual resources per package,
//! mirroring `pi config` (writes +/- patterns into the package's settings entry).

use crate::{
    errors::{pix_error, pix_error_detail},
    trust,
};
use serde::Serialize;
use serde_json::Value;

use super::glob::{glob_match, resource_enabled, strip_pattern_marker};
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

/// Settings file for one scope. Project-scope paths come from the frontend and
/// would allow reading or writing `<any dir>/.pi/settings.json` unchecked, so
/// the project root is canonicalized first (defusing `..` traversal) and must
/// pass Pi's project trust check before it is used.
fn settings_path_for(scope: &str, project: Option<&str>) -> Result<std::path::PathBuf, String> {
    if scope == "project" {
        if let Some(p) = project.map(str::trim).filter(|s| !s.is_empty()) {
            let root = dunce::canonicalize(p).map_err(|e| {
                pix_error_detail("projectDirMissing", format!("项目目录不存在: {p} ({e})"), e)
            })?;
            ensure_project_trusted(&root.to_string_lossy())?;
            return Ok(root.join(".pi").join("settings.json"));
        }
    }
    Ok(trust::agent_dir().join("settings.json"))
}

/// Project settings are only touched for projects Pi already trusts, with the
/// same preflight as the scheduler: undecided projects must decide first and
/// untrusted projects are rejected. `trust::status` is async while these
/// commands are synchronous, so it runs on a throwaway single-thread runtime.
fn ensure_project_trusted(project: &str) -> Result<(), String> {
    let status = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| e.to_string())?
        .block_on(trust::status(project))?;
    if status["needsDecision"] == true {
        return Err(pix_error("trustDecisionRequired", "项目信任需要先做出决定"));
    }
    if status["decision"] != true {
        return Err(pix_error(
            "projectUntrusted",
            "项目未被信任，无法访问项目设置",
        ));
    }
    Ok(())
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

/// Read and parse the scope's settings.json (shared by the commands that take
/// a caller-supplied `source`).
fn read_settings_doc(scope: &str, project: Option<&str>) -> Result<Value, String> {
    let settings_file = settings_path_for(scope, project)?;
    let raw = std::fs::read_to_string(&settings_file)
        .map_err(|e| pix_error_detail("settingsReadFailed", format!("读取设置失败: {e}"), e))?;
    serde_json::from_str(&raw)
        .map_err(|e| pix_error_detail("settingsParseFailed", format!("解析设置失败: {e}"), e))
}

/// Reject sources that are not registered in the scope's settings file.
/// [`package_root_dir`] adopts local paths verbatim (including absolute ones,
/// so locally developed packages keep working); without this check a
/// caller-supplied path like `/etc` would become the root itself and turn the
/// containment guards in `package_read_file` into no-ops (arbitrary file
/// read). `package_resources` has always required registration; the file
/// listing/reading commands must apply the same rule.
fn ensure_registered_package(
    source: &str,
    scope: &str,
    project: Option<&str>,
) -> Result<(), String> {
    let doc = read_settings_doc(scope, project)?;
    ensure_source_registered(source, &doc)
}

fn ensure_source_registered(source: &str, doc: &Value) -> Result<(), String> {
    find_package_entry(doc, source)
        .map(|_| ())
        .ok_or_else(|| pix_error("pluginNotInSettings", "设置中未找到该插件"))
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

/// Max recursion depth for package walks; guards against pathological nests.
const MAX_WALK_DEPTH: usize = 16;

pub(crate) fn walk_files(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<String>) {
    use crate::fs_walk::{fs_walk, WalkControl, WalkOptions};
    let _ = fs_walk(
        dir,
        WalkOptions {
            follow_links: true,
            ignore_read_errors: true,
            ignore_root_errors: true,
            max_depth: Some(MAX_WALK_DEPTH),
            ..WalkOptions::default()
        },
        |entry| {
            if entry.is_dir {
                return Ok(
                    if IGNORED_DIRS.contains(&entry.name.as_str()) || entry.name.starts_with('.') {
                        WalkControl::Skip
                    } else {
                        WalkControl::Continue
                    },
                );
            }
            if !entry.name.starts_with('.') {
                if let Ok(rel) = entry.path.strip_prefix(root) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
            Ok(WalkControl::Continue)
        },
    );
}

/// Read the `pi` manifest entry of a package's package.json, when present.
fn read_pi_manifest(root: &std::path::Path) -> Option<Value> {
    std::fs::read_to_string(root.join("package.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .and_then(|pkg| pkg.get("pi").cloned())
}

/// Collect resource paths (relative, posix) for one type, honouring the
/// package.json `pi` manifest when present, else conventional directories.
/// Walks the package root; prefer [`collect_resources_from`] when the same
/// package's files are needed for several resource types.
fn collect_resources(root: &std::path::Path, resource_type: &str) -> Vec<String> {
    let manifest = read_pi_manifest(root);
    let mut files = Vec::new();
    walk_files(root, root, &mut files);
    collect_resources_from(root, resource_type, manifest.as_ref(), &files)
}

/// [`collect_resources`] over a pre-walked file list and pre-read manifest, so
/// enumerating all resource types of one package walks its root only once.
fn collect_resources_from(
    root: &std::path::Path,
    resource_type: &str,
    manifest_entry: Option<&Value>,
    files: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    match manifest_entry.and_then(|pi| pi.get(resource_type)) {
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
                // Exact directory-segment match: `skills-extra/x` must not be
                // swept in by a bare `skills` prefix.
                let prefix = format!("{resource_type}/");
                out.extend(
                    files
                        .iter()
                        .filter(|f| f.as_str() == resource_type || f.starts_with(&prefix))
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
pub async fn package_resources(
    source: String,
    scope: String,
    project: Option<String>,
) -> Result<Vec<PackageResource>, String> {
    tokio::task::spawn_blocking(move || package_resources_blocking(source, scope, project))
        .await
        .map_err(|e| format!("package operation failed: {e}"))?
}

fn package_resources_blocking(
    source: String,
    scope: String,
    project: Option<String>,
) -> Result<Vec<PackageResource>, String> {
    let doc = read_settings_doc(&scope, project.as_deref())?;
    let idx = find_package_entry(&doc, &source)
        .ok_or_else(|| pix_error("pluginNotInSettings", "设置中未找到该插件"))?;
    let entry = &doc["packages"][idx];

    let root = package_root_dir(&source, &scope, project.as_deref()).ok_or_else(|| {
        pix_error(
            "pluginInstallDirNotFound",
            "未找到插件安装目录（尚未安装或来源不支持）",
        )
    })?;

    // Walk the package root once and reuse the file list for every resource
    // type; the command runs this work on the blocking pool.
    let manifest = read_pi_manifest(&root);
    let mut files = Vec::new();
    walk_files(&root, &root, &mut files);

    let mut out = Vec::new();
    for rt in RESOURCE_TYPES {
        let patterns = filter_patterns(entry, rt);
        let enabled_fn = |rel: &str| resource_enabled(rel, patterns.as_deref());
        for rel in collect_resources_from(&root, rt, manifest.as_ref(), &files) {
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
pub async fn package_set_resource(
    source: String,
    scope: String,
    project: Option<String>,
    resource_type: String,
    path: String,
    enabled: bool,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        package_set_resource_blocking(source, scope, project, resource_type, path, enabled)
    })
    .await
    .map_err(|e| format!("package operation failed: {e}"))?
}

fn package_set_resource_blocking(
    source: String,
    scope: String,
    project: Option<String>,
    resource_type: String,
    path: String,
    enabled: bool,
) -> Result<(), String> {
    // Concurrent async commands must not lose each other's read-modify-write updates.
    static RESOURCE_SETTINGS_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = RESOURCE_SETTINGS_LOCK.lock().map_err(|e| e.to_string())?;
    if !RESOURCE_TYPES.contains(&resource_type.as_str()) {
        return Err(pix_error_detail(
            "unknownResourceType",
            format!("未知资源类型: {resource_type}"),
            resource_type,
        ));
    }
    let settings_file = settings_path_for(&scope, project.as_deref())?;
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

    // 原子写：先写临时文件再 rename 覆盖，避免写盘中途崩溃留下截断的
    // settings.json（会丢失用户全部 packages/扩展配置）。
    let body = serde_json::to_string_pretty(&doc).map_err(|e| {
        pix_error_detail("settingsSerializeFailed", format!("序列化设置失败: {e}"), e)
    })?;
    crate::atomic_write::write(&settings_file, body.as_bytes())
        .map_err(|e| pix_error_detail("settingsWriteFailed", format!("写入设置失败: {e}"), e))
}

/// List every file inside an installed package root (relative, posix paths),
/// mirroring the walk used for resource discovery (ignores node_modules,
/// .git, .pi, dist and dotfiles).
#[tauri::command]
pub async fn package_list_files(
    source: String,
    scope: String,
    project: Option<String>,
) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || package_list_files_blocking(source, scope, project))
        .await
        .map_err(|e| format!("package operation failed: {e}"))?
}

fn package_list_files_blocking(
    source: String,
    scope: String,
    project: Option<String>,
) -> Result<Vec<String>, String> {
    ensure_registered_package(&source, &scope, project.as_deref())?;
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

const PACKAGE_ROOT_GUARD: crate::preview_guard::RootGuardSpec =
    crate::preview_guard::RootGuardSpec {
        read_failed_label: "读取资源文件失败",
        root_resolve_label: "解析插件目录失败",
        root_resolve_code: "pluginInstallDirNotFound",
        outside_message: "资源路径越界",
    };

/// Read one file inside an installed package for preview. `path` is relative
/// to the package root with forward slashes. Text files are capped at 512 KB
/// on a UTF-8 boundary; binary content is rejected with `resourceBinary`.
#[tauri::command]
pub async fn package_read_file(
    source: String,
    scope: String,
    path: String,
    project: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || package_read_file_blocking(source, scope, path, project))
        .await
        .map_err(|e| format!("package operation failed: {e}"))?
}

fn package_read_file_blocking(
    source: String,
    scope: String,
    path: String,
    project: Option<String>,
) -> Result<String, String> {
    // Reject path traversal: the relative path must stay inside the package root.
    crate::preview_guard::reject_unsafe_rel_path(&path, "无效的资源路径")?;
    // The root itself must belong to a registered package; package_root_dir
    // would otherwise adopt any caller-supplied absolute directory.
    ensure_registered_package(&source, &scope, project.as_deref())?;
    let root = package_root_dir(&source, &scope, project.as_deref()).ok_or_else(|| {
        pix_error(
            "pluginInstallDirNotFound",
            "未找到插件安装目录（尚未安装或来源不支持）",
        )
    })?;
    let canonical = crate::preview_guard::resolve_within_root(&root, &path, &PACKAGE_ROOT_GUARD)?;
    let bytes = crate::preview_guard::read_preview_bytes(&canonical, root.join(&path).display())?;
    crate::preview_guard::decode_preview_text(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(flavor = "current_thread")]
    async fn async_resource_commands_preserve_validation_errors() {
        let source = "missing".to_string();
        let scope = "global".to_string();
        let path = "../outside".to_string();
        let expected = package_read_file_blocking(source.clone(), scope.clone(), path.clone(), None);
        assert_eq!(package_read_file(source, scope, path, None).await, expected);

        let expected = package_set_resource_blocking(
            "missing".into(), "global".into(), None, "invalid".into(), "x".into(), true,
        );
        assert_eq!(package_set_resource(
            "missing".into(), "global".into(), None, "invalid".into(), "x".into(), true,
        ).await, expected);
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
    fn package_resources_enumerate_all_types_from_one_walk() {
        // All four resource types enumerate their conventional directories
        // from a single walk; `skills-extra` must not be swept into `skills`.
        let root =
            std::env::temp_dir().join(format!("pix-package-resources-{}", uuid::Uuid::new_v4()));
        let write = |rel: &str, body: &str| {
            let path = root.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, body).unwrap();
        };
        write("extensions/a.ts", "export {}");
        write("extensions/nested/b.ts", "export {}");
        write(
            "skills/demo/SKILL.md",
            "---\nname: demo\ndescription: Demo\n---\n",
        );
        write("prompts/plan.md", "---\ndescription: Plan\n---\n");
        write("themes/dark.json", "{}");
        write(
            "skills-extra/x.md",
            "---\nname: extra\ndescription: Extra skill\n---\n",
        );

        let enumerate = |root: &std::path::Path| {
            let manifest = read_pi_manifest(root);
            let mut files = Vec::new();
            walk_files(root, root, &mut files);
            RESOURCE_TYPES
                .iter()
                .map(|rt| {
                    (
                        rt.to_string(),
                        collect_resources_from(root, rt, manifest.as_ref(), &files),
                    )
                })
                .collect::<Vec<_>>()
        };

        let resources = enumerate(&root);
        let by_type = |name: &str| {
            resources
                .iter()
                .find(|(rt, _)| rt == name)
                .map(|(_, rel)| rel.clone())
                .unwrap()
        };
        assert_eq!(
            by_type("extensions"),
            vec!["extensions/a.ts", "extensions/nested/b.ts"]
        );
        assert_eq!(by_type("skills"), vec!["skills/demo"]);
        assert_eq!(by_type("prompts"), vec!["prompts/plan.md"]);
        assert_eq!(by_type("themes"), vec!["themes/dark.json"]);

        // Manifest globs keep working over the shared file list.
        std::fs::write(
            root.join("package.json"),
            r#"{"pi":{"extensions":["extensions/*.ts"]}}"#,
        )
        .unwrap();
        assert_eq!(enumerate(&root)[0].1, vec!["extensions/a.ts"]);

        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn npm_name_strips_version() {
        let dir = package_root_dir("npm:@scope/pkg@1.2.3", "__none__", None);
        assert!(dir.is_none()); // not installed, but must not panic
    }

    #[test]
    fn unregistered_sources_are_rejected() {
        let doc: Value = serde_json::from_str(
            r#"{"packages":["npm:demo",{"source":"git:example.com/repo"},"../escape"]}"#,
        )
        .unwrap();
        assert!(ensure_source_registered("npm:demo", &doc).is_ok());
        assert!(ensure_source_registered("git:example.com/repo", &doc).is_ok());
        // A relative path only works as the exact registered entry string.
        assert!(ensure_source_registered("../escape", &doc).is_ok());
        // Absolute paths and traversal are unusable unless an identical
        // package entry was actually installed — this is what keeps
        // package_root_dir's verbatim local-path branch from becoming an
        // arbitrary-file-read root.
        assert_eq!(
            ensure_source_registered("/etc", &doc).unwrap_err(),
            pix_error("pluginNotInSettings", "设置中未找到该插件")
        );
        assert!(ensure_source_registered("../../etc/passwd", &doc).is_err());
        assert!(ensure_source_registered("C:\\Windows", &doc).is_err());
        // Missing or malformed packages arrays reject everything.
        let empty: Value = serde_json::from_str("{}").unwrap();
        assert!(ensure_source_registered("npm:demo", &empty).is_err());
    }

    #[test]
    fn package_root_dir_adopts_registered_local_paths_verbatim() {
        // Documents the local-path branch: locally developed packages may be
        // absolute directories (root adopted as-is), so containment relies on
        // the registration check, not on root resolution.
        let tmp = std::env::temp_dir().join(format!("pix-pkg-root-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(tmp.join("mypkg")).unwrap();
        let source = tmp.join("mypkg").to_string_lossy().to_string();
        assert_eq!(
            package_root_dir(&source, "global", None),
            Some(tmp.join("mypkg"))
        );
        assert_eq!(
            package_root_dir("/definitely/not/a/pkg-dir", "global", None),
            None
        );
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[test]
    fn settings_path_falls_back_to_global_and_rejects_missing_projects() {
        let global = trust::agent_dir().join("settings.json");
        // Global scope ignores the project entirely.
        assert_eq!(settings_path_for("global", None).unwrap(), global);
        assert_eq!(
            settings_path_for("global", Some("C:\\anything")).unwrap(),
            global
        );
        // Project scope without a usable project falls back to global settings.
        assert_eq!(settings_path_for("project", None).unwrap(), global);
        assert_eq!(settings_path_for("project", Some("   ")).unwrap(), global);
        // A nonexistent project directory is rejected before any trust lookup.
        let missing = std::env::temp_dir().join(format!("pix-missing-{}", uuid::Uuid::new_v4()));
        assert!(settings_path_for("project", Some(missing.to_str().unwrap())).is_err());
        // `..` cannot smuggle a path out of a nonexistent base either.
        let escape = missing
            .join("..")
            .join(format!("pix-missing-{}", uuid::Uuid::new_v4()));
        assert!(settings_path_for("project", Some(escape.to_str().unwrap())).is_err());
    }

    /// Create a directory symlink; returns false when the platform or
    /// privileges do not allow it (tests skip instead of failing).
    fn create_dir_symlink(target: &std::path::Path, link: &std::path::Path) -> bool {
        #[cfg(windows)]
        {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        }
        #[cfg(not(windows))]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }

    #[test]
    fn walk_files_survives_symlink_cycles() {
        let root = std::env::temp_dir().join(format!("pix-walk-cycle-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), "x").unwrap();
        if !create_dir_symlink(&root, &root.join("loop")) {
            std::fs::remove_dir_all(&root).unwrap();
            return; // symlink/junction creation unavailable; nothing to test
        }
        let mut files = Vec::new();
        walk_files(&root, &root, &mut files);
        assert_eq!(files, vec!["a.txt"]);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
