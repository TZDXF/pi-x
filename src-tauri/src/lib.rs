mod commands;
mod fs_search;
mod pi_locate;
#[cfg(feature = "remote-access")]
mod remote;
#[cfg(not(feature = "remote-access"))]
#[path = "remote_disabled.rs"]
mod remote;
mod rpc;
mod sessions;
mod title_generation;
mod workspace_git;
mod trust;

use rpc::RpcState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RpcState::default())
        .setup(|app| {
            #[cfg(feature = "remote-access")]
            {
                app.manage(remote::RemoteState::default());
                let handle = app.handle().clone();
                let cfg = remote::load(&handle);
                if cfg.enabled {
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = remote::remote_set(handle, true, cfg.port).await {
                            eprintln!("Remote server: {e}");
                        }
                    });
                }
            }
            #[cfg(not(feature = "remote-access"))]
            let _ = app;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            remote::remote_status,
            remote::remote_set,
            commands::pi_detect,
            commands::app_config_get,
            commands::app_config_save,
            commands::trust_status,
            commands::trust_save,
            commands::rpc_spawn,
            commands::rpc_request,
            commands::rpc_notify,
            commands::rpc_kill,
            commands::rpc_running,
            commands::session_list,
            sessions::session_update,
            title_generation::session_generate_title,
            workspace_git::workspace_git_info,
            workspace_git::workspace_git_create,
            commands::search_files,
            commands::open_path,
            commands::models_config_get,
            commands::models_config_save,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<RpcState>();
                let _ = tauri::async_runtime::block_on(rpc::kill(&state));
            }
        });
}
