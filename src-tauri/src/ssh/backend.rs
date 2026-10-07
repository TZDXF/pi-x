//! 多后端传输泛化（契约 `docs/plans/remote-backends-contract.md` §1）。
//!
//! 三后端（SSH / WSL / Docker）共用同一套远端脚本层（`payload.rs` 的
//! probe/sessions/trust/spawn 载荷，POSIX shell + base64 通道，零改动复用），
//! 泛化边界只在「如何把 `<wrapped 命令>` 变成本地 argv」：
//!
//! | 后端 | 本地 argv |
//! | --- | --- |
//! | SSH | `ssh_program_parts()` + `build_ssh_args(endpoint)` + `[wrapped]` |
//! | WSL | `wsl_program_parts()` + `["-d", <distro>]`（+ `["-u", <user>]` 仅配置 user 时）+ `["--exec", "/bin/sh", "-c", wrapped]` |
//! | Docker | `docker_program_parts()` + `["exec", "-i", <container>, "/bin/sh", "-c", wrapped]` |
//!
//! WSL 必须用 `--exec`（而非 `--` + 登录 shell）：`wsl.exe --` 会把其后 argv
//! 以空格拼接、经发行版默认 shell 二次解析，多词命令被拆散（V2 实测）；
//! `--exec` 形态 argv 原样直达、stdin 转发正常（V3 实测）。外层 `/bin/sh -c`
//! 不用 `bash -lc`：避免 profile source 拖慢高频 exec 与 banner 污染面
//! （契约 §1.2）。本地一律独立参数传给 `tokio::process::Command`，绝不拼接 shell。
//!
//! 测试钩子：`PIX_WSL_COMMAND` / `PIX_DOCKER_COMMAND` 语义与 `PIX_SSH_COMMAND`
//! 逐字一致（`program` 或 `program arg1 arg2 …`，ASCII 空白切分，首段为程序，
//! 其余为前置参数），注入 mock 后三后端全链路均可无网络跑通。

use super::transport::{build_ssh_args_interactive, split_program_spec, SshEndpoint};

/// WSL 端点：发行版名（大小写保留）与可选用户（None = 发行版默认用户）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WslEndpoint {
    pub distro: String,
    pub user: Option<String>,
}

/// Docker 端点：容器名或短 ID（保留输入原样，不做归一化）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DockerEndpoint {
    pub container: String,
}

/// 三后端统一端点。`SshEndpoint` 结构不变（transport.rs）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RemoteEndpoint {
    Ssh(SshEndpoint),
    Wsl(WslEndpoint),
    Docker(DockerEndpoint),
}

impl RemoteEndpoint {
    /// 日志用的端点摘要（不含凭据）。
    pub fn describe(&self) -> String {
        match self {
            RemoteEndpoint::Ssh(ep) => format!(
                "{}@{}:{}",
                ep.user.as_deref().unwrap_or(""),
                ep.host,
                ep.port
            ),
            RemoteEndpoint::Wsl(ep) => match &ep.user {
                Some(user) => format!("{}/{}", ep.distro, user),
                None => ep.distro.clone(),
            },
            RemoteEndpoint::Docker(ep) => ep.container.clone(),
        }
    }
}

/// 读取 `PIX_WSL_COMMAND`（整体替换 wsl.exe），缺省 `wsl.exe`。
pub fn wsl_program() -> String {
    std::env::var("PIX_WSL_COMMAND").unwrap_or_else(|_| "wsl.exe".to_string())
}

/// 读取 `PIX_DOCKER_COMMAND`（整体替换 docker CLI），缺省 `docker`。
/// Windows 上缺省带 `.exe`：portable-pty 的 PATH 探测不自动补扩展名，
/// 会命中 Docker Desktop bin 目录下的同名 shell 脚本而非 docker.exe
///（实机发现：CreateProcessW os error 193）。
pub fn docker_program() -> String {
    std::env::var("PIX_DOCKER_COMMAND").unwrap_or_else(|_| docker_program_default().to_string())
}

