# Repository Guidelines

## 项目结构与模块组织

PiX 是 pi coding agent 的桌面客户端，采用 Vue 3、TypeScript 与 Tauri 2（Rust），通过 `pi --mode rpc` 的 JSONL 标准输入/输出通信。

- `src/components/`：界面组件，其中 `ui/` 与 `ai-elements/` 为 vendored 上游组件（shadcn-vue / ai-elements），以 fork 模式自行维护；`stores/`：会话与 UI 状态；`composables/`：可复用组合逻辑。
- `src/api/`：RPC 类型与桌面/远程传输；`src/lib/`：业务工具；`src/i18n/`：翻译。
- `src/assets/`、`public/`：前端资源；`src-tauri/src/`：进程管理、信任、终端及 Git 等后端能力。
- `tests/`：Vitest 单元测试；`e2e/`：Playwright TypeScript E2E 与本地 Vite harness。Rust 单元测试位于后端源码中。

## 构建、测试与开发命令

准备 Node.js ≥ 22、Rust ≥ 1.90 及已安装的 pi。统一使用 pnpm 安装依赖，仅维护 `pnpm-lock.yaml`。

- `pnpm install --frozen-lockfile`：按锁文件安装依赖。
- `pnpm run dev:desktop`：桌面开发，支持前端热更新。
- `pnpm run dev`：仅浏览器预览，不启动 pi 进程。
- `pnpm run dev:desktop:remote`：先构建前端，再启用远程访问；远程页面不支持热更新。
- `pnpm run check`：依次执行 oxlint、类型检查、前端构建与 Rust 检查，**不含测试**。
- `pnpm run lint` / `lint:fix`：oxlint 检查 / 自动修复（配置见 `.oxlintrc.json`）。
- `pnpm run fmt` / `fmt:check`：oxfmt 格式化 / 校验（配置见 `.oxfmtrc.json`）。
- `pnpm run test:web` / `pnpm run test:web:all` / `pnpm run test:web:watch` / `pnpm run test:e2e` / `pnpm test`：分别按增量（仅相对 HEAD 变动的测试）、全量、watch 模式运行 Vitest 单元测试，以及运行 Playwright E2E 与 Rust 单元测试。
- `pnpm run build` / `pnpm run package`：分别生成前端产物 / 含远程访问的桌面安装包。

## 可选：Rust 构建缓存（Mr. Boxington / mbx）

