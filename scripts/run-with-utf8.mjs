#!/usr/bin/env node
// 在 Windows 上以 UTF-8（控制台代码页 65001）运行一个命令，其他平台原样转发。
//
// 起因：中文 Windows 的控制台默认代码页是 CP936，MSVC 的本地化诊断会以 GBK 字节写进
// build script 的 stdout。mbx 只接受 UTF-8，读不了就丢掉该 build script 的结果，并让
// 下游编译无法命中缓存（`build-script stdout is not UTF-8` /
// `build-script result was not stored`）。Cargo 及其 build script 继承父进程所在控制台
// 的代码页，所以这里只在子命令运行期间把控制台代码页切到 65001，结束后恢复原值：
// 不改 PATH、不改 PowerShell profile、不动系统/用户环境变量。
//
// 命令本身仍由调用者的 PATH 决定（`cargo` 是否落到 mbx 的 shim 不由本脚本干预），
// 参数原样透传，退出码原样返回。
//
// 用法：node scripts/run-with-utf8.mjs <命令> [参数...]

import { spawnSync } from "node:child_process"

const CHCP = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\chcp.com`
const UTF8_CODE_PAGE = 65001

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error("用法: node scripts/run-with-utf8.mjs <命令> [参数...]")
  process.exit(2)
}

// cmd.exe 会把整串命令行再解析一次（展开 %VAR%、切开 & | ^ 等），所以命令与每个参数都要
// 按 cmd 的规则转义，否则含空格、引号、& | ^ < > % ! 的参数会被拆开或展开。
const META = /([()\][%!^"`<>&|;, *?])/g

// 命令只转义一次：外层整串的引号由下面负责加，命令里的空格用 ^ 转义即可。
const quoteCommand = command => command.replace(META, "^$1")

// 参数要转义两次：外层 ^ 会在 cmd.exe 第一轮解析时用掉一层，剩下的才轮到参数本身。
function quoteArgument(argument) {
  let value = `${argument}`
  value = value.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"')
  value = value.replace(/(?=(\\+?)?)\1$/, "$1$1")
  value = `"${value}"`
  return value.replace(META, "^$1").replace(META, "^$1")
}

// 先按可执行文件直接解析（PATH + PATHEXT 由 libuv 处理），这条路径不会重新解析参数；
// `.cmd` / `.bat` 形态的包装在 Windows 上不能直接 spawn（EINVAL），找不到目标也会是
// ENOENT，两者都退回 cmd.exe。此时用 windowsVerbatimArguments 关掉 Node 自己的参数
// 引用，命令行由上面两个函数保证，否则空参数会丢、带空格的参数会被拆碎。
//
// 已实测（13 条用例：真实 cargo 参数、空格、空串、空格+空串、双引号、& | ^ < ()、100%、
// %PATH%、带空格的盘符路径）：普通 `.cmd` 包装收到与传入逐字一致的 argv，含空格目录下的
// 包装也一样。这里不宣称“与直接 spawn 完全等价”，两处残余限制来自包装自己的再次解析，
// 本脚本无法干预：
//   1. 包装用 `call` 转发时（`call node ... %*`）会再解析一轮参数，`^`、`%VAR%` 会被吞
//      （实测 `a^b` → `a^^b`、`%PATH%` 被展开成实际值）；
//   2. 包装开了 `setlocal enabledelayedexpansion` 时 `!VAR!` 会被展开、字面 `!` 会丢
//      （实测 `a!b` → `ab`）。
// pi-x 现有调用（shim 是 `cargo.exe` 纯 exe，走直接 spawn；参数是
// `test --manifest-path src-tauri/Cargo.toml`）踩不到这两条。
function runCommand() {
  const direct = spawnSync(args[0], args.slice(1), { stdio: "inherit" })
  const needsShell = direct.error && (direct.error.code === "EINVAL" || direct.error.code === "ENOENT")
  if (!needsShell || process.platform !== "win32") return direct.status ?? 1

  const line = `"${[quoteCommand(args[0]), ...args.slice(1).map(quoteArgument)].join(" ")}"`
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", line], {
    stdio: "inherit",
    windowsVerbatimArguments: true,
  })
  return result.status ?? 1
}

// chcp 的输出是本地化的，但末尾的代码页数字始终是 ASCII，按字节截取即可。
function readCodePage() {
  const result = spawnSync(CHCP, [], { encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] })
  if (result.error || !result.stdout) return null
  const match = result.stdout.toString("latin1").match(/(\d{3,5})\s*$/)
  return match ? Number(match[1]) : null
}

function setCodePage(codePage) {
  const result = spawnSync(CHCP, [String(codePage)], { stdio: "ignore" })
  return !result.error && result.status === 0
}

if (process.platform !== "win32") {
  process.exit(runCommand())
}

// 切不过去就如实提示，别让构建悄悄退回到“build script 结果不入缓存、下游每次重编”的状态。
const originalCodePage = readCodePage()
let switched = false
if (originalCodePage === null) {
  console.warn(
    "[run-with-utf8] 读不到当前控制台代码页，按原样运行；若控制台不是 UTF-8，mbx 会丢弃部分 build script 结果",
  )
} else if (originalCodePage !== UTF8_CODE_PAGE) {
  if (setCodePage(UTF8_CODE_PAGE)) {
    switched = true
  } else {
    console.warn(
      `[run-with-utf8] 无法把控制台代码页从 ${originalCodePage} 切到 ${UTF8_CODE_PAGE}，按原样运行；若控制台不是 UTF-8，mbx 会丢弃部分 build script 结果`,
    )
  }
}

const status = runCommand()
if (switched && !setCodePage(originalCodePage)) {
  console.warn(`[run-with-utf8] 未能把控制台代码页恢复为 ${originalCodePage}，当前终端仍是 ${UTF8_CODE_PAGE}`)
}
process.exit(status)
