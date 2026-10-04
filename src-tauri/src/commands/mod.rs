//! Tauri commands, split by domain:
//! - [`config`]: app config (`config.json`), model refs, update channel and
//!   the projectless working directory.
//! - [`prompts`]: global prompt files (AGENTS/SYSTEM/APPEND_SYSTEM.md).
//! - [`models`]: pi `models.json` management and the provider `/models` fetcher.
//! - [`workspace`]: workspace-group manifest handed to the pix-workspace
//!   extension.
//! - [`pi`]: pi detection and trust, RPC spawn/passthrough, pi settings and
//!   diagnostics logging.
//! - [`files`]: project file browsing/preview, stored-session listing/export
//!   and `open_path`.
//!
//! 命令实现位于子模块，lib.rs 的 generate_handler 以 `commands::<域>::<cmd>`
//! 路径解析命令名与其包装宏；命令名字符串保持与拆分前完全一致。

pub(crate) mod config;
pub(crate) mod files;
pub(crate) mod models;
pub(crate) mod pi;
pub(crate) mod prompts;
pub(crate) mod workspace;

// 再导出保持拆分前 `crate::commands::*` 的对外路径；部分调用方位于
// remote-access feature 之后，默认构建下这些再导出会显示为未使用。
#[allow(unused_imports)]
pub use config::{
    app_config_get, app_config_save, projectless_dir_resolve, AppConfig, ModelRef,
    ProjectlessDirInfo, UpdateChannel,
};
#[allow(unused_imports)]
pub use files::{
    list_project_directory, open_path, read_file_preview, search_files, session_export_file,
    session_list,
};
#[allow(unused_imports)]
pub use models::{models_config_get, models_config_save, models_fetch, FetchedModel};
#[allow(unused_imports)]
pub use pi::{
    app_version_get, pi_detect, pi_settings_get, pi_settings_save, pix_log, rpc_kill, rpc_notify,
    rpc_request, rpc_running, rpc_sessions, rpc_spawn, trust_save, trust_status,
};
#[allow(unused_imports)]
pub use prompts::{global_prompt_list, global_prompt_save, GlobalPromptFile};
#[allow(unused_imports)]
pub use workspace::WorkspaceContext;

pub(crate) use pi::validate_project_dir;
