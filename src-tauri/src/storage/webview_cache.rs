use std::path::Path;

use super::{category, StorageCategory};

// Only include caches cleared by WebView2's DISK_CACHE API, never persistent user data.
const CACHE_PATHS: &[&str] = &["EBWebView/Default/Cache", "EBWebView/Default/Code Cache"];

fn is_link(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points must not lead scans outside the profile.
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

pub(super) fn scan(root: &Path) -> StorageCategory {
    let mut usage = category("webviewCache");
    if !std::fs::symlink_metadata(root).is_ok_and(|m| m.is_dir() && !is_link(&m)) {
        return usage;
    }
    for relative in CACHE_PATHS {
        let mut path = root.to_path_buf();
        let safe = relative.split('/').all(|part| {
            path.push(part);
            std::fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir() && !is_link(&m))
        });
        if !safe {
            continue;
        }
        let mut pending = vec![path];
        while let Some(path) = pending.pop() {
            let Ok(entries) = std::fs::read_dir(path) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(metadata) = std::fs::symlink_metadata(entry.path()) else {
                    continue;
                };
                if is_link(&metadata) {
                    continue;
                }
                if metadata.is_dir() {
                    pending.push(entry.path());
                } else if metadata.is_file() {
                    usage.bytes = usage.bytes.saturating_add(metadata.len());
                    usage.file_count = usage.file_count.saturating_add(1);
                }
            }
        }
    }
    usage
}

#[cfg(windows)]
pub(super) async fn clear(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use webview2_com::{
        ClearBrowsingDataCompletedHandler,
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile2, ICoreWebView2_13, COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE,
        },
    };
    use windows_core::Interface;

    let error = |detail| {
        crate::errors::pix_error_detail(
            "webviewCacheCleanupFailed",
            "清理 WebView 缓存失败：{detail}",
            detail,
        )
    };
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| error("main window not found".to_owned()))?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    window
        .with_webview(move |webview| {
            // Native COM access stays on the UI thread. Only the result crosses threads.
            let sender = std::rc::Rc::new(std::cell::RefCell::new(Some(sender)));
            let completed = sender.clone();
            let result = unsafe {
                (|| -> windows_core::Result<()> {
                    let core: ICoreWebView2_13 = webview.controller().CoreWebView2()?.cast()?;
                    let profile: ICoreWebView2Profile2 = core.Profile()?.cast()?;
                    let handler =
                        ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                            if let Some(sender) = completed.borrow_mut().take() {
                                let _ = sender.send(result.map_err(|e| e.to_string()));
                            }
                            Ok(())
                        }));
                    profile.ClearBrowsingData(COREWEBVIEW2_BROWSING_DATA_KINDS_DISK_CACHE, &handler)
                })()
            };
            if let Err(error) = result {
                if let Some(sender) = sender.borrow_mut().take() {
                    let _ = sender.send(Err(error.to_string()));
                }
            }
        })
        .map_err(|e| error(e.to_string()))?;
    receiver
        .await
        .map_err(|e| error(e.to_string()))?
        .map_err(error)
}
