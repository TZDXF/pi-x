mod data_dir;
mod desktop;
mod commands;
mod fs_search;
mod packages;
mod pi_locate;
#[cfg(feature = "remote-access")]
mod remote;
#[cfg(not(feature = "remote-access"))]
#[path = "remote_disabled.rs"]
mod remote;
mod rpc;
mod session_watch;
mod sessions;
mod skills;
mod terminal;
mod title_generation;
mod workspace_git;
mod trust;
mod pi_data;

use rpc::RpcState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RpcState::default())
        .manage(terminal::TerminalState::default())
        .setup(|app| {
            data_dir::initialize()?;
            session_watch::start(app.handle().clone());
            let config = app.config().app.windows[0].clone();
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .data_directory(data_dir::root().join("webview"))
                .build()?;
            desktop::setup(app.handle())?;
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
        .on_window_event(desktop::on_window_event)
        .invoke_handler(tauri::generate_handler![
            remote::remote_status,
            remote::remote_set,
            commands::pi_detect,
            commands::pi_settings_get,
            commands::pi_settings_save,
            commands::app_config_get,
            commands::app_config_save,
            commands::global_prompt_get,
            commands::global_prompt_save,
            commands::trust_status,
            commands::trust_save,
            commands::rpc_spawn,
            commands::rpc_request,
            commands::rpc_notify,
            commands::rpc_kill,
            commands::rpc_running,
            commands::rpc_sessions,
            commands::session_list,
            sessions::session_mtime,
            sessions::session_update,
            sessions::session_delete,
            sessions::session_list_archived,
            title_generation::session_generate_title,
            workspace_git::workspace_git_info,
            workspace_git::workspace_git_create,
            commands::search_files,
            commands::open_path,
            commands::models_config_get,
            commands::models_config_save,
            packages::package_catalog,
            packages::package_list,
            packages::package_install,
            packages::package_remove,
            packages::package_update,
            packages::package_resources,
            packages::package_set_resource,
            skills::skills_hosted_list,
            skills::skills_discovered_list,
            skills::skills_hosted_open_dir,
            skills::skills_hosted_delete,
            skills::skills_hosted_set_enabled,
            terminal::term_create,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                let state = app.state::<RpcState>();
                let _ = tauri::async_runtime::block_on(rpc::kill_all(&state));
                terminal::kill_all(&app.state::<terminal::TerminalState>());
            }
        });
}