fn docker_program_default() -> &'static str {
    if cfg!(windows) {
        "docker.exe"
    } else {
        "docker"
    }
}

/// 当前生效的 wsl.exe 程序与前置参数（`PIX_WSL_COMMAND` 注入点）。
/// 空值回退为缺省程序（`split_program_spec` 的空值回退是 ssh 专用语义）。
pub fn wsl_program_parts() -> Vec<String> {
    split_program_spec_with_default(&wsl_program(), "wsl.exe")
}

/// 当前生效的 docker 程序与前置参数（`PIX_DOCKER_COMMAND` 注入点）。
pub fn docker_program_parts() -> Vec<String> {
    split_program_spec_with_default(&docker_program(), docker_program_default())
}

fn split_program_spec_with_default(spec: &str, default: &str) -> Vec<String> {
    if spec.trim().is_empty() {
        vec![default.to_string()]
    } else {
        split_program_spec(spec)
    }
}

/// 纯函数：完整本地命令 `(程序, 参数数组)`（契约 §1.2 表）。
/// 远端命令恒为最后一个 argv 元素（SSH）或最后的 `-c` 参数（WSL/Docker）。
pub fn build_remote_command(endpoint: &RemoteEndpoint, remote_command: &str) -> (String, Vec<String>) {
    match endpoint {
        RemoteEndpoint::Ssh(ep) => super::transport::build_ssh_command(ep, remote_command),
        RemoteEndpoint::Wsl(ep) => {
            let parts = wsl_program_parts();
            let mut args: Vec<String> = parts[1..].to_vec();
            args.push("-d".to_string());
            args.push(ep.distro.clone());
            if let Some(user) = &ep.user {
                args.push("-u".to_string());
                args.push(user.clone());
            }
            args.push("--exec".to_string());
            args.push("/bin/sh".to_string());
            args.push("-c".to_string());
            args.push(remote_command.to_string());
            (parts[0].clone(), args)
        }
        RemoteEndpoint::Docker(ep) => {
            let parts = docker_program_parts();
            let mut args: Vec<String> = parts[1..].to_vec();
            args.push("exec".to_string());
            args.push("-i".to_string());
            args.push(ep.container.clone());
            args.push("/bin/sh".to_string());
            args.push("-c".to_string());
            args.push(remote_command.to_string());
            (parts[0].clone(), args)
        }
    }
}

