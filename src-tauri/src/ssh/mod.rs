//! 远程传输层（P1 契约 `docs/plans/ssh-remote-p1-contracts.md` + 多后端契约
//! `docs/plans/remote-backends-contract.md`）。
//!
//! - `identity`：展示 URI 与内部身份键的构造/解析/归一化（ssh/wsl/docker 三后端）
//! - `payload`：POSIX 单引号转义与 base64 载荷通道（脚本层三后端零改动复用）
//! - `config`：连接配置持久化（`~/.pix/config.json` 的 `sshConnections` 字段，
//!   历史命名，语义已是"远程连接"，kind 字段区分 ssh/wsl/docker）
//! - `backend`：三后端统一端点 `RemoteEndpoint` 与 per-backend 本地 argv 构造
//! - `transport`：`remote_exec*` 统一传输函数（`SshError` 等结构名为历史命名，
//!   语义即"远程传输错误"）
//! - `wsl` / `docker`：枚举（wsl.exe UTF-16LE 解码、docker ps JSON 行解析）
//!   与后端错误归类
//!
//! 禁止在模块外手拼远端命令或身份字符串，一律走上述模块的函数。

pub mod backend;
pub mod config;
pub mod docker;
pub mod identity;
pub mod payload;
pub mod transport;
pub mod wsl;

// 再导出保持 `crate::ssh::<item>` 的稳定使用面；部分条目（契约冻结 API、
// P4 才启用的预留项）暂无生产调用点，对齐 `commands/mod.rs` 的既有做法统一
// `#[allow(unused_imports)]`。
#[allow(unused_imports)]
pub use backend::{
    build_remote_command, build_remote_command_interactive, docker_program, docker_program_parts,
    wsl_program, wsl_program_parts, DockerEndpoint, RemoteEndpoint, WslEndpoint,
};
#[allow(unused_imports)]
pub use config::{SshConnection, SshConnectionInput, SshProbeInfo};
#[allow(unused_imports)]
pub use identity::{
    build_docker_uri, build_remote_uri, build_ssh_uri, build_wsl_uri, docker_identity_key,
    identity_key, is_remote_uri, is_ssh_uri, normalize_host, normalize_ssh_path,
    parse_docker_identity_key, parse_docker_uri, parse_identity_key, parse_remote_uri,
    parse_ssh_uri, parse_wsl_identity_key, parse_wsl_uri, validate_docker_container,
    validate_user, validate_wsl_distro, DockerTarget, RemoteTarget, SshTarget, WslTarget,
    DEFAULT_PORT, DOCKER_IDENTITY_KEY_PREFIX, DOCKER_URI_PREFIX, IDENTITY_KEY_PREFIX,
    SSH_URI_PREFIX, WSL_IDENTITY_KEY_PREFIX, WSL_URI_PREFIX,
};
#[allow(unused_imports)]
pub use payload::{
    build_sessions_script, build_spawn_payload, encode_payload, posix_quote, wrap_payload,
    EXIT_CODE_CHDIR_FAILED, EXIT_CODE_PI_MISSING, EXIT_CODE_SDK_DIST_MISSING,
    EXIT_CODE_UPLOAD_STAGE_FAILED, EXIT_CODE_UPLOAD_WRITE_FAILED, PROBE_SCRIPT, SESSIONS_SCRIPT,
    TRUST_RUN_SCRIPT, TRUST_UPLOAD_SCRIPT,
};
#[allow(unused_imports)]
pub use transport::{
    build_ssh_args, build_ssh_args_interactive, build_ssh_command, classify_failure,
    parse_probe_output, remote_exec, remote_exec_stream, remote_exec_with_stdin, remote_probe,
    ssh_program, ssh_program_parts, split_program_spec, ExecOutput, RemoteProbe, SshEndpoint,
    SshError, SshErrorKind, SshTransport, SystemSsh, PROBE_TIMEOUT,
};
#[allow(unused_imports)]
pub use wsl::{decode_wsl_output, parse_wsl_list, WslDistroInfo};
#[allow(unused_imports)]
pub use docker::{parse_docker_ps, DockerContainerInfo};
