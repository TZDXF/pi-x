mod app_update;
mod builtin_extensions;
mod commands;
mod data_dir;
mod desktop;
mod editor;
mod editor_icon;
mod errors;
mod file_preview;
mod fs_search;
mod logs;
mod mcp;
mod packages;
mod pi_data;
mod pi_locate;
mod pi_update;
mod preview_proxy;
#[cfg(feature = "remote-access")]
mod remote;
#[cfg(not(feature = "remote-access"))]
#[path = "remote_disabled.rs"]
mod remote;
mod rpc;
mod schedules;
mod session_checkpoint;
mod session_file_rewind;
mod session_revert;
mod session_watch;
mod sessions;
mod skills;
mod terminal;
mod title_generation;
mod trust;
mod workspace_git;

use rpc::RpcState;
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RpcState::default())
        .manage(schedules::ScheduleState::default())
        .manage(terminal::TerminalState::default())
        .setup(|app| {
            data_dir::initialize()?;
            logs::initialize();
            schedules::start(app.handle().clone())?;
            session_watch::start(app.handle().clone());
            let config = app.config().app.windows[0].clone();
            let handle = app.handle().clone();
            tauri::WebviewWindowBuilder::from_config(app, &config)?
                .data_directory(data_dir::root().join("webview"))
                // window.open() and target=_blank links open in the system
                // browser instead of being blocked by the webview.
                .on_new_window(move |url, _features| {
                    let _ = handle.opener().open_url(url.to_string(), None::<&str>);
                    tauri::webview::NewWindowResponse::Deny
                })
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
            schedules::schedule_list,
            schedules::schedule_save,
            schedules::schedule_delete,
            schedules::schedule_run,
            remote::remote_status,
            remote::remote_set,
            remote::remote_password_set,
            commands::pi_detect,
            pi_update::pi_update_check,
            pi_update::pi_update_execute,
            app_update::app_update_check,
            app_update::app_update_install,
            app_update::app_update_restart,
            commands::pi_settings_get,
            commands::pi_settings_save,
            commands::app_config_get,
            commands::app_config_save,
            commands::projectless_dir_resolve,
            commands::global_prompt_list,
            commands::global_prompt_save,
            commands::trust_status,
            commands::trust_save,
            commands::rpc_spawn,
            commands::rpc_request,
            commands::rpc_notify,
            commands::rpc_kill,
            commands::pix_log,
            commands::rpc_running,
            commands::rpc_sessions,
            commands::session_list,
            sessions::session_mtime,
            sessions::session_history,
            sessions::session_last_error,
            sessions::session_update,
            sessions::session_delete,
            sessions::session_duplicate,
            sessions::session_list_archived,
            title_generation::session_generate_title,
            workspace_git::workspace_git_info,
            workspace_git::workspace_git_create,
            workspace_git::workspace_git_prepare,
            session_revert::session_revert_changes,
            session_file_rewind::session_file_rewind_preview,
            session_file_rewind::session_file_rewind_apply,
            session_file_rewind::session_file_rewind_state_get,
            session_file_rewind::session_file_rewind_state_mark,
            session_checkpoint::session_checkpoint_create,
            session_checkpoint::session_checkpoint_diff,
            session_checkpoint::session_checkpoint_restore,
            session_checkpoint::session_checkpoint_manifest_get,
            session_checkpoint::session_checkpoint_manifest_set,
            session_checkpoint::session_checkpoint_manifest_delete,
            session_checkpoint::session_checkpoint_content,
            commands::search_files,
            commands::list_project_directory,
            commands::read_file_preview,
            commands::session_export_file,
            commands::open_path,
            editor::open_in_editor,
            editor::detect_editors,
            editor_icon::editor_icons,
            commands::models_config_get,
            commands::models_config_save,
            commands::models_fetch,
            mcp::mcp_config_read,
            mcp::mcp_config_save,
            mcp::mcp_status,
            packages::package_catalog,
            packages::package_list,
            packages::package_install,
            packages::package_remove,
            packages::package_update,
            packages::package_list_files,
            packages::package_read_file,
            packages::package_resources,
            packages::package_set_resource,
            packages::package_translate,
            
            skills::skills_hosted_list,
            skills::skills_discovered_list,
            skills::skills_hosted_open_dir,
            skills::skills_hosted_delete,
            skills::skills_hosted_set_enabled,
            terminal::term_create,
            terminal::term_write,
            terminal::term_resize,
            terminal::term_kill,
            preview_proxy::preview_proxy_info,
            desktop::set_tray_labels,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                logs::write("app", "RunEvent::Exit: killing all pi processes");
                let state = app.state::<RpcState>();
                let _ = tauri::async_runtime::block_on(rpc::kill_all(&state));
                terminal::kill_all(&app.state::<terminal::TerminalState>());
            }
        });
}
