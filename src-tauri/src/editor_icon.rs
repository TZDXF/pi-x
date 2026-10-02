//! IDE 真实图标提取(参考 RepoMeow):Windows 解析 exe 内嵌图标资源(pelite 重组 ICO + ico 解码),
//! macOS 解析 .app 包的 .icns(plist 读 CFBundleIconFile + icns 解码),统一缩放成 64px PNG
//! 缓存到 ~/.pix/icons/<id>.png,以 data URL 返回前端(桌面与远程 HTTP 模式通用,无需 asset 协议)。
//! 任何一步失败都返回 None,前端静默回退为纯文本展示。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};

use crate::editor;

/// 输出 PNG 边长;源图标更小时不放大,保持原尺寸
const ICON_SIZE: u32 = 64;
/// 图标缓存(目标路径 + mtime)文件,与 PNG 同目录
const CACHE_FILE: &str = "cache.json";

/// 图标缓存条目:图标源文件(Windows exe / macOS icns)与其 mtime,任一变化即重新提取
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct IconCacheEntry {
    target: String,
    mtime: u64,
}

type IconCache = HashMap<String, IconCacheEntry>;

fn icons_dir() -> PathBuf {
    crate::data_dir::root().join("icons")
}

fn file_mtime(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs())
}

/// 缓存命中条件:目标路径与 mtime 均未变,且 PNG 文件还在
fn cache_hit(entry: Option<&IconCacheEntry>, target: &str, mtime: u64, png_exists: bool) -> bool {
    png_exists && entry.is_some_and(|e| e.target == target && e.mtime == mtime)
}

/// 取全部 IDE 的真实图标:id → data:image/png;base64 URL(提取失败为 null)。
/// "system" 对应系统默认应用(Windows 资源管理器 / macOS Finder)图标。
#[tauri::command]
pub async fn editor_icons() -> Result<HashMap<String, Option<String>>, String> {
    // 图标提取(PE/icns 解析 + PNG 缩放编码写盘)是重 IO,放阻塞线程执行
    tokio::task::spawn_blocking(extract_all)
        .await
        .map_err(|e| e.to_string())?
}

fn extract_all() -> Result<HashMap<String, Option<String>>, String> {
    let dir = icons_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let cache_path = dir.join(CACHE_FILE);
    let mut cache: IconCache = std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|json| serde_json::from_str(&json).ok())
        .unwrap_or_default();
    let mut dirty = false;
    let mut result = HashMap::new();
    let mut ids: Vec<&str> = editor::EDITORS.iter().map(|(id, _, _)| *id).collect();
    ids.push("system");
    for id in ids {
        let path = icon_for(id, &dir, &mut cache, &mut dirty);
        // 读 PNG 转 data URL;读取失败按无图标处理
        let url = path.and_then(|p| {
            std::fs::read(p)
                .ok()
                .map(|bytes| format!("data:image/png;base64,{}", BASE64.encode(bytes)))
        });
        result.insert(id.to_string(), url);
    }
    if dirty {
        if let Ok(json) = serde_json::to_string(&cache) {
            let _ = std::fs::write(&cache_path, json);
        }
    }
    Ok(result)
}

/// 单个 id 的完整流程:解析图标源 → 命中缓存直接用,否则提取并写 PNG
fn icon_for(id: &str, dir: &Path, cache: &mut IconCache, dirty: &mut bool) -> Option<PathBuf> {
    let png = dir.join(format!("{id}.png"));
    for target in resolve_icon_candidates(id) {
        let target_str = target.to_string_lossy().into_owned();
        let Some(mtime) = file_mtime(&target) else {
            continue;
        };
        if cache_hit(cache.get(id), &target_str, mtime, png.exists()) {
            return Some(png);
        }
        if let Some((w, h, rgba)) = extract_rgba(&target) {
            write_png(&png, w, h, &rgba).ok()?;
            cache.insert(
                id.to_string(),
                IconCacheEntry {
                    target: target_str,
                    mtime,
                },
            );
            *dirty = true;
            return Some(png);
        }
        // 该候选提取失败,继续下一个候选
    }
    None
}

// ---------------------------------------------------------------------------
// 图标源解析(平台相关)
// ---------------------------------------------------------------------------

#[cfg(windows)]
fn system_root() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
}

/// Windows:editor_binary 已在 PATH 与常见安装目录里定位真实 exe,直接作为图标源
#[cfg(windows)]
fn resolve_icon_candidates(id: &str) -> Vec<PathBuf> {
    if id == "system" {
        return vec![system_root().join("explorer.exe")];
    }
    editor::editor_binary(id).into_iter().collect()
}

