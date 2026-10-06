# WSL SSH 测试环境（P1 实机冒烟）

本机（Windows 11 + WSL2 Ubuntu 26.04）上的真实 SSH 远程测试环境，用于验证 PiX 的 SSH 远程项目功能。

## 环境参数（PiX「添加 SSH 项目」直接填这些）

| 项 | 值 |
| --- | --- |
| Host | `localhost` |
| Port | `2222` |
| User | `tzdxf` |
| 认证 | 私钥 `C:\Users\TZDXF\.ssh\pix_wsl_test`（无口令） |
| 测试项目 | `/home/tzdxf/pix-ssh-demo`（git 仓库，含 `src/hello.ts`） |
| 远端工具链 | Node v22.22.1，pi 1.0.0（`/usr/local/bin/pi`） |

远端 pi 未配置 provider（get_state 返回 model=unknown），可验证 spawn/JSONL/会话文件链路；完整对话需在 WSL 内配置 pi 的模型凭据。

## 基础设施

- WSL 内运行了**独立 sshd 实例**：配置 `/etc/ssh/sshd_config_pix_test`（Port 2222、仅公钥、root 禁登），不与系统 systemd `ssh.socket`（端口 22）冲突。
- Windows 侧专用密钥对 `~/.ssh/pix_wsl_test`，公钥已装入 `tzdxf@Ubuntu:~/.ssh/authorized_keys`。
- 主机指纹已通过 `StrictHostKeyChecking=accept-new` 首连写入 Windows `~/.ssh/known_hosts`（条目 `[localhost]:2222`）。

## sshd 重启（WSL 关机后需要）

```bash
wsl -d Ubuntu -u root -- /usr/sbin/sshd -f /etc/ssh/sshd_config_pix_test
```

WSL2 的 localhost 转发使 Windows 直接以 `localhost:2222` 访问。

## 已验证的冒烟结论（2026-10-06）

1. **连通性**：`ssh -p 2222 -i pix_wsl_test -o BatchMode=yes tzdxf@localhost -- uname` 正常返回 `Linux x86_64`。
2. **base64 payload 通道**：`/bin/sh -c 'echo <b64> | base64 -d | /bin/sh'` 经真实 sshd 执行正确，多行输出无失真。
3. **真实 pi RPC**：SSH spawn `cd ~/pix-ssh-demo && pi --mode rpc`，stdin 写入 `{"type":"get_state","id":1}`，stdout 返回完整 JSONL response（含远端 `sessionFile: /home/tzdxf/.pi/agent/sessions/...`），**stderr 干净**。
4. **stdin EOF 行为（规划风险项）**：stdin 关闭后 pi 与 ssh 进程即退出——断连/kill 路径不需要额外的远程 kill 也能干净结束（PiX 的 `PIX_PI_PID` 兜底仍保留）。
5. **主机指纹问题（真实发现）**：`known_hosts` 无记录时，`BatchMode` 非交互 ssh 报 `Host key verification failed` 而非交互式提示。PiX 的传输层错误归类应把该错误映射为"主机指纹未确认，请先手动 ssh 该主机一次或添加指纹"，否则用户看到的裸错误无法理解。已记入待办（见下）。

## 待办（由本次冒烟产生）

- [ ] 前端错误文案：`Host key verification failed` / `REMOTE HOST IDENTIFICATION HAS CHANGED` 归类为可操作的提示（传输层 `transport.rs` 错误归类处）。
- [ ] `ssh-keyscan` 对该环境偶发抓不到指纹（原因未查），不阻塞 PiX（PiX 不做指纹采集）。
