//! Docker 后端：容器枚举与错误归类（多后端契约 §4.3/§4.4）。
//!
//! 探活语义（任务书踩坑 ④）：`docker ps` 失败即区分——spawn 失败（CLI 不存在）
//! → `dockerMissing`；exit 非 0 且 stderr 小写含 `cannot connect to the docker
//! daemon` → `dockerDaemonDown`。不单独前置 `docker version` 调用。
//! stdout 逐行 JSON（`ps -a --format {{json .}}`），解析失败的行静默跳过
//! （踩坑 ⑤）；`Names` 字段取逗号前首名。容器未运行不自动 start（踩坑 ⑥）。

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::backend::docker_program_parts;
use super::transport::{SshError, SshErrorKind};
use super::wsl::{run_local_command, RawOutput};
use crate::errors::{pix_error, pix_error_detail};

/// 枚举的整体超时（契约 §4.3：15s）。
pub const DOCKER_LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// 一条容器信息（契约 §4.1）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainerInfo {
    /// json .Names（首名；逗号多网络名场景取 split(',')[0]）。
    pub name: String,
    /// json .ID（12 位短 ID）。
    pub id: String,
    /// json .Image。
    pub image: String,
    /// json .State（"running"/"exited"/…，小写原值）。
    pub state: String,
    /// json .Status（"Up 2 minutes" 等展示文本）。
    pub status: String,
}

/// `docker ps -a --format {{json .}}`（消费 `PIX_DOCKER_COMMAND` 测试钩子）。
pub async fn run_docker_ps() -> RawOutput {
    run_local_command(
        &docker_program_parts(),
        &["ps", "-a", "--format", "{{json .}}"],
        DOCKER_LIST_TIMEOUT,
    )
    .await
}

/// 任意 docker CLI 一次性命令（实机测试用：create/rm 等，独立参数不经 shell）。
/// 仅测试消费（R-B7），生产路径的 docker exec 走 `remote_exec` 统一入口。
#[cfg(test)]
pub async fn run_docker_command(args: &[&str], timeout: Duration) -> RawOutput {
    run_local_command(&docker_program_parts(), args, timeout).await
}

