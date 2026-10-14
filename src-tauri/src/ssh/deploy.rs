//! 远程 pi 环境引导（P4）：远端未安装 pi 时，从本地 pi 安装上传自包含 bundle。
//!
//! 参考 ZCode `packages/server/src/remote/` 的 deploy 机制：detect → 幂等校验
//! （SHA256）→ 原子锁部署。pi 的 `dist/bundle/` 自包含（仅 `node:` 内置模块与
//! 相对路径），上传后在远端以 `node bundle/cli.js --mode rpc` 运行。
//!
//! 远端布局：
//! ```text
//! ~/.pix/pi/
//! ├── bin/pi            # wrapper: exec node <dir>/../bundle/cli.js "$@"
//! ├── bundle/           # 本地 dist/bundle 内容（约 8.8M）
//! └── .deploy-info      # JSON：contentHash / version / platform / arch / deployedAt
//! ```

use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::backend::RemoteEndpoint;
use super::transport::{remote_exec, remote_exec_with_stdin, SshError, SshErrorKind};
use crate::errors::{pix_error, pix_error_detail};

// ---------------------------------------------------------------------------
// 部署步骤与进度（对齐 ZCode RemoteConnectionConnectingStep）
// ---------------------------------------------------------------------------

/// 部署步骤（对齐 ZCode 的 detect → deploy → launch 流程）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeployStep {
  /// 检测远端环境（node / pi）
  Detect,
  /// 打包本地 bundle
  Pack,
  /// 上传到远端
  Upload,
  /// 验证部署
  Verify,
  /// 完成
  Done,
}

/// 部署进度（用于前端实时显示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployProgress {
  pub step: DeployStep,
  pub message: String,
  /// 0-100，仅 Upload 步骤有意义的进度
  pub percent: u8,
}

/// 进度回调（Tauri 事件或闭包）。
pub type ProgressCallback = Arc<dyn Fn(DeployProgress) + Send + Sync>;

// ---------------------------------------------------------------------------
// 远端路径常量（脚本中用 $HOME 展开，保持 POSIX 兼容）
// ---------------------------------------------------------------------------

#[allow(dead_code)]
pub const REMOTE_PI_DIR: &str = "$HOME/.pix/pi";
#[allow(dead_code)]
pub const REMOTE_PI_BIN: &str = "$HOME/.pix/pi/bin/pi";
#[allow(dead_code)]
pub const REMOTE_DEPLOY_INFO: &str = "$HOME/.pix/pi/.deploy-info";

// ---------------------------------------------------------------------------
// 远端脚本退出码（与既有 90/92/93/95/96 同族）
// ---------------------------------------------------------------------------

pub const EXIT_CODE_NODE_MISSING: i32 = 94;
#[allow(dead_code)]
pub const EXIT_CODE_TAR_WRITE_FAILED: i32 = 95;
#[allow(dead_code)]
pub const EXIT_CODE_DIR_CREATE_FAILED: i32 = 96;
pub const EXIT_CODE_TAR_EXTRACT_FAILED: i32 = 97;
pub const EXIT_CODE_MARKER_WRITE_FAILED: i32 = 98;

// ---------------------------------------------------------------------------
// 远端脚本
// ---------------------------------------------------------------------------

/// 检测远端 pi：PATH 优先，否则检查部署版。返回 PIX_PI_PATH 与可选 PIX_PI_INFO。
pub const PI_CHECK_SCRIPT: &str = r#"PI_BIN=$(command -v pi 2>/dev/null)
if [ -n "$PI_BIN" ]; then
  echo "PIX_PI_PATH=$PI_BIN"
  exit 0
fi
if [ -x "$HOME/.pix/pi/bin/pi" ]; then
  echo "PIX_PI_PATH=$HOME/.pix/pi/bin/pi"
  if [ -f "$HOME/.pix/pi/.deploy-info" ]; then
    echo "PIX_PI_INFO=$(cat "$HOME/.pix/pi/.deploy-info")"
  fi
fi
"#;

/// 部署 pi bundle（stdin = tar.gz）。含 mkdir 原子锁 + stale 回收。
/// `__DEPLOY_INFO__` 占位符由 Rust 侧替换为完整 JSON。
pub const PI_DEPLOY_SCRIPT_TEMPLATE: &str = r#"set -eu
mkdir -p "$HOME/.pix" || exit 96
LOCK="$HOME/.pix/pi.deploy.lock"
while ! mkdir "$LOCK" 2>/dev/null; do
  [ -d "$LOCK" ] || exit 96
  now=$(date +%s)
  mtime=$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo 0)
  if [ "$mtime" -gt 0 ] && [ $((now - mtime)) -ge 600 ]; then
    rm -rf "$LOCK"
  fi
  sleep 1
