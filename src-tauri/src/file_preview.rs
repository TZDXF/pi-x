//! In-app file preview for the project-files sidebar.
//!
//! One command covers every file kind: text is capped at 512 KB (cut on a
//! UTF-8 boundary), known image extensions that sniff as binary are returned
//! as base64 with a mime type, and any other binary content comes back with
//! `kind = "binary"` so the UI can explain instead of rendering mojibake.
//! Media payloads ride the regular JSON channel (no asset protocol), which
//! keeps remote-access browsers able to preview the same files.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use serde::Serialize;
use serde_json::json;
use std::io::Read;

/// 文本预览上限 512KB,超出按 UTF-8 边界截断(与 RepoMeow 的口径一致)。
pub const TEXT_PREVIEW_MAX_BYTES: usize = 512 * 1024;
/// 图片预览上限 8MB(原始字节,base64 编码前);超过直接报错而不是静默截断。
pub const IMAGE_PREVIEW_MAX_BYTES: u64 = 8 * 1024 * 1024;
/// 前 8KB 出现 NUL 字节即判二进制(git 风格嗅探)。
const BINARY_SNIFF_BYTES: usize = 8_000;

/// 嗅探为二进制后按这些扩展名走图片(base64)路径;svg 是文本,由前端渲染。
const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "jfif", "gif", "webp", "ico", "bmp", "avif"];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FilePreview {
    /// "text" | "image" | "binary"
    pub kind: String,
    /// 文本内容;image/binary 为 None
    pub text: Option<String>,
    /// 文本超过 512KB 被截断
    pub truncated: bool,
    /// 图片 mime(image 时必填)
    pub mime: Option<String>,
    /// 图片字节的 base64 编码(image 时必填)
    pub data: Option<String>,
}

/// Read a project file for preview. `path` is project-relative with forward
/// slashes (the format `list_project_directory` hands out).
pub async fn read_file_preview(project: String, path: String) -> Result<FilePreview, String> {
    tokio::task::spawn_blocking(move || read_preview(&project, &path))
        .await
        .map_err(|e| e.to_string())?
}

/// 取路径最后一段的扩展名,小写;点文件(.gitignore)与无扩展名返回空。
pub fn ext_of(path: &str) -> String {
    let name = path.rsplit(['/', '\\']).next().unwrap_or("");
    let dot = name.rfind('.');
    match dot {
        Some(index) if index > 0 => name[index + 1..].to_lowercase(),
        _ => String::new(),
    }
}

fn image_mime_of(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "ico" => "image/x-icon",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => return None,
    })
}

