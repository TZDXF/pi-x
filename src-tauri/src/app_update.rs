//! PiX 桌面应用自身的更新检查与安装。
//!
//! 正式版为语义化版本（tag `v0.1.0`，正式 Release），预览版为日期版本号
//! （tag `preview-v2026.9.27`，prerelease，见 `.github/workflows/preview.yml`）。
//! 两种版本号无法直接比较，目标版本的选取在这里基于 GitHub Releases 数据自行完成：
//! - 预览通道优先跟踪最新预览版；预览版停更而正式版反超时也提示正式版。
//! - 正式通道只认正式版；当前为预览版时仅在最新正式版**发布日期晚于当前预览版
//!   构建日期**（预览版版本号即日期）时才提示，否则不回退旧正式版，等待下一次发布。
//!
//! 下载与安装交给 tauri-plugin-updater，并把其内置版本比较器替换为恒真：
//! 目标已选定，不能让 updater 再按语义比较拒绝“降级”（如 2026.9.27 → 0.2.0）。

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

use crate::commands::UpdateChannel;
use crate::errors::{pix_error, pix_error_detail};
use crate::{rpc, terminal};

const RELEASES_API: &str = "https://api.github.com/repos/TZDXF/pi-x/releases?per_page=100";
/// 下载/安装进度事件，payload 见 [`UpdateProgress`]。
pub const PROGRESS_EVENT: &str = "pix://app-update";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GhRelease {
    tag_name: String,
    prerelease: bool,
    draft: bool,
    published_at: Option<String>,
    body: Option<String>,
    html_url: String,
    assets: Vec<GhAsset>,
}

#[derive(Deserialize)]
struct GhAsset {
    name: String,
    browser_download_url: String,
}

/// 待安装的目标版本信息。
#[derive(Debug, PartialEq)]
struct Target {
    version: String,
    notes: Option<String>,
    release_url: String,
    /// 该 Release 中 tauri-action 上传的 `latest.json` 资产地址，供 updater 使用。
    manifest: Option<String>,
}

