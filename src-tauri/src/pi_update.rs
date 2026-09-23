//! Check Pi's official latest-version endpoint and invoke its own self-updater.
//! Never run a shell command assembled from user input.

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;

use crate::{commands, packages, pi_locate};

const LATEST_URL: &str = "https://pi.dev/api/latest-version";
const PACKAGE_NAME: &str = "@earendil-works/pi-coding-agent";
static UPDATING: AtomicBool = AtomicBool::new(false);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LatestResponse {
    ok: bool,
    version: String,
    package_name: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiUpdateStatus {
    current_version: String,
    latest_version: String,
    update_available: bool,
}

// Pi reports a semver version (sometimes with a leading v or pi prefix).
// Official latest releases are stable; a prerelease of the same version is older.
fn version_key(text: &str) -> Option<(u64, u64, u64, bool)> {
    let re = regex::Regex::new(r"(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?").ok()?;
    let parts = re.captures(text.trim())?;
    Some((
        parts.get(1)?.as_str().parse().ok()?,
        parts.get(2)?.as_str().parse().ok()?,
        parts.get(3)?.as_str().parse().ok()?,
        parts.get(4).is_none(),
    ))
}

#[tauri::command]
pub async fn pi_update_check(app: AppHandle) -> Result<PiUpdateStatus, String> {
    let config = commands::app_config_get(app)?;
    let info = pi_locate::detect(config.pi_path).await;
    let current_version = info
        .version
        .ok_or("无法读取当前 Pi 版本，请确认 Pi 可正常启动")?;
    let current = version_key(&current_version).ok_or("无法识别当前 Pi 版本")?;

    let latest = tauri::async_runtime::spawn_blocking(|| {
        ureq::get(LATEST_URL)
            .set("User-Agent", "pi-x desktop")
            .timeout(std::time::Duration::from_secs(15))
            .call()
            .map_err(|e| format!("检查 Pi 更新失败: {e}"))?
            .into_string()
            .map_err(|e| format!("读取 Pi 更新信息失败: {e}"))
            .and_then(|body| {
                serde_json::from_str::<LatestResponse>(&body)
                    .map_err(|e| format!("解析 Pi 更新信息失败: {e}"))
            })
    })
    .await
    .map_err(|e| e.to_string())??;
    if !latest.ok || latest.package_name != PACKAGE_NAME {
        return Err("Pi 更新信息来源不匹配".into());
    }
    let newest = version_key(&latest.version).ok_or("无法识别最新 Pi 版本")?;
    Ok(PiUpdateStatus {
        current_version,
        latest_version: latest.version,
        update_available: newest > current,
    })
}

struct UpdateGuard;
impl Drop for UpdateGuard {
    fn drop(&mut self) {
        UPDATING.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn pi_update_execute(app: AppHandle) -> Result<(), String> {
    UPDATING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| "Pi 更新正在进行中".to_string())?;
    let _guard = UpdateGuard;
    packages::run_pi(&app, &["update".into(), "--self".into()], None).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::version_key;

    #[test]
    fn compares_release_versions() {
        assert!(version_key("0.87.1") > version_key("0.87.0"));
        assert!(version_key("0.87.1") > version_key("0.87.1-beta.1"));
        assert_eq!(version_key("pi v0.87.1"), version_key("0.87.1"));
        assert_eq!(version_key("unknown"), None);
    }
}
