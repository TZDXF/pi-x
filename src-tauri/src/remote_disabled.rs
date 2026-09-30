// Keep desktop IPC and local RPC events available without the remote server.
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::errors::pix_error;

#[tauri::command]
pub fn remote_status() -> Value {
    json!({"enabled": false, "port": 1421, "urls": [], "passwordEnabled": false})
}

#[tauri::command]
pub async fn remote_set(enabled: bool, port: u16) -> Result<Value, String> {
    if enabled {
        return Err(pix_error(
            "remoteNotBuiltHint",
            "当前构建未启用远程访问，请使用 npm run dev:desktop:remote 启动",
        ));
    }
    Ok(json!({"enabled": false, "port": port, "urls": []}))
}

pub fn emit(app: &AppHandle, name: &str, payload: Value) {
    use tauri::Emitter;
    let _ = app.emit(name, payload);
}

#[tauri::command]
pub async fn remote_password_set(password: Option<String>) -> Result<Value, String> {
    let _ = password;
    Err(pix_error("remoteNotBuilt", "当前构建未启用远程访问"))
}
