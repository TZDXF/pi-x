use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Window, WindowEvent};

/// 托盘菜单标签句柄；webview 内的语言包对原生菜单不可见，
/// 由前端在启动与切换语言时经 `set_tray_labels` 上报。
pub struct TrayLabels {
    show: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

pub fn restore(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示 PiX").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 PiX").build(app)?;
    let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
    app.manage(TrayLabels {
        show: show.clone(),
        quit: quit.clone(),
    });
    let mut tray = TrayIconBuilder::with_id("main-tray")
        .tooltip("PiX")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => restore(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                restore(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        // Closing always minimizes to the tray; quit via the tray menu.
        api.prevent_close();
        let _ = window.hide();
    }
}

/// 开发者模式下由前端快捷键触发；返回值表示调用后 devtools 是否处于打开状态。
///
/// tauri 只在 `any(debug_assertions, feature = "devtools")` 下提供
/// open_devtools 等 API：debug 构建自带 devtools，默认 release 产物不含
/// （避免 webview 内任意 JS 执行路径经 devtools 控制台触达全部命令），
/// 需要时以 `--features devtools` 重新编译。
#[tauri::command]
pub fn devtools_toggle(app: AppHandle) -> Result<bool, String> {
    #[cfg(any(debug_assertions, feature = "devtools"))]
    {
        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;
        if window.is_devtools_open() {
            window.close_devtools();
            Ok(false)
        } else {
            window.open_devtools();
            Ok(true)
        }
    }
    #[cfg(not(any(debug_assertions, feature = "devtools")))]
    {
        let _ = app;
        Err(crate::errors::pix_error(
            "devtoolsUnavailable",
            "当前构建未编译 devtools，需以 --features devtools 重新打包",
        ))
    }
}

#[tauri::command]
pub fn set_tray_labels(
    app: AppHandle,
    show_label: String,
    quit_label: String,
) -> Result<(), String> {
    let labels = app.state::<TrayLabels>();
    let (show, quit) = (labels.show.clone(), labels.quit.clone());
    // 菜单文本只能在主线程更新。
    app.run_on_main_thread(move || {
        let _ = show.set_text(show_label);
        let _ = quit.set_text(quit_label);
    })
    .map_err(|e| e.to_string())
}
