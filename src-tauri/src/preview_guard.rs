//! Shared path-traversal guard and size-capped read/decode helpers for
//! package / skill file previews.
//!
//! The package preview (`packages::package_read_file`) and the skill preview
//! (`skills::skills_read_file`) used to carry two nearly identical copies of
//! the "canonicalize + starts_with" containment check and a duplicate
//! `has_parent_dir_component`; they are unified here with per-caller error
//! labels so every error code and message stays byte-identical.

use dunce::canonicalize;
use std::path::{Path, PathBuf};

use crate::errors::{pix_error, pix_error_detail};

/// Whether a relative path climbs out via `..` as a whole component; a name
/// like `a..b.md` is a normal component, not traversal.
pub(crate) fn has_parent_dir_component(path: &str) -> bool {
    Path::new(path)
        .components()
        .any(|c| c == std::path::Component::ParentDir)
}

/// Reject absolute paths, drive-letter hints and whole-component `..`
/// traversal. `message` completes the coded error, e.g. `无效的技能文件路径`.
pub(crate) fn reject_unsafe_rel_path(rel_path: &str, message: &'static str) -> Result<(), String> {
    if has_parent_dir_component(rel_path)
        || rel_path.starts_with('/')
        || rel_path.starts_with('\\')
        || rel_path.contains(':')
    {
        return Err(pix_error("invalidResourcePath", message));
    }
    Ok(())
}

/// Error labels and codes where the package and skill preview flows differ.
pub(crate) struct RootGuardSpec {
    /// Detail label when the file cannot be canonicalized, e.g.
    /// `读取技能文件失败` (the resolved path and io error are appended).
    pub read_failed_label: &'static str,
    /// Detail label when the root cannot be canonicalized, e.g.
    /// `解析技能路径失败` (the io error is appended).
    pub root_resolve_label: &'static str,
    /// Error code when the root cannot be canonicalized.
    pub root_resolve_code: &'static str,
    /// Message when the canonical file escapes the canonical root.
    pub outside_message: &'static str,
}

/// Resolve the exact file to read inside `root`: the canonical file must stay
/// inside the canonical root, so symlinks cannot smuggle reads outside it.
pub(crate) fn resolve_within_root(
    root: &Path,
    rel_path: &str,
    spec: &RootGuardSpec,
) -> Result<PathBuf, String> {
    let file = root.join(rel_path);
    let canonical = canonicalize(&file).map_err(|e| {
        pix_error_detail(
            "resourceReadFailed",
            format!("{}: {} ({e})", spec.read_failed_label, file.display()),
            format!("{}: {e}", file.display()),
        )
    })?;
    let canonical_root = canonicalize(root).map_err(|e| {
        pix_error_detail(
            spec.root_resolve_code,
            format!("{}: {e}", spec.root_resolve_label),
            e,
        )
    })?;
    if !canonical.starts_with(&canonical_root) {
        return Err(pix_error("invalidResourcePath", spec.outside_message));
    }
    Ok(canonical)
}

/// Cap text previews at 512 KB so huge files don't flood the IPC bridge.
pub(crate) const PREVIEW_MAX_BYTES: u64 = 512 * 1024;

/// Read at most [`PREVIEW_MAX_BYTES`] + 3 bytes (one maximal UTF-8 character
/// of slack) so oversized files stop at the cap instead of loading whole.
pub(crate) fn read_preview_bytes(path: &Path, display: std::path::Display) -> Result<Vec<u8>, String> {
    use std::io::Read;

    let mut handle = std::fs::File::open(path).map_err(|e| {
        pix_error_detail(
            "resourceReadFailed",
            format!("读取资源文件失败: {display} ({e})"),
            format!("{display}: {e}"),
        )
    })?;
    let mut bytes = Vec::new();
    handle
        .by_ref()
        .take(PREVIEW_MAX_BYTES + 3)
        .read_to_end(&mut bytes)
        .map_err(|e| {
            pix_error_detail(
                "resourceReadFailed",
                format!("读取资源文件失败: {display} ({e})"),
                format!("{display}: {e}"),
            )
        })?;
    Ok(bytes)
}

/// Decode preview bytes: binary sniff (git style, NUL in the first 8 KB),
/// then UTF-8 validation. A multi-byte character cut at the read cap is
/// trimmed instead of failing; any other invalid sequence is binary content.
pub(crate) fn decode_preview_text(bytes: Vec<u8>) -> Result<String, String> {
    // Binary sniff (git style): NUL in the first 8 KB.
    let sniff_end = bytes.len().min(8_000);
    if bytes[..sniff_end].contains(&0) {
        return Err(pix_error("resourceBinary", "二进制文件，不支持文本预览"));
    }
    match String::from_utf8(bytes) {
        Ok(text) => Ok(text),
        Err(e) if e.utf8_error().error_len().is_none() && e.utf8_error().valid_up_to() > 0 => {
            let valid_up_to = e.utf8_error().valid_up_to();
            let bytes = e.into_bytes();
            Ok(String::from_utf8_lossy(&bytes[..valid_up_to]).into_owned())
        }
        Err(_) => Err(pix_error("resourceBinary", "二进制文件，不支持文本预览")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_text_is_trimmed_to_utf8_boundary() {
        assert_eq!(decode_preview_text(b"hello".to_vec()).unwrap(), "hello");
        // A multi-byte character cut by the read cap is trimmed, not rejected.
        let mut cut = "abc中".as_bytes().to_vec();
        cut.pop();
        assert_eq!(decode_preview_text(cut).unwrap(), "abc");
        // A genuinely invalid sequence stays binary content.
        assert!(decode_preview_text(vec![0x61, 0xFF, 0x62]).is_err());
        assert!(decode_preview_text(b"ok\0binary".to_vec()).is_err());
        assert_eq!(PREVIEW_MAX_BYTES, 512 * 1024);
    }

    #[test]
    fn parent_dir_component_check_is_component_level() {
        assert!(!has_parent_dir_component("a..b.md"));
        assert!(!has_parent_dir_component("..."));
        assert!(!has_parent_dir_component("extensions/a..b.ts"));
        assert!(has_parent_dir_component(".."));
        assert!(has_parent_dir_component("a/../b"));
        assert!(has_parent_dir_component("extensions/../x.ts"));
    }
}
