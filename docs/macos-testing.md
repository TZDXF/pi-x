# macOS 测试

CI 的 `macos` job 在 GitHub 托管的 `macos-latest` runner 上跑一遍与 Linux 等价的检查：按锁文件安装、构建前端、`cargo check` 与默认 feature 的 `cargo test`。本文给出在 Mac 本机复现同一范围所需的最小命令，以及本机与 CI 的已知差异。

## CI 的 macOS job 跑什么

`.github/workflows/ci.yml` 的 `macos` job（`runs-on: macos-latest`）顺序执行：

1. `pnpm install --frozen-lockfile`
2. `pnpm run build`
3. `cargo check --manifest-path src-tauri/Cargo.toml`
4. `cargo test --manifest-path src-tauri/Cargo.toml`

它**不**包含：`remote-access` feature（Linux 的 `rust` job 仍覆盖默认与 `remote-access` 两档）、E2E、`tauri build` / 打包、真实模型服务调用。Runner 由 GitHub 托管，不使用自托管机器。

## 前置要求

- macOS（CI 用 `macos-latest`，本机实测 macOS 27.2.1 / Apple Silicon）。
- Xcode Command Line Tools：`xcode-select -p` 应指向有效的 Developer 目录；Tauri 的 Darwin 依赖（WebKit、图标解析）来自这里，不需要额外 `brew install`。
- Node.js ≥ 22、pnpm（仓库通过 `packageManager` 固定版本）、Rust ≥ 1.90（`rustup toolchain install stable` 即可）。
- `pnpm install --frozen-lockfile`，只认 `pnpm-lock.yaml`。

## 等效命令

与 CI 的 `macos` job 一一对应：

```bash
pnpm install --frozen-lockfile
pnpm run build
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

本机全量提交前检查（覆盖 lint、类型检查、默认与 `remote-access` 两档 Rust 检查以及全部前端单测）：

```bash
pnpm run check          # oxlint + typecheck + build + 默认 Rust check + remote-access check
pnpm run test:web:all   # 全量 Vitest
```

`pnpm test` 是 `cargo test --manifest-path src-tauri/Cargo.toml` 的 UTF-8 包装入口（Windows 代码页处理，Mac 上等价于直接跑 cargo），两条都可以用。

## 已知 macOS 差异：`TMPDIR` 必须是真实路径

Darwin 上 `/tmp`、`/var`、`/etc` 都是指向 `/private/...` 的符号链接。若 `TMPDIR` 指到符号链接内的路径（例如某些终端/任务环境把它设成 `/tmp/<something>`），会有一批按 `realpath` 比较路径的用例失败：

- Rust：`commands::workspace::workspace_tests::workspace_context_lists_validated_roots`、`session_file_rewind::tests::*`、`sessions::edit::session_path_tests::normalizes_reported_session_path_before_pi_persists_it`、`workspace_git::tests::creates_worktree_in_configured_directory`（实测 6 个）。
- 前端：`tests/bench-rust.test.ts`、`tests/session-snapshot.test.ts`、`tests/ssh-remote-trust-helper.test.ts` 中按 realpath 比路径的用例。

失败原因不是代码缺陷，而是测试夹具用 `std::env::temp_dir()` / `os.tmpdir()` 拿到 `/tmp/...`，被测代码按真实路径 `/private/tmp/...` 归一。GitHub 的 macOS runner 默认 `TMPDIR=/var/folders/...`（真实路径，不经过 `/tmp` 软链），所以 CI 不受影响。

本机遇到时，把 `TMPDIR` 指向真实路径即可（不要用 `/tmp`）：

```bash
TMPDIR=/private/tmp cargo test --manifest-path src-tauri/Cargo.toml
TMPDIR=/private/tmp pnpm run test:web:all
```

要确认当前环境是否踩到这条：`python3 -c 'import tempfile; print(tempfile.gettempdir())'` 打印出 `/tmp/...` 就是。跑完不必修改任何代码或系统设置。

### 另一条：Node 主版本与 `node:vm`

`tests/project-group-folders.test.ts` 用 `node:vm` 执行 `ts.transpile` 的片段并写回 `__out`。`ts.transpile` 的产物以 `"use strict"` 开头，严格模式下给未声明标识符赋值会抛 `__out is not defined`；实测 Node 22.20（CI 的 `node-version: 22`）通过，Node 26.13 失败。遇到该失败先对齐 Node 版本（`node -v`），不需要改测试或源码。

## 不在 macOS 上验证的部分

- `remote-access` feature 的 Rust 检查与打包：由 Linux 的 `rust` job 与 Release workflow 覆盖。
- E2E：只在 Linux 跑 Playwright。
- Windows 专属能力（托盘通知、WebView2 缓存、注册表项等）与 `tauri build` 产物本身，不在 macOS CI 覆盖范围。
