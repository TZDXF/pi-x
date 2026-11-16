use super::backend::RemoteEndpoint;
use super::transport::{SshError, SshErrorKind};
use super::{docker, wsl};
use crate::errors::{pix_error, pix_error_detail};

pub fn timeout_error() -> String {
    pix_error("sshTimeout", "连接超时，网络过慢或主机无响应。")
}

/// SSH 失败统一归一化为 coded error，Remote 保留 stderr 供前端插值。
pub fn ssh_error_coded(e: &SshError) -> String {
    match &e.kind {
        SshErrorKind::SshMissing => pix_error(
            "sshMissing",
            "未找到本机 ssh 客户端。Windows 可在「设置 → 应用 → 可选功能」中安装 OpenSSH 客户端。",
        ),
        SshErrorKind::HostKey => host_key_error(e),
        SshErrorKind::Auth => pix_error(
            "sshAuthFailed",
            "SSH 认证失败。请检查密码、密钥或 agent；应用重启后请重新填写密码或密钥口令。",
        ),
        SshErrorKind::Network => pix_error(
            "sshConnectFailed",
            "无法连接到远程主机，请检查主机、端口与网络。",
        ),
        SshErrorKind::Timeout => timeout_error(),
        SshErrorKind::Remote => {
            pix_error_detail("sshProbeFailed", "远程操作失败: {detail}", &e.detail)
        }
    }
}

/// 按端点类型选择一致的 coded error 归类。
pub fn remote_error_coded(endpoint: &RemoteEndpoint, e: &SshError) -> String {
    match endpoint {
        RemoteEndpoint::Ssh(_) => ssh_error_coded(e),
        RemoteEndpoint::Wsl(_) => wsl::wsl_exec_error(e),
        RemoteEndpoint::Docker(_) => docker::docker_exec_error(e),
    }
}

fn host_key_error(e: &SshError) -> String {
    if e.detail
        .to_lowercase()
        .contains("remote host identification has changed")
    {
        pix_error(
            "sshHostKeyChanged",
            "远程主机指纹与 known_hosts 记录不一致，可能是主机重装或中间人攻击。核实后在 ~/.ssh/known_hosts 中删除该主机条目再重试。",
        )
    } else {
        pix_error(
            "sshHostKeyUnverified",
            "主机指纹尚未确认。请先在终端手动 ssh 一次该主机并确认指纹，然后重试。",
        )
    }
}
