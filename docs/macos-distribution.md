# macOS 发布签名与公证

本文说明 PiX 的 macOS 发布产物（`.dmg` / 自动更新用的 `.app.tar.gz`）是怎么签名、公证的，凭据缺失时如何降级，以及「已损坏，无法打开」这类报错怎么判断和临时解决。

相关文件：

- `scripts/macos-signing.sh`：签名模式判定 + 打包后产物校验 + release notes 的 macOS 说明，`release.yml` 与 `preview.yml` 共用。
- `.github/workflows/release.yml`、`.github/workflows/preview.yml`：macOS 作业的 `plan` / `verify` 步骤与发布说明追加。
- `docs/macos-testing.md`：macOS 上 CI 与本机检查范围（不涉及打包）。

## 为什么会出现「已损坏，无法打开」

Tauri 只有拿到签名身份时才会重签整个 `.app`。如果构建环境没有任何 Apple 凭据，产物里只剩 rustc 链接时写下的 linker-signed ad-hoc 签名，`Contents/_CodeSignature/CodeResources` 不存在，`Info.plist` 也没有被签名绑定。这类 bundle 的签名不自洽：

```bash
codesign -dv --verbose=4 PiX.app     # flags=0x20002(adhoc,linker-signed)、Sealed Resources=none、Info.plist=not bound
codesign --verify --deep --strict PiX.app
# PiX.app: code has no resources but signature indicates they must be present
```

从浏览器下载的 dmg 会被打上 `com.apple.quarantine`。系统在首次打开时先按 Gatekeeper 评估，遇到这种不自洽的 bundle 就直接判定为损坏，弹「"PiX.app"已损坏，无法打开。你应该将它移到废纸篓」。也就是说：

| 产物状态                     | 无 quarantine                      | 有 quarantine                                         |
| ---------------------------- | ---------------------------------- | ----------------------------------------------------- |
| 只有 linker-signed 签名      | 能启动                             | 打不开，提示「已损坏」                                |
| bundle 被重签（ad-hoc 自洽） | 能启动                             | Gatekeeper 拒绝，提示「无法验证开发者」/ 需手动放行    |
| Developer ID 签名 + 公证     | 能启动                             | 正常打开                                              |

因此发布链路的最低要求是 **bundle 签名自洽**，彻底解决需要 Developer ID 证书 + 公证。

## 签名模式

`bash scripts/macos-signing.sh plan` 依据环境变量判定模式，只接受「凭据全无」或「凭据齐全」，半套配置直接失败（`::error::` + 非零退出）：

- `signed`：`APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD`（Developer ID Application 证书，base64 的 `.p12`）且公证凭据成组齐全。二选一：
  - Apple ID：`APPLE_ID` + `APPLE_PASSWORD`（App 专用密码）+ `APPLE_TEAM_ID`
  - App Store Connect API Key：`APPLE_API_KEY` + `APPLE_API_ISSUER` + `APPLE_API_KEY_PATH`（或用 base64 私钥 `APPLE_API_KEY_P8_BASE64`，脚本会落盘成 `APPLE_API_KEY_PATH`）
  - 可选 `APPLE_PROVIDER_SHORT_NAME`。
  此时 Tauri 正常签名、公证并装订票据。
- `adhoc`：没有任何 Apple 凭据。脚本把 `APPLE_SIGNING_IDENTITY` 设为 `-`，Tauri 仍会深层重签 bundle（自洽、可启动），但不公证：Gatekeeper 仍然拦，release notes 会自动追加用户处理说明。

之所以必须在没有凭据时显式给 `-`：Tauri 只在"有签名身份"时才执行签名步骤，默认（无身份）什么也不做，于是发布出去的仍是只有 linker-signed 签名的坏 bundle——这正是当前问题的成因。

`secrets.X` 缺失时 GitHub 会展开成空字符串，所以脚本只把**非空**凭据写进 `$GITHUB_ENV`；否则 Tauri 会把空的 `APPLE_CERTIFICATE` 当成"有证书"去导入空文件而失败。

## 需要配置的 GitHub Secrets

| Secret                             | 说明                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| `APPLE_CERTIFICATE`                | Developer ID Application 证书 `.p12` 的 base64           |
| `APPLE_CERTIFICATE_PASSWORD`       | 导出 `.p12` 时设置的口令                                 |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Apple ID 公证方式（三者成组）             |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_P8_BASE64` | API Key 公证方式（三者成组，与上一行二选一） |
| `APPLE_PROVIDER_SHORT_NAME`        | 可选，多团队账号公证时使用                               |
| `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` | 应用内更新包的签名私钥（与 Apple 公证无关，必须保留） |

任何一项都没有时即为 `adhoc` 模式：发布照旧进行，但会在日志、`GITHUB_STEP_SUMMARY` 和 release notes 中明确标注未公证。

## 打包后自检

`bash scripts/macos-signing.sh verify <bundle 目录>`（CI 里是 `src-tauri/target/release/bundle`）逐个检查：

1. `macos/*.app`：`Contents/_CodeSignature/CodeResources` 必须存在（本次缺陷的回归守卫），`codesign --verify --deep --strict` 必须通过。
2. `macos/*.app.tar.gz`（自动更新包）：解包后对里面的 `.app` 做同样检查，避免升级安装后又是坏签名。
3. `dmg/*.dmg`：`signed` 模式要求 dmg 有有效签名；`adhoc` 模式记录"dmg 自身未签名"但不失败（决定能否打开的是 dmg 内 app 的签名）。
4. `signed` 模式额外要求 `xcrun stapler validate` 与 `spctl --assess --type execute` 通过；`adhoc` 模式记录这两项结果（必然被 Gatekeeper 拒绝）但不失败。

任一项失败即 `::error::` + 非零退出，`build` 作业失败，`publish` 不会公开 release——坏签名不会再进入正式/预览发布。

本机复现同样的检查（需要已有产物）：

```bash
# 无凭据时的 ad-hoc 模式
MACOS_SIGNING_MODE=adhoc bash scripts/macos-signing.sh verify src-tauri/target/release/bundle
```

## 用户侧临时处理

未公证的产物装好后可任选一种方式放行：

1. Finder 中右键 PiX.app →「打开」，弹窗里再点「打开」；
2. 「系统设置 → 隐私与安全性」→ 在"已阻止使用"处点「仍要打开」；
3. 命令移除隔离标记（只对本机这份拷贝生效，不改变签名状态）：

```bash
xattr -dr com.apple.quarantine /Applications/PiX.app
```

如果移除隔离标记后仍然打不开（例如签名不自洽的旧版本），说明安装包本身有问题，需要修发布链路，而不是用户环境。

## 已知缺口

- 正式版只产出 `aarch64` 的 dmg（`macos-latest` runner 原生架构），Intel（x86_64）用户没有对应安装包。补齐需要在 macOS 矩阵里增加 `--target x86_64-apple-darwin`（或 `universal-apple-darwin` 统一包），属于发布链路独立改动，需真机验证后再合入。
- CI 环境无法验证 Developer ID 签名 + 公证的真实效果（没有证书与 Apple 账号）；`signed` 分支只能由持有凭据的维护者在真机或 tag 发布时验证。