done
trap 'rm -rf "$LOCK"' EXIT HUP INT TERM
mkdir -p "$HOME/.pix/pi" || exit 96
TMP="$HOME/.pix/pi.tar.gz.$$"
cat > "$TMP" || exit 95
rm -rf "$HOME/.pix/pi/bundle"
tar xzf "$TMP" -C "$HOME/.pix/pi" || exit 97
rm -f "$TMP"
mkdir -p "$HOME/.pix/pi/bin"
cat > "$HOME/.pix/pi/bin/pi" <<'WRAPPER'
#!/bin/sh
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec node "$DIR/bundle/cli.js" "$@"
WRAPPER
chmod +x "$HOME/.pix/pi/bin/pi" || exit 98
cat > "$HOME/.pix/pi/.deploy-info" <<'INFO'
__DEPLOY_INFO__
INFO
echo "PIX_PI_DEPLOY_DONE"
"#;

// ---------------------------------------------------------------------------
// 数据结构
// ---------------------------------------------------------------------------

/// 本地 pi bundle 信息（定位 + 版本 + 内容哈希）。
pub struct LocalPiBundle {
    pub bundle_dir: PathBuf,
    pub version: String,
    pub content_hash: String,
}

/// 部署结果。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeployResult {
    /// 远端 pi 路径（$HOME 形式，spawn 脚本中展开）。
    pub pi_bin: String,
    /// 是否使用部署版（false = PATH 中已有 pi）。
    pub deployed: bool,
    pub version: Option<String>,
    pub content_hash: Option<String>,
}

// ---------------------------------------------------------------------------
// 进程内串行化（减少同进程并发竞争）
// ---------------------------------------------------------------------------

fn deploy_serial() -> &'static tokio::sync::Mutex<()> {
    static SERIAL: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    SERIAL.get_or_init(|| tokio::sync::Mutex::new(()))
}

// ---------------------------------------------------------------------------
// 本地 bundle 定位
// ---------------------------------------------------------------------------

/// 定位本地 pi bundle：复用 `pi_locate::detect` 的解析结果，从 launcher 反推
/// `dist/bundle` 目录，读取 version 并计算 content_hash。
pub async fn locate_local_bundle() -> Result<LocalPiBundle, String> {
    let info = crate::pi_locate::detect(None).await;
    if !info.found {
        return Err(pix_error(
            "piNotFound",
            "未找到本地 pi 安装。请先安装 pi：npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
        ));
    }
    let bundle_dir = resolve_bundle_dir(&info)?;
    let version = info.version.unwrap_or_else(|| "unknown".into());
    let content_hash = content_hash(&bundle_dir)?;
    Ok(LocalPiBundle {
        bundle_dir,
        version,
        content_hash,
    })
}

/// 从 pi_locate 的解析结果反推 `dist/bundle` 目录。
fn resolve_bundle_dir(info: &crate::pi_locate::PiInfo) -> Result<PathBuf, String> {
    if let Some(launcher) = &info.launcher {
        match launcher {
            crate::pi_locate::Launcher::Node { script, .. } => {
                let script = Path::new(script);
                let bundle = script
                    .parent()
                    .ok_or_else(|| "无法解析 bundle 目录".to_string())?;
                if bundle.join("cli.js").is_file() {
                    return Ok(bundle.to_path_buf());
                }
            }
            crate::pi_locate::Launcher::Binary { path } => {
                let path = Path::new(path);
                let real = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
                if real.extension().and_then(|e| e.to_str()) == Some("js") {
                    let bundle = real
                        .parent()
                        .ok_or_else(|| "无法解析 bundle 目录".to_string())?;
                    if bundle.join("cli.js").is_file() {
                        return Ok(bundle.to_path_buf());
                    }
                }
            }
        }
    }
    Err(pix_error(
        "piBundleMissing",
        "无法从 pi 安装定位 dist/bundle 目录。请选择 npm 版 pi。",
    ))
}

// ---------------------------------------------------------------------------
// 确定性内容哈希
// ---------------------------------------------------------------------------