`src-tauri` 的 Cargo 编译（`build` / `test` / `clippy`）可接入 [mbx](https://mr-boxington.jdx.dev) 本地缓存，跨 checkout 与 profile 复用 rustc 产物；前端 pnpm 流程不受影响。**CI 不接入**：`ci.yml` 的 rust job 继续用 `swatinem/rust-cache`，本机缓存只服务本地开发。

1. 安装：按官方 installation 的 Windows x86-64 归档解压到 `%LOCALAPPDATA%\Programs\mbx` 并加入 `PATH`（校验 `SHA256SUMS`）。
2. `cache_dir` 必须与 target 目录**同处 ReFS 卷**，否则还原退化为逐字节复制（`mbx doctor` 会明确报 `every restored byte is copied`）；在 `%APPDATA%\mbx\config.toml` 写 `cache_dir = 'D:\mbx-cache'`，或用 `MBX_CACHE_DIR`。同卷且可克隆时 `mbx doctor` 的 `restore` 行报 `cloning is supported`。
3. 显式跑（在 `src-tauri/` 下）：`mbx build --locked` / `mbx test --locked` / `mbx clippy --locked --all-targets`。仓库脚本 `pnpm test` 与 `pnpm run check` 里的 `cargo` 现在经 `scripts/run-with-utf8.mjs` 启动（见第 5 条），**是否命中 mbx 缓存取决于调用者 PATH 里 `cargo` 解析到谁**：`mbx setup` 装好 shim、且 `%LOCALAPPDATA%\mbx\bin` 排在 `%USERPROFILE%\.cargo\bin` 之前时，脚本里的 `cargo` 就是 mbx 的 Cargo shim，编译全程走缓存；否则仍是裸 cargo，只多一次控制台代码页切换。旧 daemon / IDE 或已运行的终端拉起的新子进程可能仍继承改动前的 PATH，判断实际生效要看目标进程自己的环境（例如 `where cargo`），不能只凭“新开一个进程”。
4. **Rust release 编译与 Tauri 安装包打包是两件事**：前者可用 `mbx build --release --locked --features remote-access`（等价 `cargo` 参数），走缓存；后者是 `pnpm run package`（`tauri build --features remote-access`，内部再调 cargo 并跑打包器与签名），本任务**未验证**其缓存命中与产物，不要把它当作已验证入口。另外，带 `remote-access` feature 时 `build.rs` 会用 `include_bytes!` 把 `dist/` 静态嵌入二进制，缺少 `dist` 会 panic（`Missing frontend assets`），所以动手前先 `pnpm run build`。
5. **控制台代码页要能解出 UTF-8**：`aws-lc-sys`、`vswhom-sys`、`ring` 的 build script 会把 MSVC 的本地化诊断（简体中文环境的 GBK/CP936 字节）写进 stdout。这类字节不是合法 UTF-8 时，mbx 只报 `build-script stdout is not UTF-8` / `build-script result was not stored` 并**丢弃该 build script 的结果**，其下游退化成 `build-script-declarations-pending` —— 缓存仍工作，只是这几个原生产物与其下游每次都要重编。实测同一份缓存上：CP936 热构建 531 hits / 17 misses，UTF-8 热构建 556 hits / 0 misses。含同类原生依赖的仓库（`repomeow` 的 `src-tauri` 也有这三种 `-sys`）同样适用，不是本仓库独有。
   仓库侧的做法是 `scripts/run-with-utf8.mjs`：Windows 上先 `chcp.com` 把控制台代码页切到 65001，运行子命令，结束后恢复原值；其他平台原样转发。它**只影响该子进程的控制台代码页**，不改 PATH、不改 PowerShell profile、不动系统/用户环境变量；参数与退出码原样透传，行为由 `tests/run-with-utf8.test.ts` 覆盖。`pnpm test` 与 `pnpm run check` 已经接上它，所以在默认 CP936 的主机上直接跑这两条即可，不必先手动 `chcp`。不经脚本的入口自己负责：显式命令用 `cmd /d /c "chcp 65001 >nul && mbx build --locked"`，或在 Git Bash / `bash -lc` 里先 `chcp.com 65001`。
6. 首次构建会把 `src-tauri/target` 换成指向 `cache_dir/targets` 的 symlink；`src-tauri/gen/schemas` 由 tauri-build 生成，仍被 `.gitignore` 忽略。`mbx clean` 只回收本 workspace 的 target 与增量态，共享 store 保留，下一次构建从 store 还原。
7. 回收/清理：`mbx clean`（本 workspace）、`mbx cache stats` / `mbx stats` / `mbx gc --dry-run`。仓库 `cargo clean` 不清 mbx 私有增量态。

不提交 `.mbx.toml`：机器相关路径（`cache_dir`、`target.root`）属于全局配置，`.mbx.toml` 会拒绝；其余工作区策略（`incremental`、`share_workspace_root`、`scheduler.*`）在本仓库用默认值更划算（`share_workspace_root` 会把源码路径换成占位符影响调试信息与 panic 位置，`scheduler.reserve_cpus` 会削减并行度）。

## 代码风格与命名

遵循邻近代码：Vue/TypeScript 通常使用两空格缩进、省略分号；Rust 使用四空格缩进。组件采用 PascalCase（如 `ChatView.vue`），变量与函数使用 camelCase，Rust 模块与函数使用 snake_case。前端内部导入可使用 `@/` 别名。

TypeScript 启用严格检查；使用 `pnpm run lint` 运行 oxlint 校验（默认 correctness 分类，规则迁移自原 ESLint 配置），不进行无关的大规模格式化。格式化使用 oxfmt（printWidth 120、无分号、双引号、箭头函数单参不加括号、LF），尚未整体套用到存量代码，按需对改动的文件执行 `pnpm run fmt`。`src/components/ui/` 与 `src/components/ai-elements/` 是 vendored 进仓库的组件库，本项目以 fork 模式直接修改维护（历史提交亦如此），可按需改动；改动保持小步、贴近原有写法，便于日后与上游同步时对照。oxlint 与 oxfmt 均忽略这两个目录，其代码风格需手动与邻近代码保持一致。遵守 `.gitattributes`：文本默认 LF，Windows 脚本使用 CRLF。用户可见文案必须通过 i18n，并同步 `zh-CN` 与 `en`。

## 测试要求

前端测试使用 Vitest 与 `expect`，文件命名为 `tests/<feature>.test.ts`；不要新增 `node:test` 依赖。修复缺陷时补充回归用例。AI/provider 请求测试通过 `@copilotkit/aimock/vitest` 与 `tests/fixtures/ai/` 做本机确定性模拟，禁止访问真实模型服务。非必要不新增或扩展 E2E 测试，优先通过单元测试覆盖变更；仅在关键用户流程或浏览器交互无法由单元测试充分验证时编写 E2E。E2E 使用 `e2e/*.spec.ts` 与 Playwright，不包含在 `test:web` 中；首次运行先执行 `pnpm run test:e2e:install`。E2E 通过本地 Vite harness 与确定性 mock 验证浏览器行为，禁止访问外部服务。

日常迭代运行 `pnpm run test:web`（默认只跑相对 HEAD 变动及其关联的测试；工作区未提交改动多时会退化为接近全量）。提交前运行 `pnpm run check`、`pnpm run test:web:all`、`pnpm run test:e2e` 和 `pnpm test`。当前未配置覆盖率门槛；重点覆盖协议、状态转换及边界条件。

## 提交与 Pull Request

沿用历史中的 `feat(scope): 描述`、`fix(scope): 描述`、`refactor(scope): 描述` 等格式；描述可中英文，emoji 非必需。提交保持单一目的。

PR 应说明变更原因、影响范围、验证命令与结果，并关联相关 issue；界面修改附截图或录屏。确保 CI 的前端与 Rust 检查通过，注明未验证的平台或流程。

## 安全与协作

不要提交 API key、个人配置。修改进程调用时使用独立参数，避免拼接 shell 命令；保留项目信任校验。协作时使用中文，勿覆盖工作区已有的无关修改。
