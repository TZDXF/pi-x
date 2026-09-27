use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::task::spawn_blocking;

use crate::errors::{pix_error, pix_error_detail};

/// 单个文件的撤销操作，按工具调用时间顺序传入，回放时逆序应用。
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RevertOp {
    /// 编辑类工具：把替换后的文本还原为替换前文本。
    Replace { before: String, after: String },
    /// create_file：文件由本次写入产生，当前内容与写入一致时直接删除。
    Delete { content: String },
}

#[derive(Deserialize)]
pub struct RevertFile {
    pub path: String,
    #[serde(default)]
    pub ops: Vec<RevertOp>,
}

#[derive(Serialize)]
pub struct RevertFileResult {
    pub path: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[tauri::command]
pub async fn session_revert_changes(
    project: String,
    files: Vec<RevertFile>,
) -> Result<Vec<RevertFileResult>, String> {
    spawn_blocking(move || {
        let root = dunce::canonicalize(&project)
            .map_err(|_| pix_error("projectDirMissing", "项目目录不存在"))?;
        if !root.is_dir() {
            return Err(pix_error("projectDirMissing", "项目目录不存在"));
        }
        Ok(files.iter().map(|file| revert_file(&root, file)).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn revert_file(root: &Path, file: &RevertFile) -> RevertFileResult {
    let result = resolve_within(root, &file.path).and_then(|path| apply_ops(&path, &file.ops));
    match result {
        Ok(()) => RevertFileResult { path: file.path.clone(), ok: true, error: None },
        Err(error) => RevertFileResult { path: file.path.clone(), ok: false, error: Some(error) },
    }
}

/// 支持绝对路径与项目内相对路径；canonicalize 后必须仍落在项目根内。
fn resolve_within(root: &Path, raw: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(raw);
    let path = if candidate.is_absolute() { candidate.to_path_buf() } else { root.join(candidate) };
    let path = dunce::canonicalize(&path)
        .map_err(|_| pix_error_detail("revertPathInvalid", "无效的文件路径: {detail}", raw))?;
    if !path.starts_with(root) {
        return Err(pix_error_detail("revertPathInvalid", "无效的文件路径: {detail}", raw));
    }
    Ok(path)
}

fn apply_ops(path: &Path, ops: &[RevertOp]) -> Result<(), String> {
    if ops.is_empty() {
        return Err(pix_error("revertNotRevertible", "该文件没有可自动撤销的修改记录"));
    }
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        // 已撤销过的新建文件再次撤销视为成功（幂等）。
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && matches!(ops[0], RevertOp::Delete { .. }) => return Ok(()),
        Err(e) => return Err(pix_error_detail("revertReadFailed", "读取文件失败: {detail}", e)),
    };
    let mut content = String::from_utf8(bytes).map_err(|_| {
        pix_error_detail("revertNotUtf8", "文件不是 UTF-8 文本，无法自动撤销: {detail}", path.display())
    })?;
    // 先在内存中逆序回放，全部成功后才落盘，保证单文件的原子性。
    for op in ops.iter().rev() {
        match op {
            RevertOp::Replace { before, after } => content = revert_replace(&content, before, after)?,
            RevertOp::Delete { content: expected } => {
                if content != *expected {
                    return Err(pix_error_detail(
                        "revertContentChanged",
                        "文件内容已变化，无法自动撤销: {detail}",
                        path.display(),
                    ));
                }
            }
        }
    }
    if matches!(ops[0], RevertOp::Delete { .. }) {
        std::fs::remove_file(path)
            .map_err(|e| pix_error_detail("revertWriteFailed", "删除文件失败: {detail}", e))?;
    } else {
        std::fs::write(path, content)
            .map_err(|e| pix_error_detail("revertWriteFailed", "写入文件失败: {detail}", e))?;
    }
    Ok(())
}

/// 用 before 还原 after 的首次出现；找不到时按行尾差异（LF/CRLF）宽松匹配，
/// 避免模型给出的 LF 参数在 Windows CRLF 文件上无法定位。
fn revert_replace(content: &str, before: &str, after: &str) -> Result<String, String> {
    if let Some(index) = content.find(after) {
        let mut updated = String::with_capacity(content.len() + before.len() - after.len());
        updated.push_str(&content[..index]);
        updated.push_str(before);
        updated.push_str(&content[index + after.len()..]);
        return Ok(updated);
    }
    if let Some((start, end, crlf)) = find_ignoring_carriage_returns(content, after) {
        let replacement = if crlf {
            before.replace('\r', "").replace('\n', "\r\n")
        } else {
            before.replace('\r', "")
        };
        let mut updated = String::with_capacity(content.len() + replacement.len() - (end - start));
        updated.push_str(&content[..start]);
        updated.push_str(&replacement);
        updated.push_str(&content[end..]);
        return Ok(updated);
    }
    Err(pix_error("revertContentChanged", "文件内容已变化，无法自动撤销"))
}

/// 忽略内容与模式中的 \r 定位 needle，返回原始字节区间及区间是否使用 CRLF 行尾。
fn find_ignoring_carriage_returns(content: &str, needle: &str) -> Option<(usize, usize, bool)> {
    if content.len() > 64 * 1024 * 1024 {
        return None; // 超大文件不做宽松匹配，避免整份字符映射的开销
    }
    let haystack: Vec<char> = content.chars().filter(|ch| *ch != '\r').collect();
    let needle_chars: Vec<char> = needle.chars().filter(|ch| *ch != '\r').collect();
    if needle_chars.is_empty() {
        return None;
    }
    let position = haystack
        .windows(needle_chars.len())
        .position(|window| window == needle_chars.as_slice())?;
    let start = char_byte_offset(content, position)?;
    let end = char_byte_offset(content, position + needle_chars.len())?;
    let crlf = content[start..end].contains("\r\n");
    Some((start, end, crlf))
}

/// 过滤 \r 后的字符流中第 skip 个字符在原文中的字节偏移。
fn char_byte_offset(content: &str, mut skip: usize) -> Option<usize> {
    for (index, ch) in content.char_indices() {
        if ch == '\r' {
            continue;
        }
        if skip == 0 {
            return Some(index);
        }
        skip -= 1;
    }
    (skip == 0).then_some(content.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir() -> TempDir {
        let path = std::env::temp_dir().join(format!("pix-revert-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        TempDir(path)
    }

    fn write(root: &TempDir, name: &str, content: &str) -> PathBuf {
        let path = root.0.join(name);
        std::fs::write(&path, content).unwrap();
        path
    }

    fn replace(before: &str, after: &str) -> RevertOp {
        RevertOp::Replace { before: before.into(), after: after.into() }
    }

    fn error_code(error: &str) -> String {
        let payload: serde_json::Value = serde_json::from_str(error.trim_start_matches("PIXERR:")).unwrap();
        payload["code"].as_str().unwrap().into()
    }

    #[test]
    fn reverts_edit_and_multi_edit_in_reverse_order() {
        let root = temp_dir();
        let path = write(&root, "a.txt", "start\nb\nc\nend\n");
        // 模拟两轮编辑：start→hello，c→world
        let ops = vec![replace("start", "hello"), replace("c", "world")];
        let edited = "hello\nb\nworld\nend\n";
        std::fs::write(&path, edited).unwrap();
        apply_ops(&path, &ops).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "start\nb\nc\nend\n");
    }

    #[test]
    fn reverts_created_file_and_stays_idempotent() {
        let root = temp_dir();
        let path = write(&root, "new.txt", "created\ncontent\n");
        apply_ops(&path, &[RevertOp::Delete { content: "created\ncontent\n".into() }]).unwrap();
        assert!(!path.exists());
        // 再撤销一次：文件已不存在，视为成功。
        apply_ops(&path, &[RevertOp::Delete { content: "created\ncontent\n".into() }]).unwrap();
    }

    #[test]
    fn refuses_revert_when_content_drifted() {
        let root = temp_dir();
        let path = write(&root, "a.txt", "user changed this\n");
        let error = apply_ops(&path, &[replace("original\n", "recorded\n")]).unwrap_err();
        assert_eq!(error_code(&error), "revertContentChanged");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "user changed this\n");
    }

    #[test]
    fn refuses_delete_when_file_changed_after_write() {
        let root = temp_dir();
        let path = write(&root, "new.txt", "changed by user\n");
        let error =
            apply_ops(&path, &[RevertOp::Delete { content: "created\n".into() }]).unwrap_err();
        assert_eq!(error_code(&error), "revertContentChanged");
        assert!(path.exists());
    }

    #[test]
    fn matches_crlf_files_with_lf_arguments() {
        let root = temp_dir();
        // 模型给出的 LF 参数在 CRLF 文件上定位，还原结果保持 CRLF 行尾。
        let path = write(&root, "win.txt", "a\r\nOLD\r\nb\r\n");
        apply_ops(&path, &[replace("new\n", "OLD\n")]).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "a\r\nnew\r\nb\r\n");
        // 匹配不到时拒绝撤销，而不是误改文件。
        let error = apply_ops(&path, &[replace("stale\n", "gone\n")]).unwrap_err();
        assert_eq!(error_code(&error), "revertContentChanged");
    }

    #[test]
    fn rejects_paths_outside_project() {
        let root = temp_dir();
        assert!(resolve_within(&root.0, "../outside.txt").is_err());
        let outside = std::env::temp_dir().join("pix-revert-test-outside.txt");
        std::fs::write(&outside, "x").unwrap();
        let resolved = resolve_within(&root.0, &outside.to_string_lossy());
        let _ = std::fs::remove_file(&outside);
        assert!(resolved.is_err());
        assert!(resolve_within(&root.0, "missing.txt").is_err());
    }

    #[test]
    fn reports_missing_ops() {
        let root = temp_dir();
        let path = write(&root, "a.txt", "x");
        let error = apply_ops(&path, &[]).unwrap_err();
        assert_eq!(error_code(&error), "revertNotRevertible");
    }
}