/// 纯函数：交互终端分支的完整本地命令（契约 §1.2/§5.3）。
/// SSH 用 `build_ssh_args_interactive`（`-tt`、无 BatchMode）；WSL 与 exec
/// 形态相同（wsl.exe 无 BatchMode 概念，`--exec` 直达，ConPTY 由 wsl.exe
/// 中继）；Docker 仅把 `-i` 换成 `-it`（daemon 侧分配 PTY）。
pub fn build_remote_command_interactive(
    endpoint: &RemoteEndpoint,
    remote_command: &str,
) -> (String, Vec<String>) {
    match endpoint {
        RemoteEndpoint::Ssh(ep) => {
            let parts = super::transport::ssh_program_parts();
            let mut args: Vec<String> = parts[1..].to_vec();
            args.extend(build_ssh_args_interactive(ep));
            args.push(remote_command.to_string());
            (parts[0].clone(), args)
        }
        RemoteEndpoint::Wsl(_) => build_remote_command(endpoint, remote_command),
        RemoteEndpoint::Docker(ep) => {
            let parts = docker_program_parts();
            let mut args: Vec<String> = parts[1..].to_vec();
            args.push("exec".to_string());
            args.push("-it".to_string());
            args.push(ep.container.clone());
            args.push("/bin/sh".to_string());
            args.push("-c".to_string());
            args.push(remote_command.to_string());
            (parts[0].clone(), args)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::transport::env_lock;

    fn ssh_endpoint() -> SshEndpoint {
        SshEndpoint {
            host: "host.example.com".to_string(),
            port: 2222,
            user: Some("dev".to_string()),
            key_path: None,
        }
    }

    #[test]
    fn ssh_branch_matches_legacy_build_ssh_command() {
        // ssh_program_parts 读进程级环境变量，与其它注入测试串行。
        let _guard = env_lock();
        let endpoint = RemoteEndpoint::Ssh(ssh_endpoint());
        let (program, args) = build_remote_command(&endpoint, "wrapped");
        assert_eq!(program, "ssh");
        // BatchMode 等 ssh 参数在 transport.rs 的单测覆盖，这里断言分流形状。
        assert!(args.contains(&"dev@host.example.com".to_string()));
        assert_eq!(args.last().map(String::as_str), Some("wrapped"));
        let (interactive_program, interactive_args) =
            build_remote_command_interactive(&endpoint, "wrapped");
        assert_eq!(interactive_program, "ssh");
        assert!(!interactive_args.contains(&"BatchMode=yes".to_string()));
        assert!(interactive_args.contains(&"-tt".to_string()));
        assert_eq!(interactive_args.last().map(String::as_str), Some("wrapped"));
    }

    #[test]
    fn wsl_branch_uses_exec_form_and_optional_user() {
        let _guard = env_lock();
        std::env::remove_var("PIX_WSL_COMMAND");
        let endpoint = RemoteEndpoint::Wsl(WslEndpoint {
            distro: "Ubuntu".to_string(),
            user: None,
        });
        let (program, args) = build_remote_command(&endpoint, "WRAPPED");
        std::env::remove_var("PIX_WSL_COMMAND");
        assert_eq!(program, "wsl.exe");
        assert_eq!(
            args,
            vec![
                "-d".to_string(),
                "Ubuntu".to_string(),
                "--exec".to_string(),
                "/bin/sh".to_string(),
                "-c".to_string(),
                "WRAPPED".to_string(),
            ]
        );
        // 交互分支与 exec 形态相同（契约 §1.2）。
        let (iprogram, iargs) = build_remote_command_interactive(&endpoint, "WRAPPED");
        assert_eq!(iprogram, "wsl.exe");
        assert_eq!(iargs, args);

        // 配置 user 时追加 -u。
        let with_user = RemoteEndpoint::Wsl(WslEndpoint {
            distro: "Ubuntu-22.04".to_string(),
            user: Some("tzdxf".to_string()),
        });
        let (_, args) = build_remote_command(&with_user, "WRAPPED");
        assert_eq!(
            args[..6],
            ["-d", "Ubuntu-22.04", "-u", "tzdxf", "--exec", "/bin/sh"]
        );
        assert_eq!(args[6], "-c");
        assert_eq!(args.last().map(String::as_str), Some("WRAPPED"));
    }

    #[test]
    fn docker_branch_uses_exec_i_and_interactive_swaps_to_it() {
        let _guard = env_lock();
        std::env::remove_var("PIX_DOCKER_COMMAND");
        let endpoint = RemoteEndpoint::Docker(DockerEndpoint {
            container: "pix-docker-test".to_string(),
        });
        let (program, args) = build_remote_command(&endpoint, "WRAPPED");
        std::env::remove_var("PIX_DOCKER_COMMAND");
        // Windows 缺省 docker.exe（portable-pty 不自动补扩展名，见 docker_program 注释）。
        assert_eq!(program, if cfg!(windows) { "docker.exe" } else { "docker" });
        assert_eq!(
            args,
            vec![
                "exec".to_string(),
                "-i".to_string(),
                "pix-docker-test".to_string(),
                "/bin/sh".to_string(),
                "-c".to_string(),
                "WRAPPED".to_string(),
            ]
        );
        let (_, iargs) = build_remote_command_interactive(&endpoint, "WRAPPED");
        assert_eq!(
            iargs[..2],
            ["exec".to_string(), "-it".to_string()]
        );
        assert_eq!(iargs.last().map(String::as_str), Some("WRAPPED"));
    }

    #[test]
    fn pix_wsl_and_docker_commands_inject_prefix_args() {
        let _guard = env_lock();
        std::env::set_var("PIX_WSL_COMMAND", "mock-wsl   --vmlinux\t-v");
        std::env::set_var("PIX_DOCKER_COMMAND", "mock-docker -H unix:///sock");
        let wsl = wsl_program_parts();
        let docker = docker_program_parts();
        // 前置参数插入最前，远端命令是最后一个 -c 参数（变量仍注入时构造）。
        let endpoint = RemoteEndpoint::Docker(DockerEndpoint {
            container: "c".to_string(),
        });
        let (program, args) = build_remote_command(&endpoint, "WRAPPED");
        std::env::remove_var("PIX_WSL_COMMAND");
        std::env::remove_var("PIX_DOCKER_COMMAND");
        assert_eq!(
            wsl,
            vec![
                "mock-wsl".to_string(),
                "--vmlinux".to_string(),
                "-v".to_string(),
            ]
        );
        assert_eq!(
            docker,
            vec![
                "mock-docker".to_string(),
                "-H".to_string(),
                "unix:///sock".to_string(),
            ]
        );
        assert_eq!(program, "mock-docker");
        assert_eq!(args.first().map(String::as_str), Some("-H"));
        assert_eq!(args.last().map(String::as_str), Some("WRAPPED"));
    }

    #[test]
    fn program_defaults_and_empty_spec_fallback() {
        let _guard = env_lock();
        std::env::remove_var("PIX_WSL_COMMAND");
        std::env::remove_var("PIX_DOCKER_COMMAND");
        assert_eq!(wsl_program(), "wsl.exe");
        assert_eq!(docker_program(), if cfg!(windows) { "docker.exe" } else { "docker" });
        // 空注入值回退为缺省程序，而非 ssh（split_program_spec 的回退语义）。
        std::env::set_var("PIX_WSL_COMMAND", "   ");
        assert_eq!(wsl_program_parts(), vec!["wsl.exe".to_string()]);
        std::env::remove_var("PIX_WSL_COMMAND");
    }

    #[test]
    fn describe_summarizes_endpoints_without_secrets() {
        assert_eq!(
            RemoteEndpoint::Ssh(ssh_endpoint()).describe(),
            "dev@host.example.com:2222"
        );
        assert_eq!(
            RemoteEndpoint::Wsl(WslEndpoint {
                distro: "Ubuntu".into(),
                user: None,
            })
            .describe(),
            "Ubuntu"
        );
        assert_eq!(
            RemoteEndpoint::Docker(DockerEndpoint {
                container: "pix-docker-test".into(),
            })
            .describe(),
            "pix-docker-test"
        );
    }
}

// ---- WSL / Docker 实机集成测试（多后端契约 §6，后端组 R-B1~R-B8）。
// 运行：
//   cargo test wsl_real -- --ignored    （PIX_WSL_TEST_DISTRO / PIX_WSL_TEST_PROJECT）
//   cargo test docker_real -- --ignored （PIX_DOCKER_TEST_CONTAINER / PIX_DOCKER_TEST_PROJECT）
// 环境变量任一缺失则 eprintln! 后跳过；Git Bash 下运行须加
// MSYS_NO_PATHCONV=1 MSYS2_ENV_CONV_EXCL='PIX_'（wsl-test-env.md）。
// 只允许访问本机 WSL Ubuntu 与容器 pix-docker-test，禁止其它真实网络。

#[cfg(test)]
mod remote_real_tests {
    use super::*;
    use crate::ssh::docker;
    use crate::ssh::identity::normalize_ssh_path;
    use crate::ssh::payload::{build_spawn_payload, posix_quote};
    use crate::ssh::transport::{
        remote_exec, remote_exec_stream, remote_exec_with_stdin, remote_probe, ssh_real_lock,
        SshErrorKind,
    };
    use serde_json::Value;
    use std::time::{Duration, Instant};
    use tokio::io::AsyncBufReadExt;

    /// 实机端点 + 项目路径；环境变量任一缺失则返回 None（用例跳过）。
    fn real_env(distro_env: &str, container_env: &str, project_env: &str) -> Option<(RemoteEndpoint, String)> {
        let read = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        if let (Some(distro), Some(project)) = (read(distro_env), read(project_env)) {
            return Some((
                RemoteEndpoint::Wsl(WslEndpoint { distro, user: None }),
                project,
            ));
        }
        if let (Some(container), Some(project)) = (read(container_env), read(project_env)) {
            return Some((RemoteEndpoint::Docker(DockerEndpoint { container }), project));
        }
        eprintln!("跳过实机测试：缺少 {distro_env}/{container_env}/{project_env}");
        None
    }

    fn wsl_env() -> Option<(RemoteEndpoint, String)> {
        real_env("PIX_WSL_TEST_DISTRO", "PIX_DOCKER_TEST_CONTAINER", "PIX_WSL_TEST_PROJECT")
    }

    fn docker_env() -> Option<(RemoteEndpoint, String)> {
        real_env("PIX_WSL_TEST_DISTRO", "PIX_DOCKER_TEST_CONTAINER", "PIX_DOCKER_TEST_PROJECT")
    }

    /// R-B2：`test -d` 存在目录 → Ok；不存在路径 → Err(Remote, exit 1)
    ///（→ spawn_remote 的 projectDirMissing 路径，多后端契约 §6 R-B2）。
    async fn real_case_test_dir(endpoint: &RemoteEndpoint, project: &str) {
        let script = format!("test -d {}", posix_quote(project));
        let output = remote_exec(endpoint, &script, Duration::from_secs(15))
            .await
            .unwrap_or_else(|e| panic!("test -d {project} 应成功: {e:?}"));
        assert_eq!(output.exit_code, 0);

        let missing = format!("{}/PIX_TEST_missing_{}", project.trim_end_matches('/'), uuid::Uuid::new_v4());
        let script = format!("test -d {}", posix_quote(&missing));
        let err = remote_exec(endpoint, &script, Duration::from_secs(15))
            .await
            .err()
            .expect("不存在的目录应失败");
        assert_eq!(err.kind, SshErrorKind::Remote);
        assert_eq!(err.exit_code, Some(1), "exit 1 → projectDirMissing 路径: {err:?}");
    }

    /// R-B3：脚本 `exit 7` → exit_code == 7（退出码传播，V4 回归）。
    async fn real_case_exit_code(endpoint: &RemoteEndpoint) {
        let err = remote_exec(endpoint, "exit 7\n", Duration::from_secs(15))
            .await
            .err()
            .expect("exit 7 应产生 Err");
        assert_eq!(err.exit_code, Some(7), "{err:?}");
    }

    /// R-B1：P1 §3.5 spawn payload 原文经 exec 投递，stdin 写 get_state →
    /// stdout 首个 JSON 行 success:true、stderr 含 PIX_PI_PID=
    ///（脚本层零改动的最终背书）。
    async fn real_case_spawn_get_state(endpoint: &RemoteEndpoint, project: &str) {
        let payload = build_spawn_payload(project, None, &[]);
        let output = remote_exec_with_stdin(
            endpoint,
            &payload,
            b"{\"type\":\"get_state\",\"id\":1}\n",
            Duration::from_secs(45),
        )
        .await
        .unwrap_or_else(|e| panic!("spawn payload exec 应成功: {e:?}"));
        let first_json = output
            .stdout
            .lines()
            .find_map(|line| serde_json::from_str::<Value>(line).ok())
            .expect("stdout 应含至少一行 JSON");
        assert_eq!(first_json["success"], true, "首个 JSON 行应 success:true: {first_json}");
        assert!(
            output.stderr.contains("PIX_PI_PID="),
            "stderr 应含 PIX_PI_PID=（实际 {}）",
            output.stderr
        );
    }

    /// R-B8：probe 脚本 + parse_probe_output → piFound:true、piVersion 非空。
    async fn real_case_probe(endpoint: &RemoteEndpoint) {
        let probe = remote_probe(endpoint)
            .await
            .unwrap_or_else(|e| panic!("probe 应成功: {e:?}"));
        assert!(probe.pi_found, "远端应已安装 pi: {probe:?}");
        assert!(
            probe.pi_version.as_deref().unwrap_or_default().starts_with('1'),
            "piVersion 应非空且为 1.x: {probe:?}"
        );
        assert_eq!(probe.uname.as_deref(), Some("Linux"));
    }

    /// R-B6：spawn payload 变体 `exec sleep 60` → 读 PIX_PI_PID →
    /// `kill -TERM <pid>` → 流在 5s 内 EOF（kill 兜底对 wsl/docker 生效；
    /// 不触碰 distro/容器生命周期）。
    async fn real_case_kill_remote_pid_eofs_stream(endpoint: &RemoteEndpoint) {
        let script = "echo \"PIX_PI_PID=$$\" >&2\nexec sleep 60\n";
        let mut child = remote_exec_stream(endpoint, script)
            .await
            .unwrap_or_else(|e| panic!("stream spawn 应成功: {e:?}"));
        let stderr = child.stderr.take().expect("stderr piped");
        let stdout = child.stdout.take().expect("stdout piped");
        let mut lines = tokio::io::BufReader::new(stderr).lines();
        let mut pid: Option<u32> = None;
        let deadline = Instant::now() + Duration::from_secs(15);
        while pid.is_none() {
            let line = tokio::time::timeout(Duration::from_secs(2), lines.next_line())
                .await
                .expect("等待 stderr 行超时")
                .expect("stderr 读取失败")
                .unwrap_or_default();
            if let Some(value) = line.strip_prefix("PIX_PI_PID=") {
                pid = value.trim().parse::<u32>().ok();
            }
            assert!(Instant::now() < deadline, "15s 内未读到 PIX_PI_PID=");
        }
        let pid = pid.expect("pid 已读到");
        // kill 兜底路径：与 rpc/child.rs kill_inner 同一脚本文本。
        let kill_script = format!("kill -TERM {pid} 2>/dev/null\n");
        let kill = remote_exec(endpoint, &kill_script, Duration::from_secs(5)).await;
        if let Err(e) = kill {
            eprintln!("kill -TERM 返回错误（忽略，仅日志语义）: {e:?}");
        }
        // 流应在 5s 内 EOF。
        let eof = tokio::time::timeout(Duration::from_secs(5), async {
            let mut stdout = stdout;
            let mut buf = Vec::new();
            let _ = tokio::io::AsyncReadExt::read_to_end(&mut stdout, &mut buf).await;
        })
        .await;
        assert!(eof.is_ok(), "kill 后流应在 5s 内 EOF");
    }

    /// 会话扫描（多后端契约 §5.2：SESSIONS_SCRIPT 三后端零改动）。
    async fn real_case_sessions_scan(endpoint: &RemoteEndpoint, project: &str) {
        let metas = crate::ssh_sessions::scan_remote_sessions(endpoint, project)
            .await
            .unwrap_or_else(|e| panic!("会话扫描应成功: {e}"));
        // 项目目录可能尚无会话；断言命令链路与解析成功即可。
        assert!(metas.len() <= 50);
    }

    // ---- wsl_real 组 ----

    /// R-B2 + R-B3（wsl_real）。
    #[tokio::test]
    #[ignore]
    async fn wsl_real_remote_exec_test_dir_and_exit_code() {
        let Some((endpoint, project)) = wsl_env() else { return };
        let _serial = ssh_real_lock();
        real_case_test_dir(&endpoint, &project).await;
        real_case_exit_code(&endpoint).await;
    }

    /// R-B1（wsl_real）：spawn payload + get_state JSONL 往返。
    #[tokio::test]
    #[ignore]
    async fn wsl_real_spawn_get_state_jsonl_roundtrip() {
        let Some((endpoint, project)) = wsl_env() else { return };
        let _serial = ssh_real_lock();
        real_case_spawn_get_state(&endpoint, &project).await;
    }

    /// R-B4（wsl_real）：`wsl_distro_list` 实机——含测试发行版、state 非空。
    #[tokio::test]
    #[ignore]
    async fn wsl_real_distro_list_contains_test_distro() {
        let Some(distro) = std::env::var("PIX_WSL_TEST_DISTRO").ok().filter(|v| !v.trim().is_empty()) else {
            eprintln!("跳过实机测试：缺少 PIX_WSL_TEST_DISTRO");
            return;
        };
        let _serial = ssh_real_lock();
        let result = crate::commands::ssh::wsl_distro_list()
            .await
            .expect("wsl_distro_list 命令应成功");
        assert!(result.available, "枚举应可用: {result:?}");
        let found = result
            .distros
            .iter()
            .find(|d| d.name == distro)
            .unwrap_or_else(|| panic!("应含 {distro}: {:?}", result.distros));
        assert!(!found.state.is_empty(), "state 应非空: {found:?}");
        assert!(
            found.version == 1 || found.version == 2,
            "version 应为 1|2: {found:?}"
        );
        // isDefault 与 `wsl -l -v` 的 `*` 行一致：default 全列表恰为 0 或 1 个，
        // 且解析无 panic（结构由 parse_wsl_list 单测保证）。
        let defaults = result.distros.iter().filter(|d| d.is_default).count();
        assert!(defaults <= 1, "default 行至多一个: {result:?}");
    }

    /// R-B6（wsl_real）：kill 兜底。
    #[tokio::test]
    #[ignore]
    async fn wsl_real_kill_remote_pid_eofs_stream() {
        let Some((endpoint, _project)) = wsl_env() else { return };
        let _serial = ssh_real_lock();
        real_case_kill_remote_pid_eofs_stream(&endpoint).await;
    }

    /// R-B8（wsl_real）：probe。
    #[tokio::test]
    #[ignore]
    async fn wsl_real_probe_finds_pi() {
        let Some((endpoint, _project)) = wsl_env() else { return };
        let _serial = ssh_real_lock();
        real_case_probe(&endpoint).await;
    }

    /// 会话扫描（wsl_real）。
    #[tokio::test]
    #[ignore]
    async fn wsl_real_sessions_scan_succeeds() {
        let Some((endpoint, project)) = wsl_env() else { return };
        let _serial = ssh_real_lock();
        real_case_sessions_scan(&endpoint, &project).await;
    }

    // ---- docker_real 组 ----

    /// R-B2 + R-B3（docker_real）。
    #[tokio::test]
    #[ignore]
    async fn docker_real_remote_exec_test_dir_and_exit_code() {
        let Some((endpoint, project)) = docker_env() else { return };
        let _serial = ssh_real_lock();
        real_case_test_dir(&endpoint, &project).await;
        real_case_exit_code(&endpoint).await;
    }

    /// R-B1（docker_real）：spawn payload + get_state JSONL 往返。
    #[tokio::test]
    #[ignore]
    async fn docker_real_spawn_get_state_jsonl_roundtrip() {
        let Some((endpoint, project)) = docker_env() else { return };
        let _serial = ssh_real_lock();
        real_case_spawn_get_state(&endpoint, &project).await;
    }

    /// R-B5（docker_real）：`docker_container_list` 实机——含测试容器、
    /// image node:22-slim、state running。
    #[tokio::test]
    #[ignore]
    async fn docker_real_container_list_contains_test_container() {
        let Some(container) = std::env::var("PIX_DOCKER_TEST_CONTAINER").ok().filter(|v| !v.trim().is_empty()) else {
            eprintln!("跳过实机测试：缺少 PIX_DOCKER_TEST_CONTAINER");
            return;
        };
        let _serial = ssh_real_lock();
        let result = crate::commands::ssh::docker_container_list()
            .await
            .expect("docker_container_list 命令应成功");
        assert!(result.available, "枚举应可用: {result:?}");
        let found = result
            .containers
            .iter()
            .find(|c| c.name == container)
            .unwrap_or_else(|| panic!("应含 {container}: {:?}", result.containers));
        assert_eq!(found.image, "node:22-slim", "{found:?}");
        assert_eq!(found.state, "running", "{found:?}");
    }

    /// R-B7（docker_real）：对未运行容器 exec → coded error
    /// `dockerContainerNotRunning`（不自动 start 的回归）。
    /// 用本地已有镜像 node:22-slim 创建 stopped 容器（禁止拉取外部镜像），
    /// 用例尾 `docker rm -f` 清理。
    #[tokio::test]
    #[ignore]
    async fn docker_real_stopped_container_exec_reports_not_running() {
        let Some((_endpoint, _project)) = docker_env() else { return };
        let _serial = ssh_real_lock();
        let name = format!("pix-test-stopped-{}", uuid::Uuid::new_v4().simple());
        let create = docker::run_docker_command(
            &["create", "--name", &name, "node:22-slim"],
            Duration::from_secs(30),
        )
        .await;
        assert_eq!(
            create.exit_code,
            Some(0),
            "create 应成功（需本地已有 node:22-slim 镜像，禁止拉取外部镜像）: stdout={} stderr={}",
            String::from_utf8_lossy(&create.stdout),
            String::from_utf8_lossy(&create.stderr),
        );
        let stopped = RemoteEndpoint::Docker(DockerEndpoint {
            container: name.clone(),
        });
        let err = remote_exec(&stopped, "true\n", Duration::from_secs(15))
            .await
            .err()
            .expect("对未运行容器 exec 应失败");
        let coded = docker::docker_exec_error(&err);
        assert!(
            coded.contains("dockerContainerNotRunning"),
            "应归类为 dockerContainerNotRunning: {coded}"
        );
        // 用例尾清理。
        let rm = docker::run_docker_command(&["rm", "-f", &name], Duration::from_secs(30)).await;
        assert_eq!(rm.exit_code, Some(0), "清理容器 {name} 应成功");
    }

    /// R-B6（docker_real）：kill 兜底。
    #[tokio::test]
    #[ignore]
    async fn docker_real_kill_remote_pid_eofs_stream() {
        let Some((endpoint, _project)) = docker_env() else { return };
        let _serial = ssh_real_lock();
        real_case_kill_remote_pid_eofs_stream(&endpoint).await;
    }

    /// R-B8（docker_real）：probe。
    #[tokio::test]
    #[ignore]
    async fn docker_real_probe_finds_pi() {
        let Some((endpoint, _project)) = docker_env() else { return };
        let _serial = ssh_real_lock();
        real_case_probe(&endpoint).await;
    }

    /// 会话扫描（docker_real）。
    #[tokio::test]
    #[ignore]
    async fn docker_real_sessions_scan_succeeds() {
        let Some((endpoint, project)) = docker_env() else { return };
        let _serial = ssh_real_lock();
        real_case_sessions_scan(&endpoint, &project).await;
    }

    /// 身份键与端点装配的实机一致性（多后端契约 §2.4 抽查）：测试项目路径
    /// 可经 normalize_ssh_path 归一化且 wsl/docker URI 可解析回同一 path。
    #[tokio::test]
    #[ignore]
    async fn wsl_real_identity_uri_matches_project_path() {
        let Some((endpoint, project)) = wsl_env() else { return };
        let _serial = ssh_real_lock();
        let normalized = normalize_ssh_path(&project).expect("测试项目路径应可归一化");
        let RemoteEndpoint::Wsl(ep) = &endpoint else {
            panic!("应为 WSL 端点");
        };
        let uri = format!("wsl://{}{normalized}", ep.distro);
        let target = crate::ssh::parse_wsl_uri(&uri).expect("wsl URI 应可解析");
        assert_eq!(target.path, normalized);
        assert_eq!(target.distro, ep.distro);
    }
}
