//! System notification delivery.
//!
//! tauri-plugin-notification 在 Windows 上仅当 exe 不位于 target 目录时才设置
//! AUMID,且从不处理点击激活:开发运行时 toast 会归属到 PowerShell 且无图标,
//! 点击也不会唤起窗口。因此 Windows 上直接用 tauri-winrt-notification 构造
//! toast:按需注册 HKCU AppUserModelId(显示名 + 图标),点击时聚焦主窗口;
//! 其他平台继续走插件的 builder。

use tauri::AppHandle;

#[tauri::command]
pub fn send_notification(app: AppHandle, title: String, body: String) {
    #[cfg(windows)]
    windows::show(&app, &title, &body);
    #[cfg(not(windows))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = app.notification().builder().title(title).body(body).show();
    }
}

#[cfg(windows)]
mod windows {
    use std::path::{Path, PathBuf};
    use std::sync::Once;

    use tauri::{AppHandle, Manager};
    use tauri_winrt_notification::Toast;

    /// 未打包的应用需要按用户注册 AUMID,否则 Windows 会把 toast 归属到宿主
    /// 进程(如 PowerShell)且不显示图标。DisplayName 与 IconUri 写入一次即可。
    fn ensure_aumid(app: &AppHandle) {
        static DONE: Once = Once::new();
        DONE.call_once(|| {
            let aumid = app.config().identifier.clone();
            let display_name = app
                .config()
                .product_name
                .clone()
                .unwrap_or_else(|| aumid.clone());
            let key = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
                .create_subkey(format!(r"Software\Classes\AppUserModelId\{aumid}"));
            let Ok((key, _)) = key else {
                return;
            };
            let _ = key.set_value("DisplayName", &display_name);
            // IconUri 只认磁盘上的图标文件(PNG/ICO),不会从 exe 内嵌资源提取;
            // 提取失败时仅缺图标,显示名仍生效
            if let Some(png) = std::env::current_exe().ok().and_then(|exe| ensure_icon_png(&exe)) {
                let _ = key.set_value("IconUri", &png.display().to_string());
            }
        });
    }

    /// 自身图标 PNG 的缓存路径:exe 更新(mtime 变新)后重新提取
    fn ensure_icon_png(exe: &Path) -> Option<PathBuf> {
        let dest = crate::data_dir::root().join("app_icon.png");
        let reuse = std::fs::metadata(&dest)
            .and_then(|icon| icon.modified())
            .ok()
            .zip(std::fs::metadata(exe).and_then(|app| app.modified()).ok())
            .is_some_and(|(icon, app)| icon >= app);
        if reuse {
            return Some(dest);
        }
        crate::editor_icon::export_icon_png(exe, &dest)?;
        Some(dest)
    }

    pub(super) fn show(app: &AppHandle, title: &str, body: &str) {
        ensure_aumid(app);
        let handle = app.clone();
        if let Err(e) = Toast::new(&app.config().identifier)
            .title(title)
            .text1(body)
            .on_activated(move |_| {
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                Ok(())
            })
            .show()
        {
            eprintln!("notification: {e}");
        }
    }
}