#[derive(Debug, PartialEq)]
enum Decision {
    UpToDate,
    /// 预览版退回正式通道：最新正式版不晚于当前预览版发布，不回退，等待下一次正式版。
    WaitingStable { latest_stable: Target },
    Update(Target),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateStatus {
    channel: UpdateChannel,
    current_version: String,
    update_available: bool,
    waiting_stable: bool,
    /// 目标通道最新版本（waiting_stable 时为最新正式版）。
    version: Option<String>,
    release_notes: Option<String>,
    release_url: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateProgress {
    stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    chunk_length: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_length: Option<u64>,
}

/// `preview-v2026.9.27` → `2026.9.27`；`v0.1.0` → `0.1.0`。
fn release_version(tag: &str) -> Option<&str> {
    tag.strip_prefix("preview-v").or_else(|| tag.strip_prefix('v'))
}

fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim().trim_start_matches('v');
    let mut parts = v.split('.');
    let major: u64 = parts.next()?.parse().ok()?;
    let minor: u64 = parts.next()?.parse().ok()?;
    let patch: u64 = parts.next()?.split('-').next()?.parse().ok()?;
    // 正式 tag 恒为 x.y.z（可能带预发布后缀）；第四段起不参与比较
    Some((major, minor, patch))
}

/// 预览版版本号为日期形式（如 `2026.9.27`）：4 位年份起头，与正式版 `0.x.y` 天然区分。
fn parse_date_version(v: &str) -> Option<(i64, u32, u32)> {
    let (year, rest) = v.split_once('.')?;
    let year: i64 = year.parse().ok()?;
    if !(2000..=2999).contains(&year) {
        return None;
    }
    let (month, day) = rest.split_once('.')?;
    let month: u32 = month.parse().ok()?;
    let day: u32 = day.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some((year, month, day))
}

fn is_preview_version(v: &str) -> bool {
    parse_date_version(v).is_some()
}

/// GitHub `published_at`（RFC3339，如 `2026-09-27T16:03:21Z`）的日期部分。
fn published_date(release: &GhRelease) -> Option<(i64, u32, u32)> {
    let date = release.published_at.as_deref()?.split('T').next()?;
    let mut it = date.split('-');
    let year: i64 = it.next()?.parse().ok()?;
    let month: u32 = it.next()?.parse().ok()?;
    let day: u32 = it.next()?.parse().ok()?;
    Some((year, month, day))
}

/// 最新预览版： Releases 列表按创建时间倒序，取首个匹配即可。
fn pick_preview(releases: &[GhRelease]) -> Option<&GhRelease> {
    releases.iter().find(|r| {
        !r.draft
            && r.prerelease
            && r.tag_name.starts_with("preview-v")
            && parse_date_version(&r.tag_name[9..]).is_some()
    })
}

/// 最新正式版。
fn pick_stable(releases: &[GhRelease]) -> Option<&GhRelease> {
    releases.iter().find(|r| {
        !r.draft
            && !r.prerelease
            && r.tag_name.starts_with('v')
            && parse_semver(release_version(&r.tag_name).unwrap_or("")).is_some()
    })
}

/// 预览版是否构成对当前版本的更新：同为预览版按日期比较；当前为正式版时
/// 用预览版 `published_at` 与当前正式版的发布日期比较，避免把正式版"降级"为更旧的预览版。
fn preview_supersedes(preview: &GhRelease, current: &str, current_release: Option<&GhRelease>) -> bool {
    let Some(newer) = parse_date_version(&preview.tag_name[9..]) else {
        return false;
    };
    match parse_date_version(current) {
        Some(current) => newer > current,
        None => match (published_date(preview), current_release.and_then(published_date)) {
            (Some(preview_date), Some(current_date)) => preview_date > current_date,
            _ => false,
        },
    }
}

/// 正式版是否构成对当前版本的更新：正式版→正式版按语义化版本比较；
/// 预览版→正式版按发布日期比较，正式版必须发布于当前预览版构建日期之后（不回退）。
fn stable_supersedes(stable: &GhRelease, current: &str) -> bool {
    if is_preview_version(current) {
        match (parse_date_version(current), published_date(stable)) {
            (Some(current), Some(published)) => published > current,
            // 发布日期未知时按“无更新”处理，避免任何形式的降级
            _ => false,
        }
    } else {
        match (
            parse_semver(current),
            parse_semver(release_version(&stable.tag_name).unwrap_or("")),
        ) {
            (Some(current), Some(newer)) => newer > current,
            _ => false,
        }
    }
}

fn target_of(release: &GhRelease) -> Target {
    let version = release_version(&release.tag_name)
        .unwrap_or(&release.tag_name)
        .to_string();
    let notes = release
        .body
        .as_deref()
        .map(str::trim)
        .filter(|body| !body.is_empty())
        .map(str::to_string);
    let manifest = release
        .assets
        .iter()
        .find(|asset| asset.name == "latest.json")
        .map(|asset| asset.browser_download_url.clone());
    Target {
        version,
        notes,
        release_url: release.html_url.clone(),
        manifest,
    }
}

fn decide(current: &str, channel: UpdateChannel, releases: &[GhRelease]) -> Decision {
    match channel {
        UpdateChannel::Preview => {
            let current_release = if is_preview_version(current) {
                None
            } else {
                releases.iter().find(|r| {
                    !r.draft && !r.prerelease
                        && release_version(&r.tag_name).is_some_and(|v| v == current)
                })
            };
            if let Some(release) = pick_preview(releases).filter(|r| preview_supersedes(r, current, current_release)) {
                return Decision::Update(target_of(release));
            }
            if let Some(release) = pick_stable(releases).filter(|r| stable_supersedes(r, current)) {
                return Decision::Update(target_of(release));
            }
            Decision::UpToDate
        }
        UpdateChannel::Stable => {
            let Some(stable) = pick_stable(releases) else {
                return Decision::UpToDate;
            };
            if stable_supersedes(stable, current) {
                Decision::Update(target_of(stable))
            } else if is_preview_version(current) {
                // 退出预览版：不回退旧正式版，等待下一次正式版发布
                Decision::WaitingStable {
                    latest_stable: target_of(stable),
                }
            } else {
                Decision::UpToDate
            }
        }
    }
}

async fn fetch_releases() -> Result<Vec<GhRelease>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        ureq::get(RELEASES_API)
            .set("User-Agent", "pi-x desktop")
            .set("Accept", "application/vnd.github+json")
            .timeout(std::time::Duration::from_secs(20))
            .call()
            .map_err(|e| pix_error_detail("appUpdateReleasesFetchFailed", "获取发布列表失败: {detail}", e))?
            .into_string()
            .map_err(|e| pix_error_detail("appUpdateReleasesReadFailed", "读取发布列表失败: {detail}", e))
            .and_then(|body| {
                serde_json::from_str(&body)
                    .map_err(|e| pix_error_detail("appUpdateReleasesParseFailed", "解析发布列表失败: {detail}", e))
            })
    })
    .await
    .map_err(|e| pix_error_detail("appUpdateTaskFailed", "更新检查任务失败: {detail}", e))?
}

