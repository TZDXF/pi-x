//! 远程项目会话列表（契约 `docs/plans/ssh-remote-p2-contracts.md` §2）。
//!
//! 单次 ssh exec 扫描远端 `~/.pi/agent/sessions/` 元数据：远端脚本
//! （[`ssh::payload::SESSIONS_SCRIPT`]）输出 `PIX_SESSION_*` 标签行并以
//! `PIX_SESSIONS_DONE` 收尾，本模块解析为 [`crate::sessions::SessionMeta`]
//! （前端类型零改动消费）。本地会话命令（`sessions.rs`）零改动。

use std::time::Duration;

use serde_json::Value;

use crate::errors::pix_error_detail;
use crate::sessions::SessionMeta;
use crate::ssh::transport::{ssh_exec, SshEndpoint};
use crate::ssh::payload;

/// exec 超时（契约 P2 §2.1：20s）。
const SESSIONS_EXEC_TIMEOUT: Duration = Duration::from_secs(20);
/// 返回条数上限（对齐本地 `sessions::MAX_SESSIONS`）。
const MAX_SESSIONS: usize = 50;

/// 远程项目会话列表。`project` 为 `ssh://` 展示 URI，`sshConnectionId` 为
/// 连接 id（与 `rpc_spawn` 的 sshConnectionId 同源，连接细节的唯一权威来源）。
/// 返回类型复用 `sessions::SessionMeta`；校验链对齐 `spawn_remote`
/// （parse/mismatch/notFound/missing，见 `commands::ssh::resolve_ssh_connection`）。
#[tauri::command]
pub async fn ssh_sessions(
    project: String,
    ssh_connection_id: String,
) -> Result<Vec<SessionMeta>, String> {
    let (target, connection) =
        crate::commands::ssh::resolve_ssh_connection(&project, &ssh_connection_id)?;
    scan_remote_sessions(&connection.to_endpoint(), &target.path).await
}

/// 扫描 + 解析：命令实现与实机集成测试（S-R2）共用的入口。
pub(crate) async fn scan_remote_sessions(
    endpoint: &SshEndpoint,
    project_path: &str,
) -> Result<Vec<SessionMeta>, String> {
    let script = payload::build_sessions_script(project_path);
    let output = ssh_exec(endpoint, &script, SESSIONS_EXEC_TIMEOUT)
        .await
        .map_err(|e| crate::commands::ssh::ssh_error_coded(&e))?;
    parse_sessions_output(&output.stdout, project_path).ok_or_else(|| {
        // 扫描成功但 DONE 标记缺失（超时/截断）→ coded error（契约 P2 §2.1）。
        pix_error_detail(
            "sshRemoteFailed",
            "远程操作失败: {detail}",
            "扫描输出缺少完成标记 PIX_SESSIONS_DONE",
        )
    })
}

/// 远端单个会话文件的标签行原始记录。
#[derive(Debug, Default)]
struct RawSessionRecord {
    file: String,
    mtime_s: u64,
    header_line: Option<String>,
    title_line: Option<String>,
}

/// 解析扫描输出：逐行 `split_once('=')`，仅认 `PIX_SESSION_*` 前缀标签行，
/// 其余（banner/motd）静默忽略（同 `parse_probe_output` 模式）；读到
/// `PIX_SESSIONS_DONE` 才返回结果（缺失 → `None`，由调用方报错）。
/// cwd 过滤 = 会话头 cwd 与 URI 路径或 `pwd -P` 物理路径任一相等，
/// 防别名路径把会话滤空；输出按 mtimeMs 降序、上限 50。
fn parse_sessions_output(stdout: &str, project_path: &str) -> Option<Vec<SessionMeta>> {
    let mut records: Vec<RawSessionRecord> = Vec::new();
    let mut phys_cwd: Option<String> = None;
    let mut done = false;
    for line in stdout.lines() {
        if line.trim_end() == "PIX_SESSIONS_DONE" {
            done = true;
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.starts_with("PIX_SESSION_") {
            continue;
        }
        match key {
            "PIX_SESSION_CWD" => {
                let value = value.trim();
                phys_cwd = (!value.is_empty()).then(|| value.to_string());
            }
            "PIX_SESSION_FILE" => records.push(RawSessionRecord {
                file: value.to_string(),
                ..Default::default()
            }),
            "PIX_SESSION_MTIME" => {
                if let Some(last) = records.last_mut() {
                    last.mtime_s = value.trim().parse().unwrap_or(0);
                }
            }
            "PIX_SESSION_HEADER" => {
                if let Some(last) = records.last_mut() {
                    last.header_line = Some(value.to_string());
                }
            }
            "PIX_SESSION_TITLE" => {
                if let Some(last) = records.last_mut() {
                    last.title_line = Some(value.to_string());
                }
            }
            _ => {}
        }
    }
    if !done {
        return None;
    }
    let mut metas: Vec<SessionMeta> = records
        .iter()
        .filter_map(|record| record_to_meta(record, project_path, phys_cwd.as_deref()))
        .collect();
    metas.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then(a.file.cmp(&b.file)));
    metas.truncate(MAX_SESSIONS);
    Some(metas)
}