/// macOS:CLI 通常是 *.app/Contents/... 下的符号链接,顺链接反推 bundle;
/// 兜底按 App 名前缀扫标准应用目录(兼容 Toolbox 命名,如 "IntelliJ IDEA Ultimate.app")
#[cfg(target_os = "macos")]
fn resolve_icon_candidates(id: &str) -> Vec<PathBuf> {
    if id == "system" {
        return icns_in_bundle(Path::new("/System/Library/CoreServices/Finder.app"))
            .into_iter()
            .collect();
    }
    let mut candidates = Vec::new();
    if let Some(cli) = editor::editor_binary(id) {
        if let Ok(resolved) = std::fs::canonicalize(&cli) {
            if let Some(bundle) = bundle_root_from_path(&resolved) {
                candidates.extend(icns_in_bundle(&bundle));
            }
        }
    }
    if candidates.is_empty() {
        if let Some(prefix) = mac_app_prefix(id) {
            let mut dirs = vec![PathBuf::from("/Applications")];
            if let Some(home) = std::env::var_os("HOME") {
                dirs.push(PathBuf::from(home).join("Applications"));
            }
            for dir in dirs {
                if let Some(bundle) = find_app_by_prefix(&dir, prefix) {
                    candidates.extend(icns_in_bundle(&bundle));
                    break;
                }
            }
        }
    }
    candidates
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn resolve_icon_candidates(_id: &str) -> Vec<PathBuf> {
    Vec::new()
}

/// 从 app 内部路径截取 .app bundle 根:CLI 通常在 *.app/Contents/... 下
#[cfg(any(target_os = "macos", test))]
fn bundle_root_from_path(path: &Path) -> Option<PathBuf> {
    let mut root = PathBuf::new();
    for comp in path.components() {
        root.push(comp.as_os_str());
        if comp
            .as_os_str()
            .to_string_lossy()
            .to_ascii_lowercase()
            .ends_with(".app")
        {
            return Some(root);
        }
    }
    None
}

/// macOS 各编辑器 .app 名前缀(用于 /Applications 兜底扫描)
#[cfg(target_os = "macos")]
fn mac_app_prefix(id: &str) -> Option<&'static str> {
    Some(match id {
        "vscode" => "Visual Studio Code",
        "cursor" => "Cursor",
        "windsurf" => "Windsurf",
        "trae" => "Trae",
        "vscodium" => "VSCodium",
        "zed" => "Zed",
        "sublime" => "Sublime Text",
        "idea" => "IntelliJ IDEA",
        "webstorm" => "WebStorm",
        "goland" => "GoLand",
        "pycharm" => "PyCharm",
        "clion" => "CLion",
        "rustrover" => "RustRover",
        _ => return None,
    })
}

/// 按前缀找 App(取名字最短者,避免 "IntelliJ IDEA Ultimate.app" 之前匹配到旧版副目录)
#[cfg(target_os = "macos")]
fn find_app_by_prefix(dir: &Path, prefix: &str) -> Option<PathBuf> {
    let mut matches: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .map(|n| {
                    let n = n.to_string_lossy().to_ascii_lowercase();
                    n.starts_with(&prefix.to_ascii_lowercase()) && n.ends_with(".app")
                })
                .unwrap_or(false)
                && p.is_dir()
        })
        .collect();
    matches.sort_by_key(|p| p.as_os_str().len());
    matches.into_iter().next()
}

/// macOS:读 bundle 的 Info.plist 取 CFBundleIconFile,定位 Contents/Resources 下的 .icns
#[cfg(target_os = "macos")]
fn icns_in_bundle(bundle: &Path) -> Option<PathBuf> {
    let bytes = std::fs::read(bundle.join("Contents").join("Info.plist")).ok()?;
    let icon = icon_file_from_info_plist(&bytes)?;
    let path = bundle.join("Contents").join("Resources").join(icon);
    path.is_file().then_some(path)
}

/// 从 Info.plist 内容解析 CFBundleIconFile;值不带 .icns 后缀时补上
#[cfg(any(target_os = "macos", test))]
fn icon_file_from_info_plist(bytes: &[u8]) -> Option<String> {
    let value = plist::Value::from_reader(std::io::Cursor::new(bytes)).ok()?;
    let name = value
        .as_dictionary()?
        .get("CFBundleIconFile")?
        .as_string()?
        .trim();
    if name.is_empty() {
        return None;
    }
    Some(if name.to_ascii_lowercase().ends_with(".icns") {
        name.to_string()
    } else {
        format!("{name}.icns")
    })
}