fn read_preview(project: &str, path: &str) -> Result<FilePreview, String> {
    let root = dunce::canonicalize(project)
        .map_err(|_| crate::errors::pix_error("projectDirMissing", "项目目录不存在"))?;
    if !root.is_dir() {
        return Err(crate::errors::pix_error("projectDirMissing", "项目目录不存在"));
    }
    // 与 list_project_directory 同一安全口径:拒绝绝对路径与 .. 逃逸,
    // canonicalize 后仍要求落在项目根内(防符号链接跳出)。
    let relative = std::path::Path::new(path);
    let valid = !relative.is_absolute()
        && relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)));
    let file = if valid {
        dunce::canonicalize(root.join(relative)).ok()
    } else {
        None
    };
    let Some(file) = file else {
        return Err(crate::errors::pix_error_detail(
            "previewPathInvalid",
            "无效的文件路径: {detail}",
            path,
        ));
    };
    if !file.starts_with(&root) || !file.is_file() {
        return Err(crate::errors::pix_error_detail(
            "previewPathInvalid",
            "无效的文件路径: {detail}",
            path,
        ));
    }
    // Check file size before reading to avoid loading oversized files into memory.
    let metadata = std::fs::metadata(&file).map_err(|e| {
        crate::errors::pix_error_detail("previewReadFailed", "读取文件失败: {detail}", e)
    })?;
    let file_size = metadata.len();
    let ext = ext_of(path);
    let is_image_ext = IMAGE_EXTS.contains(&ext.as_str());
    // Reject oversized images before reading.
    if is_image_ext && file_size > IMAGE_PREVIEW_MAX_BYTES {
        return Err(crate::errors::pix_error_with(
            "previewImageTooLarge",
            "图片过大，无法预览（上限 {limit} MB）",
            json!({ "limit": IMAGE_PREVIEW_MAX_BYTES / 1024 / 1024 }),
        ));
    }
    // Read the file: for text, stream with take() to avoid loading huge files;
    // for images, read the full content after size check.
    let mut file_handle = std::fs::File::open(&file).map_err(|e| {
        crate::errors::pix_error_detail("previewReadFailed", "读取文件失败: {detail}", e)
    })?;
    let mut bytes = Vec::with_capacity(file_size.min(TEXT_PREVIEW_MAX_BYTES as u64 + 1) as usize);
    if is_image_ext {
        file_handle.read_to_end(&mut bytes).map_err(|e| {
            crate::errors::pix_error_detail("previewReadFailed", "读取文件失败: {detail}", e)
        })?;
    } else {
        // Read at most TEXT_PREVIEW_MAX_BYTES + 1 bytes for text/binary sniffing.
        file_handle
            .take((TEXT_PREVIEW_MAX_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| {
                crate::errors::pix_error_detail("previewReadFailed", "读取文件失败: {detail}", e)
            })?;
    }
    let is_binary = bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0);
    if is_binary {
        if is_image_ext {
            return Ok(FilePreview {
                kind: "image".into(),
                text: None,
                truncated: false,
                mime: Some(image_mime_of(&ext).unwrap_or("application/octet-stream").into()),
                data: Some(BASE64.encode(&bytes)),
            });
        }
        return Ok(FilePreview {
            kind: "binary".into(),
            text: None,
            truncated: false,
            mime: None,
            data: None,
        });
    }
    let truncated = bytes.len() > TEXT_PREVIEW_MAX_BYTES;
    let mut end = bytes.len().min(TEXT_PREVIEW_MAX_BYTES);
    // 回退到 UTF-8 字符边界:跳过被截断的多字节序列的 continuation byte。
    while end > 0 && end < bytes.len() && (bytes[end] & 0xC0) == 0x80 {
        end -= 1;
    }
    Ok(FilePreview {
        kind: "text".into(),
        text: Some(String::from_utf8_lossy(&bytes[..end]).into_owned()),
        truncated,
        mime: None,
        data: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn preview(project: &std::path::Path, path: &str) -> Result<FilePreview, String> {
        read_preview(&project.to_string_lossy(), path)
    }

    #[test]
    fn ext_of_handles_separators_dotfiles_and_case() {
        assert_eq!(ext_of("src/lib/session.ts"), "ts");
        assert_eq!(ext_of("src\\lib\\Session.TS"), "ts");
        assert_eq!(ext_of(".gitignore"), "");
        assert_eq!(ext_of("README"), "");
        assert_eq!(ext_of("archive.tar.gz"), "gz");
        assert_eq!(ext_of(""), "");
    }

    #[test]
    fn text_files_round_trip_with_size_and_kind() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("main.rs"), "fn main() {}\n").unwrap();
        let out = preview(&root, "main.rs").unwrap();
        assert_eq!(out.kind, "text");
        assert_eq!(out.text.as_deref(), Some("fn main() {}\n"));
        assert!(!out.truncated);
        assert!(out.data.is_none() && out.mime.is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn binary_content_reports_binary_instead_of_mojibake() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("blob.dat"), [0x50, 0x00, 0x49]).unwrap();
        let out = preview(&root, "blob.dat").unwrap();
        assert_eq!(out.kind, "binary");
        assert!(out.text.is_none());
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn binary_images_come_back_base64_with_mime() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let bytes = [0x89u8, b'P', b'N', b'G', 0x00, 0xFF];
        std::fs::write(root.join("icon.png"), bytes).unwrap();
        let out = preview(&root, "icon.png").unwrap();
        assert_eq!(out.kind, "image");
        assert_eq!(out.mime.as_deref(), Some("image/png"));
        let decoded = BASE64.decode(out.data.unwrap()).unwrap();
        assert_eq!(decoded, bytes);
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn svg_is_text_even_though_it_is_an_image() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("icon.svg"), "<svg/>").unwrap();
        let out = preview(&root, "icon.svg").unwrap();
        assert_eq!(out.kind, "text");
        assert_eq!(out.text.as_deref(), Some("<svg/>"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn text_truncates_on_utf8_boundary_at_512kb() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        // 512KB - 2 个 'a' 后跟 3 字节的 '中',截断点落在多字节序列中间。
        let mut content = vec![b'a'; TEXT_PREVIEW_MAX_BYTES - 2];
        content.extend_from_slice("中".as_bytes());
        content.push(b'!');
        std::fs::write(root.join("big.txt"), &content).unwrap();
        let out = preview(&root, "big.txt").unwrap();
        assert!(out.truncated);
        let text = out.text.unwrap();
        assert_eq!(text.len(), TEXT_PREVIEW_MAX_BYTES - 2);
        assert!(!text.contains('\u{FFFD}'));
        assert!(!text.contains('中'));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn oversized_images_are_rejected_instead_of_truncated() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let bytes = vec![0u8; IMAGE_PREVIEW_MAX_BYTES as usize + 1];
        std::fs::write(root.join("huge.png"), bytes).unwrap();
        let err = preview(&root, "huge.png").unwrap_err();
        assert!(err.contains("previewImageTooLarge"), "{err}");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn paths_may_not_escape_the_project_root() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src").join("a.txt"), "ok").unwrap();
        let outside = std::env::temp_dir().join("pix-preview-outside.txt");
        std::fs::write(&outside, "secret").unwrap();
        assert!(preview(&root, "../pix-preview-outside.txt").is_err());
        assert!(preview(&root, &outside.to_string_lossy()).is_err());
        assert!(preview(&root, "src/../../etc").is_err());
        assert!(preview(&root, "src/missing.txt").is_err());
        assert!(preview(&root, "src").is_err(), "directories are not previewable");
        let out = preview(&root, "src/a.txt").unwrap();
        assert_eq!(out.text.as_deref(), Some("ok"));
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_file(&outside).unwrap();
    }

    #[test]
    fn missing_project_reports_coded_error() {
        let root = std::env::temp_dir().join(format!("pix-missing-{}", uuid::Uuid::new_v4()));
        let err = preview(&root, "a.txt").unwrap_err();
        assert!(err.contains("projectDirMissing"), "{err}");
    }

    #[test]
    fn error_payloads_stay_json_parseable() {
        let root = std::env::temp_dir().join(format!("pix-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let err = preview(&root, "nope.txt").unwrap_err();
        let payload: Value =
            serde_json::from_str(err.strip_prefix(crate::errors::CODED_ERROR_PREFIX).unwrap()).unwrap();
        assert_eq!(payload["code"], "previewPathInvalid");
        std::fs::remove_dir_all(&root).unwrap();
    }
}
