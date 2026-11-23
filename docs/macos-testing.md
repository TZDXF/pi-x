# macOS 测试

CI 的 `macos` job 在 GitHub 托管的 `macos-latest` runner 上跑一遍与 Linux 等价的检查：按锁文件安装、构建前端、把 `TMPDIR` 归一成真实路径、`cargo check` 与默认 feature 的 `cargo test`。本文给出在 Mac 本机复现同一范围所需的最小命令，以及本机与 CI 的已知差异。

## CI 的 macOS job 跑什么

`.github/workflows/ci.yml` 的 `macos` job（`runs-on: macos-latest`）顺序执行：

1. `pnpm install --frozen-lockfile`
2. `pnpm run build`
3. 把 `TMPDIR` 归一成真实路径并写入 `$GITHUB_ENV`（见下节）
4. `cargo check --manifest-path src-tauri/Cargo.toml`
5. `cargo test --manifest-path src-tauri/Cargo.toml`

它**不**包含：`remote-access` feature（Linux 的 `rust` job 仍覆盖默认与 `remote-access` 两档）、E2E、`tauri build` / 打包、真实模型服务调用。Runner 由 GitHub 托管，不使用自托管机器。

## 前置要求

- macOS（CI 用 `macos-latest`，本机实测 macOS 27.2.1 / Apple Silicon）。
- Xcode Command Line Tools：`xcode-select -p` 应指向有效的 Developer 目录；Tauri 的 Darwin 依赖（WebKit、图标解析）来自这里，不需要额外 `brew install`。
- **Node.js 22**（不是「≥ 22」）：跑步进 `node:vm` 的测试需要 Node 22 的严格模式语义，详见下文「Node 主版本」。
- pnpm（仓库通过 `packageManager` 固定版本）、Rust ≥ 1.90（`rustup toolchain install stable` 即可）。
- `pnpm install --frozen-lockfile`，只认 `pnpm-lock.yaml`。

## 等效命令

与 CI 的 `macos` job 一一对应（第三步先归一 `TMPDIR`，其余步骤与 job 完全一致）：

```bash
pnpm install --frozen-lockfile
pnpm run build
export TMPDIR="$(cd "${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}" && pwd -P)"
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

`export TMPDIR=...` 只作用于当前 shell，不改系统设置、不改仓库文件；新开终端需要重新执行。也可以只对这一条命令临时生效：

```bash
TMPDIR="$(cd "$(getconf DARWIN_USER_TEMP_DIR)" && pwd -P)" cargo test --manifest-path src-tauri/Cargo.toml
```

本机全量提交前检查（覆盖 lint、类型检查、默认与 `remote-access` 两档 Rust 检查以及全部前端单测）：

```bash
pnpm run check          # oxlint + typecheck + build + 默认 Rust check + remote-access check
pnpm run test:web:all   # 全量 Vitest（同样建议先归一 TMPDIR）
```

`pnpm test` 是 `cargo test --manifest-path src-tauri/Cargo.toml` 的 UTF-8 包装入口（Windows 代码页处理，Mac 上等价于直接跑 cargo），两条都可以用。

## 已知 macOS 差异：`TMPDIR` 必须是真实路径

Darwin 上 `/tmp`、`/var`、`/etc` 都是指向 `/private/...` 的符号链接，**`/var/folders/...` 同样在 `/var` 软链之下**。GitHub 的 macOS runner 默认 `TMPDIR=/var/folders/...`，因此它不是真实路径；本仓库的 macOS job 在加入归一之前正是因此失败。若 `TMPDIR` 保持这种软链路径，会有一批按 `realpath` 比较路径的用例失败：

- Rust：`commands::workspace::workspace_tests::workspace_context_lists_validated_roots`、`session_file_rewind::tests::*`、`sessions::edit::session_path_tests::normalizes_reported_session_path_before_pi_persists_it`、`workspace_git::tests::creates_worktree_in_configured_directory`（实测 6 个）。
- 前端：`tests/bench-rust.test.ts`、`tests/session-snapshot.test.ts`、`tests/ssh-remote-trust-helper.test.ts` 中按 realpath 比路径的用例。

失败原因不是代码缺陷，而是测试夹具用 `std::env::temp_dir()` / `os.tmpdir()` 拿到软链路径（如 `/var/folders/...` 或 `/tmp/...`），被测代码按 `dunce::canonicalize` / `realpathSync` 归一到 `/private/...` 后再比较。CI 的 `macos` job 用上面的 `cd ... && pwd -P` 归一 `TMPDIR` 来消除差异，本机跑同一批测试时照做即可。

判断当前环境是否踩到这条：比较原值与真实路径，两者不一致就是。

```bash
echo "raw:  ${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}"
echo "real: $(cd "${TMPDIR:-$(getconf DARWIN_USER_TEMP_DIR)}" && pwd -P)"
```

注意 `python3 -c 'import tempfile; print(tempfile.gettempdir())'` 只是把 `TMPDIR` 原样回显，无法区分软链与真实路径，不能用作判断依据。跑完不必修改任何代码或系统设置。

### Node 主版本与 `node:vm`

`tests/project-group-folders.test.ts` 用 `node:vm` 执行 `ts.transpile` 的片段并写回 `__out`。`ts.transpile` 的产物以 `"use strict"` 开头，严格模式下给未声明标识符赋值会抛 `__out is not defined`。实测 Node 22.20（CI 的 `node-version: 22`）通过，Node 26.13 失败；复现前端单测请使用 Node 22（`node -v` 确认），不需要改测试或源码。

## 不在 macOS 上验证的部分

- `remote-access` feature 的 Rust 检查与打包：由 Linux 的 `rust` job 与 Release workflow 覆盖。
- E2E：只在 Linux 跑 Playwright。
- Windows 专属能力（托盘通知、WebView2 缓存、注册表项等）与 `tauri build` 产物本身，不在 macOS CI 覆盖范围。
