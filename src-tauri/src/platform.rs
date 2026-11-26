//! 平台信息：把 `cfg!(target_os)` 与 macOS 的系统偏好交给前端，让标题栏按平台分支，
//! 而不是让 webview 靠 UA 猜平台（各平台 webview 的 UA 并不自洽）。

use serde::Serialize;

/// macOS「双击窗口标题栏」的系统偏好动作。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TitleBarDoubleClickAction {
    Maximize,
    Minimize,
    None,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowPlatform {
    /// `"macos"` / `"windows"` / `"linux"`，与前端 `DesktopOs` 对应。
    os: &'static str,
    /// 非 macOS 恒为 `null`：Windows / Linux 的双击行为由自绘标题栏自己决定。
    double_click_action: Option<TitleBarDoubleClickAction>,
}

/// 系统偏好值 → 动作。缺省（键不存在）按 macOS 默认的「缩放」处理。
///
/// 取值为字符串（系统设置写入 `"Maximize"` / `"Minimize"` / `"None"`）；
/// 更早的系统版本用布尔键 `AppleMiniaturizeOnDoubleClick`，两者都认。
///
/// 与 `editor_icon` 的 macOS 专用解析一样，只在 macOS 与单测里编译：其他平台的
/// `window_platform` 直接返回 `null`（双击行为由自绘标题栏自己决定）。
#[cfg(any(target_os = "macos", test))]
fn double_click_action_of(
    string: Option<&str>,
    legacy_minimize: bool,
) -> TitleBarDoubleClickAction {
    match string.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("minimize") => TitleBarDoubleClickAction::Minimize,
        Some("none") => TitleBarDoubleClickAction::None,
        Some("maximize") => TitleBarDoubleClickAction::Maximize,
        // 未设置或无法识别时回退到旧布尔键，再回退到系统默认。
        _ if legacy_minimize => TitleBarDoubleClickAction::Minimize,
        _ => TitleBarDoubleClickAction::Maximize,
    }
}

#[cfg(target_os = "macos")]
fn macos_double_click_action() -> TitleBarDoubleClickAction {
    use objc2_foundation::{NSString, NSUserDefaults};

    let defaults = NSUserDefaults::standardUserDefaults();
    let string = {
        let key = NSString::from_str("AppleActionOnDoubleClick");
        defaults.stringForKey(&key).map(|value| value.to_string())
    };
    let legacy_minimize = {
        let key = NSString::from_str("AppleMiniaturizeOnDoubleClick");
        defaults.boolForKey(&key)
    };
    double_click_action_of(string.as_deref(), legacy_minimize)
}

const fn os_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

/// 前端启动时探测一次；macOS 上双击标题栏前会再调一次，让系统设置的改动立即生效。
#[tauri::command]
pub fn window_platform() -> WindowPlatform {
    #[cfg(target_os = "macos")]
    let double_click_action = Some(macos_double_click_action());
    #[cfg(not(target_os = "macos"))]
    let double_click_action = None;

    WindowPlatform {
        os: os_name(),
        double_click_action,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_system_preference_values() {
        assert_eq!(
            double_click_action_of(Some("Maximize"), false),
            TitleBarDoubleClickAction::Maximize
        );
        assert_eq!(
            double_click_action_of(Some("minimize"), false),
            TitleBarDoubleClickAction::Minimize
        );
        assert_eq!(
            double_click_action_of(Some(" None "), false),
            TitleBarDoubleClickAction::None
        );
    }

    #[test]
    fn falls_back_when_key_is_absent_or_unknown() {
        // 系统默认：双击标题栏缩放。
        assert_eq!(
            double_click_action_of(None, false),
            TitleBarDoubleClickAction::Maximize
        );
        assert_eq!(
            double_click_action_of(Some("Surprise"), false),
            TitleBarDoubleClickAction::Maximize
        );
        // 旧版系统的布尔键同样生效。
        assert_eq!(
            double_click_action_of(None, true),
            TitleBarDoubleClickAction::Minimize
        );
    }

    #[test]
    fn os_name_matches_build_target() {
        #[cfg(target_os = "macos")]
        assert_eq!(os_name(), "macos");
        #[cfg(windows)]
        assert_eq!(os_name(), "windows");
        #[cfg(all(unix, not(target_os = "macos")))]
        assert_eq!(os_name(), "linux");
    }
}

#[cfg(test)]
mod config_tests {
    use std::path::Path;

    use tauri::utils::{config::parse::read_from, platform::Target};

    /// macOS 分平台配置按 JSON Merge Patch 合并：`app.windows` 是数组，会被整体替换，
    /// 所以 macos 配置必须自己重复窗口的全部字段，否则会悄悄丢掉基础配置里的尺寸、
    /// `create: false` 等设置。这里逐项核对合并结果。
    #[test]
    fn macos_config_keeps_every_window_field_and_adds_native_traffic_lights() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let (merged, paths) = read_from(Target::MacOS, root).expect("macos config parses");
        assert!(paths.len() >= 2, "tauri.macos.conf.json is merged: {paths:?}");

        let window = &merged["app"]["windows"][0];
        assert_eq!(window["decorations"], true);
        assert_eq!(window["titleBarStyle"], "Overlay");
        assert_eq!(window["hiddenTitle"], true);
        assert_eq!(window["trafficLightPosition"]["x"], 9.0);
        assert_eq!(window["trafficLightPosition"]["y"], 16.0);

        // 与 tauri.conf.json 保持一致的字段（数组被整体替换，必须在这里重复）。
        assert_eq!(window["create"], false);
        assert_eq!(window["dragDropEnabled"], false);
        assert_eq!(window["width"], 1280);
        assert_eq!(window["height"], 832);
        assert_eq!(window["minWidth"], 900);
        assert_eq!(window["minHeight"], 600);
        assert_eq!(window["title"], "PiX");
    }
}