/// 把一条原始记录组装为 [`SessionMeta`]：HEADER/TITLE 值按 JSON 解析，解析失败
/// 或非会话头的记录跳过（单文件损坏不清空整个列表）；`preview` 恒 `None`、
/// `archived` 恒 `false`（契约 P2 §2.3 裁剪）。
fn record_to_meta(
    record: &RawSessionRecord,
    project_path: &str,
    phys_cwd: Option<&str>,
) -> Option<SessionMeta> {
    let header: Value = serde_json::from_str(record.header_line.as_deref()?).ok()?;
    if header.get("type").and_then(|t| t.as_str()) != Some("session") {
        return None;
    }
    let cwd = header
        .get("cwd")
        .and_then(|c| c.as_str())
        .unwrap_or_default()
        .to_string();
    // URI 路径或物理路径（pwd -P 解析符号链接）任一相等即收录。
    if cwd != project_path && Some(cwd.as_str()) != phys_cwd {
        return None;
    }
    // 标题取最后一条 session_info 的 name（与本地 read_session_name 语义一致）。
    let title = record.title_line.as_deref().and_then(|line| {
        let entry: Value = serde_json::from_str(line).ok()?;
        if entry.get("type").and_then(|t| t.as_str()) != Some("session_info") {
            return None;
        }
        entry
            .get("name")
            .and_then(|n| n.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    });
    Some(SessionMeta {
        file: record.file.clone(),
        id: header
            .get("id")
            .and_then(|i| i.as_str())
            .unwrap_or_default()
            .to_string(),
        cwd,
        timestamp: header
            .get("timestamp")
            .and_then(|t| t.as_str())
            .map(String::from),
        mtime_ms: record.mtime_s.saturating_mul(1000),
        preview: None,
        title,
        archived: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan_output(cwd: &str, records: &[(&str, u64, &str, Option<&str>)]) -> String {
        let mut out = format!("PIX_SESSION_CWD={cwd}\n");
        for (file, mtime, header, title) in records {
            out.push_str(&format!("PIX_SESSION_FILE={file}\n"));
            out.push_str(&format!("PIX_SESSION_MTIME={mtime}\n"));
            out.push_str(&format!("PIX_SESSION_HEADER={header}\n"));
            match title {
                Some(title) => out.push_str(&format!("PIX_SESSION_TITLE={title}\n")),
                None => out.push_str("PIX_SESSION_TITLE=\n"),
            }
        }
        out.push_str("PIX_SESSIONS_DONE\n");
        out
    }

    fn header_json(cwd: &str, id: &str) -> String {
        format!(
            r#"{{"type":"session","cwd":"{cwd}","id":"{id}","timestamp":"2026-10-06T00:00:00.000Z"}}"#
        )
    }

    #[test]
    fn parse_ignores_banner_and_requires_done_marker() {
        let stdout = concat!(
            "Welcome to Ubuntu 24.04 LTS\n",
            "Last login: Fri Oct  3 09:00:00 2026\n",
            "PIX_SESSION_CWD=/home/dev/proj\n",
            "PIX_SESSION_FILE=/home/u/.pi/agent/sessions/a.jsonl\n",
            "PIX_SESSION_MTIME=100\n",
            r#"PIX_SESSION_HEADER={"type":"session","cwd":"/home/dev/proj","id":"s1"}"#,
            "\n",
            r#"PIX_SESSION_TITLE={"type":"session_info","name":"First"}"#,
            "\n",
            "PIX_SESSIONS_DONE\n",
        );
        let metas = parse_sessions_output(stdout, "/home/dev/proj").expect("DONE 应存在");
        assert_eq!(metas.len(), 1);
        assert_eq!(metas[0].file, "/home/u/.pi/agent/sessions/a.jsonl");
        assert_eq!(metas[0].id, "s1");
        assert_eq!(metas[0].cwd, "/home/dev/proj");
        assert_eq!(metas[0].title.as_deref(), Some("First"));
        assert_eq!(metas[0].timestamp, None);
        // mtime 秒 × 1000（契约 P2 §2.1）。
        assert_eq!(metas[0].mtime_ms, 100_000);
        // P2 裁剪：preview 恒 null、archived 恒 false。
        assert_eq!(metas[0].preview, None);
        assert!(!metas[0].archived);
        // 未读到 DONE（超时/截断）→ None。
        assert!(parse_sessions_output("PIX_SESSION_CWD=/a\n", "/a").is_none());
        assert!(parse_sessions_output("", "/a").is_none());
    }

    #[test]
    fn parse_filters_by_uri_path_or_physical_path() {
        let stdout = &scan_output(
            "/home/dev",
            &[
                // cwd == URI 路径。
                ("/s/one.jsonl", 10, &header_json("/dev", "one"), Some(r#"{"type":"session_info","name":"One"}"#)),
                // cwd == 物理路径（别名）→ 兜底收录。
                ("/s/two.jsonl", 20, &header_json("/home/dev", "two"), None),
                // 其余 cwd 不收录。
                ("/s/three.jsonl", 30, &header_json("/other", "three"), None),
            ],
        );
        let metas = parse_sessions_output(stdout, "/dev").expect("DONE 应存在");
        let mut ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
        ids.sort();
        assert_eq!(ids, ["one", "two"]);
    }

    #[test]
    fn parse_skips_corrupt_records_and_keeps_the_rest() {
        let stdout = &scan_output(
            "/proj",
            &[
                // 非会话头（type 缺失）。
                ("/s/bad.jsonl", 5, r#"{"cwd":"/proj"}"#, None),
                // HEADER 不是 JSON。
                ("/s/worse.jsonl", 6, "not json at all", None),
                // 合法记录。
                ("/s/good.jsonl", 7, &header_json("/proj", "good"), None),
                // TITLE 不是 JSON → 标题为空但记录保留。
                ("/s/notitle.jsonl", 8, &header_json("/proj", "notitle"), Some("plain text")),
            ],
        );
        let metas = parse_sessions_output(stdout, "/proj").expect("DONE 应存在");
        let ids: Vec<&str> = metas.iter().map(|m| m.id.as_str()).collect();
        // 降序：mtime 8 在 7 前。
        assert_eq!(ids, ["notitle", "good"]);
        let notitle = metas.iter().find(|m| m.id == "notitle").unwrap();
        assert_eq!(notitle.title, None);
    }

    #[test]
    fn parse_sorts_by_mtime_desc_and_caps_at_50() {
        let records: Vec<(String, u64, String, Option<String>)> = (0..60)
            .map(|i| {
                (
                    format!("/s/{i}.jsonl"),
                    i,
                    header_json("/proj", &format!("s{i}")),
                    None,
                )
            })
            .map(|(f, m, h, t)| (f, m, h, t))
            .collect();
        let records: Vec<(&str, u64, &str, Option<&str>)> = records
            .iter()
            .map(|(f, m, h, t)| (f.as_str(), *m, h.as_str(), t.as_deref()))
            .collect();
        let stdout = scan_output("/proj", &records);
        let metas = parse_sessions_output(&stdout, "/proj").expect("DONE 应存在");
        assert_eq!(metas.len(), 50);
        // 新到旧：最大 mtime 在前。
        assert_eq!(metas[0].id, "s59");
        assert_eq!(metas[0].mtime_ms, 59_000);
        assert_eq!(metas.last().unwrap().id, "s10");
    }

    #[test]
    fn parse_handles_empty_sessions_root_and_missing_title_name() {
        // 目录不存在：脚本只输出 CWD 空值 + DONE。
        let stdout = "PIX_SESSION_CWD=\nPIX_SESSIONS_DONE\n";
        let metas = parse_sessions_output(stdout, "/proj").expect("DONE 应存在");
        assert!(metas.is_empty());
        // session_info 的 name 为空白 → 标题 None。
        let stdout = scan_output(
            "/proj",
            &[(("/s/a.jsonl"), 1, &header_json("/proj", "a"), Some(r#"{"type":"session_info","name":"  "}"#))],
        );
        let metas = parse_sessions_output(&stdout, "/proj").unwrap();
        assert_eq!(metas[0].title, None);
    }

    // ---- 实机集成测试（契约 P2 §6）：需 WSL 测试环境（wsl-test-env.md）。
    // 运行：cargo test ssh_real -- --ignored（环境变量见 real_env）。

    use crate::ssh::transport::ssh_exec_with_stdin;

    struct RealEnv {
        endpoint: SshEndpoint,
        project: String,
        host: String,
        port: u16,
        user: String,
    }

    /// 读取实机环境变量（契约 P2 §6 冻结名，任一缺失则跳过）。
    fn real_env() -> Option<RealEnv> {
        let missing: Vec<&str> = [
            "PIX_SSH_TEST_HOST",
            "PIX_SSH_TEST_PORT",
            "PIX_SSH_TEST_USER",
            "PIX_SSH_TEST_KEY_PATH",
            "PIX_SSH_TEST_PROJECT",
        ]
        .iter()
        .copied()
        .filter(|key| std::env::var(key).is_err())
        .collect();
        if !missing.is_empty() {
            eprintln!("跳过实机测试：缺少环境变量 {missing:?}");
            return None;
        }
        let host = std::env::var("PIX_SSH_TEST_HOST").unwrap();
        let port: u16 = std::env::var("PIX_SSH_TEST_PORT")
            .unwrap()
            .parse()
            .expect("PIX_SSH_TEST_PORT 必须是十进制端口");
        let user = std::env::var("PIX_SSH_TEST_USER").unwrap();
        let key_path = std::env::var("PIX_SSH_TEST_KEY_PATH").unwrap();
        let project = std::env::var("PIX_SSH_TEST_PROJECT").unwrap();
        Some(RealEnv {
            endpoint: SshEndpoint {
                host: host.clone(),
                port,
                user: Some(user.clone()),
                key_path: Some(key_path),
            },
            project,
            host,
            port,
            user,
        })
    }

    impl RealEnv {
        fn uri_for(&self, path: &str) -> String {
            format!("ssh://{}@{}:{}{}", self.user, self.host, self.port, path)
        }

        async fn remote_home(&self) -> String {
            let output = ssh_exec(
                &self.endpoint,
                "echo \"PIX_TEST_HOME=$HOME\"\n",
                Duration::from_secs(15),
            )
            .await
            .expect("读取远端 HOME 应成功");
            output
                .stdout
                .lines()
                .rev()
                .find_map(|line| line.strip_prefix("PIX_TEST_HOME="))
                .map(str::trim)
                .filter(|home| !home.is_empty())
                .expect("远端应输出 PIX_TEST_HOME=")
                .to_string()
        }
    }

    /// S-R1：远端 realpath 把别名符号链接归一化后，`resolve_path_rebind`
    /// 产出回绑结果，重建 URI 的 host/port/user 不变、path 为物理路径。
    #[tokio::test]
    #[ignore]
    async fn ssh_real_realpath_rebind_resolves_alias_symlink() {
        let Some(env) = real_env() else { return };
        // 实机用例共享单 sshd，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        let home = env.remote_home().await;
        // 别名按用例独立命名，避免并行用例间的清理竞态。
        let alias = format!("{home}/pix-ssh-alias-r1");
        let setup = format!(
            "ln -sfn {} {}\n",
            payload::posix_quote(&env.project),
            payload::posix_quote(&alias)
        );
        ssh_exec(&env.endpoint, &setup, Duration::from_secs(15))
            .await
            .expect("创建远端符号链接应成功");
        let uri = env.uri_for(&alias);
        let result =
            crate::rpc::resolve_path_rebind(&env.endpoint, &uri, &alias).await;
        // 清理符号链接（不影响断言）。
        let _ = ssh_exec(
            &env.endpoint,
            &format!("rm -f {}\n", payload::posix_quote(&alias)),
            Duration::from_secs(15),
        )
        .await;
        match result.expect("回绑解析应成功") {
            crate::rpc::PathRebind::Rebound {
                resolved,
                rebound_project,
            } => {
                assert_eq!(resolved, env.project, "回绑 path 应为物理路径");
                assert_eq!(rebound_project, env.uri_for(&env.project));
            }
            other => panic!("期望 Rebound，实际 {other:?}"),
        }
    }

    /// S-R2：`ssh_sessions` 扫描——临时会话文件（PIX_TEST_ 前缀）可扫到、
    /// 删除后消失；cwd 为别名路径的会话因 PIX_SESSION_CWD 物理路径兜底仍被收录。
    #[tokio::test]
    #[ignore]
    async fn ssh_real_sessions_scan_finds_and_filters_temp_sessions() {
        let Some(env) = real_env() else { return };
        // 实机用例共享单 sshd，统一串行执行（见 ssh_real_lock）。
        let _serial = crate::ssh::transport::ssh_real_lock();
        let home = env.remote_home().await;
        // 别名按用例独立命名，避免并行用例间的清理竞态。
        let alias = format!("{home}/pix-ssh-alias-r2");
        ssh_exec(
            &env.endpoint,
            &format!(
                "ln -sfn {} {}\n",
                payload::posix_quote(&env.project),
                payload::posix_quote(&alias)
            ),
            Duration::from_secs(15),
        )
        .await
        .expect("创建远端符号链接应成功");

        let marker = format!("PIX_TEST_{}", uuid::Uuid::new_v4());
        let content_main = format!(
            "{{\"type\":\"session\",\"cwd\":\"{}\",\"id\":\"{marker}\",\"timestamp\":\"2026-10-06T00:00:00.000Z\"}}\n{{\"type\":\"session_info\",\"name\":\"{marker}\"}}\n",
            env.project
        );
        let content_alias = format!(
            "{{\"type\":\"session\",\"cwd\":\"{}\",\"id\":\"{marker}-alias\",\"timestamp\":\"2026-10-06T00:00:01.000Z\"}}\n{{\"type\":\"session_info\",\"name\":\"{marker}-alias\"}}\n",
            alias
        );
        let file_main = format!("{home}/.pi/agent/sessions/{marker}.jsonl");
        let file_alias = format!("{home}/.pi/agent/sessions/{marker}-alias.jsonl");
        for (file, content) in [(&file_main, &content_main), (&file_alias, &content_alias)] {
            let script = format!(
                "mkdir -p \"$HOME/.pi/agent/sessions\" && cat > {}\n",
                payload::posix_quote(file)
            );
            let output = ssh_exec_with_stdin(
                &env.endpoint,
                &script,
                content.as_bytes(),
                Duration::from_secs(15),
            )
            .await
            .expect("写入远端临时会话文件应成功");
            assert_eq!(output.exit_code, 0);
        }

        let metas = scan_remote_sessions(&env.endpoint, &env.project)
            .await
            .expect("扫描应成功");
        let main = metas
            .iter()
            .find(|meta| meta.file == file_main)
            .expect("临时会话应被扫到");
        assert_eq!(main.id, marker);
        assert_eq!(main.title.as_deref(), Some(marker.as_str()));
        assert_eq!(main.cwd, env.project);
        assert!(main.mtime_ms > 0, "远端 mtime 应换算为毫秒");
        // 协议语义（契约 P2 §2.2）：脚本只解析查询项目的物理路径（pwd -P），
        // 会话头里记录的别名 cwd 无从远端解析，以物理项目查询时不收录。
        assert!(!metas.iter().any(|meta| meta.file == file_alias));

        // 别名 URI 查询：主会话（cwd=物理路径）经 PIX_SESSION_CWD 物理路径
        // 兜底收录，别名会话（cwd=别名路径）与 URI 路径直接相等收录。
        let metas = scan_remote_sessions(&env.endpoint, &alias)
            .await
            .expect("别名扫描应成功");
        assert!(
            metas.iter().any(|meta| meta.file == file_main),
            "cwd 为物理路径的会话应因物理路径兜底被别名查询收录"
        );
        assert!(metas.iter().any(|meta| meta.file == file_alias));

        let cleanup = format!(
            "rm -f {} {} {}\n",
            payload::posix_quote(&file_main),
            payload::posix_quote(&file_alias),
            payload::posix_quote(&alias)
        );
        ssh_exec(&env.endpoint, &cleanup, Duration::from_secs(15))
            .await
            .expect("清理远端临时文件应成功");
        let metas = scan_remote_sessions(&env.endpoint, &env.project)
            .await
            .expect("再次扫描应成功");
        assert!(!metas.iter().any(|meta| meta.file == file_main));
        assert!(!metas.iter().any(|meta| meta.file == file_alias));
    }
}