// ---------------------------------------------------------------------------
// 图标解码(按文件扩展名分发,纯解析逻辑与平台无关,便于跨平台单测)
// ---------------------------------------------------------------------------

/// 供 toast AUMID 注册使用(Windows 不会从 exe 内嵌资源读取图标):提取 exe 主图标写成 PNG
pub(crate) fn export_icon_png(exe: &Path, dest: &Path) -> Option<()> {
    let (w, h, rgba) = extract_from_pe(exe)?;
    write_png(dest, w, h, &rgba).ok()
}

/// 提取图标源为 RGBA 像素(w, h, rgba)
fn extract_rgba(source: &Path) -> Option<(u32, u32, Vec<u8>)> {
    if source
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("icns"))
    {
        extract_from_icns(source)
    } else {
        extract_from_pe(source)
    }
}

/// exe 内嵌图标:pelite 读第一个 GROUP_ICON(即资源管理器展示的主图标)。
/// 不用 pelite 的整组 ICO 重组:部分 exe(如 Trae)GRPICONDIRENTRY 的 dwBytesInRes
/// 与真实数据大小不符,重组后偏移错位导致大图解码失败——改为按尺寸降序逐条取
/// 真实资源数据(nId → DataEntry)自拼单条 ICO,解码成功即返回。
fn extract_from_pe(exe: &Path) -> Option<(u32, u32, Vec<u8>)> {
    use pelite::resources::group::image::GRPICONDIRENTRY;

    /// 组图标条目的像素数(宽/高字节为 0 表示 256)
    fn entry_pixels(e: &GRPICONDIRENTRY) -> u32 {
        let w = if e.bWidth == 0 {
            256
        } else {
            u32::from(e.bWidth)
        };
        let h = if e.bHeight == 0 {
            256
        } else {
            u32::from(e.bHeight)
        };
        w * h
    }

    /// 单条 ICO:6 字节 ICONDIR + 16 字节 ICONDIRENTRY + 图像数据;
    /// dwBytesInRes 用真实数据长度,规避组条目里的错误值
    fn build_single_icon_ico(e: &GRPICONDIRENTRY, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(22 + data.len());
        out.extend_from_slice(&[0, 0, 1, 0, 1, 0]); // reserved, type=icon, count=1
        out.extend_from_slice(&[e.bWidth, e.bHeight, e.bColorCount, 0]);
        out.extend_from_slice(&e.wPlanes.to_le_bytes());
        out.extend_from_slice(&e.wBitCount.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&22u32.to_le_bytes());
        out.extend_from_slice(data);
        out
    }

    let bytes = std::fs::read(exe).ok()?;
    let pe = pelite::PeFile::from_bytes(&bytes).ok()?;
    let resources = pe.resources().ok()?;
    let (_, group) = resources.icons().find_map(|r| r.ok())?;
    let mut entries = group.entries().to_vec();
    entries.sort_by_key(|e| std::cmp::Reverse(entry_pixels(e)));
    for entry in &entries {
        let Ok(data) = group.image(entry.nId) else {
            continue;
        };
        let ico_bytes = build_single_icon_ico(entry, data);
        let Ok(dir) = ico::IconDir::read(std::io::Cursor::new(ico_bytes)) else {
            continue;
        };
        let Some(first) = dir.entries().first() else {
            continue;
        };
        if let Ok(img) = first.decode() {
            return Some((img.width(), img.height(), img.rgba_data().to_vec()));
        }
    }
    None
}

/// .icns 图标:解码全部可用元素,取最大尺寸,统一转 RGBA
fn extract_from_icns(path: &Path) -> Option<(u32, u32, Vec<u8>)> {
    let bytes = std::fs::read(path).ok()?;
    let family = icns::IconFamily::read(std::io::Cursor::new(bytes)).ok()?;
    let mut best: Option<icns::Image> = None;
    for ty in family.available_icons() {
        if let Ok(img) = family.get_icon_with_type(ty) {
            let better = match &best {
                None => true,
                Some(b) => img.width() * img.height() > b.width() * b.height(),
            };
            if better {
                best = Some(img);
            }
        }
    }
    let img = best?.convert_to(icns::PixelFormat::RGBA);
    Some((img.width(), img.height(), img.data().to_vec()))
}

