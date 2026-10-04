//! Password hashing, login rate limiting and token validation for the
//! remote HTTP server.

use super::{load, persist_settings, RemoteState, WebState};
use crate::errors::pix_error;
use argon2::{
    password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    time::Instant,
};
use tauri::Manager;

pub(super) struct LoginAttempt {
    count: u8,
    since: Instant,
}

pub(super) fn bearer(headers: &HeaderMap) -> &str {
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|h| h.strip_prefix("Bearer "))
        .unwrap_or("")
}

#[derive(Deserialize)]
pub(super) struct LoginInput {
    password: String,
}

// Bounds both the number of password guesses and the number of tracked
// clients. The window slides: every attempt (allowed or rejected) refreshes
// the window start, so a client probing continuously never regains attempts —
// it must stay fully silent for a whole window to get a fresh budget.
fn login_allowed(attempts: &mut HashMap<IpAddr, LoginAttempt>, ip: IpAddr, now: Instant) -> bool {
    const WINDOW: std::time::Duration = std::time::Duration::from_secs(60);
    attempts.retain(|_, entry| now.duration_since(entry.since) < WINDOW);
    if !attempts.contains_key(&ip) && attempts.len() >= 256 {
        return false;
    }
    let entry = attempts.entry(ip).or_insert(LoginAttempt {
        count: 0,
        since: now,
    });
    if entry.count >= 5 {
        entry.since = now;
        return false;
    }
    entry.count += 1;
    entry.since = now;
    true
}

pub(super) async fn password_login(
    State(web): State<WebState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Json(input): Json<LoginInput>,
) -> Response {
    let Some(hash) = &web.password_hash else {
        return StatusCode::FORBIDDEN.into_response();
    };
    if input.password.len() > 128 {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    {
        let mut attempts = web.login_attempts.lock().unwrap();
        if !login_allowed(&mut attempts, addr.ip(), Instant::now()) {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
    }
    let Ok(_slot) = web.login_slots.clone().try_acquire_owned() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    let hash = hash.clone();
    let valid = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).ok().is_some_and(|parsed| {
            Argon2::default()
                .verify_password(input.password.as_bytes(), &parsed)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !valid || *web.stop.borrow() {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    web.login_attempts.lock().unwrap().remove(&addr.ip());
    (
        [("cache-control", "no-store")],
        Json(json!({"token": web.token})),
    )
        .into_response()
}

pub(super) fn authorized(state: &WebState, token: &str) -> bool {
    valid_token(&state.token, token, *state.stop.borrow())
}

pub(super) fn valid_token(expected: &str, supplied: &str, stopped: bool) -> bool {
    !stopped && !expected.is_empty() && crate::secrets::constant_time_eq(expected, supplied)
}

/// PIX_REMOTE_TOKEN overrides the random per-boot token (headless testing /
/// automation). A stale environment variable in a release build would let
/// anyone on the LAN authenticate with a known token, so release builds
/// ignore it.
pub(super) fn boot_token() -> String {
    boot_token_with(std::env::var("PIX_REMOTE_TOKEN").ok())
}

fn boot_token_with(override_token: Option<String>) -> String {
    let random = || uuid::Uuid::new_v4().simple().to_string();
    match override_token {
        Some(token) if !token.is_empty() && cfg!(debug_assertions) => token,
        Some(token) if !token.is_empty() => {
            eprintln!("PIX_REMOTE_TOKEN is ignored in release builds");
            random()
        }
        _ => random(),
    }
}

#[tauri::command]
pub async fn remote_password_set(
    app: tauri::AppHandle,
    password: Option<String>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<RemoteState>();
    let _operation = state.operation.lock().await;
    if state.server.lock().unwrap().is_some() {
        return Err(pix_error(
            "disableLanBeforePasswordChange",
            "请先关闭局域网访问，再修改密码",
        ));
    }
    let password_hash = match password {
        Some(password) => {
            if password.chars().count() < 8 || password.len() > 128 {
                return Err(pix_error(
                    "passwordLengthInvalid",
                    "密码至少 8 个字符，且不超过 128 字节",
                ));
            }
            Some(
                tokio::task::spawn_blocking(move || {
                    // argon2 0.6 的 hash_password 内部自动生成随机盐
                    Argon2::default()
                        .hash_password(password.as_bytes())
                        .map(|hash| hash.to_string())
                        .map_err(|e| e.to_string())
                })
                .await
                .map_err(|e| e.to_string())??,
            )
        }
        None => None,
    };
    let mut settings = load(&app);
    settings.password_hash = password_hash;
    persist_settings(&settings)?;
    Ok(super::server::remote_status(app.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use argon2::password_hash::{phc::PasswordHash, PasswordHasher, PasswordVerifier};
    use argon2::Argon2;
    use std::time::Duration;

    #[test]
    fn login_rate_limit_is_per_address() {
        let mut attempts = HashMap::new();
        let now = Instant::now();
        let first = "192.168.1.5".parse().unwrap();
        let second = "192.168.1.6".parse().unwrap();
        for _ in 0..5 {
            assert!(login_allowed(&mut attempts, first, now));
        }
        assert!(!login_allowed(&mut attempts, first, now));
        assert!(login_allowed(&mut attempts, second, now));
        assert!(login_allowed(
            &mut attempts,
            first,
            now + Duration::from_secs(61)
        ));
    }

    #[test]
    fn sustained_login_probing_stays_locked() {
        let mut attempts = HashMap::new();
        let ip: IpAddr = "192.168.1.9".parse().unwrap();
        let t0 = Instant::now();
        for _ in 0..5 {
            assert!(login_allowed(&mut attempts, ip, t0));
        }
        // 持续探测会不断刷新窗口起点：只要两次尝试间隔不足一个窗口，
        // 就不能像固定窗口那样到期后又拿到全新的 5 次额度。
        for minute in 1..=5u64 {
            let t = t0 + Duration::from_secs(59 * minute);
            assert!(
                !login_allowed(&mut attempts, ip, t),
                "probe at {}s should stay blocked",
                59 * minute
            );
        }
        // 完全静默一个窗口后才恢复额度。
        assert!(login_allowed(
            &mut attempts,
            ip,
            t0 + Duration::from_secs(59 * 5 + 61)
        ));
    }

    #[test]
    fn pix_remote_token_override_applies_in_debug_builds_only() {
        if cfg!(debug_assertions) {
            assert_eq!(
                boot_token_with(Some("headless-token".into())),
                "headless-token"
            );
        } else {
            // 生产构建忽略环境变量，返回的必须是随机 token。
            assert_ne!(
                boot_token_with(Some("headless-token".into())),
                "headless-token"
            );
        }
        assert!(!boot_token_with(None).is_empty());
    }

    #[test]
    fn password_hash_verifies_only_the_original_password() {
        let hash = Argon2::default()
            .hash_password(b"test-password")
            .unwrap()
            .to_string();
        let parsed = PasswordHash::new(&hash).unwrap();
        assert!(Argon2::default()
            .verify_password(b"test-password", &parsed)
            .is_ok());
        assert!(Argon2::default()
            .verify_password(b"wrong-password", &parsed)
            .is_err());
        assert!(!hash.contains("test-password"));
    }

    #[test]
    fn token_required_and_revoked_on_shutdown() {
        assert!(valid_token("secret", "secret", false));
        assert!(!valid_token("secret", "", false));
        assert!(!valid_token("secret", "wrong", false));
        assert!(!valid_token("secret", "secret", true));
        assert!(!valid_token("", "", false));
    }
}