#[tauri::command]
pub async fn app_update_check(app: AppHandle, channel: UpdateChannel) -> Result<AppUpdateStatus, String> {
    let current_version = app.package_info().version.to_string();
    let releases = fetch_releases().await?;
    let current = current_version.clone();
    Ok(match decide(&current, channel, &releases) {
        Decision::UpToDate => AppUpdateStatus {
            channel,
            current_version,
            update_available: false,
            waiting_stable: false,
            version: None,
            release_notes: None,
            release_url: None,
        },
        Decision::Update(target) => AppUpdateStatus {
            channel,
            current_version,
            update_available: true,
            waiting_stable: false,
            version: Some(target.version),
            release_notes: target.notes,
            release_url: Some(target.release_url),
        },
        Decision::WaitingStable { latest_stable } => AppUpdateStatus {
            channel,
            current_version,
            update_available: false,
            waiting_stable: true,
            version: Some(latest_stable.version),
            release_notes: None,
            release_url: Some(latest_stable.release_url),
        },
    })
}

static INSTALLING: AtomicBool = AtomicBool::new(false);
struct InstallGuard;
impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::Release);
    }
}

#[tauri::command]
pub async fn app_update_install(app: AppHandle, channel: UpdateChannel) -> Result<(), String> {
    INSTALLING
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| pix_error("appUpdateInProgress", "应用更新正在进行中"))?;
    let _guard = InstallGuard;
    install(app, channel).await
}

async fn install(app: AppHandle, channel: UpdateChannel) -> Result<(), String> {
    let current_version = app.package_info().version.to_string();
    let releases = fetch_releases().await?;
    let Decision::Update(target) = decide(&current_version, channel, &releases) else {
        return Err(pix_error("appUpdateNothingToInstall", "当前没有待安装的应用更新"));
    };
    let Some(manifest) = target.manifest else {
        return Err(pix_error("appUpdateManifestMissing", "该版本未包含自动更新数据，请到发布页手动下载"));
    };
    let endpoint =
        tauri::Url::parse(&manifest).map_err(|e| pix_error_detail("appUpdateManifestInvalid", "更新清单地址无效: {detail}", e))?;
    let builder = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| pix_error_detail("appUpdateInitFailed", "初始化更新器失败: {detail}", e))?;
    // 版本/通道判定已在 decide 完成（日期版本号与语义版本号无法直接比较），
    // 恒真比较器直接安装选定目标，避免 updater 因“版本不大于当前”拒绝安装。
    let updater = builder
        .version_comparator(|_, _| true)
        .build()
        .map_err(|e| pix_error_detail("appUpdateInitFailed", "初始化更新器失败: {detail}", e))?;
    let update = updater
        .check()
        .await
        .map_err(|e| pix_error_detail("appUpdateManifestFetchFailed", "获取更新数据失败: {detail}", e))?
        .ok_or_else(|| pix_error("appUpdateManifestEmpty", "更新清单中没有可安装的版本"))?;
    let app_for_chunk = app.clone();
    let app_for_finish = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                let _ = app_for_chunk.emit(
                    PROGRESS_EVENT,
                    UpdateProgress {
                        stage: "download",
                        chunk_length: Some(chunk as u64),
                        content_length: total,
                    },
                );
            },
            || {
                let _ = app_for_finish.emit(PROGRESS_EVENT, UpdateProgress { stage: "install", chunk_length: None, content_length: None });
            },
        )
        .await
        .map_err(|e| pix_error_detail("appUpdateInstallFailed", "安装更新失败: {detail}", e))?;
    let _ = app.emit(PROGRESS_EVENT, UpdateProgress { stage: "installed", chunk_length: None, content_length: None });
    Ok(())
}