/// 对 bundle 目录取确定性哈希：排序相对路径 + 逐文件 SHA256，消除目录枚举
/// 顺序差异，使同内容同哈希（幂等判断的基础）。
fn content_hash(bundle_dir: &Path) -> Result<String, String> {
    let mut entries: Vec<(String, String)> = Vec::new();
    collect_file_hashes(bundle_dir, bundle_dir, &mut entries)?;
    entries.sort_by(|a, b| a.0.cmp(&b.0));

    let mut hasher = Sha256::new();
    for (path, hash) in entries {
        hasher.update(path.as_bytes());
        hasher.update(b"\0");
        hasher.update(hash.as_bytes());
        hasher.update(b"\n");
    }
    Ok(STANDARD.encode(hasher.finalize()))
}

fn collect_file_hashes(
    root: &Path,
    dir: &Path,
    entries: &mut Vec<(String, String)>,
) -> Result<(), String> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let rel = path.strip_prefix(root).map_err(|e| e.to_string())?;
        let rel_str = rel.to_string_lossy().replace('\\', "/");
        if path.is_dir() {
            collect_file_hashes(root, &path, entries)?;
        } else {
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let mut hasher = Sha256::new();
            hasher.update(&bytes);
            entries.push((rel_str, STANDARD.encode(hasher.finalize())));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 打包
// ---------------------------------------------------------------------------

/// 打包 bundle 目录为 tar.gz（`bundle/` 前缀，远端解包到 `~/.pix/pi/` 后
/// 得到 `~/.pix/pi/bundle/`）。
fn pack_bundle(bundle_dir: &Path) -> Result<Vec<u8>, String> {
    use flate2::write::GzEncoder;
    use flate2::Compression;
    use tar::Builder;

    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    {
        let mut builder = Builder::new(&mut encoder);
        builder
            .append_dir_all("bundle", bundle_dir)
            .map_err(|e| format!("打包 bundle 失败: {e}"))?;
        builder
            .finish()
            .map_err(|e| format!("打包 bundle 失败: {e}"))?;
    }
    encoder
        .finish()
        .map_err(|e| format!("压缩 bundle 失败: {e}"))
}

// ---------------------------------------------------------------------------
// 检测远端 pi
// ---------------------------------------------------------------------------

pub(crate) fn parse_check_output(stdout: &str) -> Option<(String, Option<String>)> {
    let mut pi_path = None;
    let mut info = None;
    for line in stdout.lines() {
        if let Some(path) = line.strip_prefix("PIX_PI_PATH=") {
            pi_path = Some(path.to_string());
        } else if let Some(i) = line.strip_prefix("PIX_PI_INFO=") {
            info = Some(i.to_string());
        }
    }
    pi_path.map(|p| (p, info))
}

// ---------------------------------------------------------------------------
// 错误归类
// ---------------------------------------------------------------------------

pub(crate) fn deploy_error(_endpoint: &RemoteEndpoint, e: &SshError) -> String {
    match e.kind {
        SshErrorKind::Timeout => pix_error("sshTimeout", "连接超时，网络过慢或主机无响应。"),
        SshErrorKind::Auth => pix_error("sshAuthFailed", "SSH 认证失败。请检查密钥或 agent。"),
        SshErrorKind::Network => {
            pix_error("sshConnectFailed", "无法连接到远程主机，请检查主机、端口与网络。")
        }
        SshErrorKind::HostKey => pix_error("sshHostKeyUnverified", "主机指纹尚未确认。"),
        SshErrorKind::SshMissing => {
            pix_error("sshMissing", "未找到本机 ssh 客户端。请安装 OpenSSH 客户端。")
        }
        SshErrorKind::Remote => {
            if e.exit_code == Some(EXIT_CODE_NODE_MISSING) {
                pix_error(
                    "sshRemoteNodeMissing",
                    "远程主机未安装 Node.js，无法运行 pi。请在远程主机安装 Node.js ≥ 22。",
                )
            } else if e.exit_code == Some(EXIT_CODE_TAR_EXTRACT_FAILED) {
                pix_error_detail(
                    "sshRemoteDeployFailed",
                    "远程部署失败: {detail}",
                    "tar 解包失败，请检查远端磁盘空间与 tar 可用性。",
                )
            } else if e.exit_code == Some(EXIT_CODE_MARKER_WRITE_FAILED) {
                pix_error_detail(
                    "sshRemoteDeployFailed",
                    "远程部署失败: {detail}",
                    "写部署标记失败。",
                )
            } else {
                pix_error_detail("sshRemoteDeployFailed", "远程部署失败: {detail}", &e.detail)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/// 确保远端 pi 可用：PATH pi 优先，否则检查部署版幂等，必要时部署。
///
/// - PATH 中有 pi → 直接返回，不触发部署。
/// - 部署版存在且 contentHash 匹配 → 跳过上传。
/// - 否则 → 上传 bundle、写 wrapper 与 .deploy-info。
///
/// `on_progress` 可选，用于前端实时显示部署步骤（对齐 ZCode RemoteConnectionConnectingStep）。
pub async fn ensure_pi_available(
    _connection_id: &str,
    endpoint: &RemoteEndpoint,
    on_progress: Option<ProgressCallback>,
) -> Result<DeployResult, String> {
    let progress = |step: DeployStep, message: &str, percent: u8| {
        if let Some(cb) = &on_progress {
            cb(DeployProgress {
                step,
                message: message.to_string(),
                percent,
            })
        }
    };

    // 1. detect 远端 pi
    progress(DeployStep::Detect, "检测远端环境...", 0);
    let check = remote_exec(endpoint, PI_CHECK_SCRIPT, Duration::from_secs(15))
        .await
        .map_err(|e| deploy_error(endpoint, &e))?;

    if let Some((pi_path, info)) = parse_check_output(&check.stdout) {
        let is_deployed = pi_path.contains("/.pix/pi/bin/pi");
        if !is_deployed {
            // PATH 中的 pi，直接使用（对齐用户「连接服务器上已经安装的 pi」）
            progress(DeployStep::Done, "PATH 中已安装 pi", 100);
            return Ok(DeployResult {
                pi_bin: pi_path,
                deployed: false,
                version: None,
                content_hash: None,
            });
        }
        // 部署版，检查幂等
        if let Some(info) = info {
            let local = locate_local_bundle().await?;
            if info.contains(&local.content_hash) {
                progress(DeployStep::Done, "pi 已部署且版本匹配", 100);
                return Ok(DeployResult {
                    pi_bin: pi_path,
                    deployed: true,
                    version: Some(local.version),
                    content_hash: Some(local.content_hash),
                });
            }
        }
    }

    // 2. 需要部署
    progress(DeployStep::Pack, "打包本地 pi bundle...", 10);
    let local = locate_local_bundle().await?;
    progress(DeployStep::Upload, "上传 pi 到远端...", 30);
    deploy_pi(endpoint, &local, &progress).await?;
    progress(DeployStep::Verify, "验证部署...", 90);
    progress(DeployStep::Done, "pi 部署完成", 100);

    Ok(DeployResult {
        pi_bin: REMOTE_PI_BIN.to_string(),
        deployed: true,
        version: Some(local.version),
        content_hash: Some(local.content_hash),
    })
}

/// 执行远端部署：打包 → 上传（含原子锁）→ 写标记。
async fn deploy_pi(
    endpoint: &RemoteEndpoint,
    local: &LocalPiBundle,
    progress: &(dyn Fn(DeployStep, &str, u8) + Sync),
) -> Result<(), String> {
    let _serial = deploy_serial().lock().await;
    progress(DeployStep::Pack, "打包本地 pi bundle...", 10);
    let tar_gz = pack_bundle(&local.bundle_dir)?;

    progress(DeployStep::Upload, "上传 pi 到远端...", 30);
    let deploy_info = serde_json::json!({
        "contentHash": local.content_hash,
        "version": local.version,
        "platform": "unknown",
        "arch": "unknown",
        "deployedAt": chrono::Utc::now().to_rfc3339(),
    });
    let script = PI_DEPLOY_SCRIPT_TEMPLATE.replace("__DEPLOY_INFO__", &deploy_info.to_string());

    let output = remote_exec_with_stdin(endpoint, &script, &tar_gz, Duration::from_secs(120))
        .await
        .map_err(|e| deploy_error(endpoint, &e))?;

    if !output.stdout.contains("PIX_PI_DEPLOY_DONE") {
        return Err(pix_error_detail(
            "sshRemoteDeployFailed",
            "远程部署失败: {detail}",
            "输出缺少完成标记 PIX_PI_DEPLOY_DONE",
        ));
    }
    progress(DeployStep::Verify, "验证部署...", 90);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Opt-in real host regression. Credentials are supplied only by environment;
    /// all remote writes are confined to a fresh mktemp HOME, removed on exit.
    #[tokio::test]
    #[ignore = "requires PIX_SSH_TEST_HOST/USER/PASSWORD and PIX_SSH_TEST_ASKPASS_PROGRAM"]
    async fn ssh_password_deploy_trust_rpc_real() {
        use crate::ssh::payload;
        use crate::ssh::transport::{remote_exec_stream, AuthMethod, SshEndpoint};
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
        let endpoint = RemoteEndpoint::Ssh(SshEndpoint {
            host: std::env::var("PIX_SSH_TEST_HOST").expect("test host required"),
            port: std::env::var("PIX_SSH_TEST_PORT")
                .unwrap_or_else(|_| "22".into())
                .parse()
                .unwrap(),
            user: Some(std::env::var("PIX_SSH_TEST_USER").expect("test user required")),
            key_path: None,
            auth_method: AuthMethod::Password,
            password: Some(std::env::var("PIX_SSH_TEST_PASSWORD").expect("test password required")),
            key_passphrase: None,
        });
        let timeout = Duration::from_secs(120);
        let root = remote_exec(&endpoint, "mktemp -d /tmp/pix-ssh-check-XXXXXXXX", timeout)
            .await
            .unwrap()
            .stdout
            .trim()
            .to_string();
        assert!(root.starts_with("/tmp/pix-ssh-check-") && !root.contains(char::is_whitespace));
        let prefix = format!(
            "export HOME={}\nexport PATH=/usr/bin:/bin\n",
            payload::posix_quote(&root)
        );
        let result: Result<(), String> = async {
            let local = locate_local_bundle().await?;
            let archive = pack_bundle(&local.bundle_dir)?;
            let info = serde_json::json!({ "contentHash": local.content_hash });
            let deploy = PI_DEPLOY_SCRIPT_TEMPLATE.replace("__DEPLOY_INFO__", &info.to_string());
            for _ in 0..2 {
                let output = remote_exec_with_stdin(&endpoint, &format!("{prefix}{deploy}"), &archive, timeout).await.map_err(|e| e.detail)?;
                if !output.stdout.contains("PIX_PI_DEPLOY_DONE") { return Err("missing deployment marker".into()); }
            }
            eprintln!("real SSH: password authentication, fresh HOME deployment and redeployment passed");
            let upload = format!("{prefix}{}\nmkdir -p \"$HOME/project/.pi\"\nprintf '{{}}' > \"$HOME/project/.pi/settings.json\"", payload::TRUST_UPLOAD_SCRIPT);
            remote_exec_with_stdin(&endpoint, &upload, include_bytes!("../../resources/remote_trust.mjs"), timeout).await.map_err(|e| e.detail)?;
            for decision in [None, Some(true), Some(false)] {
                let request = serde_json::json!({ "op": if decision.is_some() { "trust_save" } else { "trust_status" }, "project": format!("{root}/project"), "trusted": decision, "trustParent": false });
                let output = remote_exec_with_stdin(&endpoint, &format!("{prefix}{}", payload::TRUST_RUN_SCRIPT), request.to_string().as_bytes(), timeout).await.map_err(|e| e.detail)?;
                let value: serde_json::Value = serde_json::from_str(output.stdout.trim()).map_err(|e| format!("trust response: {e}"))?;
                if value["decision"] != serde_json::json!(decision) { return Err("trust decision did not round-trip".into()); }
                if decision.is_none() && value["needsDecision"] != true { return Err("fresh project must require trust".into()); }
            }
            eprintln!("real SSH: bundled SDK trust status/save true/save false passed");
            // No prompt is sent: get_state never calls a model provider.
            let script = format!("{prefix}{}", payload::build_spawn_payload(&format!("{root}/project"), None, &[]));
            let mut child = remote_exec_stream(&endpoint, &script).await.map_err(|e| e.detail)?;
            let mut input = child.stdin.take().unwrap();
            let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
            input.write_all(b"{\"id\":\"regression\",\"type\":\"get_state\"}\n").await.map_err(|e| e.to_string())?;
            let response = tokio::time::timeout(Duration::from_secs(30), async {
                while let Some(line) = lines.next_line().await? {
                    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) {
                        if value["id"] == "regression" { return Ok::<_, std::io::Error>(value); }
                    }
                }
                Err(std::io::Error::new(std::io::ErrorKind::UnexpectedEof, "pi closed stdout"))
            }).await;
            drop(input);
            let _ = child.kill().await;
            let value = response.map_err(|_| "RPC handshake timeout".to_string())?.map_err(|e| e.to_string())?;
            if value["success"] != true { return Err(format!("RPC handshake failed: {value}")); }
            eprintln!("real SSH: pi --mode rpc get_state passed (no model request)");
            Ok(())
        }.await;
        let cleanup = remote_exec(
            &endpoint,
            &format!("rm -rf -- {}", payload::posix_quote(&root)),
            timeout,
        )
        .await;
        assert!(cleanup.is_ok(), "remote test HOME cleanup failed");
        assert!(result.is_ok(), "{}", result.unwrap_err());
    }

    #[test]
    fn parse_check_output_extracts_path_and_info() {
        let stdout = "PIX_PI_PATH=/usr/bin/pi\n";
        let (path, info) = parse_check_output(stdout).unwrap();
        assert_eq!(path, "/usr/bin/pi");
        assert!(info.is_none());

        let stdout = "PIX_PI_PATH=$HOME/.pix/pi/bin/pi\nPIX_PI_INFO={\"contentHash\":\"abc\"}\n";
        let (path, info) = parse_check_output(stdout).unwrap();
        assert_eq!(path, "$HOME/.pix/pi/bin/pi");
        assert!(info.unwrap().contains("abc"));
    }

    #[test]
    fn parse_check_output_none_when_no_match() {
        assert!(parse_check_output("banner\n").is_none());
        assert!(parse_check_output("").is_none());
    }

    #[test]
    fn deploy_script_contains_markers() {
        for marker in [
            "PIX_PI_DEPLOY_DONE",
            "pi.deploy.lock",
            "WRAPPER",
            "deploy-info",
            "tar xzf",
            "chmod +x",
        ] {
            assert!(
                PI_DEPLOY_SCRIPT_TEMPLATE.contains(marker),
                "部署脚本缺少标记 {marker:?}"
            );
        }
        // 占位符必须存在且唯一
        assert_eq!(
            PI_DEPLOY_SCRIPT_TEMPLATE.matches("__DEPLOY_INFO__").count(),
            1
        );
    }

    #[test]
    fn check_script_contains_markers() {
        for marker in ["PIX_PI_PATH", "command -v pi", ".pix/pi/bin/pi"] {
            assert!(
                PI_CHECK_SCRIPT.contains(marker),
                "检测脚本缺少标记 {marker:?}"
            );
        }
    }

    #[test]
    fn deploy_error_maps_exit_codes() {
        let endpoint = RemoteEndpoint::Ssh(super::super::transport::SshEndpoint {
            host: "h".into(),
            port: 22,
            user: None,
            key_path: None,
            auth_method: super::super::transport::AuthMethod::Key,
            password: None,
            key_passphrase: None,
        });
        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(EXIT_CODE_NODE_MISSING),
            detail: "boom".into(),
        };
        assert!(deploy_error(&endpoint, &e).contains("sshRemoteNodeMissing"));

        let e = SshError {
            kind: SshErrorKind::Remote,
            exit_code: Some(EXIT_CODE_TAR_EXTRACT_FAILED),
            detail: "boom".into(),
        };
        assert!(deploy_error(&endpoint, &e).contains("sshRemoteDeployFailed"));
    }

    #[test]
    fn content_hash_is_deterministic() {
        // 创建两个内容相同但文件创建顺序不同的目录，哈希应一致
        let dir1 = std::env::temp_dir().join("pix-hash-test-1");
        let dir2 = std::env::temp_dir().join("pix-hash-test-2");
        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
        std::fs::create_dir_all(dir1.join("sub")).unwrap();
        std::fs::create_dir_all(dir2.join("sub")).unwrap();
        // 顺序不同
        std::fs::write(dir1.join("a.txt"), b"hello").unwrap();
        std::fs::write(dir1.join("sub/b.txt"), b"world").unwrap();
        std::fs::write(dir2.join("sub/b.txt"), b"world").unwrap();
        std::fs::write(dir2.join("a.txt"), b"hello").unwrap();

        let h1 = content_hash(&dir1).unwrap();
        let h2 = content_hash(&dir2).unwrap();
        assert_eq!(h1, h2, "同内容不同创建顺序应产生相同哈希");

        // 内容变化 → 哈希变化
        std::fs::write(dir2.join("a.txt"), b"changed").unwrap();
        let h3 = content_hash(&dir2).unwrap();
        assert_ne!(h1, h3, "内容变化应产生不同哈希");

        let _ = std::fs::remove_dir_all(&dir1);
        let _ = std::fs::remove_dir_all(&dir2);
    }
}