/// RGBA → PNG 文件:超过 ICON_SIZE 时等比缩小(Lanczos3),更小保持原尺寸
fn write_png(path: &Path, w: u32, h: u32, rgba: &[u8]) -> std::io::Result<()> {
    let img = image::RgbaImage::from_raw(w, h, rgba.to_vec())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "bad rgba"))?;
    let img = image::DynamicImage::ImageRgba8(img);
    let img = if w.max(h) > ICON_SIZE {
        img.resize(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };
    img.save_with_format(path, image::ImageFormat::Png)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_hit_rules() {
        let entry = IconCacheEntry {
            target: r"C:\a\code.exe".into(),
            mtime: 10,
        };
        // 目标与 mtime 一致且 PNG 在 → 命中
        assert!(cache_hit(Some(&entry), r"C:\a\code.exe", 10, true));
        // mtime 变化(编辑器升级)→ 重新提取
        assert!(!cache_hit(Some(&entry), r"C:\a\code.exe", 11, true));
        // 目标路径变化 → 重新提取
        assert!(!cache_hit(Some(&entry), r"C:\b\code.exe", 10, true));
        // PNG 被删 → 重新提取
        assert!(!cache_hit(Some(&entry), r"C:\a\code.exe", 10, false));
        assert!(!cache_hit(None, r"C:\a\code.exe", 10, true));
    }

    #[test]
    fn bundle_root_from_app_inner_path() {
        let p = Path::new("/Applications/Visual Studio Code.app/Contents/Resources/bin/code");
        assert_eq!(
            bundle_root_from_path(p),
            Some(PathBuf::from("/Applications/Visual Studio Code.app"))
        );
        // 深层 Toolbox 路径
        let p = Path::new("/Users/me/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea");
        assert_eq!(
            bundle_root_from_path(p),
            Some(PathBuf::from(
                "/Users/me/Applications/IntelliJ IDEA Ultimate.app"
            ))
        );
        // 不在 .app 内
        assert_eq!(
            bundle_root_from_path(Path::new("/usr/local/bin/code")),
            None
        );
    }

    #[test]
    fn info_plist_icon_file() {
        let xml = br#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIconFile</key><string>Code</string>
</dict></plist>"#;
        assert_eq!(
            icon_file_from_info_plist(xml),
            Some("Code.icns".to_string())
        );
        // 已带后缀
        let xml2 = br#"<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIconFile</key><string>AppIcon.icns</string>
</dict></plist>"#;
        assert_eq!(
            icon_file_from_info_plist(xml2),
            Some("AppIcon.icns".to_string())
        );
        // 缺 key / 空值
        let xml3 = br#"<?xml version="1.0"?><plist version="1.0"><dict></dict></plist>"#;
        assert_eq!(icon_file_from_info_plist(xml3), None);
    }

    /// 手动验证(仅 Windows,需本机装有 VS Code):cargo test ... icon_end_to_end -- --ignored
    /// 走完整链路(定位 exe → 提取 → 缩放写盘)并打印缓存路径与 data URL 长度
    #[cfg(windows)]
    #[test]
    #[ignore]
    fn icon_end_to_end_vscode_and_system() {
        for id in ["vscode", "system"] {
            let dir = std::env::temp_dir().join(format!("pix-icon-e2e-{}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let mut cache = IconCache::new();
            let mut dirty = false;
            let png = icon_for(id, &dir, &mut cache, &mut dirty)
                .unwrap_or_else(|| panic!("{id} 应能提取图标"));
            let bytes = std::fs::read(&png).unwrap();
            assert!(bytes.len() > 100, "{id} PNG 内容异常");
            eprintln!("{id}: {} ({} bytes)", png.display(), bytes.len());
            if std::env::var_os("PIX_KEEP_ICONS").is_none() {
                std::fs::remove_dir_all(&dir).ok();
            }
        }
    }

    /// 端到端(仅 Windows):从系统 exe 提取真实图标,验证像素尺寸与 RGBA 长度
    #[cfg(windows)]
    #[test]
    fn extract_icon_from_system_exe() {
        let exe = system_root().join("System32").join("cmd.exe");
        if !exe.is_file() {
            return;
        }
        let (w, h, rgba) = extract_rgba(&exe).expect("cmd.exe 应能提取图标");
        assert!(w > 0 && h > 0);
        assert_eq!(rgba.len() as u64, u64::from(w) * u64::from(h) * 4);
    }

    /// 端到端(仅 Windows):缩小写 PNG
    #[cfg(windows)]
    #[test]
    fn write_png_downscales() {
        let (w, h, rgba) = (128, 128, vec![255u8; 128 * 128 * 4]);
        let dir = std::env::temp_dir().join(format!("pix-icon-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("t.png");
        write_png(&png, w, h, &rgba).unwrap();
        let decoded = image::open(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (ICON_SIZE, ICON_SIZE));
        std::fs::remove_dir_all(&dir).ok();
    }
}