/// 安装完成后重启应用。`restart()` 直接退出进程，`RunEvent::Exit` 的清理不可靠，
/// 先显式终止 pi 进程与终端再重启。
#[tauri::command]
pub fn app_update_restart(app: AppHandle) -> Result<(), String> {
    let state = app.state::<rpc::RpcState>();
    let _ = tauri::async_runtime::block_on(rpc::kill_all(&state));
    terminal::kill_all(&app.state::<terminal::TerminalState>());
    app.restart()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, prerelease: bool, published_at: Option<&str>) -> GhRelease {
        GhRelease {
            tag_name: tag.into(),
            prerelease,
            draft: false,
            published_at: published_at.map(Into::into),
            body: None,
            html_url: format!("https://github.com/TZDXF/pi-x/releases/tag/{tag}"),
            assets: vec![GhAsset {
                name: "latest.json".into(),
                browser_download_url: "https://example.com/latest.json".into(),
            }],
        }
    }

    #[test]
    fn strips_release_tag_prefixes() {
        assert_eq!(release_version("preview-v2026.9.27"), Some("2026.9.27"));
        assert_eq!(release_version("v0.1.0"), Some("0.1.0"));
    }

    #[test]
    fn distinguishes_date_versions_from_semver() {
        assert_eq!(parse_date_version("2026.9.27"), Some((2026, 9, 27)));
        assert_eq!(parse_date_version("0.1.0"), None);
        assert_eq!(parse_date_version("999.1.0"), None);
        assert_eq!(parse_date_version("2026.13.1"), None);
        assert_eq!(parse_semver("0.1.0"), Some((0, 1, 0)));
        assert_eq!(parse_semver("v0.10.2-beta.1"), Some((0, 10, 2)));
    }

    #[test]
    fn preview_channel_tracks_newest_preview() {
        let releases = [
            release("preview-v2026.9.28", true, Some("2026-09-28T16:10:00Z")),
            release("v0.1.0", false, Some("2026-09-20T10:00:00Z")),
            release("preview-v2026.9.27", true, Some("2026-09-27T16:10:00Z")),
        ];
        let decision = decide("2026.9.27", UpdateChannel::Preview, &releases);
        assert_eq!(decision, Decision::Update(Target {
            version: "2026.9.28".into(),
            notes: None,
            release_url: "https://github.com/TZDXF/pi-x/releases/tag/preview-v2026.9.28".into(),
            manifest: Some("https://example.com/latest.json".into()),
        }));
        // 已是最新预览版，正式版虽然存在但更旧
        let decision = decide("2026.9.28", UpdateChannel::Preview, &releases);
        assert_eq!(decision, Decision::UpToDate);
    }

    #[test]
    fn preview_channel_falls_back_to_newer_stable() {
        // 无任何预览发布：正式版 0.1.0 → 0.2.0 提示更新
        let releases = [release("v0.2.0", false, Some("2026-09-25T10:00:00Z")), release("v0.1.0", false, None)];
        let decision = decide("0.1.0", UpdateChannel::Preview, &releases);
        assert_eq!(decision, Decision::Update(Target {
            version: "0.2.0".into(),
            notes: None,
            release_url: "https://github.com/TZDXF/pi-x/releases/tag/v0.2.0".into(),
            manifest: Some("https://example.com/latest.json".into()),
        }));
        // 预览版停在 2026.9.27，此后的正式版反超（预览停更场景）
        let releases = [
            release("v0.2.0", false, Some("2026-09-28T10:00:00Z")),
            release("preview-v2026.9.27", true, Some("2026-09-27T16:10:00Z")),
        ];
        let decision = decide("2026.9.27", UpdateChannel::Preview, &releases);
        assert!(matches!(decision, Decision::Update(_)), "expected stable update, got {decision:?}");
    }

    #[test]
    fn stable_channel_compares_semver() {
        let releases = [
            release("preview-v2026.9.28", true, Some("2026-09-28T16:10:00Z")),
            release("v0.2.0", false, Some("2026-09-25T10:00:00Z")),
        ];
        assert!(matches!(
            decide("0.1.0", UpdateChannel::Stable, &releases),
            Decision::Update(_)
        ));
        assert_eq!(decide("0.2.0", UpdateChannel::Stable, &releases), Decision::UpToDate);
        // 预览版发布不影响正式通道
        assert_eq!(decide("0.3.0", UpdateChannel::Stable, &releases), Decision::UpToDate);
    }

    #[test]
    fn exiting_preview_never_rolls_back_and_waits_for_next_stable() {
        // 当前预览版 2026.9.27；最新正式版 0.1.0 发布于预览版之前 → 不回退，等待
        let releases = [release("v0.1.0", false, Some("2026-09-20T10:00:00Z"))];
        let decision = decide("2026.9.27", UpdateChannel::Stable, &releases);
        match decision {
            Decision::WaitingStable { latest_stable } => assert_eq!(latest_stable.version, "0.1.0"),
            other => panic!("expected waiting for next stable, got {other:?}"),
        }
        // 同日发布的正式版也视为“未晚于”，不提示
        let releases = [release("v0.2.0", false, Some("2026-09-27T23:00:00Z"))];
        assert!(matches!(decide("2026.9.27", UpdateChannel::Stable, &releases), Decision::WaitingStable { .. }));
        // 发布日期缺失时不提示
        let releases = [release("v0.2.0", false, None)];
        assert!(matches!(decide("2026.9.27", UpdateChannel::Stable, &releases), Decision::WaitingStable { .. }));
        // 下一次正式版发布（晚于预览版构建日期）→ 提示更新
        let releases = [release("v0.2.0", false, Some("2026-09-28T10:00:00Z"))];
        assert!(matches!(decide("2026.9.27", UpdateChannel::Stable, &releases), Decision::Update(_)));
    }

    #[test]
    fn update_channel_serializes_lowercase() {
        assert_eq!(serde_json::to_value(UpdateChannel::Stable).unwrap(), "stable");
        assert_eq!(serde_json::to_value(UpdateChannel::Preview).unwrap(), "preview");
        let channel: UpdateChannel = serde_json::from_value("preview".into()).unwrap();
        assert_eq!(channel, UpdateChannel::Preview);
    }
}
