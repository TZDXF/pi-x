# SSH 修复实机回归

## 确定性检查

```powershell
pnpm run check
pnpm run test:web:all
pnpm test
```

新增覆盖：凭据经保存/重载后仍可使用但不写入配置；密码、口令中的空格与特殊字符不被修改；askpass 不生成含凭据的脚本；完整 SDK 与 bundle 的信任读写及父目录继承。

## 可选实机回归

测试默认 `ignored`。仅连接明确授权的测试主机，不读取真实项目或调用模型。

1. 在终端核实主机指纹并将其加入 `known_hosts`，不关闭 host-key 检查。
2. `cargo build --manifest-path src-tauri/Cargo.toml` 构建应用；应用本身提供 askpass 模式，不生成临时凭据文件。
3. 从安全的会话环境注入以下变量，不把真实凭据写进脚本、仓库、命令行参数或日志：
   - `PIX_SSH_TEST_HOST`、`PIX_SSH_TEST_USER`、可选 `PIX_SSH_TEST_PORT`（默认 22）
   - `PIX_SSH_TEST_PASSWORD`
   - `PIX_SSH_TEST_ASKPASS_PROGRAM`：上一步生成的应用可执行文件绝对路径（仅测试构建读取此覆盖项）
4. 本地需安装 npm 版 pi；远端需提供 Node.js、tar、base64 及 `/usr/bin:/bin` 下的 POSIX 工具。
5. 执行：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml ssh_password_deploy_trust_rpc_real -- --ignored --nocapture
```

测试创建 `/tmp/pix-ssh-check-*` 临时 HOME，验证首次部署、重复部署、bundle 信任状态、信任/拒绝保存，以及 `pi --mode rpc` 的 `get_state` 响应。正常完成或返回错误时清理临时 HOME；强制终止测试进程后需人工核实遗留目录。测试结束后清除当前会话的凭据环境变量。

## 2026-10-14 验证结果

在用户授权的 Linux 主机、Node.js v24.21.0、PATH 无 pi 的环境执行。Windows 原生 OpenSSH 9.5p2 与 Git OpenSSH 10.3p1 均通过上述回归；远端临时目录已清理，未向模型服务发起请求。
