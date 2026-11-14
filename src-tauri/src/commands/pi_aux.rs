//! aux（辅助对话）的 spawn 命令：策略固定为 `Aux`，参数集来自
//! `rpc::aux`（见 `docs/aux-chat-spec.md` §1）。

use tauri::{AppHandle, State};

use crate::errors::pix_error;
use crate::ssh::transport::SshErrorKind;
use crate::{pi_locate, rpc, ssh};

use super::config::app_config_get;
use super::pi::validate_project_dir;
use super::ssh::remote_error_coded;
use super::workspace::{workspace_manifest_for, WorkspaceContext};

/// 校验 aux 的 runtimeId：必须是 `aux:` 前缀，避免把主会话进程改成 aux 策略。
fn validate_aux_runtime(runtime_id: &str) -> Result<(), String> {
    if runtime_id.starts_with("aux:") {
        Ok(())
    } else {
        Err(pix_error(
            "auxRuntimeIdInvalid",
            "辅助对话的 runtimeId 必须以 aux: 开头",
        ))
    }
}

/// Spawn an aux runtime. `session_file` is always `None` (`--no-session`).
#[tauri::command]
pub async fn aux_spawn(
    app: AppHandle,
    state: State<'_, rpc::RpcState>,
    project: String,
    runtime_id: String,
    provider: String,
    model: String,
    thinking: Option<String>,
    workspace: Option<WorkspaceContext>,
    ssh_connection_id: Option<String>,
) -> Result<(), String> {
    validate_aux_runtime(&runtime_id)?;
    let spec_json = serde_json::json!({
        "provider": provider,
        "model": model,
        "thinking": thinking,
    });
    let mut spec = rpc::aux_launch::spec_from_json(&spec_json)?;
    rpc::aux_launch::ensure_ephemeral(None)?;

    let Some(target) = ssh::parse_remote_uri(&project) else {
        validate_project_dir(&project)?;
        let cfg = app_config_get(app.clone())?;
        let manifest = workspace_manifest_for(&project, workspace, cfg.workspace_groups.unwrap_or(true))?;
        let info = pi_locate::detect(cfg.pi_path).await;
        if !info.found {
            return Err(pix_error(
                "piNotFound",
                "未找到 pi。请安装：npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
            ));
        }
        // 本地 aux：`-e` 白名单是代码常量，物化后传入；provider 需要时回补 llama.cpp。
        spec.file_changes_extension = Some(materialize_file_changes()?);
        if manifest.is_some() {
            spec.workspace_extension = Some(materialize_workspace()?);
        }
        let args = rpc::aux_launch::aux_extra_args(&spec);
        let fingerprint = rpc::aux_launch::probe_fingerprint(
            info.path.as_deref().unwrap_or("unknown"),
            &rpc::aux_launch::probe_args(&spec),
            info.version.as_deref().unwrap_or("unknown"),
        );
        rpc::aux_launch::probe_local(&info, &rpc::aux_launch::probe_args(&spec), &fingerprint).await?;
        return rpc::spawn(
            app,
            &state,
            &rpc::SpawnProgram::LocalPi(info),
            &project,
            None,
            args,
            manifest,
            Some(runtime_id),
            rpc::RuntimePolicy::Aux,
        )
        .await;
    };

    spawn_aux_remote(
        app,
        &state,
        &project,
        &target,
        spec,
        workspace.is_some(),
        ssh_connection_id,
        runtime_id,
    )
    .await
}

/// 远程 aux：扩展文件不上传，因此 `-e` 白名单为空（差异卡不承诺，见规格 §1/§5）。
#[allow(clippy::too_many_arguments)]
async fn spawn_aux_remote(
    app: AppHandle,
    state: &rpc::RpcState,
    project: &str,
    target: &ssh::RemoteTarget,
    spec: rpc::aux_launch::AuxLaunchSpec,
    has_workspace: bool,
    ssh_connection_id: Option<String>,
    runtime_id: String,
) -> Result<(), String> {
    let connection = ssh::config::resolve_connection_for_target(target, ssh_connection_id.as_deref())?;
    if has_workspace {
        return Err(pix_error(
            "sshWorkspaceUnsupported",
            "SSH 远程项目暂不支持多目录工作区",
        ));
    }
    let endpoint = connection.to_remote_endpoint();
    let script = format!("test -d {}", ssh::posix_quote(target.path()));
    if let Err(e) = ssh::remote_exec(&endpoint, &script, std::time::Duration::from_secs(15)).await {
        if e.kind == SshErrorKind::Remote && e.exit_code == Some(1) {
            return Err(pix_error("projectDirMissing", "项目目录不存在"));
        }
        return Err(remote_error_coded(&endpoint, &e));
    }
    ssh::ensure_pi_available(&connection.id, &endpoint, None).await?;
    // 部署可能换掉远端 pi，探测缓存必须作废。
    rpc::aux_launch::reset_probe_cache();

    let args = rpc::aux_launch::aux_extra_args(&spec);
    let fingerprint = rpc::aux_launch::probe_fingerprint(
        endpoint.describe().as_str(),
        &rpc::aux_launch::probe_args(&spec),
        "remote",
    );
    rpc::aux_launch::probe_remote(&endpoint, target.path(), &rpc::aux_launch::probe_args(&spec), &fingerprint)
        .await?;

    let spawn_spec = rpc::RemoteSpawnSpec {
        endpoint: endpoint.clone(),
        remote_path: target.path().to_string(),
    };
    rpc::spawn(
        app,
        state,
        &rpc::SpawnProgram::Remote(spawn_spec),
        project,
        None,
        args,
        None,
        Some(runtime_id),
        rpc::RuntimePolicy::Aux,
    )
    .await?;
    let _ = ssh::config::touch_connection(&connection.id);
    Ok(())
}

fn materialize_file_changes() -> Result<std::path::PathBuf, String> {
    // `file_changes_extension_args` 返回 `["--extension", path]`。
    let args = crate::builtin_extensions::file_changes_extension_args()?;
    args.get(1)
        .map(std::path::PathBuf::from)
        .ok_or_else(|| pix_error("builtinExtensionPathMissing", "内置插件路径缺失"))
}

fn materialize_workspace() -> Result<std::path::PathBuf, String> {
    let args = crate::builtin_extensions::workspace_extension_args()?;
    args.get(1)
        .map(std::path::PathBuf::from)
        .ok_or_else(|| pix_error("builtinExtensionPathMissing", "内置插件路径缺失"))
}