/// 解析 `{{json .}}` 单行；缺 `Names`/`ID` 字段或解析失败的行返回 `None`。
pub fn parse_docker_ps_line(line: &str) -> Option<DockerContainerInfo> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let name = value.get("Names")?.as_str()?.split(',').next()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    Some(DockerContainerInfo {
        name,
        id: value
            .get("ID")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        image: value
            .get("Image")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        state: value
            .get("State")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        status: value
            .get("Status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    })
}

/// 解析整个 stdout：逐行解析，失败行静默跳过（保持 docker 原顺序）。
pub fn parse_docker_ps(stdout: &str) -> Vec<DockerContainerInfo> {
    stdout.lines().filter_map(parse_docker_ps_line).collect()
}

/// 错误归类（契约 §4.4）：返回 errorKind 字符串。
/// - spawn docker 失败 → `dockerMissing`；
/// - 超时 → `timeout`（复用既有键）；
/// - stderr 含 `cannot connect to the docker daemon` → `dockerDaemonDown`（V10）；
/// - stderr 含 `no such container` → `dockerContainerNotFound`（V9）；
/// - stderr 含 `is not running` → `dockerContainerNotRunning`；
/// - 其余 → `dockerExecFailed`。
pub fn classify_docker_failure(e: &SshError) -> &'static str {
    match e.kind {
        SshErrorKind::SshMissing => return "dockerMissing",
        SshErrorKind::Timeout => return "timeout",
        _ => {}
    }
    let text = e.detail.to_lowercase();
    if text.contains("cannot connect to the docker daemon") {
        return "dockerDaemonDown";
    }
    if text.contains("no such container") {
        return "dockerContainerNotFound";
    }
    if text.contains("is not running") {
        return "dockerContainerNotRunning";
    }
    "dockerExecFailed"
}

/// coded error（契约 §4.4 文案冻结）。
pub fn docker_exec_error(e: &SshError) -> String {
    match classify_docker_failure(e) {
        "dockerMissing" => pix_error(
            "dockerMissing",
            "未找到 docker 命令。请安装并启动 Docker Desktop。",
        ),
        "timeout" => pix_error("sshTimeout", "连接超时，网络过慢或主机无响应。"),
        "dockerDaemonDown" => pix_error(
            "dockerDaemonDown",
            "Docker 守护进程未响应。请确认 Docker Desktop 已启动。",
        ),
        "dockerContainerNotFound" => pix_error(
            "dockerContainerNotFound",
            "Docker 容器不存在。请确认容器名称。",
        ),
        "dockerContainerNotRunning" => pix_error(
            "dockerContainerNotRunning",
            "容器未运行（state=exited）。请先启动该容器，PiX 不会自动启动它。",
        ),
        _ => pix_error_detail("dockerExecFailed", "Docker 命令执行失败: {detail}", &e.detail),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_docker_ps_line_extracts_first_name_and_fields() {
        let line = r#"{"Command":"sleep 1","CreatedAt":"2026-10-07 08:00:00 +0800 +08","ID":"fdc995e5a8fc","Image":"node:22-slim","Names":"pix-docker-test","Ports":[],"State":"running","Status":"Up 2 minutes"}"#;
        let info = parse_docker_ps_line(line).expect("应解析成功");
        assert_eq!(info.name, "pix-docker-test");
        assert_eq!(info.id, "fdc995e5a8fc");
        assert_eq!(info.image, "node:22-slim");
        assert_eq!(info.state, "running");
        assert_eq!(info.status, "Up 2 minutes");

        // 多网络名（逗号分隔）取首名。
        let line = r#"{"ID":"aabbccddeeff","Image":"alpine","Names":"net-alias,other-name","State":"exited","Status":"Exited (0) 5 minutes ago"}"#;
        let info = parse_docker_ps_line(line).unwrap();
        assert_eq!(info.name, "net-alias");
        assert_eq!(info.state, "exited");
    }

    #[test]
    fn parse_docker_ps_skips_unparseable_lines_silently() {
        let stdout = concat!(
            "CONTAINER ID   IMAGE   COMMAND   CREATED   STATUS   NAMES\n",
            r#"{"ID":"a1","Image":"img1","Names":"one","State":"running","Status":"Up"}"#,
            "\n",
            "not json at all\n",
            r#"{"ID":"a2","Image":"img2","Names":"two","State":"exited","Status":"Exited"}"#,
            "\n",
            // 缺 Names 字段 → 跳过。
            r#"{"ID":"a3","Image":"img3","State":"running"}"#,
            "\n",
        );
        let containers = parse_docker_ps(stdout);
        let names: Vec<&str> = containers.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["one", "two"]);
        assert!(parse_docker_ps("").is_empty());
    }

    #[test]
    fn classify_docker_failure_follows_contract_keywords() {
        let e = |kind, exit, detail: &str| SshError {
            kind,
            exit_code: exit,
            detail: detail.to_string(),
        };
        // V10：daemon 未应答。
        assert_eq!(
            classify_docker_failure(&e(
                SshErrorKind::Remote,
                Some(1),
                "error during connect: error while mounting volume: Cannot connect to the Docker daemon at unix:///var/run/docker.sock"
            )),
            "dockerDaemonDown"
        );
        // V9：容器不存在。
        assert_eq!(
            classify_docker_failure(&e(
                SshErrorKind::Remote,
                Some(1),
                "Error response from daemon: No such container: no-such-container-xyz"
            )),
            "dockerContainerNotFound"
        );
        // 容器未运行。
        assert_eq!(
            classify_docker_failure(&e(
                SshErrorKind::Remote,
                Some(1),
                "Error response from daemon: Container fdc995e5a8fc is not running"
            )),
            "dockerContainerNotRunning"
        );
        assert_eq!(
            classify_docker_failure(&e(SshErrorKind::SshMissing, None, "no docker")),
            "dockerMissing"
        );
        assert_eq!(
            classify_docker_failure(&e(SshErrorKind::Timeout, None, "timed out")),
            "timeout"
        );
        assert_eq!(
            classify_docker_failure(&e(SshErrorKind::Remote, Some(3), "boom")),
            "dockerExecFailed"
        );
    }

    #[test]
    fn docker_exec_error_maps_to_contract_coded_errors() {
        let e = |detail: &str| SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(1),
            detail: detail.to_string(),
        };
        for (detail, code) in [
            ("Cannot connect to the Docker daemon", "dockerDaemonDown"),
            ("No such container: xyz", "dockerContainerNotFound"),
            ("Container xyz is not running", "dockerContainerNotRunning"),
        ] {
            let coded = docker_exec_error(&e(detail));
            assert!(coded.starts_with("PIXERR:"), "{coded}");
            assert!(coded.contains(code), "{code} not in {coded}");
        }
        assert!(docker_exec_error(&e("boom")).contains("dockerExecFailed"));
        assert!(docker_exec_error(&SshError::new(SshErrorKind::SshMissing, "x")).contains("dockerMissing"));
    }
}
