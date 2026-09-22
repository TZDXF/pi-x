use crate::commands::{app_config_get, app_config_save};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, Window, WindowEvent};
use tauri_plugin_dialog::DialogExt;

static PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

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

/// Result of the in-app close dialog: "tray" hides to tray, "quit" exits,
/// anything else cancels. `remember` persists the choice and skips future prompts.
#[tauri::command]
pub fn close_window_decide(app: AppHandle, action: String, remember: bool) -> Result<(), String> {
    PROMPT_OPEN.store(false, Ordering::SeqCst);
    let close_to_tray = match action.as_str() {
        "tray" => true,
        "quit" => false,
        _ => return Ok(()),
    };
    if remember {
        let mut config = app_config_get(app.clone())?;
        config.close_notice_shown = true;
        config.close_to_tray = close_to_tray;
        app_config_save(app.clone(), config)?;
    }
    if close_to_tray {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
    } else {
        app.exit(0);
    }
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != "main" {
        return;
    }
    let app = window.app_handle();
    match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let config = match app_config_get(app.clone()) {
                Ok(config) => config,
                Err(error) => {
                    app.dialog().message(error).show(|_| {});
                    return;
                }
            };
            if !config.close_notice_shown {
                if PROMPT_OPEN.swap(true, Ordering::SeqCst) {
                    return;
                }
                // The in-app dialog resolves via `close_window_decide`, which resets PROMPT_OPEN.
                if window.emit("pix://close-requested", ()).is_err() {
                    PROMPT_OPEN.store(false, Ordering::SeqCst);
                }
            } else if config.close_to_tray {
                let _ = window.hide();
            } else {
                app.exit(0);
            }
        }
        WindowEvent::Resized(_) => {
            if window.is_minimized().unwrap_or(false)
                && app_config_get(app.clone())
                    .map(|c| c.minimize_to_tray)
                    .unwrap_or(false)
            {
                let _ = window.hide();
            }
        }
        _ => {}
    }
}
