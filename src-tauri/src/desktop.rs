use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Window, WindowEvent};

/// 托盘菜单标签句柄；webview 内的语言包对原生菜单不可见，
/// 由前端在启动与切换语言时经 `set_tray_labels` 上报。
pub struct TrayLabels {
    show: MenuItem<tauri::Wry>,
    quit: MenuItem<tauri::Wry>,
}

fn restore(app: &AppHandle) {
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
