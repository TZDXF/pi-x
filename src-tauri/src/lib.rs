mod commands;
mod fs_search;
mod pi_locate;
mod rpc;
mod sessions;
mod trust;

use rpc::RpcState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RpcState::default())
        .invoke_handler(tauri::generate_handler![
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
            commands::search_files,
            commands::open_path,
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
