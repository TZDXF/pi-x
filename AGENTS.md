# Repository Guidelines

## 项目结构与模块组织
PiX 是 pi coding agent 的桌面客户端，采用 Vue 3、TypeScript 与 Tauri 2（Rust），通过 `pi --mode rpc` 的 JSONL 标准输入/输出通信。
- `src/components/`：界面组件，其中 `ui/` 与 `ai-elements/` 为 vendored 上游组件（shadcn-vue / ai-elements），以 fork 模式自行维护；`stores/`：会话与 UI 状态；`composables/`：可复用组合逻辑。
- `src/api/`：RPC 类型与桌面/远程传输；`src/lib/`：业务工具；`src/i18n/`：翻译。
- `src/assets/`、`public/`：前端资源；`src-tauri/src/`：进程管理、信任、终端及 Git 等后端能力。
- `tests/`：Node 单元测试与浏览器回归脚本；`tests/lib/`：测试辅助代码。Rust 单元测试位于后端源码中。

## 构建、测试与开发命令
准备 Node.js ≥ 22、Rust ≥ 1.90 及已安装的 pi。统一使用 pnpm 安装依赖，仅维护 `pnpm-lock.yaml`。
- `pnpm install --frozen-lockfile`：按锁文件安装依赖。
- `pnpm run dev:desktop`：桌面开发，支持前端热更新。
- `pnpm run dev`：仅浏览器预览，不启动 pi 进程。
- `pnpm run dev:desktop:remote`：先构建前端，再启用远程访问；远程页面不支持热更新。
- `pnpm run check`：依次执行 oxlint、类型检查、前端构建与 Rust 检查，**不含测试**。
- `pnpm run lint` / `lint:fix`：oxlint 检查 / 自动修复（配置见 `.oxlintrc.json`）。
- `pnpm run fmt` / `fmt:check`：oxfmt 格式化 / 校验（配置见 `.oxfmtrc.json`）。
- `pnpm run test:web` / `pnpm test`：分别运行 Node / Rust 单元测试。
- `pnpm run build` / `pnpm run package`：分别生成前端产物 / 含远程访问的桌面安装包。

## 代码风格与命名
遵循邻近代码：Vue/TypeScript 通常使用两空格缩进、省略分号；Rust 使用四空格缩进。组件采用 PascalCase（如 `ChatView.vue`），变量与函数使用 camelCase，Rust 模块与函数使用 snake_case。前端内部导入可使用 `@/` 别名。

TypeScript 启用严格检查；使用 `pnpm run lint` 运行 oxlint 校验（默认 correctness 分类，规则迁移自原 ESLint 配置），不进行无关的大规模格式化。格式化使用 oxfmt（printWidth 120、无分号、双引号、箭头函数单参不加括号、LF），尚未整体套用到存量代码，按需对改动的文件执行 `pnpm run fmt`。`src/components/ui/` 与 `src/components/ai-elements/` 是 vendored 进仓库的组件库，本项目以 fork 模式直接修改维护（历史提交亦如此），可按需改动；改动保持小步、贴近原有写法，便于日后与上游同步时对照。oxlint 与 oxfmt 均忽略这两个目录，其代码风格需手动与邻近代码保持一致。遵守 `.gitattributes`：文本默认 LF，Windows 脚本使用 CRLF。用户可见文案必须通过 i18n，并同步 `zh-CN` 与 `en`。

## 测试要求
Node 测试使用 `node:test` 与 `node:assert/strict`，文件命名为 `tests/<feature>.test.mjs`；修复缺陷时补充回归用例。浏览器脚本 `*.browser.mjs` 需单独执行，不包含在 `test:web` 中，环境配置参见 README。

提交前运行 `pnpm run check`、`pnpm run test:web` 和 `pnpm test`。当前未配置覆盖率门槛；重点覆盖协议、状态转换及边界条件。

## 提交与 Pull Request
沿用历史中的 `feat(scope): 描述`、`fix(scope): 描述`、`refactor(scope): 描述` 等格式；描述可中英文，emoji 非必需。提交保持单一目的。

PR 应说明变更原因、影响范围、验证命令与结果，并关联相关 issue；界面修改附截图或录屏。确保 CI 的前端与 Rust 检查通过，注明未验证的平台或流程。

## 安全与协作
不要提交 API key、`~/.pi/agent/auth.json` 或个人配置。修改进程调用时使用独立参数，避免拼接 shell 命令；保留项目信任校验。协作时使用中文，勿覆盖工作区已有的无关修改。
