//! 回滚状态清单：按会话文件存储（快照对象存于仓库 .git/pix 下的私有对象目录）。

use std::path::{Path, PathBuf};
use tokio::task::spawn_blocking;

use crate::data_dir;
use crate::errors::{pix_error_detail, pix_error_with};
use crate::sessions::validate_session_path;

use super::git::fnv1a;

fn manifest_path(file: &Path) -> PathBuf {
    data_dir::root()
        .join("checkpoints")
        .join(format!("{:016x}.json", fnv1a(&file.to_string_lossy())))
}

#[tauri::command]
pub async fn session_checkpoint_manifest_get(file: String) -> Result<serde_json::Value, String> {
    spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        match std::fs::read_to_string(manifest_path(&path)) {
            Ok(content) => serde_json::from_str(&content).map_err(|e| {
                pix_error_with("checkpointManifestInvalid", format!("快照清单损坏: {e}"), serde_json::json!({ "detail": e.to_string() }))
            }),
            Err(_) => Ok(serde_json::Value::Null),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn session_checkpoint_manifest_set(file: String, manifest: serde_json::Value) -> Result<(), String> {
    spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        let store = manifest_path(&path);
        std::fs::create_dir_all(store.parent().unwrap()).map_err(|e| e.to_string())?;
        std::fs::write(&store, serde_json::to_string(&manifest).map_err(|e| e.to_string())?)
            .map_err(|e| pix_error_detail("checkpointManifestWriteFailed", "写入快照清单失败: {detail}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除会话对应的快照清单文件（会话删除时调用）。
#[tauri::command]
pub async fn session_checkpoint_manifest_delete(file: String) -> Result<(), String> {
    spawn_blocking(move || {
        let path = validate_session_path(&file)?;
        let store = manifest_path(&path);
        if store.exists() {
            std::fs::remove_file(&store).map_err(|e| {
                pix_error_detail("checkpointManifestDeleteFailed", "删除快照清单失败: {detail}", e)
            })?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}
