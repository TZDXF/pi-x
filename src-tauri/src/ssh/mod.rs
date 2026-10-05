//! SSH 远程传输层（P1，契约 `docs/plans/ssh-remote-p1-contracts.md`）。
//!
//! - `identity`：展示 URI 与内部身份键的构造/解析/归一化
//! - `payload`：POSIX 单引号转义与 base64 载荷通道
//! - `config`：连接配置持久化（`~/.pix/config.json` 的 `sshConnections` 字段）
//! - `transport`：`SshTransport` trait 与系统 ssh 实现
//!
//! 禁止在模块外手拼 ssh 命令或身份字符串，一律走上述模块的函数。

pub mod config;
pub mod identity;
pub mod payload;
pub mod transport;

pub use config::{SshConnection, SshConnectionInput, SshProbeInfo};
pub use identity::{
    build_ssh_uri, identity_key, is_ssh_uri, normalize_host, normalize_ssh_path,
    parse_identity_key, parse_ssh_uri, validate_user, SshTarget, DEFAULT_PORT,
    IDENTITY_KEY_PREFIX, SSH_URI_PREFIX,
};
pub use payload::{
    build_spawn_payload, encode_payload, posix_quote, wrap_payload, EXIT_CODE_CHDIR_FAILED,
    EXIT_CODE_PI_MISSING, EXIT_CODE_SDK_DIST_MISSING, PROBE_SCRIPT,
};
pub use transport::{
    build_ssh_args, build_ssh_command, classify_failure, parse_probe_output, ssh_exec,
    ssh_exec_stream, ssh_program, ssh_program_parts, split_program_spec, ExecOutput, RemoteProbe,
    SshEndpoint, SshError, SshErrorKind, SshTransport, SystemSsh, PROBE_TIMEOUT,
};
