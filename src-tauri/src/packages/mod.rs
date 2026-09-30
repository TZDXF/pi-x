//! Pi package management: browse the official catalog at https://pi.dev/packages
//! and drive `pi install / remove / update` for the user.

mod catalog;
mod resources;
mod runner;

pub use catalog::package_catalog;
pub(crate) use resources::package_skill_paths;
pub use resources::{package_read_resource, package_resources, package_set_resource, package_translate};
pub(crate) use runner::run_pi;
pub use runner::{package_install, package_list, package_remove, package_update};

// Re-export the command wrapper macros so `generate_handler![packages::<cmd>]`
// resolves them under the same path as the command functions.
#[doc(hidden)]
pub use catalog::{__cmd__package_catalog, __tauri_command_name_package_catalog};
#[doc(hidden)]
pub use resources::{
    __cmd__package_read_resource, __cmd__package_resources, __cmd__package_set_resource, __cmd__package_translate,
    __tauri_command_name_package_read_resource, __tauri_command_name_package_resources, __tauri_command_name_package_translate,
    __tauri_command_name_package_set_resource,
};
#[doc(hidden)]
pub use runner::{
    __cmd__package_install, __cmd__package_list, __cmd__package_remove, __cmd__package_update,
    __tauri_command_name_package_install, __tauri_command_name_package_list,
    __tauri_command_name_package_remove, __tauri_command_name_package_update,
};
